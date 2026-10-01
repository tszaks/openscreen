import { describe, expect, it } from 'vitest';
import { autoZoomOn, withAutoZoom } from '../src/shared/types';
import {
  anchoredScroll,
  clampInspector,
  clampTimeline,
  clampZoom,
  fmtTick,
  laneHeights,
  naturalTimelineHeight,
  rulerTicks,
  ZOOM_MAX,
} from '../src/shared/timelineView';

describe('pane sizes', () => {
  it('keeps the inspector between its bounds and under half the window', () => {
    expect(clampInspector(100, 1600)).toBe(280);
    expect(clampInspector(500, 1600)).toBe(500);
    expect(clampInspector(900, 1600)).toBe(640);
    expect(clampInspector(600, 1000)).toBe(500);
    // A window too narrow for the floor still gets the floor, not less.
    expect(clampInspector(600, 400)).toBe(280);
  });

  it('never shrinks the timeline below its natural height or starves the preview', () => {
    expect(clampTimeline(100, 190, 1000, 52)).toBe(190);
    expect(clampTimeline(400, 190, 1000, 52)).toBe(400);
    expect(clampTimeline(900, 190, 1000, 52)).toBe(1000 - 52 - 220);
    expect(clampTimeline(900, 190, 300, 52)).toBe(190);
  });

  it('clamps zoom', () => {
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(999)).toBe(ZOOM_MAX);
  });
});

describe('anchoredScroll', () => {
  it('keeps the point under the anchor still when zooming', () => {
    // 1000px content, viewport 500, scrolled 200, anchor 100px in => content x 300 (30%).
    const next = anchoredScroll(200, 100, 1000, 2000, 500);
    expect((next + 100) / 2000).toBeCloseTo(0.3);
  });
  it('stays in range at the edges', () => {
    expect(anchoredScroll(0, 0, 1000, 500, 500)).toBe(0);
    expect(anchoredScroll(500, 500, 1000, 4000, 500)).toBe(3500);
  });
});

describe('ruler', () => {
  it('labels a 2.1s take in tenths instead of repeating 0:00 0:00 0:01', () => {
    const { ticks, step } = rulerTicks(2.1);
    expect(step).toBe(0.25);
    const labels = ticks.map((t) => fmtTick(t, step));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.slice(0, 3)).toEqual(['0:00.00', '0:00.25', '0:00.50']);
  });
  it('adds finer ticks as you zoom in', () => {
    expect(rulerTicks(60, 1).step).toBe(10);
    expect(rulerTicks(60, 6).step).toBe(1);
    expect(rulerTicks(60, 40).step).toBe(0.25);
  });
  it('formats whole-second and sub-second ticks', () => {
    expect(fmtTick(75, 5)).toBe('1:15');
    expect(fmtTick(61.5, 0.5)).toBe('1:01.5');
    expect(fmtTick(0.1, 0.1)).toBe('0:00.1');
  });
});

describe('lane heights and the natural timeline height', () => {
  it('adds the phone taps lane, and ends with the music lane', () => {
    expect(laneHeights(false)).toEqual([56, 22, 38, 34]);
    expect(laneHeights(true)).toEqual([56, 22, 26, 38, 34]);
  });
  it('is padding + ruler + lanes + gaps', () => {
    expect(naturalTimelineHeight(laneHeights(false))).toBe(6 + 14 + 22 + 150 + 24);
    expect(naturalTimelineHeight(laneHeights(true))).toBe(6 + 14 + 22 + 176 + 30);
  });
  it('lifts a height saved under shorter lanes up to the new floor', () => {
    const floor = naturalTimelineHeight(laneHeights(false));
    expect(clampTimeline(157, floor, 900, 52)).toBe(floor);
  });
});

describe('automatic zoom switch', () => {
  const base = { autofocus: true, dwell: true, fromTaps: true };
  it('reads on/off per kind of take', () => {
    expect(autoZoomOn(base, false)).toBe(true);
    expect(autoZoomOn({ ...base, autofocus: false }, false)).toBe(true); // dwell alone still zooms
    expect(autoZoomOn({ ...base, autofocus: false, dwell: false }, false)).toBe(false);
    expect(autoZoomOn({ ...base, fromTaps: false }, true)).toBe(false);
    expect(autoZoomOn({ ...base, autofocus: false, dwell: false }, true)).toBe(true); // phones zoom from taps
  });
  it('turns every automatic source off and back on, leaving the rest alone', () => {
    const z = { ...base, depth: 1.6 };
    expect(withAutoZoom(z, false, false)).toEqual({ ...z, autofocus: false, dwell: false });
    expect(withAutoZoom({ ...z, autofocus: false, dwell: false }, false, true)).toEqual(z);
    expect(withAutoZoom(z, true, false)).toEqual({ ...z, fromTaps: false });
    expect(autoZoomOn(withAutoZoom(z, true, false), true)).toBe(false);
  });
});
