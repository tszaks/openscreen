// The 4K-downscale layout check's pure parts (scripts/golden/downscale4k.mjs,
// SPEC §4.2): PSNR, per-band PSNR, and which golden fixtures it runs on. The
// check itself drives the real app (`frames` at p1080 and uhd4k); see the
// script header for how to run it.
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { bandPsnr, DEFAULT_MIN_DB, psnr, scalingFixtures } from '../scripts/golden/downscale4k.mjs';

describe('downscale4k helpers', () => {
  it('psnr: Infinity when equal; 10·log10(255²/MSE) otherwise; refuses different sizes', () => {
    const a = new Uint8Array([10, 20, 30, 40]);
    expect(psnr(a, a.slice())).toBe(Infinity);
    // One value off by 255 in four: MSE = 255²/4, PSNR = 10·log10(4) ≈ 6.02 dB.
    expect(psnr(new Uint8Array([0, 0, 0, 0]), new Uint8Array([255, 0, 0, 0]))).toBeCloseTo(10 * Math.log10(4), 9);
    // Off by 1 everywhere: MSE 1, PSNR 48.13 dB.
    expect(psnr(new Uint8Array([1, 2, 3]), new Uint8Array([2, 3, 4]))).toBeCloseTo(48.1308, 3);
    expect(() => psnr(new Uint8Array(3), new Uint8Array(4))).toThrow('size mismatch');
  });

  it('bandPsnr: splits an RGB frame into horizontal bands and finds the band that differs', () => {
    const w = 4;
    const h = 8;
    const a = new Uint8Array(w * h * 3).fill(100);
    const b = a.slice();
    // Rows 6 and 7 (the last of 4 bands) differ by 5.
    for (let i = 6 * w * 3; i < h * w * 3; i++) b[i] = 105;
    const bands = bandPsnr(a, b, w, h, 4);
    expect(bands.map((x: { y0: number; y1: number }) => [x.y0, x.y1])).toEqual([[0, 2], [2, 4], [4, 6], [6, 8]]);
    expect(bands.slice(0, 3).map((x: { db: number }) => x.db)).toEqual([Infinity, Infinity, Infinity]);
    expect(bands[3].db).toBeCloseTo(10 * Math.log10((255 * 255) / 25), 9);
    // The whole frame is the band average in MSE terms.
    expect(psnr(a, b)).toBeCloseTo(10 * Math.log10((255 * 255) / (25 / 4)), 9);
  });

  it('runs on the golden fixtures whose layout preset scales at uhd4k (never App Store or Classic), at the spec gate of 40 dB', () => {
    expect(scalingFixtures()).toEqual(['ios-16x9', 'ios-social']);
    expect(DEFAULT_MIN_DB).toBe(40);
  });
});
