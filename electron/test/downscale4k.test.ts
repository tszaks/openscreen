// The 4K-downscale check's pure parts (scripts/golden/downscale4k.mjs, SPEC
// §4.2, owner decision 8): PSNR, the text mask built from the compositor's
// text boxes, the masked PSNR (the picture gate outside the text), the
// text-box layout check (1 px at 1080 scale), and one still's verdict. The
// check itself drives the real app (`frames` at p1080 and uhd4k); see the
// script header for how to run it.
import { describe, expect, it } from 'vitest';
import {
  compareStill,
  DEFAULT_MIN_DB,
  DEFAULT_TOL_PX,
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

type Box = { kind: string; rect: { x: number; y: number; w: number; h: number } };
const box = (kind: string, x: number, y: number, w: number, h: number): Box => ({ kind, rect: { x, y, w, h } });

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
    expect(layoutCheck(small, big().slice(0, 1), 2)).toMatchObject({ ok: false, problems: ['text boxes differ: 1080 has [caption,title], 4K has [caption]'] });
    expect(layoutCheck(small, [box('annotation', 200, 3000, 800, 160), big()[1]], 2).ok).toBe(false);
    expect(layoutCheck([], [], 2)).toEqual({ ok: true, maxDelta: 0, problems: [] });
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

describe('scope', () => {
  it('runs on the golden fixtures whose layout preset scales at uhd4k (never App Store or Classic), at the spec gate of 40 dB', () => {
    expect(scalingFixtures()).toEqual(['ios-16x9', 'ios-social']);
    expect(DEFAULT_MIN_DB).toBe(40);
  });
});
