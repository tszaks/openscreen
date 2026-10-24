#!/usr/bin/env node
// The 4K-downscale layout check (SPEC §4.2, D18): with `exportPreset: 'uhd4k'`
// a social/web layout preset renders at a 2160 short side, and the layout is
// meant to be resolution-independent. So a 4K frame, area-downscaled to the
// 1080-class size, should match the 1080-class frame of the same project at
// PSNR ≥ 40 dB (RGB, whole frame).
//
// For each golden fixture with a social/web layout preset (ios-social,
// ios-16x9): build it (makeFixtures), clone it twice, set the export
// resolution through the real CLI (`apply exportSettings p1080 | uhd4k`),
// render the same output times with the real app (`frames`), downscale the 4K
// PNGs with ffmpeg's area filter and compare. It prints the whole-frame PSNR
// per still (the gate) and, to show WHERE pixels differ, the PSNR of each
// horizontal band of the frame (portrait: 16 bands; landscape: 9).
//
//   node scripts/golden/downscale4k.mjs [--out DIR] [--only ios-social] [--at 1,2.5,4,6]
//        [--min 40] [--app /path/OpenScreen.app] [--keep]
// Needs `npm run build` (the CLI and the app it drives). Prints one JSON
// object; exit 0 when every still meets --min, 1 when one does not, 2 on bad
// usage. Run folders go under --out (default <tmp>/openscreen-golden/downscale4k)
// and are deleted unless --keep or a still fails.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELECTRON_DIR, findFfmpeg, fixtureNames, FIXTURES_DIR, makeFixtures } from './makeFixtures.mjs';

export const DEFAULT_TIMES = [1, 2.5, 4, 6];
export const DEFAULT_MIN_DB = 40;
const DEFAULT_OUT = join(tmpdir(), 'openscreen-golden', 'downscale4k');
const AGENT = join(ELECTRON_DIR, 'scripts', 'openscreen-agent.mjs');

/** PSNR in dB of two equal-length 8-bit buffers (Infinity when identical). */
export function psnr(a, b, from = 0, to = a.length) {
  if (a.length !== b.length) throw new Error(`size mismatch: ${a.length} vs ${b.length}`);
  let se = 0;
  for (let i = from; i < to; i++) {
    const d = a[i] - b[i];
    se += d * d;
  }
  const mse = se / Math.max(1, to - from);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

/** PSNR of each horizontal band of two RGB24 frames `w` × `h`: [{ y0, y1, db }]. */
export function bandPsnr(a, b, w, h, bands) {
  const out = [];
  for (let k = 0; k < bands; k++) {
    const y0 = Math.round((k * h) / bands);
    const y1 = Math.round(((k + 1) * h) / bands);
    out.push({ y0, y1, db: psnr(a, b, y0 * w * 3, y1 * w * 3) });
  }
  return out;
}

/** Fixtures whose layout preset scales at uhd4k (social/web presets; never App Store or Classic). */
export function scalingFixtures() {
  return fixtureNames().filter((n) => {
    const id = JSON.parse(readFileSync(join(FIXTURES_DIR, n, 'project.json'), 'utf8')).layout?.presetId;
    return typeof id === 'string' && id !== 'none' && !id.startsWith('appstore');
  });
}

const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : n);

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

/** A PNG as RGB24, optionally area-scaled to w × h. */
function rgb(ffmpeg, file, w, h) {
  return execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
}

export async function downscale4k({ out = DEFAULT_OUT, only, times = DEFAULT_TIMES, min = DEFAULT_MIN_DB, app, keep = false, log = () => {} } = {}) {
  const names = only?.length ? only : scalingFixtures();
  const bad = names.filter((n) => !scalingFixtures().includes(n));
  if (bad.length) throw Object.assign(new Error(`not a scaling-preset fixture: ${bad.join(', ')} (have: ${scalingFixtures().join(', ')})`), { usage: true });
  mkdirSync(out, { recursive: true });
  const run = mkdtempSync(join(out, 'run-'));
  const ffmpeg = findFfmpeg();
  const env = { ...process.env, OPENSCREEN_RECORDINGS_DIR: run };
  log({ stage: 'fixtures', run });
  const built = makeFixtures({ out: join(run, 'fixtures'), only: names });
  const fixtures = [];
  for (const { name, bundle } of built.bundles) {
    const side = {};
    for (const res of ['p1080', 'uhd4k']) {
      const dir = join(run, `${name}-${res}.openscreen`);
      cpSync(bundle, dir, { recursive: true });
      agent(['apply', dir, JSON.stringify([{ op: 'exportSettings', preset: res }])], env);
      log({ stage: 'frames', fixture: name, res });
      side[res] = agent(['frames', dir, '--at', times.join(','), '--out', join(run, `${name}-${res}-frames`), ...(app ? ['--app', app] : [])], env);
    }
    const { w, h } = side.p1080.size;
    const big = side.uhd4k.size;
    const stills = [];
    for (const f of side.p1080.files) {
      const g = side.uhd4k.files.find((x) => x.t === f.t);
      if (!f.path || !g?.path) {
        stills.push({ t: f.t, error: f.error ?? g?.error ?? 'missing' });
        continue;
      }
      const a = rgb(ffmpeg, f.path, w, h);
      const b = rgb(ffmpeg, g.path, w, h);
      const db = psnr(a, b);
      stills.push({ t: f.t, db: r2(db), pass: db >= min, bands: bandPsnr(a, b, w, h, h > w ? 16 : 9).map((x) => ({ ...x, db: r2(x.db) })) });
    }
    fixtures.push({ name, size: { w, h }, size4k: big, k: big.h / h, stills });
  }
  const ok = fixtures.every((f) => f.stills.every((s) => s.pass));
  if (ok && !keep) rmSync(run, { recursive: true, force: true });
  return { ok, min, times, run: ok && !keep ? null : run, fixtures };
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw Object.assign(new Error(`${name} needs a value`), { usage: true });
  args.splice(i, 2);
  return v;
}

/** True when this file is the script node was started with (real paths: /tmp is a symlink on macOS). */
function runAsScript() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runAsScript()) {
  const args = process.argv.slice(2);
  try {
    const out = resolve(flag(args, '--out') ?? DEFAULT_OUT);
    const only = flag(args, '--only')?.split(',').filter(Boolean);
    const atRaw = flag(args, '--at');
    const times = atRaw ? atRaw.split(',').map(Number) : DEFAULT_TIMES;
    if (!times.length || times.some((t) => !(t >= 0))) throw Object.assign(new Error('--at must be output seconds ≥ 0'), { usage: true });
    const minRaw = flag(args, '--min');
    const min = minRaw === undefined ? DEFAULT_MIN_DB : Number(minRaw);
    if (!(min > 0)) throw Object.assign(new Error('--min must be a positive number of dB'), { usage: true });
    const app = flag(args, '--app');
    const ki = args.indexOf('--keep');
    const keep = ki >= 0;
    if (keep) args.splice(ki, 1);
    if (args.length) throw Object.assign(new Error(`unknown argument(s): ${args.join(' ')}`), { usage: true });
    if (!existsSync(join(ELECTRON_DIR, 'dist', 'node', 'agentCli.js'))) throw new Error('not built: run `npm run build` in electron/');
    const r = await downscale4k({ out, only, times, min, app, keep, log: (o) => process.stderr.write(JSON.stringify(o) + '\n') });
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exitCode = r.ok ? 0 : 1;
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
    process.exitCode = e.usage ? 2 : 1;
  }
}
