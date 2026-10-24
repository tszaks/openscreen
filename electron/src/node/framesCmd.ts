// `frames <bundle|latest> (--at 0.5,2,4.25 | --every 0.5 | --moves) [--out dir]
// [--scale 0.5] [--sheet] [--draft] [--timeout s] [--app OpenScreen.app]`:
// render still PNGs at OUTPUT seconds with the real app, headless, through
// the same compositor and inputs as an export (SPEC §4.2). An agent looks at
// these (and sheet.png) before paying for a full export.
//
// The default quality is the export's (3D: supersampling, jittered
// anti-aliasing and motion blur); --draft renders one 3D sample at 1×.
// PNGs go to <tmp>/openscreen-frames/<bundle>-<stamp>/ unless --out is
// given, never into the bundle (D10).

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { MAX_FRAMES, type HeadlessFrame } from '../shared/headless';
import { tapsToOutput } from '../shared/mobileProject';
import { phone3dActive } from '../shared/phone3d/placement';
import { poseAtWithFloat } from '../shared/phone3d/pose';
import { screenQuad } from '../shared/phone3d/projection';
import type { Pose } from '../shared/phone3d/model';
import { Timeline } from '../shared/timeline';
import type { Project } from '../shared/types';
import { appCommand, bool, CliError, flag, r2, runHeadless, seconds } from './cliKit';

export type FrameSelection = { kind: 'at'; times: number[] } | { kind: 'every'; step: number } | { kind: 'moves' };

export interface FramesArgs {
  bundle: string | undefined;
  select: FrameSelection;
  out?: string;
  scale: number;
  sheet: boolean;
  draft: boolean;
  timeout?: number;
  app?: string;
}

export const FRAMES_USAGE = 'usage: frames <bundle|latest> (--at 0.5,2,4.25 | --every 0.5 | --moves) [--out dir] [--scale 0.5] [--sheet] [--draft] [--timeout s]';

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
  const bundle = args.shift();
  const unknown = args.find((a) => a.startsWith('--'));
  if (unknown) throw new CliError(`frames: unknown option ${unknown}. ${FRAMES_USAGE}`, 2);
  if (args.length) throw new CliError(`frames: unexpected argument "${args[0]}". ${FRAMES_USAGE}`, 2);
  if ([at !== undefined, every !== undefined, moves].filter(Boolean).length !== 1) {
    throw new CliError(`frames needs exactly one of --at, --every or --moves. ${FRAMES_USAGE}`, 2);
  }
  let select: FrameSelection;
  if (at !== undefined) {
    const times = at.split(',').map((s) => s.trim()).filter(Boolean).map((s) => Number(s.replace(/s$/, '')));
    if (!times.length || times.some((t) => !Number.isFinite(t) || t < 0)) throw new CliError(`--at must be output seconds ≥ 0, comma-separated (got "${at}")`, 2);
    select = { kind: 'at', times };
  } else if (every !== undefined) select = { kind: 'every', step: seconds(every) };
  else select = { kind: 'moves' };
  const scale = scaleArg === undefined ? 1 : Number(scaleArg);
  if (!(scale > 0 && scale <= 1)) throw new CliError('--scale must be a number in (0, 1]', 2);
  const timeout = timeoutArg === undefined ? undefined : Number(timeoutArg);
  if (timeout !== undefined && !(timeout > 0)) throw new CliError('--timeout must be a positive number of seconds', 2);
  return { bundle, select, ...(outArg !== undefined ? { out: outArg } : {}), scale, sheet, draft, ...(timeout !== undefined ? { timeout } : {}), ...(app !== undefined ? { app } : {}) };
}

const ms = (t: number) => Math.round(t * 1000) / 1000;

/**
 * The output times to render, ascending and unique to the millisecond, and
 * the ones past the end of the edited timeline (reported, not rendered).
 * --moves: the start, middle and end of every 3D move, plus every tap.
 */
export function planFrameTimes(p: Project, select: FrameSelection): { times: number[]; past: number[] } {
  const tl = new Timeline(p.recording.duration, p.clips);
  const D = tl.outputDuration;
  let wanted: number[];
  if (select.kind === 'at') wanted = select.times;
  else if (select.kind === 'every') {
    const n = Math.ceil(D / select.step - 1e-9);
    if (n > MAX_FRAMES) throw new CliError(`--every ${select.step} gives ${n} frames; at most ${MAX_FRAMES} (use --every ${Math.ceil((D / MAX_FRAMES) * 100) / 100} or more)`, 2);
    wanted = Array.from({ length: n }, (_, k) => k * select.step);
  } else {
    const moves = (p.phone3d?.transitions ?? []).flatMap((m) => [m.start, (m.start + m.end) / 2, m.end]);
    wanted = [...moves, ...tapsToOutput(p.taps, tl).map((t) => t.t)];
    if (!wanted.length) throw new CliError('--moves: this project has no 3D moves and no taps; use --at or --every', 2);
  }
  const unique = [...new Set(wanted.map(ms))].sort((a, b) => a - b);
  if (unique.length > MAX_FRAMES) throw new CliError(`${unique.length} frames requested; at most ${MAX_FRAMES}`, 2);
  return { times: unique.filter((t) => tl.sourceTime(t) !== null), past: unique.filter((t) => tl.sourceTime(t) === null) };
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
  const { times, past } = planFrameTimes(p, a.select);
  const outDir = resolve(a.out ?? defaultFramesDir(dir));
  if (existsSync(outDir) && !statSync(outDir).isDirectory()) throw new CliError(`--out must be a folder: ${outDir} is a file`);
  mkdirSync(outDir, { recursive: true });
  const active = p.phone3d ? phone3dActive(p) : null;
  const started = Date.now();
  let stills: HeadlessFrame[] = [];
  let size: unknown = null;
  let sheet: string | null = null;
  let gpu: unknown = null;
  if (times.length) {
    const app = appCommand(a.app);
    const argvApp = [
      '--export', dir,
      '--frames', times.join(','),
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
  const files = [
    ...stills.map((s) => (s.path ? { t: s.t, path: s.path, ...poseInfo(p, s.t) } : { t: s.t, error: s.error ?? 'not rendered' })),
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
    outputDuration: r2(tl.outputDuration),
    phone3d: active,
    files,
    ...(a.sheet ? { sheet } : {}),
    seconds: r2((Date.now() - started) / 1000),
    gpu,
  };
}
