#!/usr/bin/env node
// The 4K-downscale check (SPEC §4.2, D18, owner decisions 8 and 14). With
// `exportPreset: 'uhd4k'` a social/web layout preset renders at a 2160 short
// side, and the layout is meant to be resolution-independent. Each still is
// checked in three parts:
//
//   picture  The 4K frame, area-downscaled to the 1080-class size, matches
//            the 1080-class frame at PSNR >= 40 dB (RGB) over every pixel
//            OUTSIDE the text boxes and the device-frame edge bands.
//   layout   Inside the text boxes the gate is layout, not pixels: the
//            compositor's own text boxes (CanvasCompositor.textBoxes, which
//            `frames` reports per still: caption pills, keycaps, text
//            overlays, and each title and subtitle line the title card drew)
//            are the same boxes with the same text in the same order, and
//            each one's x, y, width and height match within 1 px at 1080
//            scale (the 4K box divided by the scale factor).
//   frame    The flat device frame's body rect and screen rect (`frames`
//            reports them per still from the compositor's contentRect and
//            screenMap: HeadlessFrame.deviceFrame) match within 1 px at 1080
//            scale.
//
// Why the frame's two hard edges are out of the picture gate (owner decision
// 14): mobile/deviceFrame.ts cuts the screen hole half an OUTPUT pixel in (so
// the bezel overlaps the content's anti-aliased edge) and strokes the outer
// edge a quarter output pixel in. That is right per output pixel at every
// size, so at 4K those insets are half as wide at 1080 scale and a downscaled
// 4K frame differs from the 1080 frame along them by design (the 4K hole
// edge is a quarter 1080 px further out, so the pixels it touches are within
// 0.75 px of the 1080 hole edge). A band BAND_PX wide centred on the 1080
// still's outer body edge and screen-hole edge is left out of the PSNR. It is
// centred on the 1080 geometry only, never widened by the 4K side's: a 4K
// frame that is moved, or whose bezel is wider, by 1 px at 1080 scale puts
// its edge outside the band and fails the picture gate, and the frame part
// checks the geometry the compositor placed. Everything else in the frame
// (the metal band, bezel, island, buttons, shadow) stays in the 40 dB gate.
//
// Why text is out of the picture gate: glyphs never scale exactly (macOS
// system font optical sizing, glyph-edge anti-aliasing), and the owner ruled
// that letterSpacing and font rendering are not to be touched to pass. The
// mask is the union of both sides' boxes, each grown by MASK_PAD_PX plus
// MASK_PAD_FRAC of its short side: that covers the anti-aliased edge, the
// overlay outline stroke (6% of the font size, centred on the glyph edge) and
// glyph overshoot past the layout box. Everything else (backdrop, phone,
// screen, cursor, shadows) is in the picture gate.
//
// For each golden fixture with a social/web layout preset (ios-social,
// ios-16x9): build it (makeFixtures), clone it twice, set the export
// resolution through the real CLI (`apply exportSettings p1080 | uhd4k`),
// render the same output times with the real app (`frames`), downscale the
// 4K PNGs with ffmpeg's area filter and compare.
//
//   node scripts/golden/downscale4k.mjs [--out DIR] [--only ios-social] [--at 1,2.5,4,6]
//        [--min 40] [--tol 1] [--app /path/OpenScreen.app] [--keep]
// Needs `npm run build` (the CLI and the app it drives). Prints one JSON
// object; exit 0 when every still passes both parts, 1 when one does not, 2
// on bad usage. Run folders go under --out (default
// <tmp>/openscreen-golden/downscale4k) and are deleted unless --keep or a
// still fails.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELECTRON_DIR, findFfmpeg, fixtureNames, FIXTURES_DIR, makeFixtures } from './makeFixtures.mjs';

const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : n);

export const DEFAULT_TIMES = [1, 2.5, 4, 6];
export const DEFAULT_MIN_DB = 40;
/** Text-box layout tolerance, px at 1080 scale (owner decision 8). */
export const DEFAULT_TOL_PX = 1;
/** Mask growth around each text box: MASK_PAD_PX + MASK_PAD_FRAC × its short side, px at 1080 scale. */
export const MASK_PAD_PX = 2;
export const MASK_PAD_FRAC = 0.1;
/** Width of the band left out along each device-frame edge, px at 1080 scale, centred on the edge (owner decision 14). */
export const BAND_PX = 1.5;
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

/**
 * The text mask of a `w` × `h` frame: 1 where a pixel is inside any of
 * `boxes` (rects in that frame's px) grown by `padPx + padFrac` × the box's
 * short side, else 0. Rects are taken outward to whole pixels.
 */
export function textMask(boxes, w, h, { padPx = MASK_PAD_PX, padFrac = MASK_PAD_FRAC } = {}) {
  const mask = new Uint8Array(w * h);
  for (const { rect: r } of boxes) {
    const pad = padPx + padFrac * Math.min(Math.abs(r.w), Math.abs(r.h));
    const x0 = Math.max(0, Math.floor(r.x - pad));
    const y0 = Math.max(0, Math.floor(r.y - pad));
    const x1 = Math.min(w, Math.ceil(r.x + r.w + pad));
    const y1 = Math.min(h, Math.ceil(r.y + r.h + pad));
    for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + Math.max(x0, x1));
  }
  return mask;
}

/**
 * Marks in `mask` (a `w` × `h` frame, 1 = left out) every pixel whose centre
 * is within `half` px of one of the closed outlines in `edges` (each a list
 * of [x, y] points in that frame's px, the first not repeated). Returns
 * `mask`.
 */
export function edgeBand(edges, w, h, mask = new Uint8Array(w * h), half = BAND_PX / 2) {
  for (const pts of edges) {
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1));
      const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + half + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 1));
      const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + half + 1));
      for (let y = y0; y <= y1; y++) {
        const cy = y + 0.5;
        for (let x = x0; x <= x1; x++) {
          const cx = x + 0.5;
          const t = len2 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / len2)) : 0;
          const ex = ax + t * dx - cx;
          const ey = ay + t * dy - cy;
          if (ex * ex + ey * ey <= half * half) mask[y * w + x] = 1;
        }
      }
    }
  }
  return mask;
}

/**
 * PSNR of two RGB24 frames `w` px wide over the pixels of rows [y0, y1)
 * whose mask value is `where` (0 = outside the text, 1 = inside), with the
 * number of pixels it covered. Infinity when they are identical there; NaN
 * when no pixel qualifies.
 */
export function maskedPsnr(a, b, mask, w, { where = 0, y0 = 0, y1 = mask.length / w } = {}) {
  if (a.length !== b.length) throw new Error(`size mismatch: ${a.length} vs ${b.length}`);
  if (a.length !== mask.length * 3) throw new Error(`mask is ${mask.length} px, frames are ${a.length / 3}`);
  let se = 0;
  let n = 0;
  for (let p = y0 * w; p < y1 * w; p++) {
    if (mask[p] !== where) continue;
    n++;
    for (let c = 0; c < 3; c++) {
      const d = a[p * 3 + c] - b[p * 3 + c];
      se += d * d;
    }
  }
  if (!n) return { db: NaN, pixels: 0 };
  const mse = se / (n * 3);
  return { db: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse), pixels: n };
}

/** Each of x, y, w, h of `big` / k against `small`: the largest difference, and a sentence per one over `tol`. */
function rectDelta(label, small, big, k, tol, problems) {
  let max = 0;
  for (const key of ['x', 'y', 'w', 'h']) {
    const d = Math.abs(big[key] / k - small[key]);
    max = Math.max(max, d);
    if (!(d <= tol)) problems.push(`${label} ${key}: 1080 ${r2(small[key])} px, 4K/${k} ${r2(big[key] / k)} px (off by ${r2(d)} > ${tol})`);
  }
  return max;
}

/**
 * The layout half: the 1080 still's text boxes against the 4K still's,
 * divided by `k` (4K px per 1080 px). Same count, same kinds and line texts
 * in the same order (a title that wraps differently fails here), and every
 * x, y, w, h within `tol` px. Returns the largest difference and a sentence
 * per problem.
 */
export function layoutCheck(small, big, k, tol = DEFAULT_TOL_PX) {
  const problems = [];
  let maxDelta = 0;
  const kinds = (bs) => bs.map((b) => (b.text === undefined ? b.kind : `${b.kind} "${b.text}"`)).join(', ');
  if (kinds(small) !== kinds(big)) {
    problems.push(`text boxes differ: 1080 has [${kinds(small)}], 4K has [${kinds(big)}]`);
    return { ok: false, maxDelta: Infinity, problems };
  }
  small.forEach((a, i) => {
    maxDelta = Math.max(maxDelta, rectDelta(`${a.kind} #${i}${a.text === undefined ? '' : ` "${a.text}"`}`, a.rect, big[i].rect, k, tol, problems));
  });
  return { ok: problems.length === 0, maxDelta: r2(maxDelta), problems };
}

/**
 * The frame half (owner decision 14): the 1080 still's device frame against
 * the 4K still's (HeadlessFrame.deviceFrame, or null when no flat frame was
 * drawn), body rect and screen rect within `tol` px at 1080 scale. A frame on
 * one side only fails.
 */
export function frameLayoutCheck(small, big, k, tol = DEFAULT_TOL_PX) {
  if (!small && !big) return { ok: true, frame: false, maxDelta: 0, problems: [] };
  if (!small || !big) return { ok: false, frame: true, maxDelta: Infinity, problems: [`device frame drawn at ${small ? '1080 only' : '4K only'}`] };
  const problems = [];
  const maxDelta = Math.max(rectDelta('frame body', small.body, big.body, k, tol, problems), rectDelta('frame screen', small.screen, big.screen, k, tol, problems));
  return { ok: problems.length === 0, frame: true, maxDelta: r2(maxDelta), problems };
}

/**
 * One still, all three parts. `a` is the 1080 frame and `b` the 4K frame
 * area-downscaled to it, RGB24 `w` × `h`; `boxes` / `boxes4k` are each
 * side's text boxes and `frame` / `frame4k` each side's device frame
 * (HeadlessFrame.deviceFrame, or null), in its own PNG px; `k` = 4K px per
 * 1080 px. The picture PSNR is over the pixels outside the union of both
 * sides' text masks and the 1080 frame's edge band; the PSNR of what is left
 * out is reported, never gated.
 */
export function compareStill({ a, b, w, h, boxes, boxes4k, frame = null, frame4k = null, k, min = DEFAULT_MIN_DB, tol = DEFAULT_TOL_PX }) {
  const div = (r) => ({ x: r.x / k, y: r.y / k, w: r.w / k, h: r.h / k });
  const down = boxes4k.map(({ rect, drawn, ...rest }) => ({ ...rest, rect: div(rect), ...(drawn ? { drawn: div(drawn) } : {}) }));
  // A title line is masked over both its layout box and the box it was drawn in (they differ by the font's optical sizing).
  const both = (bs) => bs.flatMap((x) => (x.drawn ? [x, { kind: x.kind, rect: x.drawn }] : [x]));
  const mask = textMask([...both(boxes), ...both(down)], w, h);
  const textPixels = mask.reduce((n, v) => n + v, 0);
  // The frame-edge band: on the 1080 still's edges only (see the header).
  if (frame) edgeBand(frame.edges, w, h, mask);
  const outside = maskedPsnr(a, b, mask, w, { where: 0 });
  const inside = maskedPsnr(a, b, mask, w, { where: 1 });
  const layout = layoutCheck(boxes, boxes4k, k, tol);
  const frameLayout = frameLayoutCheck(frame, frame4k, k, tol);
  const picture = outside.pixels > 0 && outside.db >= min;
  const bands = h > w ? 16 : 9;
  return {
    pass: picture && layout.ok && frameLayout.ok,
    picture: {
      pass: picture,
      db: r2(outside.db),
      maskedFraction: r2(1 - outside.pixels / (w * h)),
      // The share of the picture left out as frame-edge band (pixels also in a text box count as text).
      bandFraction: Math.round(((w * h - outside.pixels - textPixels) / (w * h)) * 10000) / 10000,
    },
    text: { db: r2(inside.db) },
    layout,
    frame: frameLayout,
    // Where the picture differs: the outside-text PSNR of each horizontal band.
    bands: Array.from({ length: bands }, (_, i) => {
      const y0 = Math.round((i * h) / bands);
      const y1 = Math.round(((i + 1) * h) / bands);
      return { y0, y1, db: r2(maskedPsnr(a, b, mask, w, { where: 0, y0, y1 }).db) };
    }),
  };
}

/** Fixtures whose layout preset scales at uhd4k (social/web presets; never App Store or Classic). */
export function scalingFixtures() {
  return fixtureNames().filter((n) => {
    const id = JSON.parse(readFileSync(join(FIXTURES_DIR, n, 'project.json'), 'utf8')).layout?.presetId;
    return typeof id === 'string' && id !== 'none' && !id.startsWith('appstore');
  });
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

/** A PNG as RGB24, optionally area-scaled to w × h. */
function rgb(ffmpeg, file, w, h) {
  return execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
}

export async function downscale4k({ out = DEFAULT_OUT, only, times = DEFAULT_TIMES, min = DEFAULT_MIN_DB, tol = DEFAULT_TOL_PX, app, keep = false, log = () => {} } = {}) {
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
      // --debug: the text boxes and device frame edges this check reads (left out of a normal frames run's stdout).
      side[res] = agent(['frames', dir, '--at', times.join(','), '--debug', '--out', join(run, `${name}-${res}-frames`), ...(app ? ['--app', app] : [])], env);
    }
    const { w, h } = side.p1080.size;
    const big = side.uhd4k.size;
    const k = big.h / h;
    if (big.w / w !== k) throw new Error(`${name}: 4K size ${big.w}x${big.h} is not a uniform scale of ${w}x${h}`);
    const stills = [];
    for (const f of side.p1080.files) {
      const g = side.uhd4k.files.find((x) => x.t === f.t);
      if (!f.path || !g?.path) {
        stills.push({ t: f.t, pass: false, error: f.error ?? g?.error ?? 'missing' });
        continue;
      }
      // Without the compositor's boxes nothing could be masked or checked: an app built before textBoxes.
      if (!Array.isArray(f.textBoxes) || !Array.isArray(g.textBoxes)) throw new Error(`frames reported no textBoxes for ${name} at ${f.t} s: rebuild (npm run build)`);
      const a = rgb(ffmpeg, f.path, w, h);
      const b = rgb(ffmpeg, g.path, w, h);
      // Likewise the device frame (null = none drawn; undefined = an app built before deviceFrame).
      if (f.deviceFrame === undefined || g.deviceFrame === undefined) throw new Error(`frames reported no deviceFrame for ${name} at ${f.t} s: rebuild (npm run build)`);
      stills.push({
        t: f.t,
        ...compareStill({ a, b, w, h, boxes: f.textBoxes, boxes4k: g.textBoxes, frame: f.deviceFrame, frame4k: g.deviceFrame, k, min, tol }),
        textBoxes: f.textBoxes.map((x) => (x.text === undefined ? x.kind : `${x.kind}: ${x.text}`)),
      });
    }
    fixtures.push({ name, size: { w, h }, size4k: big, k, stills });
  }
  const ok = fixtures.every((f) => f.stills.every((s) => s.pass));
  if (ok && !keep) rmSync(run, { recursive: true, force: true });
  return { ok, min, tol, times, run: ok && !keep ? null : run, fixtures };
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
    const tolRaw = flag(args, '--tol');
    const tol = tolRaw === undefined ? DEFAULT_TOL_PX : Number(tolRaw);
    if (!(tol >= 0)) throw Object.assign(new Error('--tol must be px ≥ 0'), { usage: true });
    const app = flag(args, '--app');
    const ki = args.indexOf('--keep');
    const keep = ki >= 0;
    if (keep) args.splice(ki, 1);
    if (args.length) throw Object.assign(new Error(`unknown argument(s): ${args.join(' ')}`), { usage: true });
    if (!existsSync(join(ELECTRON_DIR, 'dist', 'node', 'agentCli.js'))) throw new Error('not built: run `npm run build` in electron/');
    const r = await downscale4k({ out, only, times, min, tol, app, keep, log: (o) => process.stderr.write(JSON.stringify(o) + '\n') });
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exitCode = r.ok ? 0 : 1;
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
    process.exitCode = e.usage ? 2 : 1;
  }
}
