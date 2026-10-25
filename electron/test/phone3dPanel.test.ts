import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  deleteTarget,
  changeIsTyped,
  mixedFieldRange,
  movesHaveFocus,
  clock,
  dragTimes,
  durationBase,
  durationDragOps,
  durationOps,
  durationsMixed,
  durationStepOps,
  beginDuration,
  beginMultiPose,
  multiPoseStepOps,
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

/** A hand-made spring move squeezed into 0.63 s (shorter than its 180/18 spring needs), clear of plan()'s moves. */
const squeezed = (): PoseTransition => ({ id: 'sq', start: 20, end: 20.63, to: { ...FRONT, turn: 20 }, easing: { kind: 'spring', stiffness: 180, damping: 18 } });

/**
 * A spin-in at 0 and two Laybacks, as Auto 3D writes them. Since look round 4 a spin-in is 2 moves (spin, settle)
 * and a Layback 4 (out, hold, back, settle): [0] spin, [1] settle | [2] out, [3] hold, [4] back, [5] settle |
 * [6] out (mirrored), [7] hold, [8] back, [9] settle.
 */
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
  it('groups a shot\'s moves into one shot (as many as its recipe writes) and names each move', () => {
    const list = plan();
    expect(shotGroups(list).map((g) => g.length)).toEqual([2, 4, 4]);
    expect(list.map((m) => moveName(list, m.id))).toEqual([
      'Spin in · spin', 'Spin in · settle',
      'Layback · out', 'Layback · hold', 'Layback · back', 'Layback · settle',
      'Layback · out', 'Layback · hold', 'Layback · back', 'Layback · settle',
    ]);
    expect(shotLine(list, list[4].id)).toBe('Shot 2 of 3 · move 3 of 4');
    expect(shotLine(list, list[0].id)).toBe('Shot 1 of 3 · move 1 of 2');
    // Two shots of the same recipe back to back stay two shots.
    n = 0;
    const two = [...expandShot('hero-layback', { start: 0 }, FRONT, id).transitions, ...expandShot('hero-layback', { start: 2.4 }, FRONT, id).transitions];
    expect(shotGroups(two).map((g) => g.length)).toEqual([4, 4]);
    // One-way shots (return: stay) name their own keys.
    n = 0;
    const ttb = expandShot('turn-to-back', { start: 0, ret: 'stay' }, FRONT, id).transitions;
    expect(ttb.map((m) => moveName(ttb, m.id))).toEqual(['To back · out', 'To back · land']);
    n = 0;
    const lay = expandShot('hero-layback', { start: 0, ret: 'stay' }, FRONT, id).transitions;
    expect(lay.map((m) => moveName(lay, m.id))).toEqual(['Layback · out', 'Layback · hold']);
  });
  it('names a hand-made move by its easing', () => {
    const m: PoseTransition = { id: 'x', start: 1, end: 2, to: FRONT, easing: { kind: 'smooth' } };
    expect(moveName([m], 'x')).toBe('Smooth move');
  });
  it('selects all Laybacks, or the same move of every Layback', () => {
    const list = plan();
    expect(sameRecipe(list, list[2].id)).toEqual(list.slice(2).map((m) => m.id));
    expect(samePart(list, list[2].id)).toEqual([list[2].id, list[6].id]);
    expect(samePart(list, list[8].id)).toEqual([list[4].id, list[8].id]);
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
    // The first Layback's last move: a hold follows it (the moves inside a shot touch, so just past their Ends is the
    // next move's Start).
    const lay = s.transitions[5];
    expect(chipFor(s, lay.end + 0.016, o)).toMatchObject({ mode: 'on', label: 'End of Layback · settle' });
    expect(chipFor(s, lay.end + 0.017, o).mode).not.toBe('on');
  });

  it('is Near inside a move, with the distance to the end it edits', () => {
    const s = p3();
    const lay = s.transitions[2];
    const c = chipFor(s, lay.end - 0.2, o);
    expect(c.mode).toBe('near');
    expect(c.dist).toBeCloseTo(0.2, 9);
    expect(c.label).toBe('End of Layback · out');
  });

  it('holds the last End in a hold, or adds a move there with Auto key', () => {
    const s = p3();
    expect(chipFor(s, 7, o)).toMatchObject({ mode: 'holding', label: 'End of Layback · settle' });
    expect(chipFor(s, 7, { ...o, autoKey: true }).mode).toBe('none');
  });

  it('edits the base pose when Base pose is chosen, even with moves', () => {
    expect(chipFor(p3(), 7, { ...o, editing: 'base' }).mode).toBe('base');
  });

  it('turns each chip into the op the CLI would run', () => {
    const s = p3();
    const lay = s.transitions[2];
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
    const end = s.transitions[5].end; // the first Layback's last move
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
    const lay = s.transitions[2];
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
    const outs = [s.transitions[2].id, s.transitions[6].id];
    const mixed = mixedChannels(keyPoses(s, outs, 'to'));
    expect(mixed.has('turn')).toBe(true); // −24 and 24
    expect(mixed.has('tilt')).toBe(false); // 16 and 16
  });

  it('adds the same change to each move when a "–" field is dragged, as one op list', () => {
    const p = phoneProject({ transitions: plan() });
    const s = p.phone3d!;
    const outs = [s.transitions[2].id, s.transitions[6].id];
    const ops = multiPoseOps(s, outs, 'to', 'turn', 5, 'add');
    const r = applyOps3d(p, ops);
    expect('project' in r).toBe(true);
    if (!('project' in r)) return;
    const after = keyPoses(r.project.phone3d!, outs, 'to').map((q) => q.turn);
    expect(after).toEqual([-19, 29]);
  });

  it('sets every move when a value is typed', () => {
    const s = { pose: { ...FRONT }, transitions: plan() };
    const ops = multiPoseOps(s, [s.transitions[2].id, s.transitions[6].id], 'to', 'tilt', 9, 'set');
    expect(ops.map((x) => x.tilt)).toEqual([9, 9]);
  });

  it('never sends a value the op would refuse (clamped to the pose range)', () => {
    const s = { pose: { ...FRONT }, transitions: plan() };
    const ops = multiPoseOps(s, [s.transitions[2].id], 'to', 'tilt', 500, 'add');
    expect(ops[0].tilt).toBe(85);
  });

  it('sets an easing, fitting a spring\'s length, and durations, for every move', () => {
    const p = phoneProject({ transitions: plan() });
    const ids = [p.phone3d!.transitions[2].id, p.phone3d!.transitions[6].id];
    const r = applyOps3d(p, easingOps(ids, { kind: 'spring', stiffness: 180, damping: 18 }, true));
    expect('project' in r).toBe(true);
    if ('project' in r) for (const m of r.project.phone3d!.transitions.filter((x) => ids.includes(x.id))) expect(isFitted(m)).toBe(true);
    const d = durationOps(p.phone3d!.transitions, ids, 0.9);
    expect(d.every((x) => x.op === 'editTransition' && typeof x.end === 'number')).toBe(true);
  });
});

describe('a mixed Duration drag', () => {
  // Track sends `delta` = the total change since pointerdown. One render per
  // pointermove: each step is applied to the project the step before made.
  function drag(p: Project, ids: string[], deltas: number[], withBase: boolean): Project {
    const base = durationBase(p.phone3d!.transitions, ids);
    for (const d of deltas) {
      const now = withBase ? base : durationBase(p.phone3d!.transitions, ids);
      const r = applyOps3d(p, durationDragOps(now, d));
      if (!('project' in r)) throw new Error('refused');
      p = r.project;
    }
    return p;
  }
  const mk = () =>
    phoneProject({
      transitions: [
        { id: 'a', start: 1, end: 1.6, to: { ...FRONT, turn: 20 }, easing: { kind: 'smooth' } },
        { id: 'b', start: 5, end: 6.2, to: { ...FRONT, turn: -20 }, easing: { kind: 'smooth' } },
      ],
    });
  const lens = (p: Project) => p.phone3d!.transitions.map((m) => +(m.end - m.start).toFixed(6));
  const steps = Array.from({ length: 10 }, (_, i) => +(0.01 * (i + 1)).toFixed(2));

  it('ends at the lengths from pointerdown plus the last delta, however many steps it took', () => {
    const p = drag(mk(), ['a', 'b'], steps, true);
    expect(lens(p)).toEqual([0.7, 1.3]);
    expect(p.phone3d!.transitions.map((m) => m.start)).toEqual([1, 5]); // Start stays put
    // Same answer in one step: the result does not depend on how renders batch.
    expect(lens(drag(mk(), ['a', 'b'], [0.1], true))).toEqual([0.7, 1.3]);
  });

  it('would build up if the delta were added to the newest lengths (guards the base)', () => {
    expect(lens(drag(mk(), ['a', 'b'], steps, false))).not.toEqual([0.7, 1.3]);
  });

  it('never makes a move shorter than 0.1 s, and dragging back restores it', () => {
    const p = drag(mk(), ['a', 'b'], [-0.4, -0.8, 0], true);
    expect(lens(p)).toEqual([0.6, 1.2]);
    expect(lens(drag(mk(), ['a', 'b'], [-0.8], true))).toEqual([0.1, 0.4]);
  });
});

describe('a many-move drag that makes every value match part-way', () => {
  // Mirrors MultiView and Track exactly: every pointermove is a new render, so
  // the project, the shown value and the "–" state are read again each step;
  // Track's delta is v minus the value shown at the first change, and
  // ScrubField clamps v to the field's own min and max.
  const two = (a: Partial<PoseTransition>, b: Partial<PoseTransition>) =>
    phoneProject({
      transitions: [
        { id: 'a', start: 1, end: 2, to: { ...FRONT }, easing: { kind: 'smooth' }, ...a },
        { id: 'b', start: 5, end: 6, to: { ...FRONT }, easing: { kind: 'smooth' }, ...b },
      ],
    });
  const apply = (p: Project, ops: ReturnType<typeof durationOps>) => {
    const r = applyOps3d(p, ops);
    if (!('project' in r)) throw new Error('refused');
    return r.project;
  };
  const ids = ['a', 'b'];

  function poseDrag(p: Project, key: 'tilt' | 'size', vs: number[], refix: boolean) {
    const [lo, hi] = key === 'tilt' ? [-85, 85] : [0.2, 3];
    let start: number | null = null;
    let g: ReturnType<typeof beginMultiPose> | null = null;
    const seen: boolean[] = [];
    for (const raw of vs) {
      const v = Math.min(hi, Math.max(lo, raw));
      const p3 = p.phone3d!;
      const shown = keyPoses(p3, ids, 'to')[0][key];
      if (start === null) start = shown;
      // `refix` re-reads the gesture on every render: the old bug.
      if (!g || refix) g = beginMultiPose(p3, ids, 'to');
      seen.push(mixedChannels(keyPoses(p3, ids, 'to')).has(key));
      p = apply(p, multiPoseStepOps(p3, ids, 'to', g, key, v, { delta: v - start, typed: false }));
    }
    return { p, seen };
  }
  const tilts = (p: Project) => p.phone3d!.transitions.map((m) => m.to.tilt);

  it('keeps adding to each Pose value after a range end makes them match, so dragging back restores them', () => {
    const { p, seen } = poseDrag(two({ to: { ...FRONT, tilt: 60 } }, { to: { ...FRONT, tilt: 80 } }), 'tilt', [65, 70, 75, 80, 85, 80, 70, 60], false);
    expect(seen).toContain(false); // the values did match part-way (both at 85)
    expect(tilts(p)).toEqual([60, 80]);
  });

  it('would lose the per-move values if "–" were read again on every render (guards the gesture)', () => {
    const { p } = poseDrag(two({ to: { ...FRONT, tilt: 60 } }, { to: { ...FRONT, tilt: 80 } }), 'tilt', [65, 70, 75, 80, 85, 80, 70, 60], true);
    expect(tilts(p)).toEqual([60, 60]);
  });

  it('does the same at the bottom of the Size range', () => {
    const { p, seen } = poseDrag(two({ to: { ...FRONT, size: 1.2 } }, { to: { ...FRONT, size: 0.6 } }), 'size', [1, 0.6, 0.3, 0.2, 0.6, 1.2], false);
    expect(seen).toContain(false); // both at 20 %
    expect(p.phone3d!.transitions.map((m) => +m.to.size.toFixed(6))).toEqual([1.2, 0.6]);
  });

  it('a typed value sets every move even while the field shows "–"', () => {
    const p = two({ to: { ...FRONT, tilt: 60 } }, { to: { ...FRONT, tilt: 80 } });
    const g = beginMultiPose(p.phone3d!, ids, 'to');
    expect(tilts(apply(p, multiPoseStepOps(p.phone3d!, ids, 'to', g, 'tilt', 10, { delta: -50, typed: true })))).toEqual([10, 10]);
  });

  function durDrag(p: Project, vs: number[], refix: boolean) {
    let start: number | null = null;
    let g: ReturnType<typeof beginDuration> | null = null;
    const seen: boolean[] = [];
    for (const raw of vs) {
      const v = Math.min(60, Math.max(0.1, raw));
      const moves = p.phone3d!.transitions;
      const shown = +(moves[0].end - moves[0].start).toFixed(2);
      if (start === null) start = shown;
      if (!g || refix) g = beginDuration(moves, ids);
      seen.push(durationsMixed(moves, ids));
      p = apply(p, durationStepOps(moves, ids, g, v, { delta: v - start, typed: false }));
    }
    return { p, seen };
  }
  const lens = (p: Project) => p.phone3d!.transitions.map((m) => +(m.end - m.start).toFixed(4));
  const down = [0.45, 0.4, 0.3, 0.2, 0.15, 0.1, 0.2, 0.3, 0.4, 0.5];

  it('keeps adding to each Duration after the 0.1 s floor makes them match, so dragging back restores them', () => {
    const { p, seen } = durDrag(two({ end: 1.5 }, { end: 5.3 }), down, false);
    expect(seen).toContain(false);
    expect(lens(p)).toEqual([0.5, 0.3]);
    expect(p.phone3d!.transitions.map((m) => m.start)).toEqual([1, 5]);
  });

  it('would give every move the same Duration if "–" were read again on every render (guards the gesture)', () => {
    expect(lens(durDrag(two({ end: 1.5 }, { end: 5.3 }), down, true).p)).toEqual([0.5, 0.5]);
  });

  it('is the only way the many-move view changes Pose, Angle and Duration', () => {
    const src = readFileSync(join(__dirname, '../src/renderer/src/phone3d/Phone3DPanel.tsx'), 'utf8');
    const multi = src.slice(src.indexOf('function MultiView('));
    expect(multi).not.toMatch(/multiPoseOps\s*\(|durationDragOps\s*\(|mixed\.has\(\s*k\s*\)|mixedDur\s*&&/);
    expect(multi.match(/multiPoseStepOps\(/g)?.length).toBe(1);
    expect(multi.match(/durationStepOps\(/g)?.length).toBe(1);
    // Angle (light) uses the same pose gesture, and its commit clears it.
    expect(multi).toMatch(/poseStep\('light'/);
    expect(multi).toMatch(/poseStep\('focus'/);
    expect(multi.match(/onCommit=\{endPose\}/g)?.length).toBe(3);
  });
});

describe('a "–" field: typed, stepped, or put back', () => {
  const key = (k: string, draft: string | null = null) => ({ key: k, draft });
  it('a drag or an arrow key on the field itself is never typed (each move changes by the same amount)', () => {
    expect(changeIsTyped(false, null)).toBe(false);
    expect(changeIsTyped(false, key('ArrowUp'))).toBe(false);
  });
  it('in the text input: Enter and blur are typed; Escape puts the value back (not typed)', () => {
    expect(changeIsTyped(true, key('Enter', '12'))).toBe(true);
    expect(changeIsTyped(true, null)).toBe(true);
    expect(changeIsTyped(true, key('Escape', '12'))).toBe(false);
  });
  it('an arrow key on "–" adds to each move; on a typed number it sets them all', () => {
    expect(changeIsTyped(true, key('ArrowUp', '–'))).toBe(false);
    expect(changeIsTyped(true, key('ArrowDown', ''))).toBe(false);
    expect(changeIsTyped(true, key('ArrowUp', '12'))).toBe(true);
    expect(changeIsTyped(true, key('ArrowDown', '−3'))).toBe(true);
  });
  it('the field\'s own number has a range width of room each side, so the first move never stops the others', () => {
    const [lo, hi] = mixedFieldRange(0.1, 60);
    expect(lo).toBeCloseTo(-59.8, 9);
    expect(hi).toBeCloseTo(119.9, 9);
    expect(mixedFieldRange(-720, 720)).toEqual([-2160, 2160]);
  });
  it('a mixed Duration drag keeps every move inside 0.1..60 s on its own', () => {
    const base = [{ id: 'a', start: 0, len: 0.5 }, { id: 'b', start: 2, len: 59 }];
    expect(durationDragOps(base, 5).map((o) => (o as { end?: number }).end)).toEqual([5.5, 62]);
    expect(durationDragOps(base, -5).map((o) => +((o as { end?: number }).end ?? NaN).toFixed(3))).toEqual([0.1, 56]);
  });
});

describe('the ⌫ key', () => {
  const none = { layer: false, layerHides: false, moves: 0, movesFocused: false, words: false, tap: false, music: false };

  it('cuts the selected words when moves are still selected from the 3D tab but the transcript has focus', () => {
    expect(deleteTarget({ ...none, moves: 2, movesFocused: false, words: true })).toBe('words');
    expect(deleteTarget({ ...none, moves: 2, movesFocused: false, tap: true })).toBe('tap');
    expect(deleteTarget({ ...none, moves: 2, movesFocused: false, music: true })).toBe('music');
  });

  it('removes the moves while the 3D tab or lane has focus, before words, taps and sounds', () => {
    expect(deleteTarget({ ...none, moves: 1, movesFocused: true, words: true, tap: true, music: true })).toBe('moves');
    expect(deleteTarget({ ...none, moves: 0, movesFocused: true, words: true })).toBe('words');
  });

  it('gives the keys to the moves only from the lane, or the 3D tab when the transcript did not have the last press', () => {
    expect(movesHaveFocus('lane3d', 'text')).toBe(true);
    expect(movesHaveFocus('other', 'three')).toBe(true);
    expect(movesHaveFocus('transcript', 'three')).toBe(false);
    // Words selected, a move clicked on the lane (the tab turns to 3D), then the Text tab pressed: the words own ⌫.
    expect(movesHaveFocus('other', 'text')).toBe(false);
    expect(movesHaveFocus('transcript', 'text')).toBe(false);
  });

  it('keeps the old order for everything else', () => {
    expect(deleteTarget({ ...none, layer: true, layerHides: true, moves: 1, movesFocused: true })).toBe('layer');
    expect(deleteTarget({ ...none, layer: true, words: true })).toBe('keep-layer'); // the recording never hides
    expect(deleteTarget(none)).toBe('clip');
  });

  it('is what the editor\'s key handler uses, with the focus rule and the lane-only T, J, K, F', () => {
    const editor = readFileSync(join(__dirname, '../src/renderer/src/Editor.tsx'), 'utf8');
    expect(editor).toMatch(/const target = deleteTarget\(\{[^}]*movesFocused: movesHaveFocus\(pressScope\.current, activeTab\),/);
    // The scope follows every press and focus change, window-wide (a tab click, a word, the lane).
    expect(editor).toMatch(/window\.addEventListener\('pointerdown', onPress, true\)/);
    expect(editor).toMatch(/window\.addEventListener\('focusin', onPress, true\)/);
    expect(editor).toMatch(/closest\('\[data-scope="transcript"\]'\)/);
    expect(editor.match(/data-scope="transcript"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(editor).toMatch(/if \(isPhone && proj\.phone3d && !hasPhoneLayer && !role\) \{\s*const key = e\.key\.toLowerCase\(\);\s*if \(key === 't'/);
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
    const lay = list[2];
    const halves = zoomed.keys.filter((k) => k.shape !== 'full');
    expect(halves.length).toBeGreaterThan(0);
    const left = zoomed.keys.find((k) => k.moveId === lay.id && k.which === 'end')!;
    const right = zoomed.keys.find((k) => k.moveId === list[3].id && k.which === 'start')!;
    expect(left.shape).toBe('left');
    expect(right.shape).toBe('right');
    expect(left.hit[1]).toBe(right.hit[0]);
    const out = laneLayout(list, { pxPerSec: 10, selected: [] });
    expect(out.keys).toHaveLength(0); // the longest move is 1.2 s × 10 px = 12 px: no keys
    const far = laneLayout(list, { pxPerSec: 5.5, selected: [] });
    expect(far.blocks).toHaveLength(1); // only the 1.2 s spin is 6 px or wider (6.6 px)
    expect(far.ticks.length).toBe(list.length - 1); // every other move is a tick
  });

  it('marks a linked Start hollow and labels only blocks wide enough', () => {
    const list = plan();
    const l = laneLayout(list, { pxPerSec: 140, selected: [] });
    expect(l.keys.find((k) => k.moveId === list[3].id && k.which === 'start')!.hollow).toBe(true);
    expect(l.keys.find((k) => k.moveId === list[0].id && k.which === 'start')!.hollow).toBe(false);
    expect(l.blocks.find((b) => b.id === list[0].id)!.label).toBe('Spin in');
    expect(l.blocks.find((b) => b.id === list[2].id)!.label).toBe('Layback');
    expect(l.blocks.find((b) => b.id === list[3].id)!.label).toBeNull(); // the second move of a shot
  });

  it('hatches the cut part of a squeezed spring on the one selected block', () => {
    // Look round 4's recipes use no spring, so the squeezed spring is a hand-made one.
    const list = [...plan(), squeezed()];
    const back = list[list.length - 1];
    expect(springShortfall(back)).toBeGreaterThan(0);
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
    expect(marqueeIds(list, 395, 420, 100)).toEqual([list[2].id]);
    expect(marqueeIds(list, 0, 2000, 100)).toHaveLength(list.length);
  });

  it('frames a selection with room, including a squeezed spring\'s tail', () => {
    const sq = squeezed();
    expect(springShortfall(sq)).toBeGreaterThan(0);
    const w = frameWindow([sq])!;
    expect(w.start).toBeLessThan(sq.start);
    expect(w.end).toBeGreaterThan(sq.end + springShortfall(sq));
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
    expect(warningText({ code: 'zoom-3d', at: 2, message: 'The zoom at 2.00 s does not play while the phone is 3D (…)' }, at)).toBe('Zoom does not play in 3D');
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

describe('every 3D control writes through apply3d (SPEC D1)', () => {
  const read = (f: string) => readFileSync(join(__dirname, '../src/renderer/src', f), 'utf8');
  const panelFiles = ['phone3d/Phone3DPanel.tsx', 'phone3d/TransitionLane.tsx', 'phone3d/EasingCurve.tsx', 'phone3d/ShotGallery.tsx', 'phone3d/Track.tsx', 'phone3d/PopupMenu.tsx', 'phone3d/panelModel.ts', 'components/ExportPanel.tsx'];

  it('has no setProj( in the 3D panel, lane, curve and gallery files', () => {
    for (const f of panelFiles) expect(read(f), f).not.toMatch(/setProj\s*\(/);
  });

  it('never writes phone3d or exportPreset with setProj in the editor', () => {
    const editor = read('Editor.tsx');
    // Any setProj whose updater touches phone3d, or the Export menu's preset-layout Resolution.
    // Each setProj(…) call's own argument, up to its matching ")".
    const calls = editor.split('setProj(').slice(1).map((c) => {
      let depth = 1;
      for (let i = 0; i < c.length; i++) {
        if (c[i] === '(') depth++;
        else if (c[i] === ')' && --depth === 0) return c.slice(0, i);
      }
      return c;
    });
    expect(calls.length).toBeGreaterThan(20); // the parse found the editor's many setProj calls
    expect(calls.filter((c) => /phone3d|exportPreset/.test(c))).toEqual(["(p) => ({ ...p, exportPreset: v })"]);
    expect(editor).toMatch(/onResolution=\{\(preset\) => apply3d\(\{ op: 'exportSettings', preset \}\)\}/);
  });

  it('validates each 3D edit exactly as the CLI does (apply3d runs applyOps3d)', () => {
    const editor = read('Editor.tsx');
    expect(editor).toMatch(/const run = \(p: Project\) => applyOps3d\(p, list, ctxFor\(\)\);/);
    expect(editor).toMatch(/if \('error' in first\) \{\s*toast\(first\.error\);\s*return false;/);
  });
});

describe('popup menus', () => {
  const css = (f: string) => readFileSync(join(__dirname, '../src/renderer/src', f), 'utf8');
  it('never draw the focus ring a submenu would get when hovering its row focuses it (the highlighted row shows focus)', () => {
    // The app-wide keyboard ring is a box-shadow on :focus-visible, and a focus() after a hover counts as keyboard focus.
    expect(css('styles.css')).toMatch(/(^|\n):focus-visible\s*\{[^}]*box-shadow:\s*var\(--focus-ring\)/);
    const rule = css('phone3d/phone3d.css').match(/\.p3-menu:focus-visible\s*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/box-shadow:\s*var\(--shadow-float\)/);
    expect(css('phone3d/phone3d.css')).toMatch(/\.p3-menu\s*\{[^}]*box-shadow:\s*var\(--shadow-float\)/);
  });
});
