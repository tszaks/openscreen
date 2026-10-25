// `frames <bundle|latest> (--at 0.5,2,4.25 | --every 0.5 | --moves) [--from s] [--to s]
// [--out dir] [--scale 0.5] [--sheet] [--draft] [--debug] [--timeout s] [--app OpenScreen.app]`:
// render still PNGs at OUTPUT seconds with the real app, headless, through
// the same compositor and inputs as an export (SPEC §4.2). An agent looks at
// these (and sheet.png) before paying for a full export. Every time snaps to
// the export's frame grid (frame round(t·fps), drawn at frame/fps), so each
// still is a frame the export writes, also mid-zoom and mid-move.
//
// The default quality is the export's (3D: supersampling, jittered
// anti-aliasing and motion blur); --draft renders one 3D sample at 1×.
// PNGs go to <tmp>/openscreen-frames/<bundle>-<stamp>/ unless --out is
// given, never into the bundle (D10).

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { MAX_FRAMES, snapToExportFrame, type HeadlessFrame } from '../shared/headless';
import { layoutPresetOf } from '../shared/exportJobs';
import { tapsToOutput } from '../shared/mobileProject';
import { phone3dActive } from '../shared/phone3d/placement';
import { poseAtWithFloat } from '../shared/phone3d/pose';
import { screenQuad } from '../shared/phone3d/projection';
import type { Pose } from '../shared/phone3d/model';
import { Timeline } from '../shared/timeline';
import type { Project } from '../shared/types';
import { validateProject } from '../shared/agentOps';
import { readCursorSamples } from './bundleFiles';
import { appCommand, bool, CliError, flag, r2, runHeadless, seconds, warnProgress } from './cliKit';
import { projectWarnings } from './phone3dPlan';

/** `from`/`to`: an output-time range for --every and --moves (owner decision 18). */
export type FrameSelection = { kind: 'at'; times: number[] } | { kind: 'every'; step: number; from?: number; to?: number } | { kind: 'moves'; from?: number; to?: number };

export interface FramesArgs {
  bundle: string | undefined;
  select: FrameSelection;
  out?: string;
  scale: number;
  sheet: boolean;
  draft: boolean;
  /** Print each still's textBoxes and deviceFrame (layout checks such as downscale4k; large on long runs). */
  debug?: true;
  timeout?: number;
  app?: string;
}

export const FRAMES_USAGE = 'usage: frames <bundle|latest> (--at 0.5,2,4.25 | --every 0.5 | --moves) [--from s] [--to s] [--out dir] [--scale 0.5] [--sheet] [--draft] [--debug] [--timeout s]';

/** Parse `frames` arguments; exactly one of --at / --every / --moves. Throws CliError(…, 2) on bad usage. */
export function parseFramesArgs(argv: string[]): FramesArgs {
  const args = [...argv];
  const at = flag(args, '--at');
  const every = flag(args, '--every');
  const moves = bool(args, '--moves');
  const outArg = flag(args, '--out');
  const scaleArg = flag(args, '--scale');
  const timeoutArg = flag(args, '--timeout');
  const app = flag(args, '--app');
  const sheet = bool(args, '--sheet');
  const draft = bool(args, '--draft');
  const debug = bool(args, '--debug');
  const fromArg = flag(args, '--from');
  const toArg = flag(args, '--to');
  const bundle = args.shift();
  const unknown = args.find((a) => a.startsWith('--'));
  if (unknown) throw new CliError(`frames: unknown option ${unknown}. ${FRAMES_USAGE}`, 2);
  if (args.length) throw new CliError(`frames: unexpected argument "${args[0]}". ${FRAMES_USAGE}`, 2);
  if ([at !== undefined, every !== undefined, moves].filter(Boolean).length !== 1) {
    throw new CliError(`frames needs exactly one of --at, --every or --moves. ${FRAMES_USAGE}`, 2);
  }
  const time = (name: string, v: string | undefined) => {
    if (v === undefined) return undefined;
    const n = Number(v.replace(/s$/, ''));
    if (!Number.isFinite(n) || n < 0) throw new CliError(`${name} must be output seconds ≥ 0 (got "${v}")`, 2);
    return n;
  };
  const from = time('--from', fromArg);
  const to = time('--to', toArg);
  if ((from !== undefined || to !== undefined) && at !== undefined) throw new CliError(`--from/--to go with --moves or --every; --at already names its times. ${FRAMES_USAGE}`, 2);
  if (from !== undefined && to !== undefined && !(to > from)) throw new CliError(`--to must be after --from (got ${from} to ${to})`, 2);
  const range = { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
  let select: FrameSelection;
  if (at !== undefined) {
    const times = at.split(',').map((s) => s.trim()).filter(Boolean).map((s) => Number(s.replace(/s$/, '')));
    if (!times.length || times.some((t) => !Number.isFinite(t) || t < 0)) throw new CliError(`--at must be output seconds ≥ 0, comma-separated (got "${at}")`, 2);
    select = { kind: 'at', times };
  } else if (every !== undefined) select = { kind: 'every', step: seconds(every), ...range };
  else select = { kind: 'moves', ...range };
  const scale = scaleArg === undefined ? 1 : Number(scaleArg);
  if (!(scale > 0 && scale <= 1)) throw new CliError('--scale must be a number in (0, 1]', 2);
  const timeout = timeoutArg === undefined ? undefined : Number(timeoutArg);
  if (timeout !== undefined && !(timeout > 0)) throw new CliError('--timeout must be a positive number of seconds', 2);
  return { bundle, select, ...(outArg !== undefined ? { out: outArg } : {}), scale, sheet, draft, ...(debug ? { debug: true as const } : {}), ...(timeout !== undefined ? { timeout } : {}), ...(app !== undefined ? { app } : {}) };
}

/** The frame rate the project exports at (Editor.exportVideo): its layout preset's, else `outputFPS`. */
export const exportFps = (p: Project) => layoutPresetOf(p)?.fps ?? p.outputFPS;

/** A still to render: the time asked for and the export frame that shows it. */
export interface PlannedFrame {
  /** Output seconds asked for (the first, when several land on one frame). */
  t: number;
  /** Export frame index, round(t · fps). */
  frame: number;
  /** Its output time, frame / fps: what the export draws, and what is rendered. */
  at: number;
}

/**
 * The stills to render, one per export frame, in time order, and the times
 * at or past the end of the edited timeline (reported, not rendered). Every
 * time snaps to the export's frame grid (snapToExportFrame at exportFps), so
 * each PNG is a frame the export writes; times on one frame render once.
 * --moves: the start, middle and end of every 3D move, plus every tap.
 * --every and --moves take an output range (`from`, `to`; default the whole
 * take). --moves with more than MAX_FRAMES frames samples them evenly (the
 * first and last always kept) and says so in `note`, instead of refusing
 * (owner decision 18: a long take has hundreds of moves and taps).
 */
export function planFrameTimes(p: Project, select: FrameSelection): { frames: PlannedFrame[]; past: number[]; fps: number; note?: string } {
  const tl = new Timeline(p.recording.duration, p.clips);
  const fps = exportFps(p);
  const D = tl.outputDuration;
  const from = select.kind === 'at' ? 0 : (select.from ?? 0);
  const to = select.kind === 'at' ? Infinity : (select.to ?? Infinity);
  const inRange = (t: number) => t >= from - 1e-9 && t <= to + 1e-9;
  const range = select.kind !== 'at' && (select.from !== undefined || select.to !== undefined) ? ` between ${from} s and ${to === Infinity ? 'the end' : `${to} s`}` : '';
  let wanted: number[];
  if (select.kind === 'at') wanted = select.times;
  else if (select.kind === 'every') {
    const end = Math.min(to, D);
    const n = Math.max(0, Math.ceil((end - from) / select.step - 1e-9));
    if (n > MAX_FRAMES) throw new CliError(`--every ${select.step} gives ${n} frames${range}; at most ${MAX_FRAMES} (use --every ${Math.ceil(((end - from) / MAX_FRAMES) * 100) / 100} or more, or a shorter --from/--to)`, 2);
    wanted = Array.from({ length: n }, (_, k) => from + k * select.step);
    if (!wanted.length) throw new CliError(`--every: nothing to render${range} (the output is ${Math.round(D * 100) / 100} s)`, 2);
  } else {
    const moves = (p.phone3d?.transitions ?? []).flatMap((m) => [m.start, (m.start + m.end) / 2, m.end]);
    const all = [...moves, ...tapsToOutput(p.taps, tl).map((t) => t.t)];
    if (!all.length) throw new CliError('--moves: this project has no 3D moves and no taps; use --at or --every', 2);
    wanted = all.filter(inRange);
    if (!wanted.length) throw new CliError(`--moves: no 3D move or tap${range}; use another range, --at or --every`, 2);
  }
  const byFrame = new Map<number, PlannedFrame>();
  const past = new Set<number>();
  for (const t of [...wanted].sort((a, b) => a - b)) {
    const g = snapToExportFrame(t, fps, D);
    if (!g || tl.sourceTime(g.at) === null) past.add(t);
    else if (!byFrame.has(g.frame)) byFrame.set(g.frame, { t, ...g });
  }
  let frames = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
  let note: string | undefined;
  if (frames.length > MAX_FRAMES) {
    if (select.kind !== 'moves') throw new CliError(`${frames.length} frames requested; at most ${MAX_FRAMES}`, 2);
    const n = frames.length;
    const picked = new Set(Array.from({ length: MAX_FRAMES }, (_, i) => Math.round((i * (n - 1)) / (MAX_FRAMES - 1))));
    frames = frames.filter((_, i) => picked.has(i));
    note = `--moves found ${n} frames${range}, more than the ${MAX_FRAMES} a run renders, so it rendered ${frames.length} evenly spread over them (every ${Math.round(((n - 1) / (MAX_FRAMES - 1)) * 100) / 100}th). For every frame, run shorter ranges with --from/--to.`;
  }
  return { frames, past: [...past], fps, ...(note ? { note } : {}) };
}

/** <tmp>/openscreen-frames/<bundle name>-<YYYYMMDD-HHMMSS>, with -2, -3… when taken. */
export function defaultFramesDir(bundle: string, now = new Date(), root = join(tmpdir(), 'openscreen-frames')): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const name = basename(bundle).replace(/\.openscreen$/, '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'bundle';
  let dir = join(root, `${name}-${stamp}`);
  for (let i = 2; existsSync(dir); i++) dir = join(root, `${name}-${stamp}-${i}`);
  return dir;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const roundPose = (pose: Pose): Pose => Object.fromEntries(Object.entries(pose).map(([k, v]) => [k, round3(v)])) as unknown as Pose;

/** The 3D pose drawn at `t` and how squarely the screen faces the camera (1 = straight on), when 3D is active. */
export function poseInfo(p: Project, t: number): { pose: Pose | null; facing: number | null } {
  if (!p.phone3d || !phone3dActive(p).active) return { pose: null, facing: null };
  const q = screenQuad(p, t);
  return { pose: roundPose(poseAtWithFloat(p.phone3d, t)), facing: q ? round3(q.facing) : null };
}

export interface FramesDeps {
  /** The bundle folder and its normalized project (`latest` resolved). */
  resolveBundle(arg: string | undefined): { dir: string; project: Project };
}

export async function framesCmd(argv: string[], deps: FramesDeps) {
  const a = parseFramesArgs(argv);
  const { dir, project: p } = deps.resolveBundle(a.bundle);
  // Like export: an invalid project is refused; warnings go to stderr and never block.
  const errs = validateProject(p);
  if (errs.length) throw new CliError(`project is invalid, fix it before rendering frames: ${errs.join('; ')}`);
  warnProgress(projectWarnings(p, { cursor: readCursorSamples(dir) }));
  const { frames: planned, past, fps, note } = planFrameTimes(p, a.select);
  const outDir = resolve(a.out ?? defaultFramesDir(dir));
  if (existsSync(outDir) && !statSync(outDir).isDirectory()) throw new CliError(`--out must be a folder: ${outDir} is a file`);
  mkdirSync(outDir, { recursive: true });
  const active = p.phone3d ? phone3dActive(p) : null;
  const started = Date.now();
  let stills: HeadlessFrame[] = [];
  let size: unknown = null;
  let sheet: string | null = null;
  let gpu: unknown = null;
  if (planned.length) {
    const app = appCommand(a.app);
    const argvApp = [
      '--export', dir,
      // Exact frame times (String keeps every digit of i / fps, so the app draws the export's double).
      '--frames', planned.map((f) => String(f.at)).join(','),
      '--out', outDir,
      ...(a.scale !== 1 ? ['--scale', String(a.scale)] : []),
      ...(a.sheet ? ['--sheet'] : []),
      ...(a.draft ? ['--draft'] : []),
      ...(a.timeout !== undefined ? ['--timeout', String(a.timeout)] : []),
    ];
    const result = await runHeadless(app, argvApp);
    if (!result.ok) throw Object.assign(new CliError(String(result.error ?? 'frames failed')), { extra: { ...result, out: outDir } });
    stills = (result.stills as HeadlessFrame[] | undefined) ?? [];
    size = result.size ?? null;
    sheet = typeof result.sheet === 'string' ? result.sheet : null;
    gpu = result.gpu ?? null;
  }
  // The app reports each still by the time it was sent (f.at) and the frame it drew.
  const sent = new Map(planned.map((f) => [f.at, f]));
  const files = [
    ...stills.map((s) => {
      const asked = sent.get(s.t)?.t ?? s.t;
      if (!s.path) return { t: asked, error: s.error ?? 'not rendered' };
      const at = s.at ?? s.t;
      // The text the still drew and the flat device frame's edges (PNG px), as
      // the app reported them; absent from an app built before they existed.
      // Only with --debug: the edge polylines are thousands of points per still,
      // far too much for a normal run's stdout.
      const rect3 = (r: { x: number; y: number; w: number; h: number }) => ({ x: round3(r.x), y: round3(r.y), w: round3(r.w), h: round3(r.h) });
      const textBoxes = s.textBoxes?.map(({ kind, rect: r, text, drawn }) => ({
        kind,
        rect: rect3(r),
        ...(text !== undefined ? { text } : {}),
        ...(drawn ? { drawn: rect3(drawn) } : {}),
      }));
      const df = s.deviceFrame;
      const deviceFrame =
        df === undefined
          ? undefined
          : df && { body: rect3(df.body), screen: rect3(df.screen), edges: df.edges.map((e) => e.map(([x, y]) => [round3(x), round3(y)])) };
      return {
        t: asked,
        frame: s.frame ?? null,
        at: r6(at),
        path: s.path,
        ...poseInfo(p, at),
        ...(a.debug && textBoxes ? { textBoxes } : {}),
        ...(a.debug && deviceFrame !== undefined ? { deviceFrame } : {}),
      };
    }),
    ...past.map((t) => ({ t, error: 'past the end' })),
  ].sort((x, y) => x.t - y.t);
  const tl = new Timeline(p.recording.duration, p.clips);
  return {
    ok: true,
    bundle: dir,
    out: outDir,
    size,
    quality: a.draft ? 'draft' : 'full',
    scale: a.scale,
    fps,
    outputDuration: r2(tl.outputDuration),
    phone3d: active,
    ...(note ? { note } : {}),
    files,
    ...(a.sheet ? { sheet } : {}),
    seconds: r2((Date.now() - started) / 1000),
    gpu,
  };
}
