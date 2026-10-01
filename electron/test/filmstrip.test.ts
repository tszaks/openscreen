import { describe, expect, it } from 'vitest';
import { clipFrames, filmstripTimes } from '../src/shared/filmstrip';

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
  it('shows every frame inside the clip', () => {
    expect(clipFrames(times, 2, 5, 10)).toEqual([2, 3, 4]);
  });
  it('thins evenly to the most a clip has room for', () => {
    expect(clipFrames(times, 0, 10, 3)).toEqual([1, 5, 8]);
  });
  it('gives a clip too short for a frame the one nearest its middle', () => {
    expect(clipFrames(times, 4.6, 4.9, 4)).toEqual([4]);
    expect(clipFrames(times, 9.8, 10, 4)).toEqual([9]);
  });
  it('is empty with no frames or no room', () => {
    expect(clipFrames([], 0, 1, 3)).toEqual([]);
    expect(clipFrames(times, 0, 10, 0)).toEqual([]);
  });
});
