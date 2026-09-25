import { describe, expect, it } from 'vitest';
import { CursorSmoother, catmullRom } from '../src/shared/cursor';
import { Timeline } from '../src/shared/timeline';
import { clickEvents, ripplesAt } from '../src/shared/ripples';
import type { CursorSample } from '../src/shared/types';

describe('CursorSmoother', () => {
  const smoother = new CursorSmoother();

  it('resamples moves at fixed step and preserves clicks', () => {
    const samples: CursorSample[] = [
      { time: 0, x: 0, y: 0, kind: 'move' },
      { time: 0.5, x: 0.5, y: 0.5, kind: 'clickDown' },
      { time: 1, x: 1, y: 1, kind: 'move' },
    ];
    const out = smoother.smoothedPath(samples);
    expect(out.length).toBeGreaterThanOrEqual(60);
    expect(out.some((s) => s.kind === 'clickDown')).toBe(true);
  });

  it('catmullRom interpolates endpoints exactly', () => {
    expect(catmullRom(0, 1, 2, 3, 0)).toBeCloseTo(1);
    expect(catmullRom(0, 1, 2, 3, 1)).toBeCloseTo(2);
  });
});

describe('Timeline', () => {
  it('maps output↔source through speed', () => {
    const tl = new Timeline(6, [
      { id: 'a', sourceStart: 0, sourceEnd: 4, speed: 1 },
      { id: 'b', sourceStart: 4, sourceEnd: 6, speed: 2 },
    ]);
    expect(tl.outputDuration).toBeCloseTo(5);
    expect(tl.sourceTime(4.5)).toBeCloseTo(5);
    expect(tl.outputTime(5)).toBeCloseTo(4.5);
    expect(tl.outputTime(7)).toBeNull();
  });

  it('splits a clip at the playhead', () => {
    const tl = new Timeline(10);
    expect(tl.split(4)).toBe(true);
    expect(tl.clips).toHaveLength(2);
    expect(tl.clips[0].sourceEnd).toBeCloseTo(4);
  });
});

describe('ripples', () => {
  it('maps clicks through the timeline and expires them', () => {
    const tl = new Timeline(10);
    const events = clickEvents([{ time: 2, x: 0.3, y: 0.4, kind: 'clickDown' }], tl);
    expect(events).toHaveLength(1);
    expect(ripplesAt(2.2, events, 0.7)).toHaveLength(1);
    expect(ripplesAt(2.2, events, 0.7)[0].progress).toBeCloseTo(0.2 / 0.7);
    expect(ripplesAt(3.0, events, 0.7)).toHaveLength(0);
  });
});
