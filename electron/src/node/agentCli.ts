// openscreen-agent: drive OpenScreen from an agent. Every command prints ONE
// JSON object on stdout (progress, if any, goes to stderr as JSON lines) and
// exits 0 on success, 1 on failure, 2 on bad usage. No prompts, ever.
//
// Entry point: electron/scripts/openscreen-agent.mjs (loads this file from
// electron/dist/node after `npm run build`).

import { spawn, execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { applyOps, audioImports, captionsFromSegments, needsSilences, needsTapAnalysis, needsTranscript, OP_NAMES, OpError, validateProject, type ApplyContext, type EditOp, type TranscriptSegment } from '../shared/agentOps';
import { planPolish, type PolishStyle } from '../shared/polish';
import { defaultProject, fileSafeName, normalizeProject, projectName, unsafeAudioFiles, type Project } from '../shared/types';
import { Timeline } from '../shared/timeline';
import { isPhoneProject, resolveDevice, projectCanvasSize, layoutPreset } from '../shared/mobileProject';
import { getFinish } from '../shared/devices';
import { phone3dActive } from '../shared/phone3d/placement';
import { resolveStarts } from '../shared/phone3d/pose';
import { parseFreezes, parseSilences, silenceDetectArgs } from '../shared/silence';
import { IosHelperClient, createLineSplitter, parseDeviceList } from '../shared/iosCapture';
import { withProbedDuration } from '../shared/recording';
import { randomUUID } from 'node:crypto';
import { itemSpan } from '../shared/audioTracks';
import { phoneDevice, phoneLayerOn } from '../shared/phoneLayer';
import { layerOrder } from '../shared/canvasLayers';
import { importVideoFile } from './importVideo';
import { readCursorSamples } from './bundleFiles';
import { appCommand, bool, CliError, flag, out, progress, r2, runHeadless, seconds, warnProgress } from './cliKit';
import { exportFps, framesCmd } from './framesCmd';
import { DIRECT_STYLES, needsScenes, planDirect, projectWarnings, shotRecipes, type ApplyContext3d, type DirectStyle, type Phone3DWarning as Warning } from './phone3dPlan';
import { sceneTimes } from './scenes';
import { analyzeTapsInFile, bundleAudioPath, detectSilences, ffmpegPath, probeAudioDuration, ffmpegRun, ffmpegStderr, parseWhisperJson, probeMedia, transcribeBundle, whisperCli } from './media';

// ---------------------------------------------------------------------------
// Bundles

export const recordingsRoot = () => process.env.OPENSCREEN_RECORDINGS_DIR || join(homedir(), 'Movies', 'OpenScreen');

function bundlePath(arg: string | undefined): string {
  if (!arg) throw new CliError('missing <bundle> (a rec-*.openscreen folder; `latest` finds the newest)', 2);
  const dir = resolve(arg === 'latest' ? latestBundle()?.bundle ?? '' : arg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new CliError(`not a folder: ${dir}`);
  if (!existsSync(join(dir, 'project.json'))) {
    throw new CliError(existsSync(join(dir, 'screen.mov')) ? `${dir} has no project.json (a take still recording, or interrupted: open it in the app to recover it, or run \`record stop\`)` : `${dir} is not an OpenScreen bundle (no project.json)`);
  }
  return dir;
}

function readProject(dir: string): Project {
  let raw: Project;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  } catch (e) {
    throw new CliError(`project.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!raw?.recording) throw new CliError('project.json has no "recording"');
  return normalizeProject(raw);
}

/** Write project.json atomically, keeping the previous version as project.json.bak. */
function writeProject(dir: string, p: Project) {
  const file = join(dir, 'project.json');
  copyFileSync(file, join(dir, 'project.json.bak'));
  const tmp = join(dir, `.project.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(p, null, 2));
  renameSync(tmp, file);
}

/** Sound files project.json points outside the bundle at; loading drops those items. */
function droppedAudio(dir: string): string[] {
  try {
    return unsafeAudioFiles(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))?.tracks);
  } catch {
    return [];
  }
}
const droppedNote = (files: string[]) => files.map((f) => `audio item dropped: its file "${f}" is outside the bundle`);

function readTranscript(dir: string): TranscriptSegment[] | null {
  const f = join(dir, 'transcript.json');
  if (!existsSync(f)) return null;
  try {
    return parseWhisperJson(JSON.parse(readFileSync(f, 'utf8')));
  } catch {
    return null;
  }
}

/** The phone layer of a Mac + iPhone take, or null for every other recording. */
function phoneSummary(dir: string, p: Project) {
  const r = p.recording;
  if (!r.phoneVideoFile) return null;
  const size = r.phoneSize ?? { width: 0, height: 0 };
  const d = size.width > 0 ? phoneDevice(size, p.phoneOverlay) : null;
  return {
    video: join(dir, r.phoneVideoFile),
    missing: !existsSync(join(dir, r.phoneVideoFile)),
    width: size.width,
    height: size.height,
    duration: r.phoneDuration !== undefined ? r2(r.phoneDuration) : null,
    offset: r.phoneOffset ?? 0,
    model: d?.device.id ?? null,
    orientation: d?.orientation ?? null,
    drawn: phoneLayerOn(p),
    ...p.phoneOverlay,
  };
}

/** The 3D phone settings and whether they draw (the one gate, phone3dActive), or null when the project has no 3D. */
function phone3dSummary(p: Project) {
  const p3 = p.phone3d;
  if (!p3) return null;
  const gate = phone3dActive(p);
  const phone = isPhoneProject(p) ? resolveDevice(p).device : null;
  const finish = phone ? getFinish(phone, p.device.finishId) : null;
  return {
    active: gate.active,
    ...(gate.reason ? { reason: gate.reason } : {}),
    enabled: p3.enabled,
    model: phone?.id ?? null,
    finish: finish ? { id: finish.id, name: finish.name, hex: finish.hex } : null,
    pose: p3.pose,
    camera: p3.camera,
    light: p3.light,
    glass: p3.glass,
    back: p3.back,
    shadow: p3.shadow,
    dof: p3.dof,
    float: p3.float,
    motionBlur: p3.motionBlur,
    supersample: p3.supersample,
  };
}

/** The 3D moves in OUTPUT seconds, each with its resolved Start (a linked Start continues from the pose before it). */
function transitionsSummary(p: Project) {
  const p3 = p.phone3d;
  if (!p3) return [];
  const starts = resolveStarts(p3);
  return p3.transitions.map((m, i) => ({
    index: i,
    id: m.id,
    start: r2(m.start),
    end: r2(m.end),
    duration: r2(m.end - m.start),
    linked: !m.from,
    from: starts[i],
    to: m.to,
    easing: m.easing,
    ...(m.recipe ? { recipe: m.recipe } : {}),
  }));
}

function summarize(dir: string, p: Project) {
  const cursor = readCursorSamples(dir);
  const tl = new Timeline(p.recording.duration, p.clips);
  const transcript = readTranscript(dir);
  const isPhone = p.recording.sourceKind === 'iosDevice';
  let device: unknown = undefined;
  if (isPhone) {
    const d = resolveDevice(p);
    device = { model: d.device.id, name: d.device.name, orientation: d.orientation, frame: p.device.frame, finishId: p.device.finishId ?? null };
  }
  const canvas = projectCanvasSize(p);
  return {
    bundle: dir,
    video: join(dir, p.recording.screenVideoFile),
    source: { kind: p.recording.sourceKind, width: p.recording.sourceSize.width, height: p.recording.sourceSize.height, duration: r2(p.recording.duration) },
    outputDuration: r2(tl.outputDuration),
    canvas: { ...canvas, layoutPreset: layoutPreset(p)?.id ?? 'none' },
    device,
    clips: p.clips.map((c, i) => {
      let outStart = 0;
      for (let j = 0; j < i; j++) outStart += (p.clips[j].sourceEnd - p.clips[j].sourceStart) / p.clips[j].speed;
      return { index: i, id: c.id, sourceStart: r2(c.sourceStart), sourceEnd: r2(c.sourceEnd), speed: c.speed, outputStart: r2(outStart), outputEnd: r2(outStart + (c.sourceEnd - c.sourceStart) / c.speed) };
    }),
    captions: p.captions.map((c, i) => ({ index: i, id: c.id, start: r2(c.start), end: r2(c.end), text: c.text, words: c.words?.length ?? 0 })),
    transcript: transcript
      ? { segments: transcript.length, items: transcript.slice(0, 200).map((s) => ({ start: r2(s.start), end: r2(s.end), text: s.text })) }
      : null,
    chapters: p.chapters,
    annotations: p.annotations,
    manualZooms: p.manualZooms.map((z, i) => ({ index: i, at: r2(z.inStart), holdEnd: r2(z.holdEnd), center: z.center, scale: z.scale })),
    zoom: { autofocus: p.zoom.autofocus, dwell: p.zoom.dwell, depth: p.zoom.depth, fromTaps: p.zoom.fromTaps },
    taps: { count: p.taps.length, analyzed: p.tapsAnalyzed, items: p.taps.slice(0, 100).map((t, i) => ({ index: i, id: t.id, t: r2(t.t), x: r2(t.x), y: r2(t.y), kind: t.kind, confidence: r2(t.confidence) })) },
    tapStyle: p.tapStyle,
    waits: p.waits.map((w) => ({ start: r2(w.start), end: r2(w.end), ...(w.edge ? { edge: w.edge } : {}) })),
    style: p.style,
    layout: p.layout,
    // The recording moved/resized by hand (the `content` op); null = where the layout fits it.
    content: p.style.contentTransform ?? null,
    // Canvas layers bottom to top (the `layer` op restacks them).
    layers: layerOrder(p),
    cameraOverlay: p.cameraOverlay,
    phone: phoneSummary(dir, p),
    audio: p.audio,
    tracks: p.tracks.map((t, ti) => ({
      index: ti,
      id: t.id,
      kind: t.kind,
      name: t.name,
      muted: t.muted,
      volume: r2(t.volume),
      duck: t.duck,
      items: t.items.map((i, ii) => {
        const span = itemSpan(i, tl.outputDuration);
        return {
          index: ii,
          id: i.id,
          name: i.name,
          file: i.file,
          start: r2(i.start),
          end: r2(Math.max(span.start, span.end)),
          sourceIn: r2(i.sourceIn),
          sourceOut: r2(i.sourceOut),
          fileDuration: r2(i.fileDuration),
          volume: r2(i.gain),
          fadeIn: r2(i.fadeIn),
          fadeOut: r2(i.fadeOut),
          loop: i.loop,
          missing: !existsSync(join(dir, i.file)),
        };
      }),
    })),
    // The canvas the export renders at: a layout preset at the export resolution (D18), else the classic size.
    // fps: the rate the export writes (a layout preset's own, else outputFPS), as Editor.exportVideo and frames use it.
    export: { preset: p.exportPreset, fps: exportFps(p), canvas: { w: canvas.width, h: canvas.height } },
    phone3d: phone3dSummary(p),
    transitions: transitionsSummary(p),
    shotRecipes: shotRecipes(),
    problems: [...validateProject(p), ...droppedNote(droppedAudio(dir))],
    warnings: projectWarnings(p, { cursor }),
  };
}

// ---------------------------------------------------------------------------
// latest

function listBundles(root = recordingsRoot()) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith('.openscreen'))
    .map((e) => {
      const dir = join(root, e.name);
      const ts = Number(e.name.match(/rec-(\d+)/)?.[1]);
      const created = Number.isFinite(ts) ? ts : statSync(dir).birthtimeMs;
      return { dir, created, hasProject: existsSync(join(dir, 'project.json')) };
    })
    .sort((a, b) => b.created - a.created);
}

function latestBundle(): { bundle: string; created: string; hasProject: boolean; recording: boolean } | null {
  const rec = readRecordState();
  const all = listBundles();
  const b = all.find((x) => x.hasProject) ?? all[0];
  if (!b) return null;
  return { bundle: b.dir, created: new Date(b.created).toISOString(), hasProject: b.hasProject, recording: !!rec && rec.state === 'recording' && rec.bundle === b.dir };
}

// ---------------------------------------------------------------------------
// review

const FONT_CANDIDATES = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf'];

async function review(args: string[]) {
  const every0 = flag(args, '--every');
  const outFlag = flag(args, '--out');
  const maxSheets = Number(flag(args, '--max-sheets') ?? 10);
  const transcribe = bool(args, '--transcribe');
  const noTaps = bool(args, '--no-taps');
  const target = args.shift();
  if (!target) throw new CliError('usage: review <bundle|video.mp4> [--every 2s] [--out dir] [--transcribe]', 2);
  const abs = resolve(target === 'latest' ? latestBundle()?.bundle ?? '' : target);
  const isVideo = existsSync(abs) && statSync(abs).isFile();
  let dir: string | null = null;
  let project: Project | null = null;
  let video: string;
  if (isVideo) video = abs;
  else {
    dir = bundlePath(abs);
    project = readProject(dir);
    video = join(dir, project.recording.screenVideoFile);
  }
  if (!existsSync(video)) throw new CliError(`missing video: ${video}`);
  const bin = ffmpegPath();
  const media = await probeMedia(video, bin);
  const duration = media.duration ?? project?.recording.duration ?? 0;
  if (!(duration > 0) || !media.width || !media.height) throw new CliError(`cannot read the video (${video})`);
  const portrait = media.height > media.width;
  const cols = portrait ? 6 : 4;
  const rows = portrait ? 2 : 3;
  const per = cols * rows;
  let every = every0 ? seconds(every0) : 2;
  // Keep it small for an LLM: at most maxSheets sheets.
  const maxFrames = Math.max(1, maxSheets) * per;
  if (duration / every > maxFrames) every = Math.ceil((duration / maxFrames) * 10) / 10;
  const outDir = resolve(outFlag ?? (dir ? join(dir, 'review') : `${video.replace(/\.[^.]+$/, '')}.review`));
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const tileH = portrait ? 420 : 240;
  const font = FONT_CANDIDATES.find((f) => existsSync(f));
  const label = font
    ? `,drawtext=fontfile='${font}':text='%{pts\\:hms}':x=6:y=6:fontsize=${Math.round(tileH / 14)}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=4`
    : '';
  progress({ step: 'contact sheets', every });
  await ffmpegRun(['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-an', '-vf', `fps=1/${every},scale=-2:${tileH}${label},tile=${cols}x${rows}:padding=4:margin=4:color=0x202020`, '-vsync', 'vfr', join(outDir, 'sheet-%02d.png')], bin);
  const frames = Math.floor(duration / every) + 1;
  const sheets = readdirSync(outDir).filter((f) => /^sheet-\d+\.png$/.test(f)).sort().map((f, i) => {
    const first = i * per;
    const times = Array.from({ length: Math.min(per, frames - first) }, (_, k) => r2((first + k) * every)).filter((t) => t <= duration);
    return { path: join(outDir, f), grid: `${cols}x${rows}`, order: 'left-to-right, top-to-bottom', times };
  });

  // Scene keyframes: frames where the picture changes a lot.
  progress({ step: 'scene keyframes' });
  // The same detection `direct` and the editor's Auto 3D use (scenes.ts); a
  // bundle's times are cached in analysis/scenes.json for them.
  const changes = await sceneTimes(video, { bundle: dir, bin, keyframes: { dir: outDir, height: portrait ? 640 : 360 } });
  let scenes = readdirSync(outDir).filter((f) => /^scene-\d+\.jpg$/.test(f)).sort().map((f, i) => ({ path: join(outDir, f), time: r2(changes[i] ?? NaN) }));
  // Keep ~12 spread evenly; delete the rest.
  if (scenes.length > 12) {
    const keep = new Set(Array.from({ length: 12 }, (_, i) => Math.round((i * (scenes.length - 1)) / 11)));
    scenes.forEach((s, i) => !keep.has(i) && rmSync(s.path, { force: true }));
    scenes = scenes.filter((_, i) => keep.has(i));
  }

  // Still stretches and silence.
  progress({ step: 'stills and silence' });
  const frz = await ffmpegStderr(['-hide_banner', '-i', video, '-an', '-vf', 'scale=180:-2,freezedetect=n=0.003:d=1.5', '-f', 'null', '-'], bin);
  const stills = parseFreezes(frz, duration).map((r) => ({ start: r2(r.start), end: r2(r.end) }));
  let silences: { start: number; end: number }[] = [];
  if (media.hasAudio) {
    const se = await ffmpegStderr(silenceDetectArgs(video), bin);
    silences = parseSilences(se, duration).map((r) => ({ start: r2(r.start), end: r2(r.end) }));
  }

  // Taps/waits: the editor's own analysis (phone bundles).
  let taps: unknown = null;
  let waits: unknown = null;
  const phone = project?.recording.sourceKind === 'iosDevice';
  if (phone && !noTaps) {
    progress({ step: 'tap analysis' });
    try {
      const found = project!.tapsAnalyzed && project!.taps.length ? { taps: project!.taps, deadTime: project!.waits } : await analyzeTapsInFile(video, bin);
      taps = found.taps.map((t) => ({ t: r2(t.t), x: r2(t.x), y: r2(t.y), kind: t.kind, confidence: r2(t.confidence) }));
      waits = found.deadTime.map((w) => ({ start: r2(w.start), end: r2(w.end), ...(w.edge ? { edge: w.edge } : {}) }));
    } catch (e) {
      taps = { error: (e as Error).message };
    }
  }

  let transcript: unknown = null;
  if (dir) {
    let segs = readTranscript(dir);
    if (!segs && transcribe) {
      progress({ step: 'transcribing' });
      segs = await transcribeBundle(dir, project!.recording.screenVideoFile, bin);
    }
    transcript = segs
      ? segs.map((s) => ({ start: r2(s.start), end: r2(s.end), text: s.text }))
      : { available: false, hint: whisperCli() ? 'run review --transcribe to create transcript.json' : 'install whisper-cpp (brew install whisper-cpp) to transcribe' };
  }

  const reviewJson = {
    source: isVideo ? 'video' : 'bundle',
    video,
    bundle: dir,
    duration: r2(duration),
    width: media.width,
    height: media.height,
    orientation: portrait ? 'portrait' : 'landscape',
    codec: media.videoCodec,
    hasAudio: media.hasAudio,
    device: project && phone ? (() => { const d = resolveDevice(project); return { model: d.device.id, name: d.device.name, orientation: d.orientation }; })() : null,
    outputDuration: project ? r2(new Timeline(project.recording.duration, project.clips).outputDuration) : r2(duration),
    sheetInterval: every,
    sheets,
    scenes,
    stills,
    silences,
    taps,
    waits,
    transcript,
    note: isVideo ? 'times are seconds in this video' : 'times are SOURCE seconds (the raw recording); captions/zooms/chapters in edits use OUTPUT seconds',
  };
  writeFileSync(join(outDir, 'review.json'), JSON.stringify(reviewJson, null, 2));
  return { ok: true, reviewJson: join(outDir, 'review.json'), ...reviewJson };
}

// ---------------------------------------------------------------------------
// apply / polish / undo

/** Sound files addAudio will copy into the bundle: bundle-relative target → source path. */
const audioCopies = new Map<string, string>();

async function buildContext(dir: string, p: Project, ops: EditOp[], editsDir: string, cursor = readCursorSamples(dir), dryRun = false): Promise<ApplyContext3d> {
  // The bundle's cursor samples (D5): `direct` plans with the same zooms the editor shows.
  const ctx: ApplyContext3d = { files: {}, audioFiles: {}, cursor };
  const bin = ffmpegPath();
  if (needsScenes(ops)) {
    progress({ step: 'scene changes' });
    ctx.scenes = await sceneTimes(join(dir, p.recording.screenVideoFile), { bundle: dir, bin, writeCache: !dryRun });
  }
  if (needsSilences(ops)) {
    const o = ops.find((x) => x.op === 'cutSilences' || x.op === 'smartCut')!;
    progress({ step: 'silencedetect' });
    ctx.silences = await detectSilences(dir, p.recording.screenVideoFile, { thresholdDb: o.thresholdDb as number | undefined, minDur: o.minDur as number | undefined }, bin);
  }
  if (needsTapAnalysis(ops)) {
    progress({ step: 'tap analysis' });
    ctx.tapAnalysis = await analyzeTapsInFile(join(dir, p.recording.screenVideoFile), bin);
  }
  if (needsTranscript(ops)) {
    ctx.transcript = readTranscript(dir) ?? undefined;
    if (!ctx.transcript && ops.some((o) => o.op === 'captionsFromTranscript' && o.transcribe === true)) {
      progress({ step: 'transcribing' });
      ctx.transcript = await transcribeBundle(dir, p.recording.screenVideoFile, bin);
    }
  }
  // addAudio: measure each sound file now; apply() copies it into the bundle
  // only once every op has succeeded, so a failed apply leaves no stray file.
  for (const src of audioImports(ops)) {
    const f = isAbsolute(src) ? src : resolve(editsDir, src);
    if (!existsSync(f)) throw new CliError(`addAudio: file not found: ${f}`);
    const duration = await probeAudioDuration(f, bin);
    if (!duration) throw new CliError(`addAudio: ${f} has no sound OpenScreen can play`);
    const file = bundleAudioPath(randomUUID(), f);
    ctx.audioFiles![src] = { file, name: basename(f, extname(f)), duration };
    audioCopies.set(file, f);
  }
  for (const o of ops) {
    if (o.op === 'importCaptions' && typeof o.file === 'string') {
      const f = isAbsolute(o.file) ? o.file : resolve(editsDir, o.file);
      if (!existsSync(f)) throw new CliError(`importCaptions: file not found: ${f}`);
      ctx.files![o.file] = readFileSync(f, 'utf8');
    }
  }
  return ctx;
}

function readEdits(arg: string | undefined): { ops: EditOp[]; baseDir: string } {
  if (!arg) throw new CliError('missing <edits.json> (a file, "-" for stdin, or inline JSON)', 2);
  let text: string;
  let baseDir = process.cwd();
  if (arg === '-') text = readFileSync(0, 'utf8');
  else if (arg.trim().startsWith('[') || arg.trim().startsWith('{')) text = arg;
  else {
    const f = resolve(arg);
    if (!existsSync(f)) throw new CliError(`edits file not found: ${f}`);
    text = readFileSync(f, 'utf8');
    baseDir = dirname(f);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new CliError(`edits are not valid JSON: ${(e as Error).message}`);
  }
  const ops = Array.isArray(parsed) ? parsed : (parsed as { ops?: unknown })?.ops;
  if (!Array.isArray(ops)) throw new CliError('edits must be a JSON array of ops, or {"ops":[...]}');
  return { ops: ops as EditOp[], baseDir };
}

async function apply(args: string[]) {
  const dry = bool(args, '--dry-run');
  const dir = bundlePath(args.shift());
  const { ops, baseDir } = readEdits(args.shift());
  const p = readProject(dir);
  const cursor = readCursorSamples(dir);
  const ctx = await buildContext(dir, p, ops, baseDir, cursor, dry);
  let result;
  try {
    result = applyOps(p, ops, ctx);
  } catch (e) {
    if (e instanceof OpError) throw new CliError(e.message);
    throw e;
  }
  if (!dry) {
    // Only the sounds the edited project still uses (a later op may have removed one).
    const used = new Set(result.project.tracks.flatMap((t) => t.items.map((i) => i.file)));
    for (const [file, src] of audioCopies) {
      if (!used.has(file)) continue;
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      copyFileSync(src, join(dir, file));
    }
    writeProject(dir, result.project);
  }
  const tl = new Timeline(result.project.recording.duration, result.project.clips);
  return { ok: true, bundle: dir, dryRun: dry, applied: result.notes.length, changes: result.notes, warnings: projectWarnings(result.project, { cursor }), outputDuration: r2(tl.outputDuration), backup: dry ? null : join(dir, 'project.json.bak') };
}

async function polish(args: string[]) {
  const style = (flag(args, '--style') ?? 'clean') as PolishStyle;
  if (style !== 'clean' && style !== 'bold') throw new CliError('--style must be clean or bold', 2);
  const reanalyze = bool(args, '--reanalyze');
  const dry = bool(args, '--dry-run');
  const title = flag(args, '--title');
  const subtitle = flag(args, '--subtitle');
  const dir = bundlePath(args.shift());
  const p = readProject(dir);
  const ctx: ApplyContext = {};
  const phone = p.recording.sourceKind === 'iosDevice';
  if (phone && (reanalyze || !p.tapsAnalyzed)) {
    progress({ step: 'tap analysis' });
    ctx.tapAnalysis = await analyzeTapsInFile(join(dir, p.recording.screenVideoFile));
  }
  ctx.transcript = readTranscript(dir) ?? undefined;
  const ops = planPolish(p, { style, analyzed: !!ctx.tapAnalysis, transcript: !!ctx.transcript, title, subtitle });
  let result;
  try {
    result = applyOps(p, ops, ctx);
  } catch (e) {
    if (e instanceof OpError) throw new CliError(e.message);
    throw e;
  }
  if (!dry) writeProject(dir, result.project);
  const before = new Timeline(p.recording.duration, p.clips).outputDuration;
  const after = new Timeline(result.project.recording.duration, result.project.clips).outputDuration;
  return { ok: true, bundle: dir, style, dryRun: dry, ops, changes: result.notes, warnings: projectWarnings(result.project, { cursor: readCursorSamples(dir) }), outputDuration: { before: r2(before), after: r2(after) }, backup: dry ? null : join(dir, 'project.json.bak') };
}

/** `direct`'s flags, 1:1 with the `direct` op and the editor's Auto 3D options. */
export function parseDirectArgs(argv: string[]): { bundle: string | undefined; style: DirectStyle; replace: boolean; scenes: boolean; dryRun: boolean } {
  const args = [...argv];
  const style = (flag(args, '--style') ?? 'hero') as DirectStyle;
  if (!DIRECT_STYLES.includes(style)) throw new CliError(`--style must be ${DIRECT_STYLES.join(', ')}`, 2);
  const keep = bool(args, '--keep');
  const noScenes = bool(args, '--no-scenes');
  const dryRun = bool(args, '--dry-run');
  const bundle = args.shift();
  const extra = args.find((a) => a.startsWith('--')) ?? args[0];
  if (extra !== undefined) throw new CliError(`direct: unexpected "${extra}". usage: direct <bundle> [--style subtle|hero|bold] [--keep] [--no-scenes] [--dry-run]`, 2);
  return { bundle, style, replace: !keep, scenes: !noScenes, dryRun };
}

/**
 * `direct`: plan 3D shots around the taps, waits, zooms and scene changes
 * (planDirect, the same plan the editor's Auto 3D makes) and apply them.
 * Like polish: reads the project, runs tap analysis the first time, then
 * scene changes (unless --no-scenes) and cursor.json, plans, applies, writes.
 */
async function direct(argv: string[]) {
  const a = parseDirectArgs(argv);
  const dir = bundlePath(a.bundle);
  let p = readProject(dir);
  if (!isPhoneProject(p)) throw new CliError('3D phone needs an iPhone recording');
  const ctx: ApplyContext3d = { cursor: readCursorSamples(dir) };
  const run = (proj: Project, list: EditOp[]) => {
    try {
      return applyOps(proj, list, ctx);
    } catch (e) {
      if (e instanceof OpError) throw new CliError(e.message);
      throw e;
    }
  };
  const ops: EditOp[] = [];
  const notes: string[] = [];
  if (!p.tapsAnalyzed) {
    // The planner keeps the phone facing front at every tap, so it needs them.
    progress({ step: 'tap analysis' });
    ctx.tapAnalysis = await analyzeTapsInFile(join(dir, p.recording.screenVideoFile));
    ops.push({ op: 'analyzeTaps' });
    const analyzed = run(p, ops);
    p = analyzed.project;
    notes.push(...analyzed.notes);
  }
  if (a.scenes) {
    progress({ step: 'scene changes' });
    ctx.scenes = await sceneTimes(join(dir, p.recording.screenVideoFile), { bundle: dir, writeCache: !a.dryRun });
  }
  const plan = planDirect(p, { style: a.style, replace: a.replace, cursor: ctx.cursor, ...(a.scenes ? { scenes: ctx.scenes } : {}) });
  ops.push(...plan.ops);
  const planned = run(p, plan.ops);
  notes.push(...planned.notes);
  const result = { project: planned.project, notes };
  if (!a.dryRun) writeProject(dir, result.project);
  const tl = new Timeline(result.project.recording.duration, result.project.clips);
  return {
    ok: true,
    bundle: dir,
    dryRun: a.dryRun,
    style: a.style,
    shots: plan.shots.map((x) => ({ recipe: x.recipe, start: r2(x.start), end: r2(x.end), reason: x.reason })),
    // Present when no moving shot fits: why, and what the phone does instead.
    ...(plan.note ? { note: plan.note } : {}),
    ops,
    changes: result.notes,
    warnings: projectWarnings(result.project, { cursor: ctx.cursor }),
    outputDuration: r2(tl.outputDuration),
    backup: a.dryRun ? null : join(dir, 'project.json.bak'),
  };
}

function undo(args: string[]) {
  const dir = bundlePath(args.shift());
  const bak = join(dir, 'project.json.bak');
  if (!existsSync(bak)) throw new CliError('nothing to undo (no project.json.bak)');
  const cur = join(dir, 'project.json');
  const tmp = join(dir, `.undo.${process.pid}.tmp`);
  // Swap, so a second undo redoes.
  renameSync(cur, tmp);
  renameSync(bak, cur);
  renameSync(tmp, bak);
  return { ok: true, bundle: dir, restored: cur, previousNowIn: bak };
}

// ---------------------------------------------------------------------------
// export (spawns the app headless)

/** Warnings that refuse an export: a tap the viewer cannot read (the phone turned away or showing its back). */
export const EXPORT_BLOCKING: readonly string[] = ['tap-angle', 'tap-back'];

/**
 * The export guard: throws (exit 1) when a tap would not be readable, unless
 * `force`. Look round 2 shipped an export with both tap warnings standing;
 * every other warning still only goes to stderr. The error carries the
 * blocking warnings with their fixes, ready for `apply`.
 */
export function exportGuard(warnings: readonly Warning[], force: boolean): void {
  const blocking = warnings.filter((w) => EXPORT_BLOCKING.includes(w.code));
  if (!blocking.length || force) return;
  throw Object.assign(
    new CliError(
      `export refused: ${blocking.map((w) => w.message).join('; ')}. Apply each warning's fix (apply <bundle> '<fix>'), move the shot or the trim, or pass --force to export anyway`,
    ),
    { extra: { warnings: blocking } },
  );
}

async function exportCmd(args: string[]) {
  const force = bool(args, '--force');
  const outArg = flag(args, '--out');
  const presets = flag(args, '--preset');
  const appFlag = flag(args, '--app');
  const timeout = flag(args, '--timeout');
  const gif = bool(args, '--gif');
  const dir = bundlePath(args.shift());
  let outPath = outArg ? resolve(outArg) : undefined;
  if (!outPath) {
    const name = fileSafeName(projectName(readProject(dir), dir));
    outPath = presets ? join(dirname(dir), `${name}-export`) : join(dirname(dir), `${name}.${gif ? 'gif' : 'mp4'}`);
  }
  if (gif && extname(outPath).toLowerCase() !== '.gif') outPath = outPath.replace(/\.[^./]*$/, '') + '.gif';
  if (presets) mkdirSync(outPath, { recursive: true });
  const project = readProject(dir);
  const errs = validateProject(project);
  if (errs.length) throw new CliError(`project is invalid, fix it before exporting: ${errs.join('; ')}`);
  // Warnings go to stderr with the progress lines; an unreadable tap refuses the export (exportGuard).
  const warnings = projectWarnings(project, { cursor: readCursorSamples(dir) });
  exportGuard(warnings, force);
  warnProgress(warnings);
  const app = appCommand(appFlag);
  const argv = ['--export', dir, '--out', outPath, ...(gif ? ['--gif'] : []), ...(presets ? ['--preset', presets] : []), ...(timeout ? ['--timeout', timeout] : [])];
  const started = Date.now();
  const result = await runHeadless(app, argv);
  if (!result.ok) throw Object.assign(new CliError(String(result.error ?? 'export failed')), { extra: result });
  const primary = String(result.out ?? outPath);
  let probe: unknown = null;
  const file = existsSync(primary) && statSync(primary).isFile() ? primary : (result.files as string[] | undefined)?.find((f) => /\.(mp4|mov|gif|webm)$/.test(f));
  if (file && existsSync(file)) {
    const m = await probeMedia(file);
    probe = { file, duration: m.duration, width: m.width, height: m.height, fps: m.fps, codec: m.videoCodec, hasAudio: m.hasAudio, bytes: statSync(file).size };
  }
  return { ...result, app: app.kind === 'dev' ? 'dev electron (this checkout)' : app.cmd, wallSeconds: r2((Date.now() - started) / 1000), probe };
}

/** Open a bundle in the editor for a human (a new app window, detached). */
function openCmd(args: string[]) {
  const appFlag = flag(args, '--app');
  const dir = bundlePath(args.shift());
  const app = appCommand(appFlag);
  const child = spawn(app.cmd, [...app.pre, '--open', dir], { detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true, bundle: dir, pid: child.pid, note: 'the editor reloads project.json by itself when you apply more edits' };
}

// ---------------------------------------------------------------------------
// devices / record

function helperPath(): string {
  const cands = [
    process.env.OPENSCREEN_IOS_HELPER,
    join(__dirname, '..', 'native', 'ios-capture'),
    process.env.OPENSCREEN_APP ? join(resolve(process.env.OPENSCREEN_APP), 'Contents', 'Resources', 'native', 'ios-capture') : undefined,
    '/Applications/OpenScreen.app/Contents/Resources/native/ios-capture',
    join(homedir(), 'Applications', 'OpenScreen.app', 'Contents', 'Resources', 'native', 'ios-capture'),
  ].filter((x): x is string => !!x);
  const found = cands.find((c) => existsSync(c));
  if (!found) throw new CliError(`iPhone capture helper not found (looked in: ${cands.join(', ')}). Run npm run build:helper.`);
  return found;
}

async function devices(args: string[]) {
  const wait = Number(flag(args, '--wait') ?? 4000);
  const helper = helperPath();
  const stdout = await new Promise<string>((res, rej) =>
    execFile(helper, ['list', '--wait', String(wait)], { timeout: wait + 15000 }, (e, so, se) => (e && !so ? rej(new CliError(`helper failed: ${String(se || e.message).trim()}`)) : res(String(so)))),
  );
  const list = parseDeviceList(stdout);
  return { ok: true, helper, count: list.length, devices: list, ...(list.length ? {} : { hint: 'No iPhone/iPad found. Plug it in with a cable, unlock it, and tap Trust.' }) };
}

const stateFile = () => join(process.env.OPENSCREEN_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'OpenScreen'), 'agent-recording.json');

interface RecordState {
  state: 'starting' | 'recording' | 'stopping' | 'finished' | 'failed';
  pid: number;
  bundle: string;
  deviceId: string;
  deviceName?: string;
  startedAt?: string;
  width?: number;
  height?: number;
  error?: string;
  finishedAt?: string;
  duration?: number;
}

function readRecordState(): RecordState | null {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    return null;
  }
}
function writeRecordState(s: RecordState) {
  mkdirSync(dirname(stateFile()), { recursive: true });
  const tmp = stateFile() + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, stateFile());
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function recordStart(args: string[]) {
  const deviceArg = flag(args, '--device');
  if (bool(args, '--mic')) throw new CliError('--mic is not supported for agent recordings yet: the helper records the phone\'s own audio only');
  const cur = readRecordState();
  if (cur && (cur.state === 'recording' || cur.state === 'starting' || cur.state === 'stopping') && alive(cur.pid)) {
    throw new CliError(`a recording is already running (${cur.bundle}); run \`record stop\` first`);
  }
  const d = await devices([]);
  if (!d.devices.length) throw new CliError('No iPhone/iPad is connected. Plug it in with a cable, unlock it, and tap Trust.');
  const dev = deviceArg ? d.devices.find((x) => x.id === deviceArg || x.name === deviceArg) : d.devices[0];
  if (!dev) throw new CliError(`device ${deviceArg} not found; connected: ${d.devices.map((x) => `${x.name} (${x.id})`).join(', ')}`);
  const bundle = join(recordingsRoot(), `rec-${Date.now()}.openscreen`);
  mkdirSync(bundle, { recursive: true });
  const log = openSync(join(bundle, 'agent-record.log'), 'a');
  const child = spawn(process.execPath, [process.argv[1], 'record', '__daemon', bundle, dev.id, dev.name], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE },
  });
  child.unref();
  writeRecordState({ state: 'starting', pid: child.pid!, bundle, deviceId: dev.id, deviceName: dev.name });
  // Wait for the first frame (or failure).
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(250);
    const s = readRecordState();
    if (s?.state === 'recording') return { ok: true, ...s, stateFile: stateFile() };
    if (s?.state === 'failed') throw new CliError(`recording failed to start: ${s.error}`);
    if (!alive(child.pid!)) throw new CliError(`recorder exited before starting; see ${join(bundle, 'agent-record.log')}`);
  }
  throw new CliError('the device did not start sending video within 30s. Unlock it and try again.');
}

/** The detached recorder: owns the helper (the same `serve` protocol the app uses) until SIGTERM. */
async function recordDaemon(args: string[]) {
  const [bundle, deviceId, deviceName] = args;
  const helper = helperPath();
  const proc = spawn(helper, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const base: RecordState = { state: 'starting', pid: process.pid, bundle, deviceId, deviceName };
  const client = new IosHelperClient({
    write: (line) => proc.stdin.writable && proc.stdin.write(line + '\n'),
    kill: () => proc.kill('SIGKILL'),
    onEnded: (ended) => void finish('ok' in ended ? null : ended.err, 'ok' in ended ? ended.ok : undefined),
  });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', createLineSplitter((l) => client.handleLine(l)));
  proc.stderr.on('data', (d) => process.stderr.write(d));
  proc.on('exit', (code, sig) => client.handleExit(`helper exited (${sig ?? code})`));
  const mov = join(bundle, 'screen.mov');
  let startedAtMs = 0;
  let size = { width: 0, height: 0 };
  let finishing = false;
  const finish = async (err: string | null, done?: { width?: number; height?: number; duration?: number }) => {
    if (finishing) return;
    finishing = true;
    try {
      if (err && !existsSync(mov)) throw new Error(err);
      const m = await probeMedia(mov);
      if (!m.duration || !m.width || !m.height) throw new Error(err ?? 'the recording did not produce a playable screen.mov');
      let project = defaultProject({
        screenVideoFile: 'screen.mov',
        sourceKind: 'iosDevice',
        sourceSize: { width: done?.width ?? m.width ?? size.width, height: done?.height ?? m.height ?? size.height },
        duration: done?.duration ?? m.duration ?? (Date.now() - startedAtMs) / 1000,
      });
      project = withProbedDuration(project, m.duration);
      writeFileSync(join(bundle, 'cursor.json'), JSON.stringify({ samples: [] }, null, 2));
      writeFileSync(join(bundle, 'keystrokes.json'), JSON.stringify({ keys: [] }, null, 2));
      writeFileSync(join(bundle, 'project.json'), JSON.stringify(project, null, 2));
      writeRecordState({ ...base, state: 'finished', startedAt: new Date(startedAtMs).toISOString(), finishedAt: new Date().toISOString(), duration: m.duration, width: m.width, height: m.height, ...(err ? { error: `ended early: ${err}` } : {}) });
    } catch (e) {
      writeRecordState({ ...base, state: 'failed', error: (e as Error).message });
    }
    proc.kill('SIGTERM');
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', () => {
    writeRecordState({ ...base, state: 'stopping', startedAt: new Date(startedAtMs).toISOString() });
    client.stop().then((done) => finish(null, done), (e) => finish((e as Error).message));
  });
  process.on('SIGINT', () => process.emit('SIGTERM' as NodeJS.Signals));
  // Wait for the helper's first device list, then record.
  const readyBy = Date.now() + 15000;
  while (!client.ready && Date.now() < readyBy) await sleep(200);
  try {
    const st = await client.start(deviceId, mov);
    size = st;
    startedAtMs = Date.now();
    writeRecordState({ ...base, state: 'recording', startedAt: new Date(startedAtMs).toISOString(), width: st.width, height: st.height });
  } catch (e) {
    writeRecordState({ ...base, state: 'failed', error: (e as Error).message });
    proc.kill('SIGTERM');
    rmSync(mov, { force: true });
    process.exit(1);
  }
  await new Promise(() => {}); // until SIGTERM
}

async function recordStop() {
  const s = readRecordState();
  if (!s || !['recording', 'starting', 'stopping'].includes(s.state)) throw new CliError('no agent recording is running');
  if (!alive(s.pid)) throw new CliError(`the recorder (pid ${s.pid}) is gone; its take may be recoverable by opening ${s.bundle} in the app`);
  process.kill(s.pid, 'SIGTERM');
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    await sleep(300);
    const n = readRecordState();
    if (n?.state === 'finished') return { ok: true, ...n, next: `openscreen-agent review ${n.bundle}` };
    if (n?.state === 'failed') throw new CliError(`recording failed: ${n.error}`);
  }
  throw new CliError('the recording did not finish writing within 40s');
}

function recordStatus() {
  const s = readRecordState();
  if (!s) return { ok: true, state: 'idle' };
  const running = ['recording', 'starting', 'stopping'].includes(s.state);
  return { ok: true, ...s, ...(running && !alive(s.pid) ? { state: 'dead', error: 'the recorder process is gone' } : {}), ...(s.startedAt && s.state === 'recording' ? { elapsed: r2((Date.now() - Date.parse(s.startedAt)) / 1000) } : {}) };
}

/** `import <file> [--name N]`: the same import as the app's Import Video…. */
async function importCmd(args: string[]) {
  const name = flag(args, '--name');
  const file = args.shift();
  if (!file) throw new CliError('usage: import <video file> [--name N]', 2);
  const r = await importVideoFile(resolve(file), { root: recordingsRoot(), name, onProgress: (p) => progress({ stage: p.stage, progress: r2(p.fraction) }) });
  const rec = r.project.recording;
  return {
    ok: true,
    bundle: r.dir,
    name: r.project.name,
    sourceKind: rec.sourceKind,
    size: rec.sourceSize,
    duration: r2(rec.duration),
    video: rec.screenVideoFile,
    converted: r.conversion,
    hasAudio: r.hasAudio,
    next: `openscreen-agent review "${r.dir}"`,
  };
}

// ---------------------------------------------------------------------------

const HELP = {
  usage: 'openscreen-agent <command> [args]  (every command prints one JSON object on stdout)',
  commands: {
    devices: 'devices [--wait ms]  list connected iPhones/iPads',
    'record start': 'record start [--device id|name]  start an iPhone recording into a new bundle (detached)',
    'record stop': 'record stop  finish it and write project.json',
    'record status': 'record status',
    import: 'import <video file> [--name N]  copy (or convert) a video into a new bundle, as File > Import Video… does',
    latest: 'latest  newest bundle in the recordings folder',
    list: 'list  all bundles, newest first',
    info: 'info <bundle>  project summary: clips, captions, transcript, style, taps…',
    validate: 'validate <bundle>  problems (exit 1) and warnings (never fail)',
    review: 'review <bundle|video.mp4> [--every 2s] [--out dir] [--transcribe] [--max-sheets 10]  contact sheets + review.json',
    apply: 'apply <bundle> <edits.json|-|inline-json> [--dry-run]',
    polish: 'polish <bundle> [--style clean|bold] [--title T] [--subtitle S] [--reanalyze] [--dry-run]',
    direct: 'direct <bundle> [--style subtle|hero|bold] [--keep] [--no-scenes] [--dry-run]  plan and apply 3D phone shots around taps, waits and scene changes (the editor\'s Auto 3D)',
    frames: 'frames <bundle> (--at 0.5,2 | --every 0.5 | --moves) [--out dir] [--scale 0.5] [--sheet] [--draft] [--timeout s]  render still PNGs at output seconds with the real app, each the export frame round(t·fps) (default: <tmp>/openscreen-frames/…)',
    undo: 'undo <bundle>  swap project.json with project.json.bak',
    export: 'export <bundle> [--out file.mp4|.gif|folder] [--gif] [--preset id,id] [--app OpenScreen.app] [--timeout s] [--force]  refuses while a tap is unreadable (tap-angle, tap-back warnings) unless --force',
    open: 'open <bundle> [--app OpenScreen.app]  open it in the editor for a human (a new app process)',
    ops: 'ops  list edit op names',
  },
  bundle: '<bundle> is a rec-*.openscreen folder path, or the word "latest"',
};

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const cmd = args.shift();
  try {
    let result: unknown;
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        result = { ok: true, ...HELP };
        break;
      case 'ops':
        result = { ok: true, ops: OP_NAMES };
        break;
      case 'latest': {
        const l = latestBundle();
        if (!l) throw new CliError(`no recordings in ${recordingsRoot()}`);
        result = { ok: true, root: recordingsRoot(), ...l };
        break;
      }
      case 'list':
        result = { ok: true, root: recordingsRoot(), bundles: listBundles().map((b) => ({ bundle: b.dir, created: new Date(b.created).toISOString(), hasProject: b.hasProject })) };
        break;
      case 'info': {
        const dir = bundlePath(args.shift());
        result = { ok: true, ...summarize(dir, readProject(dir)) };
        break;
      }
      case 'validate': {
        const dir = bundlePath(args.shift());
        const p = readProject(dir);
        const problems = [...validateProject(p), ...droppedNote(droppedAudio(dir))];
        const video = join(dir, p.recording.screenVideoFile);
        if (!existsSync(video)) problems.push(`missing video file ${video}`);
        // Warnings (3D) never fail validation: exit 1 is for problems only.
        result = { ok: problems.length === 0, bundle: dir, problems, warnings: projectWarnings(p, { cursor: readCursorSamples(dir) }) };
        out(result);
        return problems.length ? 1 : 0;
      }
      case 'review':
        result = await review(args);
        break;
      case 'apply':
        result = await apply(args);
        break;
      case 'polish':
        result = await polish(args);
        break;
      case 'direct':
        result = await direct(args);
        break;
      case 'frames':
        result = await framesCmd(args, { resolveBundle: (arg) => { const dir = bundlePath(arg); return { dir, project: readProject(dir) }; } });
        break;
      case 'undo':
        result = undo(args);
        break;
      case 'export':
        result = await exportCmd(args);
        break;
      case 'open':
        result = openCmd(args);
        break;
      case 'devices':
        result = await devices(args);
        break;
      case 'import':
        result = await importCmd(args);
        break;
      case 'record': {
        const sub = args.shift();
        if (sub === 'start') result = await recordStart(args);
        else if (sub === 'stop') result = await recordStop();
        else if (sub === 'status') result = recordStatus();
        else if (sub === '__daemon') {
          await recordDaemon(args);
          return 0;
        } else throw new CliError('usage: record start|stop|status', 2);
        break;
      }
      default:
        throw new CliError(`unknown command "${cmd}". Run with --help.`, 2);
    }
    out(result);
    return 0;
  } catch (e) {
    const err = e as CliError & { extra?: Record<string, unknown> };
    out({ ...(err.extra ?? {}), ok: false, error: err.message ?? String(e) });
    return err instanceof CliError ? err.code : 1;
  }
}

export { summarize, captionsFromSegments };
