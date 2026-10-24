import { describe, expect, it } from 'vitest';
import { Timeline } from '../src/shared/timeline';
import { remapProject, remapRange, remapTime, remapTransitions } from '../src/shared/remap';
import { defaultPhone3D, type PoseTransition } from '../src/shared/phone3d/model';
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

describe('remapTransitions (3D moves follow the moment they land on)', () => {
  const tr = (id: string, start: number, end: number): PoseTransition => ({
    id, start, end, to: { turn: 90, tilt: 0, rotate: 0, size: 1, x: 0, y: 0, light: 0, focus: 1 }, easing: { kind: 'smooth' },
  });
  const oldTl = new Timeline(12, [clip('a', 0, 12)]);

  it('anchors on the End and keeps the duration', () => {
    // Cut 2..4: a move ending at 6 now ends at 4, still 1.5 s long.
    const newTl = new Timeline(12, [clip('a', 0, 2), clip('b', 4, 12)]);
    expect(remapTransitions([tr('m', 4.5, 6)], oldTl, newTl)).toEqual([tr('m', 2.5, 4)]);
  });

  it('a lost End snaps to the nearest surviving moment; a move with no footage at or before its End is dropped', () => {
    // Trim to 0..5: a move 4..7 loses its end; it lands where its start's footage is.
    const trimmed = new Timeline(12, [clip('a', 0, 5)]);
    const [m] = remapTransitions([tr('m', 4, 7)], oldTl, trimmed);
    expect(m.end).toBe(5);
    expect(m.end - m.start).toBeCloseTo(3, 12);
    // A move entirely in removed footage snaps to the nearest surviving moment (remapTime), keeping its length.
    expect(remapTransitions([tr('late', 8, 9)], oldTl, trimmed)).toEqual([tr('late', 4, 5)]);
    // Cut the head 0..5: a move 1..4 has nothing at or before its End; its Start falls to 0 and it is too short.
    expect(remapTransitions([tr('head', 1, 4)], oldTl, new Timeline(12, [clip('a', 5, 12)]))).toEqual([]);
  });

  it('clamps start at 0 (dropping a move squeezed below MIN_TRANSITION) and sorts by (start, id)', () => {
    const cutHead = new Timeline(12, [clip('a', 3, 12)]);
    const out = remapTransitions([tr('late', 5, 6), tr('b', 3.05, 3.1), tr('a', 2, 3.5)], oldTl, cutHead);
    expect(out.map((t) => t.id)).toEqual(['a', 'late']);
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBeCloseTo(0.5, 12);
  });

  it('remapProject carries phone3d.transitions and never creates the key', () => {
    const p = project([clip('a', 0, 12)]);
    const newTl = new Timeline(12, [clip('a', 0, 2), clip('b', 4, 12)]);
    const flat = remapProject(p, oldTl, newTl);
    expect('phone3d' in flat).toBe(false);
    const with3d = { ...p, phone3d: { ...defaultPhone3D(), transitions: [tr('m', 4.5, 6)] } };
    const moved = remapProject(with3d, oldTl, newTl);
    expect(moved.phone3d!.transitions).toEqual([tr('m', 2.5, 4)]);
    expect(moved.phone3d!.pose).toEqual(with3d.phone3d.pose);
  });
});
