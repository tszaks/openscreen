import { describe, expect, it } from 'vitest';
import { cameraAt } from '../src/shared/autofocus';
import { clampCenter, planTapZoom } from '../src/shared/autozoomTaps';
import type { TapSuggestion } from '../src/shared/taps';

const tap = (t: number, x: number, y: number, extra: Partial<TapSuggestion> = {}): TapSuggestion => ({
  id: `t${t}`, t, x, y, kind: 'tap', confidence: 0.9, ...extra,
});

describe('planTapZoom', () => {
  it('zooms ~1.8x on a tap, starting 250 ms before it, and eases out after the screen settles', () => {
    const [seg] = planTapZoom([tap(3, 0.5, 0.6, { settleT: 4 })], 20);
    expect(seg.scale).toBe(1.8);
    expect(seg.inStart).toBeCloseTo(2.75);
    expect(seg.center).toEqual({ x: 0.5, y: 0.6 });
    expect(seg.holdEnd).toBeCloseTo(4.35); // settle + pad
    expect(seg.outEnd).toBeCloseTo(5.05);
    expect(cameraAt(2.7, [seg]).scale).toBe(1);
    expect(cameraAt(3.5, [seg]).scale).toBeCloseTo(1.8);
    expect(cameraAt(6, [seg]).scale).toBe(1);
  });

  it('keeps the zoomed viewport inside the frame', () => {
    const [seg] = planTapZoom([tap(1, 0.02, 0.97)], 10);
    expect(seg.center.x).toBeCloseTo(0.5 / 1.8);
    expect(seg.center.y).toBeCloseTo(1 - 0.5 / 1.8);
    expect(clampCenter(0.5, 2)).toBe(0.5);
  });

  it('pans between nearby taps without zooming out', () => {
    const segs = planTapZoom([tap(2, 0.3, 0.3, { settleT: 2.4 }), tap(3.2, 0.7, 0.7, { settleT: 3.6 })], 20);
    expect(segs).toHaveLength(2);
    // The camera never drops below full zoom between the two taps.
    for (let t = segs[0].holdStart; t <= segs[1].holdEnd; t += 0.02) {
      expect(cameraAt(t, segs).scale).toBeCloseTo(1.8, 6);
    }
    // And it actually travels from the first centre to the second.
    expect(cameraAt(segs[0].holdStart + 0.01, segs).center.x).toBeCloseTo(0.3, 2);
    expect(cameraAt(segs[1].holdStart + 0.01, segs).center.x).toBeCloseTo(0.7, 2);
  });

  it('zooms out for a swipe between taps', () => {
    const segs = planTapZoom(
      [
        tap(2, 0.3, 0.3),
        { id: 's', t: 2.9, x: 0.5, y: 0.7, endX: 0.5, endY: 0.3, kind: 'swipe', duration: 0.3, confidence: 0.9 },
        tap(3.4, 0.7, 0.7),
      ],
      20,
    );
    expect(segs).toHaveLength(2);
    expect(segs[0].holdEnd).toBeLessThan(2.9);
    const mins = [];
    for (let t = segs[0].holdEnd; t <= segs[1].holdStart; t += 0.01) mins.push(cameraAt(t, segs).scale);
    expect(Math.min(...mins)).toBeCloseTo(1, 2);
    // No jumps: the camera moves continuously.
    let prev = cameraAt(0, segs).scale;
    for (let t = 0; t < 8; t += 1 / 60) {
      const s = cameraAt(t, segs).scale;
      expect(Math.abs(s - prev)).toBeLessThan(0.12);
      prev = s;
    }
  });

  it('skips low-confidence suggestions, typing, and can be switched off', () => {
    const list: TapSuggestion[] = [
      tap(1, 0.5, 0.5, { confidence: 0.3 }),
      { id: 'k', t: 4, x: 0.5, y: 0.8, kind: 'typing', duration: 2, confidence: 0.9 },
    ];
    expect(planTapZoom(list, 10)).toEqual([]);
    expect(planTapZoom([tap(1, 0.5, 0.5)], 10, { enabled: false })).toEqual([]);
    expect(planTapZoom([tap(1, 0.5, 0.5)], 10, { scale: 2 })[0].scale).toBe(2);
  });

  it('holds a long press for its duration', () => {
    const [seg] = planTapZoom([tap(1, 0.5, 0.5, { kind: 'longpress', duration: 0.9 })], 10);
    expect(seg.holdEnd).toBeGreaterThanOrEqual(1 + 0.9 + 0.8 - 1e-9);
  });

  it('clips to the recording', () => {
    const [seg] = planTapZoom([tap(9.8, 0.5, 0.5)], 10);
    expect(seg.outEnd).toBeLessThanOrEqual(10);
    expect(seg.holdEnd).toBeLessThanOrEqual(10);
    expect(planTapZoom([tap(12, 0.5, 0.5)], 10)).toEqual([]);
  });
});
