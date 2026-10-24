// The 4K-downscale check's pure parts (scripts/golden/downscale4k.mjs, SPEC
// §4.2, owner decisions 8 and 14): PSNR, the text mask built from the
// compositor's text boxes, the device-frame edge band, the masked PSNR (the
// picture gate outside the text and the band), the text-box layout check and
// the frame layout check (1 px at 1080 scale), and one still's verdict, down
// to a phone frame drawn at 1080 and at 4K the way deviceFrame.ts draws it.
// The check itself drives the real app (`frames` at p1080 and uhd4k); see
// the script header for how to run it.
import { describe, expect, it } from 'vitest';
import {
  BAND_PX,
  compareStill,
  DEFAULT_MIN_DB,
  DEFAULT_TOL_PX,
  edgeBand,
  frameLayoutCheck,
  layoutCheck,
  MASK_PAD_FRAC,
  MASK_PAD_PX,
  maskedPsnr,
  psnr,
  scalingFixtures,
  textMask,
  // @ts-expect-error plain .mjs script without types
} from '../scripts/golden/downscale4k.mjs';
import { lcg } from './helpers/phone3dFixtures';

type Box = { kind: string; rect: { x: number; y: number; w: number; h: number }; text?: string };
const box = (kind: string, x: number, y: number, w: number, h: number, text?: string): Box => ({ kind, rect: { x, y, w, h }, ...(text !== undefined ? { text } : {}) });

/** A noisy RGB24 frame (so a shift or a blur shows in PSNR, as in a real frame). */
function noise(w: number, h: number, seed = 1): Uint8Array {
  const r = lcg(seed);
  return Uint8Array.from({ length: w * h * 3 }, () => Math.floor(r() * 256));
}

/** Sets every pixel of `rect` in an RGB24 frame `w` wide to `v`. */
function paint(f: Uint8Array, w: number, rect: Box['rect'], v: number) {
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) f.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
}

describe('psnr', () => {
  it('Infinity when equal; 10·log10(255²/MSE) otherwise; refuses different sizes', () => {
    const a = new Uint8Array([10, 20, 30, 40]);
    expect(psnr(a, a.slice())).toBe(Infinity);
    // One value off by 255 in four: MSE = 255²/4, PSNR = 10·log10(4) ≈ 6.02 dB.
    expect(psnr(new Uint8Array([0, 0, 0, 0]), new Uint8Array([255, 0, 0, 0]))).toBeCloseTo(10 * Math.log10(4), 9);
    // Off by 1 everywhere: MSE 1, PSNR 48.13 dB.
    expect(psnr(new Uint8Array([1, 2, 3]), new Uint8Array([2, 3, 4]))).toBeCloseTo(48.1308, 3);
    expect(() => psnr(new Uint8Array(3), new Uint8Array(4))).toThrow('size mismatch');
  });
});

describe('textMask', () => {
  it('covers each box grown by MASK_PAD_PX + MASK_PAD_FRAC of its short side, outward to whole px, clipped to the frame', () => {
    expect([MASK_PAD_PX, MASK_PAD_FRAC]).toEqual([2, 0.1]);
    const w = 40;
    const h = 30;
    // Short side 10 → pad 3: x 10..30 → 7..33, y 5.5..15.5 → floor(2.5)=2 .. ceil(18.5)=19.
    const m = textMask([box('caption', 10, 5.5, 20, 10)], w, h);
    const rows = (x: number) => Array.from({ length: h }, (_, y) => m[y * w + x]);
    const cols = (y: number) => Array.from({ length: w }, (_, x) => m[y * w + x]);
    expect(cols(10).indexOf(1)).toBe(7);
    expect(cols(10).lastIndexOf(1)).toBe(32);
    expect(rows(20).indexOf(1)).toBe(2);
    expect(rows(20).lastIndexOf(1)).toBe(18);
    // A box past the edge is clipped, not wrapped onto the next row.
    const edge = textMask([box('keycap', 35, 0, 20, 4)], w, h, { padPx: 0, padFrac: 0 });
    expect(Array.from({ length: h }, (_, y) => edge[y * w]).every((v) => v === 0)).toBe(true);
    expect((edge as Uint8Array).reduce((s: number, v: number) => s + v, 0)).toBe(5 * 4);
    expect(textMask([], w, h).every((v: number) => v === 0)).toBe(true);
  });
});

describe('maskedPsnr', () => {
  it('measures only the pixels on the chosen side of the mask, and counts them', () => {
    const w = 4;
    const h = 2;
    const a = new Uint8Array(w * h * 3).fill(100);
    const b = a.slice();
    // Pixel (1,0) differs by 10 in every channel; it is the only masked pixel.
    b.fill(110, 3, 6);
    const mask = new Uint8Array(w * h);
    mask[1] = 1;
    expect(maskedPsnr(a, b, mask, w, { where: 0 })).toEqual({ db: Infinity, pixels: 7 });
    const inside = maskedPsnr(a, b, mask, w, { where: 1 });
    expect(inside.pixels).toBe(1);
    expect(inside.db).toBeCloseTo(10 * Math.log10((255 * 255) / 100), 9);
    // Rows: only row 1 → nothing differs there.
    expect(maskedPsnr(a, b, mask, w, { where: 1, y0: 1, y1: 2 })).toEqual({ db: NaN, pixels: 0 });
    expect(() => maskedPsnr(a, b, new Uint8Array(3), w)).toThrow('mask is 3 px');
  });
});

describe('layoutCheck (inside the text boxes the gate is layout: 1 px at 1080 scale)', () => {
  const small = [box('caption', 100, 1500, 400, 80), box('title', 40, 60, 1000, 200)];
  const big = (d = 0) => [box('caption', 200 + d, 3000, 800, 160 + d), box('title', 80, 120, 2000, 400)];

  it('passes the 1080 boxes against the 4K boxes / 2, and up to the tolerance', () => {
    expect(DEFAULT_TOL_PX).toBe(1);
    expect(layoutCheck(small, big(), 2)).toEqual({ ok: true, maxDelta: 0, problems: [] });
    // 2 px at 4K = 1 px at 1080: still in.
    expect(layoutCheck(small, big(2), 2)).toMatchObject({ ok: true, maxDelta: 1 });
  });

  it('fails a box more than 1 px off at 1080 scale, naming it', () => {
    const r = layoutCheck(small, big(3), 2);
    expect(r.ok).toBe(false);
    expect(r.maxDelta).toBe(1.5);
    expect(r.problems).toEqual(['caption #0 x: 1080 100 px, 4K/2 101.5 px (off by 1.5 > 1)', 'caption #0 h: 1080 80 px, 4K/2 81.5 px (off by 1.5 > 1)']);
  });

  it('fails when a box is missing, extra or of another kind', () => {
    expect(layoutCheck(small, big().slice(0, 1), 2)).toMatchObject({ ok: false, problems: ['text boxes differ: 1080 has [caption, title], 4K has [caption]'] });
    expect(layoutCheck(small, [box('annotation', 200, 3000, 800, 160), big()[1]], 2).ok).toBe(false);
    expect(layoutCheck([], [], 2)).toEqual({ ok: true, maxDelta: 0, problems: [] });
  });

  it('compares title lines by their text too: a title that wraps differently at 4K fails, naming the lines', () => {
    const hd = [box('title', 100, 1300, 600, 130, 'Title beside the phone')];
    const uhd = [box('title', 200, 2600, 900, 260, 'Title beside'), box('title', 200, 2860, 400, 260, 'the phone')];
    expect(layoutCheck(hd, uhd, 2)).toMatchObject({
      ok: false,
      problems: ['text boxes differ: 1080 has [title "Title beside the phone"], 4K has [title "Title beside", title "the phone"]'],
    });
    // Same lines, one 1.5 px wider at 1080 scale (a title font picked 0.5 px too big at 4K): named with its text.
    const r = layoutCheck(hd, [box('title', 200, 2600, 1203, 260, 'Title beside the phone')], 2);
    expect(r).toMatchObject({ ok: false, maxDelta: 1.5 });
    expect(r.problems).toEqual(['title #0 "Title beside the phone" w: 1080 600 px, 4K/2 601.5 px (off by 1.5 > 1)']);
  });

  it('fails a 4K layout that did not scale (text drawn at 1080 size on the 4K canvas)', () => {
    const r = layoutCheck(small, small, 2);
    expect(r.ok).toBe(false);
    // The caption's y: 1500 at 1080, 1500 / 2 = 750 from the 4K side.
    expect(r.maxDelta).toBe(750);
  });
});

describe('compareStill (one still: the picture outside the text at 40 dB, and the text layout)', () => {
  const w = 120;
  const h = 200;
  const caption = box('caption', 20, 150, 80, 20);
  const k = 2;
  const caption4k = box('caption', 40, 300, 160, 40);

  it('passes when only the glyphs inside a text box differ (font rendering is not gated)', () => {
    const a = noise(w, h);
    const b = a.slice();
    paint(b, w, { x: 30, y: 155, w: 40, h: 10 }, 255);
    const r = compareStill({ a, b, w, h, boxes: [caption], boxes4k: [caption4k], k });
    expect(r.pass).toBe(true);
    expect(r.picture).toMatchObject({ pass: true, db: Infinity });
    expect(r.text.db).toBeLessThan(20);
    expect(r.layout.ok).toBe(true);
    expect(r.picture.maskedFraction).toBeGreaterThan(0);
    expect(r.bands).toHaveLength(16);
  });

  it('fails when the picture outside the text differs (a shifted phone, a wrong backdrop)', () => {
    const a = noise(w, h);
    const b = a.slice();
    paint(b, w, { x: 10, y: 10, w: 60, h: 60 }, 0);
    const r = compareStill({ a, b, w, h, boxes: [caption], boxes4k: [caption4k], k });
    expect(r.pass).toBe(false);
    expect(r.picture.pass).toBe(false);
    expect(r.picture.db).toBeLessThan(DEFAULT_MIN_DB);
    expect(r.layout.ok).toBe(true);
    // The band that holds the square is the worst one; bands below it are untouched.
    const worst = r.bands.reduce((m: { db: number }, x: { db: number }) => (x.db < m.db ? x : m));
    expect(worst.y0).toBeLessThan(70);
    expect(r.bands.at(-1).db).toBe(Infinity);
  });

  it('fails when a text box is laid out wrong at 4K even though the mask hides its pixels', () => {
    const a = noise(w, h);
    const r = compareStill({ a, b: a.slice(), w, h, boxes: [caption], boxes4k: [box('caption', 46, 300, 160, 40)], k });
    expect(r.picture.pass).toBe(true);
    expect(r.layout).toMatchObject({ ok: false, maxDelta: 3 });
    expect(r.pass).toBe(false);
  });

  it('masks the union of both sides, so text that moved is not counted twice as a picture error', () => {
    const a = noise(w, h);
    const b = a.slice();
    // The 4K caption sits 1 px lower at 1080 scale (allowed); its pixels differ in both places.
    paint(a, w, { x: 20, y: 150, w: 80, h: 20 }, 0);
    paint(b, w, { x: 20, y: 151, w: 80, h: 20 }, 0);
    const r = compareStill({ a, b, w, h, boxes: [caption], boxes4k: [box('caption', 40, 302, 160, 40)], k });
    expect(r.picture.db).toBe(Infinity);
    expect(r.layout.ok).toBe(true);
    expect(r.pass).toBe(true);
  });

  it('refuses frames of different sizes', () => {
    expect(() => compareStill({ a: noise(w, h), b: noise(w, h - 1), w, h, boxes: [], boxes4k: [], k })).toThrow('size mismatch');
  });
});

describe('edgeBand (the device-frame edges left out of the picture gate: BAND_PX centred on each edge)', () => {
  it('marks the pixels whose centre is within BAND_PX / 2 of a closed outline, the closing side included', () => {
    expect(BAND_PX).toBe(1.5);
    const w = 20;
    const h = 20;
    // A square outline from (5,5) to (15,15): the last side runs back from (5,15) to (5,5).
    const m = edgeBand([[[5, 5], [15, 5], [15, 15], [5, 15]]], w, h);
    const at = (x: number, y: number) => m[y * w + x];
    // Pixel centres 0.5 px from the x = 5 side (columns 4 and 5) are in; 1.5 px away (3 and 6) are out.
    expect([3, 4, 5, 6].map((x) => at(x, 10))).toEqual([0, 1, 1, 0]);
    expect([13, 14, 15, 16].map((x) => at(x, 10))).toEqual([0, 1, 1, 0]);
    expect([3, 4, 5, 6].map((y) => at(10, y))).toEqual([0, 1, 1, 0]);
    // Inside and outside the square are untouched: on whole-pixel edges the band is the 2 px ring from column/row 4 to 15
    // (corner pixels too: their centre is 0.71 px from the corner).
    expect(at(10, 10)).toBe(0);
    expect(at(1, 1)).toBe(0);
    expect(at(4, 4)).toBe(1);
    expect((m as Uint8Array).reduce((n: number, v: number) => n + v, 0)).toBe(12 * 12 - 8 * 8);
  });

  it('is one pixel wide on an edge through pixel centres, clips to the frame, and adds to a given mask', () => {
    const w = 10;
    const h = 6;
    const m = edgeBand([[[4.5, -5], [4.5, 20]]], w, h);
    expect(Array.from({ length: w }, (_, x) => m[2 * w + x])).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
    const prior = new Uint8Array(w * h);
    prior[0] = 1;
    const both = edgeBand([[[4.5, -5], [4.5, 20]]], w, h, prior);
    expect(both).toBe(prior);
    expect([both[0], both[4]]).toEqual([1, 1]);
  });
});

describe('frameLayoutCheck (the frame body and screen rects: 1 px at 1080 scale)', () => {
  const frame = (k: number, dx = 0) => ({
    body: { x: (100 + dx) * k, y: 200 * k, w: 400 * k, h: 820 * k },
    screen: { x: (120 + dx) * k, y: 220 * k, w: 360 * k, h: 780 * k },
    edges: [],
  });

  it('passes the same frame at both sizes, and no frame on either side', () => {
    expect(frameLayoutCheck(frame(1), frame(2), 2)).toEqual({ ok: true, frame: true, maxDelta: 0, problems: [] });
    expect(frameLayoutCheck(null, null, 2)).toEqual({ ok: true, frame: false, maxDelta: 0, problems: [] });
  });

  it('fails a frame more than 1 px off at 1080 scale, or drawn on one side only', () => {
    const r = frameLayoutCheck(frame(1), frame(2, 1.5), 2);
    expect(r).toMatchObject({ ok: false, maxDelta: 1.5 });
    expect(r.problems).toEqual(['frame body x: 1080 100 px, 4K/2 101.5 px (off by 1.5 > 1)', 'frame screen x: 1080 120 px, 4K/2 121.5 px (off by 1.5 > 1)']);
    expect(frameLayoutCheck(frame(1), null, 2)).toMatchObject({ ok: false, problems: ['device frame drawn at 1080 only'] });
    expect(frameLayoutCheck(null, frame(2), 2)).toMatchObject({ ok: false, problems: ['device frame drawn at 4K only'] });
  });
});

// A phone still drawn the way deviceFrame.ts draws one, at `s` output px per
// 1080 px, 4 × 4 samples per pixel: a smooth backdrop, a rounded metal body,
// a black bezel, and smooth screen content in a hole cut `holeInset` OUTPUT
// px inside the screen edge (deviceFrame.ts: half a pixel at every size, so
// a quarter 1080 px at 4K). `move` shifts the whole frame and `bezel` widens
// the bezel, both in output px: the deliberate breaks.
const PHONE = { w: 120, h: 200, body: { x: 20.3, y: 20.2, w: 79.4, h: 159.6, r: 14 }, rim: 2, screenInset: 6, screenR: 9 };

/** Signed distance from (x, y) to a rounded rect with circular corners (negative inside). */
function sdRoundRect(x: number, y: number, r: { x: number; y: number; w: number; h: number }, radius: number): number {
  const qx = Math.abs(x - (r.x + r.w / 2)) - (r.w / 2 - radius);
  const qy = Math.abs(y - (r.y + r.h / 2)) - (r.h / 2 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function phoneGeometry(s: number, { holeInset = 0.5, move = 0, bezel = 0 } = {}) {
  const b = PHONE.body;
  const body = { x: b.x + move / s, y: b.y, w: b.w, h: b.h };
  const i = PHONE.screenInset;
  const screen = { x: body.x + i, y: body.y + i, w: body.w - 2 * i, h: body.h - 2 * i };
  const hi = (holeInset + bezel) / s;
  const hole = { x: screen.x + hi, y: screen.y + hi, w: screen.w - 2 * hi, h: screen.h - 2 * hi };
  return { body, screen, hole, holeR: PHONE.screenR - hi };
}

function phoneStill(s: number, opts: { holeInset?: number; move?: number; bezel?: number } = {}): Uint8Array {
  const g = phoneGeometry(s, opts);
  const W = PHONE.w * s;
  const H = PHONE.h * s;
  const out = new Uint8Array(W * H * 3);
  const N = 4;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          // The sample in 1080 units.
          const x = (px + (sx + 0.5) / N) / s;
          const y = (py + (sy + 0.5) / N) / s;
          let c: number[];
          if (sdRoundRect(x, y, g.hole, g.holeR) <= 0) c = [128 + 90 * Math.sin(x / 5), 128 + 90 * Math.cos(y / 7), 128];
          else if (sdRoundRect(x, y, g.body, PHONE.body.r) <= -PHONE.rim) c = [6, 6, 7];
          else if (sdRoundRect(x, y, g.body, PHONE.body.r) <= 0) c = [190, 120, 60];
          else c = [60 + x * 0.5, 80 + y * 0.3, 120];
          for (let k = 0; k < 3; k++) acc[k] += c[k];
        }
      }
      for (let k = 0; k < 3; k++) out[(py * W + px) * 3 + k] = Math.round(acc[k] / (N * N));
    }
  }
  return out;
}

/** An RGB24 frame `w` × `h` (at 1080 scale) area-downscaled from its 2× version, as ffmpeg's area filter does. */
function downscale2(f: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < 3; k++) {
        const at = (dx: number, dy: number) => f[((2 * y + dy) * 2 * w + 2 * x + dx) * 3 + k];
        out[(y * w + x) * 3 + k] = Math.round((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4);
      }
    }
  }
  return out;
}

/** The frame as `frames` reports it (HeadlessFrame.deviceFrame) for a still at scale `s`, in that still's px. */
function phoneFrame(s: number, opts: { holeInset?: number; move?: number; bezel?: number } = {}) {
  const g = phoneGeometry(s, { holeInset: opts.holeInset, move: opts.move });
  const outline = (r: { x: number; y: number; w: number; h: number }, radius: number) => {
    const pts: number[][] = [];
    const corners = [
      [r.x + r.w - radius, r.y + radius, -Math.PI / 2],
      [r.x + r.w - radius, r.y + r.h - radius, 0],
      [r.x + radius, r.y + r.h - radius, Math.PI / 2],
      [r.x + radius, r.y + radius, Math.PI],
    ];
    for (const [cx, cy, a0] of corners) for (let i = 0; i <= 24; i++) pts.push([(cx + radius * Math.cos(a0 + (i / 24) * (Math.PI / 2))) * s, (cy + radius * Math.sin(a0 + (i / 24) * (Math.PI / 2))) * s]);
    return pts;
  };
  const px = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s });
  // The compositor's screen is where the content goes (not the hole); the hole is the bezel's own edge.
  return { body: px(g.body), screen: px(g.screen), edges: [outline(g.body, PHONE.body.r), outline(g.hole, g.holeR)] };
}

describe('compareStill on a phone frame drawn at 1080 and at 4K (owner decision 14)', () => {
  const { w, h } = PHONE;
  const a = phoneStill(1);
  const frame = phoneFrame(1);
  const check = (opts: { move?: number; bezel?: number } = {}, reported = opts) =>
    compareStill({ a, b: downscale2(phoneStill(2, opts), w, h), w, h, boxes: [], boxes4k: [], frame, frame4k: phoneFrame(2, reported), k: 2 });

  it("passes a correct 4K frame: the hole's half-pixel inset differs only inside the 1.5 px band", () => {
    const r = check();
    expect(r.frame).toEqual({ ok: true, frame: true, maxDelta: 0, problems: [] });
    expect(r.picture.pass).toBe(true);
    expect(r.picture.db).toBeGreaterThan(DEFAULT_MIN_DB + 5);
    expect(r.pass).toBe(true);
    // The band is a thin ring: a few percent of this small frame, nowhere near the whole phone.
    expect(r.picture.bandFraction).toBeGreaterThan(0.02);
    expect(r.picture.bandFraction).toBeLessThan(0.08);
  });

  it('the band is what lets it pass: the same frames with no band fail the 40 dB gate', () => {
    const r = compareStill({ a, b: downscale2(phoneStill(2), w, h), w, h, boxes: [], boxes4k: [], k: 2 });
    expect(r.picture.db).toBeLessThan(DEFAULT_MIN_DB);
    expect(r.pass).toBe(false);
  });

  it('fails a 4K bezel 2 px wider (1 px at 1080), though the frame rects the compositor placed are unchanged', () => {
    const r = check({ bezel: 2 }, {});
    expect(r.frame.ok).toBe(true);
    expect(r.picture.pass).toBe(false);
    expect(r.picture.db).toBeLessThan(DEFAULT_MIN_DB);
    expect(r.pass).toBe(false);
  });

  it('fails a 4K frame moved 2 px (1 px at 1080): the picture catches it even where the layout tolerance allows 1 px', () => {
    const r = check({ move: 2 });
    expect(r.frame).toMatchObject({ ok: true, maxDelta: 1 });
    expect(r.picture.pass).toBe(false);
    expect(r.pass).toBe(false);
    // Moved 3 px (1.5 px at 1080), the frame check fails as well.
    const r3 = check({ move: 3 });
    expect(r3.frame.ok).toBe(false);
    expect(r3.frame.problems[0]).toMatch(/^frame body x: .*off by 1\.5 > 1/);
  });
});

describe('scope', () => {
  it('runs on the golden fixtures whose layout preset scales at uhd4k (never App Store or Classic), at the spec gate of 40 dB', () => {
    expect(scalingFixtures()).toEqual(['ios-16x9', 'ios-social']);
    expect(DEFAULT_MIN_DB).toBe(40);
  });
});
