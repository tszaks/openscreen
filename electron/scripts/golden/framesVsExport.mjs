#!/usr/bin/env node
// Frames = export (SPEC §6.3): a `frames` still at output time t is the
// export's frame round(t·fps), at PSNR >= 50 dB (RGB). Run on a 3D project,
// where the two paths could drift apart (engine settings, waits, seeking).
//
// The export frames are taken BEFORE encoding: the app's ffmpeg runs through
// a wrapper (FFMPEG_BIN, which ffmpeg-static and so the app's main process
// honour) that passes every byte through unchanged and copies the wanted
// frames out of the raw RGBA pipe the export writes. So the comparison is
// rendered pixels against rendered pixels, with no encoder in between; the
// exported file itself is the app's normal one.
//
// Default bundle: a 3D copy of the ios-social golden fixture (makeFixtures,
// then `apply` with 3D on and two fixed moves: a turn out to 35° and back),
// with stills at every move's start, middle and end and every tap
// (`frames --moves`), so moving, turned and still frames are all checked.
// The moves are written out rather than planned by `direct`, so this check
// does not change when the planner does.
//
//   node scripts/golden/framesVsExport.mjs [--bundle B] [--at 1,2.5 | --moves]
//        [--min 50] [--out DIR] [--app /path/OpenScreen.app] [--timeout s] [--keep]
// Needs `npm run build`. --bundle is copied first; the original is only read.
// Prints one JSON object; exit 0 when every still meets --min, 1 when one
// does not (or a run fails), 2 on bad usage. Run folders go under --out
// (default <tmp>/openscreen-golden/frames-vs-export) and are deleted unless
// --keep or a still fails.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psnr } from './downscale4k.mjs';
import { ELECTRON_DIR, findFfmpeg, makeFixtures } from './makeFixtures.mjs';

export const DEFAULT_MIN_DB = 50;
const DEFAULT_OUT = join(tmpdir(), 'openscreen-golden', 'frames-vs-export');
const AGENT = join(ELECTRON_DIR, 'scripts', 'openscreen-agent.mjs');
const HERE = fileURLToPath(import.meta.url);

const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : n);

/**
 * The raw video an ffmpeg command line reads from stdin, as the export
 * writes it (`-f rawvideo -pix_fmt rgba -s WxH … -i pipe:0`): { w, h }, or
 * null for any other command (probes, transcodes), which pass through.
 */
export function rawPipeInput(args) {
  const input = args.indexOf('-i');
  if (input < 0 || args[input + 1] !== 'pipe:0') return null;
  // The rawvideo options are the ones before that -i.
  const before = args.slice(0, input);
  const opt = (flag) => {
    const i = before.lastIndexOf(flag);
    return i >= 0 ? before[i + 1] : undefined;
  };
  if (opt('-f') !== 'rawvideo' || opt('-pix_fmt') !== 'rgba') return null;
  const size = /^(\d+)x(\d+)$/.exec(opt('-s') ?? '');
  return size ? { w: Number(size[1]), h: Number(size[2]) } : null;
}

/**
 * Copies whole frames out of a byte stream of `frameBytes`-sized frames:
 * push() each chunk as it arrives (any size, any boundary); every frame whose
 * index is in `wanted` is handed to `onFrame(index, bytes)` once complete.
 */
export class FrameTap {
  constructor(frameBytes, wanted, onFrame) {
    this.frameBytes = frameBytes;
    this.wanted = new Set(wanted);
    this.onFrame = onFrame;
    this.offset = 0;
    this.buf = null;
  }

  push(chunk) {
    let pos = 0;
    while (pos < chunk.length) {
      const index = Math.floor(this.offset / this.frameBytes);
      const into = this.offset % this.frameBytes;
      const take = Math.min(chunk.length - pos, this.frameBytes - into);
      if (this.wanted.has(index)) {
        if (into === 0) this.buf = Buffer.alloc(this.frameBytes);
        chunk.copy(this.buf, into, pos, pos + take);
        if (into + take === this.frameBytes) {
          this.onFrame(index, this.buf);
          this.buf = null;
        }
      }
      pos += take;
      this.offset += take;
    }
  }
}

/**
 * The wrapper's body: run the real ffmpeg with the same arguments; when it
 * reads the export's raw pipe, tee stdin into it and write the wanted frames
 * to `dir/export-<index>.rgba`. Exits with ffmpeg's code.
 */
export function runWrapper(real, dir, wanted, args = process.argv.slice(2)) {
  const raw = rawPipeInput(args);
  const done = (code, signal) => process.exit(code ?? (signal ? 1 : 0));
  if (!raw) {
    spawn(real, args, { stdio: 'inherit' }).on('exit', done);
    return;
  }
  const child = spawn(real, args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const tap = new FrameTap(raw.w * raw.h * 4, wanted, (i, bytes) => writeFileSync(join(dir, `export-${i}.rgba`), bytes));
  process.stdin.on('data', (chunk) => {
    tap.push(chunk);
    if (!child.stdin.write(chunk)) {
      process.stdin.pause();
      child.stdin.once('drain', () => process.stdin.resume());
    }
  });
  process.stdin.on('end', () => child.stdin.end());
  // ffmpeg stopping early (an error) closes its stdin; its exit code reports why.
  child.stdin.on('error', () => {});
  child.on('exit', done);
}

/** Writes the tapping ffmpeg wrapper into `dir` (it runs `real`, and writes the `wanted` export frames into `dir`); returns its path. */
export function writeWrapper(dir, real, wanted) {
  const file = join(dir, 'ffmpeg-tap.mjs');
  const js = JSON.stringify;
  writeFileSync(file, [`#!${process.execPath}`, `import { runWrapper } from ${js(HERE)};`, `runWrapper(${js(real)}, ${js(dir)}, ${js(wanted)});`, ''].join('\n'), {
    mode: 0o755,
  });
  return file;
}

/** Run the agent CLI; its one JSON result (throws with the CLI's error otherwise). */
function agent(args, env) {
  const r = spawnSync(process.execPath, [AGENT, ...args], { encoding: 'utf8', env, maxBuffer: 64 << 20 });
  let o;
  try {
    o = JSON.parse(r.stdout);
  } catch {
    throw new Error(`agent ${args[0]} printed no JSON (exit ${r.status}): ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  }
  if (!o.ok) throw new Error(`agent ${args[0]} failed: ${o.error}`);
  return o;
}

/** An image file (PNG) as RGB24. */
const pngRgb = (ffmpeg, file) => execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });

/** RGBA bytes as RGB24 (alpha dropped: export frames are opaque). */
export function rgbaToRgb(rgba) {
  const out = Buffer.alloc((rgba.length / 4) * 3);
  for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
    out[q] = rgba[p];
    out[q + 1] = rgba[p + 1];
    out[q + 2] = rgba[p + 2];
  }
  return out;
}

/** The default bundle's 3D edits: 3D on, a turn out (moving at 1.3 s, turned until 4.6 s) and back to front by 6 s. */
export const FIXTURE_3D_OPS = [
  { op: 'phone3d', enabled: true },
  { op: 'addTransition', start: 0.4, end: 2.2, to: { turn: 35, tilt: 8 } },
  { op: 'addTransition', start: 4.6, end: 6, to: { turn: 0, tilt: 0 } },
];

/** The default bundle: ios-social with FIXTURE_3D_OPS applied. */
function threeDFixture(run, env) {
  const built = makeFixtures({ out: join(run, 'fixtures'), only: ['ios-social'] });
  const bundle = join(run, 'ios-social-3d.openscreen');
  cpSync(built.bundles[0].bundle, bundle, { recursive: true });
  agent(['apply', bundle, JSON.stringify(FIXTURE_3D_OPS)], env);
  return bundle;
}

export async function framesVsExport({ out = DEFAULT_OUT, bundle, at, min = DEFAULT_MIN_DB, app, timeout, keep = false, log = () => {} } = {}) {
  mkdirSync(out, { recursive: true });
  const run = mkdtempSync(join(out, 'run-'));
  const ffmpeg = findFfmpeg();
  const env = { ...process.env, OPENSCREEN_RECORDINGS_DIR: run };
  let src;
  if (bundle) {
    src = join(run, 'bundle.openscreen');
    cpSync(bundle, src, { recursive: true });
  } else {
    log({ stage: 'fixture' });
    src = threeDFixture(run, env);
  }
  const appArgs = [...(app ? ['--app', app] : []), ...(timeout ? ['--timeout', String(timeout)] : [])];
  log({ stage: 'frames' });
  const frames = agent(['frames', src, ...(at ? ['--at', at.join(',')] : ['--moves']), '--out', join(run, 'frames'), ...appArgs], env);
  const drawn = frames.files.filter((f) => f.path);
  if (!drawn.length) throw new Error('frames drew no still');
  const wanted = [...new Set(drawn.map((f) => f.frame))];
  const tapDir = join(run, 'tap');
  mkdirSync(tapDir);
  const wrapper = writeWrapper(tapDir, ffmpeg, wanted);
  log({ stage: 'export', frames: wanted });
  const exported = agent(['export', src, '--out', join(run, 'export.mp4'), ...appArgs], { ...env, FFMPEG_BIN: wrapper, OPENSCREEN_FFMPEG: wrapper });
  const { w, h } = frames.size;
  const stills = drawn.map((f) => {
    const base = { t: f.t, frame: f.frame, facing: f.facing ?? null };
    const raw = join(tapDir, `export-${f.frame}.rgba`);
    if (!existsSync(raw)) return { ...base, pass: false, error: 'the export wrote no such frame' };
    const rgba = readFileSync(raw);
    if (rgba.length !== w * h * 4) return { ...base, pass: false, error: `export frame is ${rgba.length} bytes, not ${w}x${h} RGBA` };
    const db = psnr(pngRgb(ffmpeg, f.path), rgbaToRgb(rgba));
    return { ...base, db: r2(db), pass: db >= min };
  });
  const ok = stills.every((s) => s.pass);
  if (ok && !keep) rmSync(run, { recursive: true, force: true });
  return {
    ok,
    min,
    bundle: bundle ?? 'ios-social golden fixture with FIXTURE_3D_OPS',
    phone3d: frames.phone3d,
    quality: frames.quality,
    fps: frames.fps,
    size: frames.size,
    gpu: frames.gpu,
    exported: exported.out ?? null,
    run: ok && !keep ? null : run,
    stills,
  };
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw Object.assign(new Error(`${name} needs a value`), { usage: true });
  args.splice(i, 2);
  return v;
}

function bool(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

/** True when this file is the script node was started with (real paths: /tmp is a symlink on macOS). */
function runAsScript() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(HERE);
  } catch {
    return false;
  }
}

if (runAsScript()) {
  const args = process.argv.slice(2);
  try {
    const out = resolve(flag(args, '--out') ?? DEFAULT_OUT);
    const bundleRaw = flag(args, '--bundle');
    const bundle = bundleRaw ? resolve(bundleRaw) : undefined;
    if (bundle && !existsSync(join(bundle, 'project.json'))) throw Object.assign(new Error(`--bundle: no project.json in ${bundle}`), { usage: true });
    const atRaw = flag(args, '--at');
    const moves = bool(args, '--moves');
    if (atRaw && moves) throw Object.assign(new Error('use --at or --moves, not both'), { usage: true });
    const at = atRaw ? atRaw.split(',').map(Number) : undefined;
    if (at && (!at.length || at.some((t) => !(t >= 0)))) throw Object.assign(new Error('--at must be output seconds ≥ 0'), { usage: true });
    const minRaw = flag(args, '--min');
    const min = minRaw === undefined ? DEFAULT_MIN_DB : Number(minRaw);
    if (!(min > 0)) throw Object.assign(new Error('--min must be a positive number of dB'), { usage: true });
    const app = flag(args, '--app');
    const timeoutRaw = flag(args, '--timeout');
    const timeout = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
    if (timeout !== undefined && !(timeout > 0)) throw Object.assign(new Error('--timeout must be seconds > 0'), { usage: true });
    const keep = bool(args, '--keep');
    if (args.length) throw Object.assign(new Error(`unknown argument(s): ${args.join(' ')}`), { usage: true });
    if (!existsSync(join(ELECTRON_DIR, 'dist', 'node', 'agentCli.js'))) throw new Error('not built: run `npm run build` in electron/');
    const r = await framesVsExport({ out, bundle, at, min, app, timeout, keep, log: (o) => process.stderr.write(JSON.stringify(o) + '\n') });
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exitCode = r.ok ? 0 : 1;
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
    process.exitCode = e.usage ? 2 : 1;
  }
}
