import { describe, expect, it } from 'vitest';
import { Timeline } from '../src/shared/timeline';
import { remapProject, remapRange, remapTime } from '../src/shared/remap';
import { defaultProject, type Project } from '../src/shared/types';

const clip = (id: string, sourceStart: number, sourceEnd: number, speed = 1) => ({
  id,
  sourceStart,
  sourceEnd,
  speed,
});

const zoom = (holdStart: number) => ({
  inStart: holdStart - 0.5,
  holdStart,
  holdEnd: holdStart + 0.9,
  outEnd: holdStart + 1.6,
  center: { x: 0.3, y: 0.3 },
  scale: 2,
});

function project(clips: ReturnType<typeof clip>[]): Project {
  const p = defaultProject({
    screenVideoFile: 'screen.webm',
    sourceKind: 'display',
    sourceSize: { width: 1920, height: 1080 },
    duration: 12,
  });
  p.clips = clips;
  p.captions = [{ id: 'c', start: 8, end: 10, text: 'late caption' }];
  p.annotations = [{ id: 'a', start: 1, end: 3, text: 'early', band: 0, hex: '#fff' }];
  p.chapters = [
    { id: 'ch1', start: 0, title: 'Intro' },
    { id: 'ch2', start: 6, title: 'Demo' },
  ];
  p.manualZooms = [zoom(9)];
  return p;
}

/** Old timeline → new one, as the editor's clip edits do. */
const edit = (p: Project, clips: ReturnType<typeof clip>[]) =>
  remapProject(p, new Timeline(12, p.clips), new Timeline(12, clips));

describe('remap on clip edits (BH-07)', () => {
  it('delete: later content moves left, content in the deleted clip goes', () => {
    const p = project([clip('a', 0, 4), clip('b', 4, 12)]);
    const out = edit(p, [clip('b', 4, 12)]);
    expect(out.captions[0].start).toBeCloseTo(4); // source 8 → output 4
    expect(out.captions[0].end).toBeCloseTo(6);
    expect(out.annotations).toHaveLength(0); // 1-3 lived only in clip a
    expect(out.chapters.map((c) => [c.title, +c.start.toFixed(3)])).toEqual([
      ['Intro', 0], // snaps to the first surviving moment
      ['Demo', 2],
    ]);
    expect(out.manualZooms[0].holdStart).toBeCloseTo(5);
    expect(out.manualZooms[0].outEnd - out.manualZooms[0].inStart).toBeCloseTo(2.1);
  });

  it('trim start: everything after shifts by the trimmed amount', () => {
    const p = project([clip('a', 0, 12)]);
    const out = edit(p, [clip('a', 2, 12)]);
    expect(out.captions[0].start).toBeCloseTo(6);
    expect(out.annotations[0].start).toBeCloseTo(0); // 1-3 clamps to 2-3 source
    expect(out.annotations[0].end).toBeCloseTo(1);
    expect(out.manualZooms[0].holdStart).toBeCloseTo(7);
  });

  it('speed: a 2x clip halves output times inside it and after it', () => {
    const p = project([clip('a', 0, 12)]);
    const out = edit(p, [clip('a', 0, 12, 2)]);
    expect(out.captions[0].start).toBeCloseTo(4);
    expect(out.captions[0].end).toBeCloseTo(5);
    expect(out.chapters[1].start).toBeCloseTo(3);
  });

  it('reorder: content travels with its clip', () => {
    const p = project([clip('a', 0, 6), clip('b', 6, 12)]);
    const out = edit(p, [clip('b', 6, 12), clip('a', 0, 6)]);
    expect(out.captions[0].start).toBeCloseTo(2); // source 8 is now 2s in
    expect(out.annotations[0].start).toBeCloseTo(7); // source 1 is now 7s in
    expect(out.chapters.map((c) => c.title)).toEqual(['Demo', 'Intro']);
  });

  it('a range spanning a reordered boundary keeps the part in its first clip', () => {
    const oldTl = new Timeline(12, [clip('a', 0, 6), clip('b', 6, 12)]);
    const newTl = new Timeline(12, [clip('b', 6, 12), clip('a', 0, 6)]);
    expect(remapRange(5, 7, oldTl, newTl)).toEqual({ start: 11, end: 12 });
  });

  it('split changes nothing', () => {
    const oldTl = new Timeline(12, [clip('a', 0, 12)]);
    const newTl = new Timeline(12, [clip('a1', 0, 5), clip('a2', 5, 12)]);
    for (const t of [0, 2.5, 5, 7, 12]) {
      expect(remapTime(t, oldTl, newTl, 'start') ?? 12).toBeCloseTo(t);
    }
  });
});
