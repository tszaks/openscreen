import { describe, expect, it } from 'vitest';
import { applyOps3d } from '../src/shared/agentOps';
import { springSettleTime } from '../src/shared/phone3d/easing3d';
import { defaultPhone3D, FRONT, type Phone3D, type PoseTransition } from '../src/shared/phone3d/model';
import { expandShot } from '../src/shared/phone3d/shots';
import { poseAt } from '../src/shared/phone3d/pose';
import { defaultProject, type Project } from '../src/shared/types';
import {
  addMoveOp,
  bezierFrom,
  chipFor,
  clock,
  dragTimes,
  durationOps,
  easeCaption,
  easingOps,
  fovForMm,
  frameWindow,
  inactiveText,
  isFitted,
  keyTimes,
  laneHit,
  laneLayout,
  LENS_RANGE,
  lensMm,
  marqueeIds,
  minus,
  mixedChannels,
  moveName,
  multiPoseOps,
  nextKey,
  parseBezier,
  parseTime,
  PACE_RANGE,
  phone3dAsOps,
  poseEditOps,
  prevKey,
  qualityHint,
  samePart,
  sameRecipe,
  shotGroups,
  shotLine,
  snapTime,
  springBounce,
  springFrom,
  springPace,
  springShortfall,
  warningText,
  keyPoses,
  lockPose,
  lockedOps,
} from '../src/renderer/src/phone3d/panelModel';

/** An iPhone take: 1179×2556, 60 s. */
function phoneProject(p3?: Partial<Phone3D>): Project {
  const p = defaultProject({ screenVideoFile: 'screen.mov', sourceSize: { width: 1179, height: 2556 }, duration: 60, sourceKind: 'iosDevice' } as never);
  return p3 ? { ...p, phone3d: { ...defaultPhone3D(), ...p3 } } : p;
}

let n = 0;
const id = () => `m${++n}`;

/** A spin-in at 0 and two Laybacks, as Auto 3D writes them. */
function plan(): PoseTransition[] {
  n = 0;
  const spin = expandShot('spin-in', { start: 0 }, FRONT, id).transitions;
  const lay1 = expandShot('hero-layback', { start: 4 }, FRONT, id).transitions;
  const lay2 = expandShot('hero-layback', { start: 9, direction: -1 }, FRONT, id).transitions;
  return [...spin, ...lay1, ...lay2];
}

describe('words', () => {
  it('shows a true minus and m:ss.ss times', () => {
    expect(minus(-24)).toBe('−24');
    expect(minus(24)).toBe('24');
    expect(clock(53.09)).toBe('0:53.09');
    expect(clock(637.07)).toBe('10:37.07');
    expect(clock(59.999)).toBe('1:00.00');
  });

  it('reads a typed keyframe time in every form the toggle accepts', () => {
    expect(parseTime('0:53.20', 1)).toBeCloseTo(53.2);
    expect(parseTime('53.2', 1)).toBeCloseTo(53.2);
    expect(parseTime('+0.1', 53.09)).toBeCloseTo(53.19);
    expect(parseTime('−0.25', 2)).toBeCloseTo(1.75);
    expect(parseTime('1:75', 0)).toBeNull();
    expect(parseTime('soon', 0)).toBeNull();
  });

  it('reads a pasted cubic-bezier and refuses what the op would refuse', () => {
    expect(parseBezier('cubic-bezier(.7, 0, .16, 1)')).toEqual([0.7, 0, 0.16, 1]);
    expect(parseBezier('.68 −.22 .24 1.22')).toEqual([0.68, -0.22, 0.24, 1.22]);
    expect(parseBezier('cubic-bezier(1.2, 0, .5, 1)')).toBeNull(); // x out of 0..1
    expect(parseBezier('(0.5, 3, 0.5, 1)')).toBeNull(); // y out of -1..2
    expect(parseBezier('0.5 0.5 0.5')).toBeNull();
  });

  it('describes a custom curve from its handles', () => {
    expect(easeCaption({ kind: 'bezier', x1: 0.68, y1: -0.22, x2: 0.24, y2: 1.22 })).toBe('Your curve: winds up first, overshoots, then lands.');
    expect(easeCaption({ kind: 'bezier', x1: 0.7, y1: 0, x2: 0.16, y2: 1 })).toBe('Your curve: slow start, soft landing.');
    expect(easeCaption({ kind: 'cinematic' })).toMatch(/soft landing/);
  });

  it('starts Custom from the current preset\'s handles', () => {
    expect(bezierFrom({ kind: 'cinematic' })).toEqual([0.7, 0, 0.16, 1]);
    expect(bezierFrom({ kind: 'bezier', x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 })).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});

describe('springs in pace and bounce', () => {
  it('round-trips stiffness/damping through pace/bounce', () => {
    const s = springFrom(springPace(180), springBounce(180, 18));
    expect(s.stiffness).toBeCloseTo(180, 0);
    expect(s.damping).toBeCloseTo(18, 1);
  });
  it('stays inside the op\'s spring range at the field limits', () => {
    for (const [pace, bounce] of [[PACE_RANGE[0], 1], [PACE_RANGE[1], 0], [0.01, 2], [99, -1]] as const) {
      const s = springFrom(pace, bounce);
      expect(s.stiffness).toBeGreaterThanOrEqual(1);
      expect(s.stiffness).toBeLessThanOrEqual(1000);
      expect(s.damping).toBeGreaterThanOrEqual(0.1);
      expect(s.damping).toBeLessThanOrEqual(200);
    }
  });
  it('knows a fitted spring from a squeezed one (the real Auto 3D Layback return)', () => {
    const T = springSettleTime(180, 18);
    const squeezed = { start: 1, end: 1.63, easing: { kind: 'spring' as const, stiffness: 180, damping: 18 } };
    expect(isFitted(squeezed)).toBe(false);
    expect(springShortfall(squeezed)).toBeCloseTo(T - 0.63, 6);
    const fitted = { ...squeezed, end: 1 + T };
    expect(isFitted(fitted)).toBe(true);
    expect(springShortfall(fitted)).toBe(0);
    expect(springShortfall({ start: 0, end: 1, easing: { kind: 'cinematic' } })).toBe(0);
  });
});

describe('lens', () => {
  it('shows the default 22° field of view as 62 mm and maps back', () => {
    expect(Math.round(lensMm(22))).toBe(62);
    expect(fovForMm(lensMm(33))).toBeCloseTo(33, 9);
  });
  it('keeps the lens range inside the fov range the op accepts', () => {
    expect(fovForMm(LENS_RANGE[0])).toBeLessThanOrEqual(60);
    expect(fovForMm(LENS_RANGE[1])).toBeGreaterThanOrEqual(8);
  });
});

describe('shots and names', () => {
  it('groups a Layback\'s two moves into one shot and names each move', () => {
    const list = plan();
    expect(shotGroups(list).map((g) => g.length)).toEqual([1, 2, 2]);
    expect(moveName(list, list[0].id)).toBe('Spin in');
    expect(moveName(list, list[1].id)).toBe('Layback · out');
    expect(moveName(list, list[2].id)).toBe('Layback · back');
    expect(shotLine(list, list[2].id)).toBe('Shot 2 of 3 · move 2 of 2');
    expect(shotLine(list, list[0].id)).toBe('Shot 1 of 3');
  });
  it('names a hand-made move by its easing', () => {
    const m: PoseTransition = { id: 'x', start: 1, end: 2, to: FRONT, easing: { kind: 'smooth' } };
    expect(moveName([m], 'x')).toBe('Smooth move');
  });
  it('selects all Laybacks, or the same move of every Layback', () => {
    const list = plan();
    expect(sameRecipe(list, list[1].id)).toEqual([list[1].id, list[2].id, list[3].id, list[4].id]);
    expect(samePart(list, list[1].id)).toEqual([list[1].id, list[3].id]);
    expect(samePart(list, list[4].id)).toEqual([list[2].id, list[4].id]);
  });
});

describe('the target chip', () => {
  const p3 = () => ({ pose: { ...FRONT }, transitions: plan() });
  const o = { editing: 'auto' as const, autoKey: false, fps: 30 };

  it('says Base pose with no moves, and "a change adds a move" with Auto key', () => {
    const empty = { pose: { ...FRONT }, transitions: [] };
    expect(chipFor(empty, 3, o).mode).toBe('base');
    expect(chipFor(empty, 3, { ...o, autoKey: true }).mode).toBe('none');
  });

  it('is On a keyframe within half a frame, not a loose distance', () => {
    const s = p3();
    const lay = s.transitions[1];
    expect(chipFor(s, lay.end + 0.016, o)).toMatchObject({ mode: 'on', label: 'End of Layback · out' });
    expect(chipFor(s, lay.end + 0.017, o).mode).not.toBe('on');
  });

  it('is Near inside a move, with the distance to the end it edits', () => {
    const s = p3();
    const lay = s.transitions[1];
    const c = chipFor(s, lay.end - 0.2, o);
    expect(c.mode).toBe('near');
    expect(c.dist).toBeCloseTo(0.2, 9);
    expect(c.label).toBe('End of Layback · out');
  });

  it('holds the last End in a hold, or adds a move there with Auto key', () => {
    const s = p3();
    expect(chipFor(s, 7, o)).toMatchObject({ mode: 'holding', label: 'End of Layback · back' });
    expect(chipFor(s, 7, { ...o, autoKey: true }).mode).toBe('none');
  });

  it('edits the base pose when Base pose is chosen, even with moves', () => {
    expect(chipFor(p3(), 7, { ...o, editing: 'base' }).mode).toBe('base');
  });

  it('turns each chip into the op the CLI would run', () => {
    const s = p3();
    const lay = s.transitions[1];
    const near = poseEditOps(s, chipFor(s, lay.end - 0.2, o), { turn: 10 }, lay.end - 0.2);
    expect(near).toEqual({ ops: [{ op: 'setPose', id: lay.id, end: 'to', turn: 10 }], seek: lay.end });
    const base = poseEditOps(s, chipFor(s, 7, { ...o, editing: 'base' }), { tilt: 3 }, 7);
    expect(base).toEqual({ ops: [{ op: 'setPose', target: 'base', tilt: 3 }] });
  });

  it('with Auto key adds a move that ends at the playhead, and the result validates', () => {
    const p = phoneProject({ transitions: plan() });
    const s = p.phone3d!;
    const r = poseEditOps(s, chipFor(s, 7.5, { ...o, autoKey: true }), { turn: 30 }, 7.5);
    expect('ops' in r && r.ops[0]).toMatchObject({ op: 'addTransition', end: 7.5, to: { turn: 30 } });
    const out = applyOps3d(p, 'ops' in r ? r.ops : []);
    expect('project' in out).toBe(true);
    if ('project' in out) expect(poseAt(out.project.phone3d!, 7.5).turn).toBeCloseTo(30, 9);
  });

  it('refuses an Auto key move squeezed against the move before', () => {
    const s = p3();
    const end = s.transitions[2].end;
    const r = poseEditOps(s, chipFor(s, end + 0.05, { ...o, autoKey: true }), { turn: 30 }, end + 0.05);
    expect(r).toHaveProperty('error');
  });

  it('locks a gesture on one keyframe; with Auto key the gesture first adds a still move, then edits its End', () => {
    const p = phoneProject({ transitions: plan() });
    const s = p.phone3d!;
    const r = lockPose(s, chipFor(s, 7.5, { ...o, autoKey: true }), 7.5, 'new1');
    expect('lock' in r && r.lock).toEqual({ kind: 'key', id: 'new1', end: 'to' });
    if (!('lock' in r)) return;
    // The added move holds the pose (nothing moves until the drag does) …
    const added = applyOps3d(p, r.ops, { newId: () => 'new1' });
    expect('project' in added).toBe(true);
    if (!('project' in added)) return;
    expect(poseAt(added.project.phone3d!, 7.5)).toEqual(poseAt(s, 7.5));
    // … and every change of the drag edits that same End, two in a row included.
    const a = applyOps3d(added.project, lockedOps(r.lock, { turn: 10 }));
    const b = 'project' in a ? applyOps3d(a.project, lockedOps(r.lock, { turn: 20 })) : a;
    expect('project' in b && poseAt(b.project.phone3d!, 7.5).turn).toBeCloseTo(20, 9);
    expect('project' in b && b.project.phone3d!.transitions.length).toBe(s.transitions.length + 1);
  });

  it('locks Near on the End it edits and asks the playhead to go there', () => {
    const s = p3();
    const lay = s.transitions[1];
    const r = lockPose(s, chipFor(s, lay.end - 0.2, o), lay.end - 0.2, 'unused');
    expect(r).toEqual({ lock: { kind: 'key', id: lay.id, end: 'to' }, ops: [], seek: lay.end });
    expect(lockedOps({ kind: 'base' }, { size: 0.9 })).toEqual([{ op: 'setPose', target: 'base', size: 0.9 }]);
  });

  it('steps between keyframes for J and K', () => {
    const list = plan();
    const ks = keyTimes(list);
    expect(ks[0]).toBe(0);
    expect(nextKey(list, 0)).toBe(ks[1]);
    expect(prevKey(list, ks[2])).toBe(ks[1]);
    expect(prevKey(list, 0)).toBeNull();
    expect(nextKey(list, 1e9)).toBeNull();
  });
});

describe('many moves at once', () => {
  it('shows "–" for channels that differ (mirrored Laybacks) and keeps shared ones', () => {
    const s = { pose: { ...FRONT }, transitions: plan() };
    const outs = [s.transitions[1].id, s.transitions[3].id];
    const mixed = mixedChannels(keyPoses(s, outs, 'to'));
    expect(mixed.has('turn')).toBe(true); // −24 and 24
    expect(mixed.has('tilt')).toBe(false); // 16 and 16
  });

  it('adds the same change to each move when a "–" field is dragged, as one op list', () => {
    const p = phoneProject({ transitions: plan() });
    const s = p.phone3d!;
    const outs = [s.transitions[1].id, s.transitions[3].id];
    const ops = multiPoseOps(s, outs, 'to', 'turn', 5, 'add');
    const r = applyOps3d(p, ops);
    expect('project' in r).toBe(true);
    if (!('project' in r)) return;
    const after = keyPoses(r.project.phone3d!, outs, 'to').map((q) => q.turn);
    expect(after).toEqual([-19, 29]);
  });

  it('sets every move when a value is typed', () => {
    const s = { pose: { ...FRONT }, transitions: plan() };
    const ops = multiPoseOps(s, [s.transitions[1].id, s.transitions[3].id], 'to', 'tilt', 9, 'set');
    expect(ops.map((x) => x.tilt)).toEqual([9, 9]);
  });

  it('never sends a value the op would refuse (clamped to the pose range)', () => {
    const s = { pose: { ...FRONT }, transitions: plan() };
    const ops = multiPoseOps(s, [s.transitions[1].id], 'to', 'tilt', 500, 'add');
    expect(ops[0].tilt).toBe(85);
  });

  it('sets an easing, fitting a spring\'s length, and durations, for every move', () => {
    const p = phoneProject({ transitions: plan() });
    const ids = [p.phone3d!.transitions[1].id, p.phone3d!.transitions[3].id];
    const r = applyOps3d(p, easingOps(ids, { kind: 'spring', stiffness: 180, damping: 18 }, true));
    expect('project' in r).toBe(true);
    if ('project' in r) for (const m of r.project.phone3d!.transitions.filter((x) => ids.includes(x.id))) expect(isFitted(m)).toBe(true);
    const d = durationOps(p.phone3d!.transitions, ids, 0.9);
    expect(d.every((x) => x.op === 'editTransition' && typeof x.end === 'number')).toBe(true);
  });
});

describe('the lane', () => {
  it('drags absolute times from the move as it was at pointerdown', () => {
    const orig = { start: 2, end: 3 };
    expect(dragTimes(orig, 'body', 0.5, 60)).toEqual({ start: 2.5, end: 3.5 });
    expect(dragTimes(orig, 'body', -5, 60)).toEqual({ start: 0, end: 1 });
    expect(dragTimes(orig, 'end', -2, 60)).toEqual({ start: 2, end: 2.1 }); // never under 0.1 s
    expect(dragTimes(orig, 'start', 2, 60).start).toBeCloseTo(2.9, 9);
    // The same total offset gives the same answer however many moves it took (no build-up).
    expect(dragTimes(orig, 'body', 0.3, 60)).toEqual(dragTimes(orig, 'body', 0.3, 60));
  });

  it('snaps to the playhead and taps within 6 px, else to frames', () => {
    const pps = 100; // 100 px per second: 6 px = 0.06 s
    expect(snapTime(5.04, [{ t: 5, what: 'playhead' }], pps, 30)).toEqual({ t: 5, what: 'playhead' });
    expect(snapTime(5.07, [{ t: 5, what: 'playhead' }], pps, 30)).toEqual({ t: Math.round(5.07 * 30) / 30, what: 'frame' });
    expect(snapTime(5.02, [{ t: 5, what: 'playhead' }, { t: 5.03, what: 'tap' }], pps, 30).what).toBe('tap');
  });

  it('draws touching keys as two halves with split hit areas, and hides keys on narrow blocks', () => {
    const list = plan();
    const zoomed = laneLayout(list, { pxPerSec: 140, selected: [] });
    const lay = list[1];
    const halves = zoomed.keys.filter((k) => k.shape !== 'full');
    expect(halves.length).toBeGreaterThan(0);
    const left = zoomed.keys.find((k) => k.moveId === lay.id && k.which === 'end')!;
    const right = zoomed.keys.find((k) => k.moveId === list[2].id && k.which === 'start')!;
    expect(left.shape).toBe('left');
    expect(right.shape).toBe('right');
    expect(left.hit[1]).toBe(right.hit[0]);
    const out = laneLayout(list, { pxPerSec: 10, selected: [] });
    expect(out.keys).toHaveLength(0); // 0.63 s × 10 px = 6.3 px blocks: no keys
    const far = laneLayout(list, { pxPerSec: 4, selected: [] });
    expect(far.blocks).toHaveLength(1); // only the 1.6 s spin-in is 6 px or wider (6.4 px)
    expect(far.ticks.length).toBe(4);
  });

  it('marks a linked Start hollow and labels only blocks wide enough', () => {
    const list = plan();
    const l = laneLayout(list, { pxPerSec: 140, selected: [] });
    expect(l.keys.find((k) => k.moveId === list[2].id && k.which === 'start')!.hollow).toBe(true);
    expect(l.keys.find((k) => k.moveId === list[0].id && k.which === 'start')!.hollow).toBe(false);
    expect(l.blocks.find((b) => b.id === list[0].id)!.label).toBe('Spin in');
    expect(l.blocks.find((b) => b.id === list[2].id)!.label).toBeNull(); // the second move of a shot
  });

  it('hatches the cut part of a squeezed spring on the one selected block', () => {
    const list = plan();
    const back = list[2];
    const sel = laneLayout(list, { pxPerSec: 100, selected: [back.id] });
    expect(sel.blocks.find((b) => b.id === back.id)!.tail).toBeCloseTo(springShortfall(back) * 100, 6);
    expect(laneLayout(list, { pxPerSec: 100, selected: [back.id, list[0].id] }).blocks.every((b) => b.tail === 0)).toBe(true);
  });

  it('hits keys first, then edges (retime), then the body (slide)', () => {
    const list = plan();
    const l = laneLayout(list, { pxPerSec: 100, selected: [] });
    const spin = l.blocks[0];
    expect(laneHit(l, spin.x)).toMatchObject({ kind: 'key' });
    expect(laneHit(l, spin.x + spin.w / 2)).toEqual({ kind: 'body', id: list[0].id, part: 'body' });
    expect(laneHit(l, 3000)).toEqual({ kind: 'empty' });
  });

  it('selects the moves a selection box touches', () => {
    const list = plan();
    expect(marqueeIds(list, 395, 420, 100)).toEqual([list[1].id]);
    expect(marqueeIds(list, 0, 2000, 100)).toHaveLength(list.length);
  });

  it('frames a selection with room, including a squeezed spring\'s tail', () => {
    const list = plan();
    const w = frameWindow([list[2]])!;
    expect(w.start).toBeLessThan(list[2].start);
    expect(w.end).toBeGreaterThan(list[2].end + springShortfall(list[2]));
    expect(frameWindow([])).toBeNull();
  });
});

describe('ops the editor sends are ones the CLI accepts', () => {
  it('adds a move with T / Option-click from where the phone is', () => {
    const p = phoneProject({ transitions: [] });
    const r = applyOps3d(p, [addMoveOp(p.phone3d!, 2)]);
    expect('project' in r).toBe(true);
    if ('project' in r) expect(r.project.phone3d!.transitions[0]).toMatchObject({ start: 2, end: 3.2, to: { turn: 25 } });
  });

  it('copies the 3D setup as edits.json that rebuilds it exactly', () => {
    const p = phoneProject({ transitions: plan(), glass: 0.4 });
    const fresh = phoneProject();
    let k = 0;
    const ids = p.phone3d!.transitions.map((t) => t.id);
    const r = applyOps3d(fresh, phone3dAsOps(p.phone3d!), { newId: () => ids[k++] });
    expect('project' in r).toBe(true);
    if (!('project' in r)) return;
    const strip = (list: PoseTransition[]) => list.map(({ recipe: _r, ...t }) => t);
    expect(strip(r.project.phone3d!.transitions)).toEqual(strip(p.phone3d!.transitions));
    expect(r.project.phone3d!.glass).toBe(0.4);
  });
});

describe('panel text', () => {
  it('writes warnings in plain words, never raw move ids', () => {
    const at = (t: number) => (t === 8.9 ? 'swipe' : 'tap');
    expect(warningText({ code: 'tap-back', at: 8.9, message: 'x' }, at)).toBe('Faces away at this swipe');
    expect(warningText({ code: 'tap-back', at: 2, message: 'x' }, at)).toBe('Faces away at this tap');
    expect(warningText({ code: 'over-zoom', at: 2, message: 'Move w1 (…) runs during a zoom' }, at)).toBe('Turns during a zoom');
  });
  it('gives the App Store reason and the frame-off reason', () => {
    expect(inactiveText('app-store')!.title).toBe('Flat in App Store layouts.');
    expect(inactiveText('frame-off')!.title).toBe('Needs the device frame.');
    expect(inactiveText('disabled')).toBeNull();
  });
  it('estimates the export cost only when it grows', () => {
    const base = defaultPhone3D();
    expect(qualityHint(base)).toBe('Edges are already smooth at 1×');
    expect(qualityHint({ ...base, supersample: 2 })).toMatch(/^Exports about 4× slower$/);
    expect(qualityHint({ ...base, motionBlur: { ...base.motionBlur, samples: 24 } })).toBe('Exports about 2× slower');
  });
});
