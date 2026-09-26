import { describe, expect, it } from 'vitest';
import { Timeline } from '../src/shared/timeline';
import { clipSpans, locate, mediaDuration, playbackTick } from '../src/shared/playback';

const clip = (id: string, sourceStart: number, sourceEnd: number, speed = 1) => ({
  id,
  sourceStart,
  sourceEnd,
  speed,
});

/** Drive playbackTick like the rAF loop: advance the video by `dt` of
 *  wall-clock per frame at the clip's rate, applying jumps. */
function simulate(tl: Timeline, startOut: number, dt = 1 / 60, maxFrames = 10_000) {
  let { index, srcT } = locate(tl, startOut);
  const trace: { outT: number; srcT: number; rate: number }[] = [];
  for (let f = 0; f < maxFrames; f++) {
    const tick = playbackTick(tl, index, srcT);
    if (tick.kind === 'end') {
      trace.push({ outT: tick.outT, srcT, rate: 0 });
      return trace;
    }
    if (tick.kind === 'jump') {
      index = tick.index;
      srcT = tick.seekTo;
    }
    trace.push({ outT: tick.outT, srcT, rate: tick.rate });
    srcT += dt * tick.rate;
  }
  throw new Error('playback never ended');
}

describe('preview playback (BH-04)', () => {
  it('split + delete the first clip: play starts at the kept footage, not source 0', () => {
    // 12s recording split at 4s, first clip deleted.
    const tl = new Timeline(12, [clip('b', 4, 12)]);
    expect(locate(tl, 0)).toEqual({ index: 0, srcT: 4 });
    const trace = simulate(tl, 0);
    expect(Math.min(...trace.map((s) => s.srcT))).toBeGreaterThanOrEqual(4);
    // The playhead is output time: 0 → 8, never the source 4 → 12.
    expect(trace[0].outT).toBeCloseTo(0);
    expect(trace[trace.length - 1].outT).toBeCloseTo(8);
  });

  it('jumps over a removed middle range to the next clip', () => {
    const tl = new Timeline(10, [clip('a', 0, 3), clip('b', 6, 10)]);
    const trace = simulate(tl, 0);
    // No frame shows source 3..6.
    expect(trace.some((s) => s.srcT > 3.02 && s.srcT < 6)).toBe(false);
    // Output time is continuous across the jump.
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i].outT - trace[i - 1].outT).toBeLessThan(0.05);
    }
    expect(trace[trace.length - 1].outT).toBeCloseTo(7);
  });

  it('plays each clip at its speed', () => {
    const tl = new Timeline(10, [clip('a', 0, 4, 2), clip('b', 4, 10, 1)]);
    const t1 = playbackTick(tl, 0, 1);
    expect(t1).toMatchObject({ kind: 'play', rate: 2, outT: 0.5 });
    const t2 = playbackTick(tl, 0, 4);
    expect(t2).toMatchObject({ kind: 'jump', index: 1, seekTo: 4, rate: 1, outT: 2 });
  });

  it('plays reordered clips in timeline order', () => {
    const tl = new Timeline(10, [clip('b', 5, 10), clip('a', 0, 5)]);
    expect(playbackTick(tl, 0, 10)).toMatchObject({ kind: 'jump', index: 1, seekTo: 0, outT: 5 });
    // Source 2 inside clip index 1 is output 7, even though source 2 < 5.
    expect(playbackTick(tl, 1, 2)).toMatchObject({ kind: 'play', outT: 7 });
    expect(playbackTick(tl, 1, 5)).toMatchObject({ kind: 'end', outT: 10 });
  });

  it('stops at the end instead of running past it', () => {
    const tl = new Timeline(12, [clip('a', 0, 6)]);
    expect(playbackTick(tl, 0, 6.001)).toEqual({ kind: 'end', outT: 6 });
  });

  it('locate clamps past the end to the last frame', () => {
    const tl = new Timeline(10, [clip('a', 2, 4), clip('b', 7, 9)]);
    expect(locate(tl, 99)).toEqual({ index: 1, srcT: 9 });
    expect(locate(tl, 2.5)).toEqual({ index: 1, srcT: 7.5 });
    expect(clipSpans(tl).map((s) => [s.outStart, s.outEnd])).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });
});

describe('mediaDuration (BH-12)', () => {
  it('falls back when MediaRecorder WebM reports Infinity', () => {
    expect(mediaDuration(Infinity, 12)).toBe(12);
    expect(mediaDuration(NaN, 12)).toBe(12);
    expect(mediaDuration(0, 12)).toBe(12);
    expect(mediaDuration(11.5, 12)).toBe(11.5);
  });
});
