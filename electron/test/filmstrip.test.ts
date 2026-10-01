import { describe, expect, it } from 'vitest';
import { clipFrames, filmstripTile, filmstripTimes, slotFrame, tilesForClip, visibleSlots } from '../src/shared/filmstrip';

describe('filmstripTimes', () => {
  it('spaces frames evenly at the middle of each slice', () => {
    expect(filmstripTimes(10, 5)).toEqual([1, 3, 5, 7, 9]);
  });
  it('is empty for a recording with no length or no frames wanted', () => {
    expect(filmstripTimes(0, 5)).toEqual([]);
    expect(filmstripTimes(NaN, 5)).toEqual([]);
    expect(filmstripTimes(10, 0)).toEqual([]);
  });
});

describe('clipFrames', () => {
  const times = filmstripTimes(10, 10); // 0.5, 1.5, … 9.5
  it('gives each slot the frame nearest its moment', () => {
    expect(clipFrames(times, 2, 5, 3)).toEqual([2, 3, 4]);
    expect(clipFrames(times, 0, 10, 4)).toEqual([1, 3, 6, 8]);
  });
  it('repeats the nearest frame when the clip has more slots than frames', () => {
    expect(clipFrames(times, 4, 6, 4)).toEqual([4, 4, 5, 5]);
  });
  it('gives a clip too short for a frame the one nearest its middle', () => {
    expect(clipFrames(times, 4.6, 4.9, 1)).toEqual([4]);
    expect(clipFrames(times, 9.8, 10, 2)).toEqual([9, 9]);
  });
  it('is empty with no frames or no room', () => {
    expect(clipFrames([], 0, 1, 3)).toEqual([]);
    expect(clipFrames(times, 0, 10, 0)).toEqual([]);
  });
});

describe('filmstripTile', () => {
  const phone = { width: 1206, height: 2622 };
  const mac = { width: 1920, height: 1080 };
  const square = { width: 1080, height: 1080 };
  it('keeps a portrait frame whole: a narrow tile at the lane height', () => {
    expect(filmstripTile(phone, 37)).toEqual({ width: 17, portrait: true });
    expect(filmstripTile(phone, 56)).toEqual({ width: 26, portrait: true });
  });
  it('keeps landscape and square frames whole at their own shape', () => {
    expect(filmstripTile(mac, 37)).toEqual({ width: 66, portrait: false });
    expect(filmstripTile(mac, 56)).toEqual({ width: 100, portrait: false });
    expect(filmstripTile(square, 40)).toEqual({ width: 40, portrait: false });
  });
  it('caps very wide sources, floors very tall ones, survives a missing size', () => {
    expect(filmstripTile({ width: 4000, height: 500 }, 40).width).toBe(96);
    expect(filmstripTile({ width: 300, height: 3000 }, 40).width).toBe(12);
    expect(filmstripTile({ width: 0, height: 0 }, 40)).toEqual({ width: 71, portrait: false });
  });
});

describe('tilesForClip', () => {
  it('fills a clip with as many tiles as its width holds', () => {
    expect(tilesForClip(1, 1200, 30)).toBe(40); // a whole take at zoom 1
    expect(tilesForClip(0.5, 1200, 71)).toBe(8);
  });
  it('grows with the timeline zoom (the lanes get wider)', () => {
    const at = (zoom: number) => tilesForClip(0.25, 1000 * zoom, 30);
    expect([at(1), at(2), at(4)]).toEqual([8, 17, 33]);
  });
  it('keeps tiles at their own width at deep zoom (no cap: drawing is windowed)', () => {
    // A whole portrait take at 40× zoom on a 1200px timeline.
    expect(tilesForClip(1, 1200 * 40, 18)).toBe(2667);
  });
  it('always shows at least one tile', () => {
    expect(tilesForClip(0.001, 1000, 71)).toBe(1);
    expect(tilesForClip(0.5, 0, 30)).toBe(1);
  });
});

describe('visibleSlots', () => {
  it('draws only what is in view, plus a viewport of margin each side', () => {
    // 2,667 slots of 18px from x=0; viewing 9,000..10,200 (1,200px wide).
    expect(visibleSlots(2667, 18, 0, 9000, 10200)).toEqual([433, 634]);
  });
  it('draws a whole clip that fits in view', () => {
    expect(visibleSlots(40, 30, 0, 0, 1200)).toEqual([0, 40]);
  });
  it('accounts for where the clip starts', () => {
    expect(visibleSlots(100, 20, 5000, 0, 1000)).toEqual([0, 0]); // entirely past the margin
    expect(visibleSlots(100, 20, 1500, 0, 1000)).toEqual([0, 25]);
  });
  it('is empty for no slots', () => {
    expect(visibleSlots(0, 20, 0, 0, 1000)).toEqual([0, 0]);
  });
});

describe('slotFrame', () => {
  it('matches clipFrames slot by slot', () => {
    const times = filmstripTimes(10, 10);
    const all = clipFrames(times, 1, 9, 7);
    expect(all.map((_, k) => slotFrame(times, 1, 9, 7, k))).toEqual(all);
  });
});
