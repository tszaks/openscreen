import { describe, expect, it } from 'vitest';
import { AutofocusPlanner, cameraAt, defaultAutofocus } from '../src/shared/autofocus';
import { smootherstep, springSettle } from '../src/shared/easing';
import type { CursorSample } from '../src/shared/types';

const click = (time: number, x: number, y: number): CursorSample => ({ time, x, y, kind: 'clickDown' });

describe('easing', () => {
  it('smootherstep has zero endpoints and is symmetric', () => {
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(0.5)).toBeCloseTo(0.5, 9);
    for (const t of [0.1, 0.37, 0.83]) {
      expect(smootherstep(t)).toBeCloseTo(1 - smootherstep(1 - t), 9);
    }
  });

  it('springSettle rises fast and settles without overshoot', () => {
    expect(springSettle(0)).toBe(0);
    expect(springSettle(1)).toBeGreaterThan(0.99);
    // Monotonic-ish: never dips below 0 or above 1.
    for (let t = 0; t <= 1; t += 0.05) {
      expect(springSettle(t)).toBeGreaterThanOrEqual(0);
      expect(springSettle(t)).toBeLessThanOrEqual(1.0000001);
    }
  });
});

describe('AutofocusPlanner', () => {
  const planner = new AutofocusPlanner();

  it('returns no segments with no clicks', () => {
    expect(planner.planSegments([], 10)).toHaveLength(0);
  });

  it('clusters clicks that are close in time and space', () => {
    const clicks = [
      click(1.0, 0.2, 0.2),
      click(1.1, 0.21, 0.19), // same cluster
      click(4.0, 0.8, 0.7), // far in space+time
    ];
    const segs = planner.planSegments(clicks, 10);
    expect(segs).toHaveLength(2);
    expect(segs[0].center.x).toBeCloseTo((0.2 + 0.21) / 2, 6);
  });

  it('begins and ends at scale 1', () => {
    const segs = planner.planSegments([click(2, 0.3, 0.4)], 10);
    expect(cameraAt(0, segs).scale).toBe(1);
    expect(cameraAt(10, segs).scale).toBe(1);
  });

  it('holds at maxScale during the click dwell', () => {
    const segs = planner.planSegments([click(2, 0.3, 0.4)], 10);
    const mid = (segs[0].holdStart + segs[0].holdEnd) / 2;
    const cam = cameraAt(mid, segs);
    expect(cam.scale).toBeCloseTo(defaultAutofocus.maxScale, 6);
    expect(cam.center.x).toBeCloseTo(0.3, 6);
    expect(cam.center.y).toBeCloseTo(0.4, 6);
  });

  it('buttery: zero transition velocity at segment boundaries', () => {
    // Sample the camera's effective velocity around a hold start: the
    // derivative must approach 0 as t → holdStart.
    const segs = planner.planSegments([click(2, 0.5, 0.5)], 20);
    const hs = segs[0].holdStart;
    const eps = 1e-4;
    const vInside =
      Math.abs(cameraAt(hs, segs).scale - cameraAt(hs - eps, segs).scale) / eps;
    // At the seam the camera is fully zoomed — velocity there must be small.
    const vWellInside =
      Math.abs(cameraAt(hs + 0.05, segs).scale - cameraAt(hs, segs).scale) / 0.05;
    expect(vWellInside).toBe(0);
    expect(vInside).toBeLessThan(0.5); // vs 4.0 for a linear ramp
  });

  it('pans directly between nearby click clusters (no zoom-out detour)', () => {
    const segs = planner.planSegments([click(2, 0.2, 0.2), click(3.4, 0.8, 0.8)], 12);
    // When consecutive glides overlap, the camera should still be zoomed
    // somewhere between the two centers — never returning to scale 1 mid-pan.
    const t = segs[1].inStart + 0.01;
    const cam = cameraAt(t, segs);
    expect(cam.scale).toBeGreaterThan(1.2);
  });

  it('handles a glide-in after a coverage gap (no stack overflow)', () => {
    // Two clicks far apart: segment 1 fully ends long before segment 2's
    // glide-in begins. cameraAt must not recurse back into itself.
    const segs = planner.planSegments([click(1, 0.2, 0.2), click(10, 0.8, 0.8)], 15);
    expect(segs).toHaveLength(2);
    const t = segs[1].inStart + 0.1;
    const cam = cameraAt(t, segs);
    expect(Number.isFinite(cam.scale)).toBe(true);
    expect(cam.scale).toBeGreaterThan(1); // gliding in from idle
    // In the gap itself the camera rests at idle.
    const gapT = (segs[0].outEnd + segs[1].inStart) / 2;
    expect(cameraAt(gapT, segs).scale).toBe(1);
  });
});
