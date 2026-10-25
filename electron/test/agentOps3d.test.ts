// The 3D phone's agent ops (SPEC §4.1): every JSON shape, the refusals, and
// the editor's apply path (applyOps3d) refusing exactly what applyOps does.
import { describe, expect, it } from 'vitest';
import { applyOp, applyOps, applyOps3d, needsCursor, needsScenes, OP_NAMES, OpError, validateProject, type EditOp } from '../src/shared/agentOps';
import { springSettleTime } from '../src/shared/phone3d/easing3d';
import { defaultPhone3D, FRONT, type Pose } from '../src/shared/phone3d/model';
import { describeTransitions, PHONE3D_OP_FIELDS, PHONE3D_OP_NAMES } from '../src/shared/phone3d/ops';
import { facing, poseAt, poseDelta, resolveStarts } from '../src/shared/phone3d/pose';
import { defaultProject, type Project } from '../src/shared/types';
import { move, phoneProject, with3d } from './helpers/phone3dFixtures';

let n = 0;
const newId = () => `m${++n}`;
const fresh = () => {
  n = 0;
  return { newId };
};
const desktop = (): Project => defaultProject({ screenVideoFile: 'screen.webm', sourceKind: 'display', sourceSize: { width: 1920, height: 1080 }, duration: 10 });
const run = (p: Project, ops: EditOp[]) => applyOps(p, ops, fresh()).project;
const p3of = (p: Project) => p.phone3d!;
const P = (patch: Partial<Pose>): Pose => ({ ...FRONT, ...patch });

describe('OP_NAMES and the non-iPhone refusal', () => {
  it('lists every 3D op and direct', () => {
    for (const name of [...PHONE3D_OP_NAMES, 'direct']) expect(OP_NAMES).toContain(name);
  });

  it('PHONE3D_OP_FIELDS documents every 3D op, and the fields the editor sends are accepted', () => {
    expect(Object.keys(PHONE3D_OP_FIELDS).sort()).toEqual([...PHONE3D_OP_NAMES, 'direct'].sort());
    const editorFields: [keyof typeof PHONE3D_OP_FIELDS, string][] = [
      ['direct', 'style'], ['direct', 'replace'], ['direct', 'scenes'],
      ['shot', 'duration'], ['shot', 'return'], ['shot', 'intensity'], ['shot', 'direction'],
      ['setPose', 'target'], ['setPose', 'focus'],
      ['editTransition', 'swap'], ['editTransition', 'resetEnd'], ['editTransition', 'fitDuration'], ['editTransition', 'from'],
    ];
    for (const [op, field] of editorFields) expect(PHONE3D_OP_FIELDS[op] as readonly string[]).toContain(field);
  });

  it('every 3D op is refused on a screen recording', () => {
    const ops: EditOp[] = [
      { op: 'phone3d', enabled: true },
      { op: 'phone3d', clear: true },
      { op: 'setPose', target: 'base', turn: 10 },
      { op: 'addTransition', start: 1, to: { turn: 30 } },
      { op: 'editTransition', index: 0, start: 1 },
      { op: 'removeTransition', index: 0 },
      { op: 'clearTransitions' },
      { op: 'shot', recipe: 'spin-in', at: 0 },
      { op: 'direct', style: 'hero' },
    ];
    for (const o of ops) expect(() => applyOps(desktop(), [o], fresh()), o.op).toThrow(/3D phone needs an iPhone recording/);
  });
});

describe('phone3d op', () => {
  it('the first enabled:true seeds the defaults; enabled:false keeps the settings; clear deletes the key', () => {
    const on = run(phoneProject(), [{ op: 'phone3d', enabled: true }]);
    expect(p3of(on)).toEqual(defaultPhone3D());
    const tuned = run(on, [{ op: 'phone3d', camera: { fov: 30 } }]);
    const off = run(tuned, [{ op: 'phone3d', enabled: false }]);
    expect(p3of(off)).toEqual({ ...p3of(tuned), enabled: false });
    const cleared = run(off, [{ op: 'phone3d', clear: true }]);
    expect('phone3d' in cleared).toBe(false);
    expect(JSON.stringify(cleared)).toBe(JSON.stringify(phoneProject()));
    // clear on a project with no 3D changes nothing
    expect(run(phoneProject(), [{ op: 'phone3d', clear: true }])).toEqual(phoneProject());
  });

  it('merges sub-objects (the spec example)', () => {
    const p = run(phoneProject(), [
      {
        op: 'phone3d',
        pose: { turn: -8 },
        camera: { fov: 24, elevation: 0 },
        light: { preset: 'studio', azimuth: -35, intensity: 1.1 },
        glass: 0.3,
        back: 'auto',
        shadow: { on: true, kind: 'wall', opacity: 0.4, softness: 0.6 },
        dof: { on: true, amount: 0.3, background: 0.2 },
        float: { on: true, amount: 0.4, period: 6 },
        motionBlur: { on: true, shutter: 0.5, samples: 12 },
        supersample: 2,
      },
    ]);
    const d = defaultPhone3D();
    expect(p3of(p)).toEqual({
      ...d,
      pose: P({ turn: -8 }),
      camera: { fov: 24, elevation: 0 },
      light: { preset: 'studio', azimuth: -35, intensity: 1.1 },
      glass: 0.3,
      shadow: { on: true, kind: 'wall', opacity: 0.4, softness: 0.6 },
      dof: { on: true, amount: 0.3, background: 0.2 },
      float: { on: true, amount: 0.4, period: 6 },
      supersample: 2,
    });
    // A partial sub-object keeps the rest.
    const q = run(p, [{ op: 'phone3d', shadow: { kind: 'floor' } }]);
    expect(p3of(q).shadow).toEqual({ on: true, kind: 'floor', opacity: 0.4, softness: 0.6 });
  });

  it('refuses bad values instead of clamping them, and unknown fields', () => {
    const p = with3d(phoneProject());
    const bad: [EditOp, RegExp][] = [
      [{ op: 'phone3d', camera: { fov: 99 } }, /camera\.fov must be 8\.\.60/],
      [{ op: 'phone3d', motionBlur: { samples: 2.5 } }, /samples must be an integer 2\.\.32/],
      [{ op: 'phone3d', light: { preset: 'disco' } }, /light\.preset must be studio\|soft/],
      [{ op: 'phone3d', back: 'matte' }, /back must be auto\|glossy\|frosted/],
      [{ op: 'phone3d', supersample: 4 }, /supersample must be 1, 2 or 3/],
      [{ op: 'phone3d', pose: { yaw: 3 } }, /unknown pose channel "yaw"/],
      [{ op: 'phone3d', pose: { tilt: 90 } }, /pose\.tilt must be -85\.\.85/],
      [{ op: 'phone3d', fov: 24 }, /unknown field "fov"/],
      [{ op: 'phone3d', camera: { zoom: 2 } }, /unknown field camera\.zoom/],
      [{ op: 'phone3d', shadow: { on: 'yes' } }, /shadow\.on must be true or false/],
      [{ op: 'phone3d', clear: true, enabled: true }, /clear:true takes no other fields/],
      [{ op: 'phone3d' }, /pass enabled, clear:true, or a setting/],
      [{ op: 'phone3d', enabled: 1 }, /"enabled" must be true or false/],
    ];
    for (const [o, re] of bad) expect(() => applyOps(p, [o], fresh()), JSON.stringify(o)).toThrow(re);
  });
});

describe('setPose', () => {
  const twoMoves = () => with3d(phoneProject(), { pose: P({ size: 0.9 }), transitions: [move('a', 2, 3, { turn: 40 }), move('b', 6, 7, { tilt: 10 })] });

  it('with no moves, edits the base pose (the first 3D edit seeds the defaults)', () => {
    const p = run(phoneProject(), [{ op: 'setPose', at: 4.2, turn: 30, tilt: 10 }]);
    expect(p3of(p).pose).toEqual(P({ turn: 30, tilt: 10 }));
    expect(p3of(p).enabled).toBe(true);
  });

  it('edits the keyframe poseTargetAt picks: hold → End, before the first → its Start (made explicit), inside → nearer end', () => {
    let p = run(twoMoves(), [{ op: 'setPose', at: 4.2, turn: 30 }]); // hold after a
    expect(p3of(p).transitions[0].to.turn).toBe(30);
    p = run(twoMoves(), [{ op: 'setPose', at: 0.5, rotate: 12 }]); // before a: a's Start, materialized from the base
    expect(p3of(p).transitions[0].from).toEqual(P({ size: 0.9, rotate: 12 }));
    p = run(twoMoves(), [{ op: 'setPose', at: 6.8, focus: 0 }]); // inside b, nearer its End: a focus pull keyframe
    expect(p3of(p).transitions[1].to).toMatchObject({ tilt: 10, focus: 0 });
  });

  it('a base edit says when it shows nowhere (the first move has its own Start), and when it shows', () => {
    const explicitFirst = with3d(phoneProject(), { transitions: [{ ...move('a', 0, 1.6, {}), from: P({ turn: -200 }) }, move('b', 6, 7, { tilt: 10 })] });
    const hidden = applyOps(explicitFirst, [{ op: 'setPose', target: 'base', turn: -8, tilt: 5 }], fresh());
    expect(hidden.notes[0]).toMatch(/shows nowhere: the first move a has its own Start/);
    expect(hidden.notes[0]).toContain('setPose {at}');
    // And it really is invisible: every moment samples the same pose as before the edit.
    for (const t of [0, 0.8, 1.6, 4, 6.5, 9]) expect(poseAt(p3of(hidden.project), t)).toEqual(poseAt(p3of(explicitFirst), t));
    // A linked first move starts from the base, and no moves at all holds it: plain note.
    expect(applyOps(twoMoves(), [{ op: 'setPose', target: 'base', size: 0.8 }], fresh()).notes[0]).toBe('setPose edited the base pose');
    expect(applyOps(phoneProject(), [{ op: 'setPose', target: 'base', size: 0.8 }], fresh()).notes[0]).toBe('setPose edited the base pose');
  });

  it('target:"base" edits the base pose even when moves exist; id + end picks a keyframe directly', () => {
    let p = run(twoMoves(), [{ op: 'setPose', target: 'base', size: 0.8 }]);
    expect(p3of(p).pose.size).toBe(0.8);
    expect(p3of(p).transitions.map((t) => t.id)).toEqual(['a', 'b']);
    p = run(twoMoves(), [{ op: 'setPose', id: 'b', end: 'from', x: 0.1 }]);
    expect(p3of(p).transitions[1].from).toEqual(P({ turn: 40, x: 0.1 })); // b's resolved Start (= a's End) plus x
    p = run(twoMoves(), [{ op: 'setPose', index: 0, end: 'to', tilt: -5 }]);
    expect(p3of(p).transitions[0].to).toEqual(P({ turn: 40, tilt: -5 }));
  });

  it('refuses no channels, out-of-range values, a bad end and unknown fields', () => {
    const p = twoMoves();
    expect(() => applyOps(p, [{ op: 'setPose', at: 1 }], fresh())).toThrow(/at least one pose channel/);
    expect(() => applyOps(p, [{ op: 'setPose', at: 1, turn: 800 }], fresh())).toThrow(/turn must be -720\.\.720/);
    expect(() => applyOps(p, [{ op: 'setPose', id: 'a', turn: 1 }], fresh())).toThrow(/end: "from"/);
    expect(() => applyOps(p, [{ op: 'setPose', id: 'zz', end: 'to', turn: 1 }], fresh())).toThrow(/no 3D move with id zz/);
    expect(() => applyOps(p, [{ op: 'setPose', at: 1, yaw: 1 }], fresh())).toThrow(/unknown field "yaw"/);
    expect(() => applyOps(p, [{ op: 'setPose', turn: 1 }], fresh())).toThrow(/"at" must be a number/);
  });
});

describe('addTransition', () => {
  it('the spec shapes: spring with numbers; partial poses fill from the pose at the start', () => {
    const base = with3d(phoneProject(), { pose: P({ tilt: 4 }) });
    const p = run(base, [{ op: 'addTransition', start: 2, end: 3.2, to: { turn: 180 }, from: { turn: 0 }, easing: 'spring', stiffness: 180, damping: 18 }]);
    expect(p3of(p).transitions).toEqual([{ id: 'm1', start: 2, end: 3.2, from: P({ tilt: 4 }), to: P({ turn: 180, tilt: 4 }), easing: { kind: 'spring', stiffness: 180, damping: 18 } }]);
  });

  it('fitDuration sets end = start + the spring settle time; no end defaults to 1.2 s', () => {
    const p = run(with3d(phoneProject()), [
      { op: 'addTransition', start: 2, to: { turn: 180 }, easing: 'spring', fitDuration: true },
      { op: 'addTransition', start: 5, to: { tilt: 10 } },
    ]);
    const [a, b] = p3of(p).transitions;
    expect(a.end - a.start).toBeCloseTo(springSettleTime(180, 18), 12);
    expect(b).toMatchObject({ start: 5, end: 6.2, easing: { kind: 'smooth' } });
    expect(b.from).toBeUndefined(); // linked
  });

  it('easing as a full object, as a bezier array, and from:null (linked); the list stays sorted', () => {
    const p = run(with3d(phoneProject()), [
      { op: 'addTransition', start: 5, end: 6, to: { turn: 10 }, easing: { kind: 'bezier', x1: 0.7, y1: 0, x2: 0.16, y2: 1 } },
      { op: 'addTransition', start: 1, end: 2, to: { turn: 20 }, bezier: [0.25, 0.1, 0.25, 1], from: null },
      { op: 'addTransition', start: 3, end: 4, to: { turn: 30 }, easing: 'cinematic' },
    ]);
    const list = p3of(p).transitions;
    expect(list.map((t) => t.start)).toEqual([1, 3, 5]);
    expect(list[0]).toMatchObject({ id: 'm2', easing: { kind: 'bezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } });
    expect(list[0].from).toBeUndefined();
    expect(list[2].easing).toEqual({ kind: 'bezier', x1: 0.7, y1: 0, x2: 0.16, y2: 1 });
  });

  it('never reuses an id that is taken', () => {
    let calls = 0;
    const ids = ['a', 'a', 'b'];
    const { project } = applyOps(with3d(phoneProject(), { transitions: [move('a', 0, 1, {})] }), [{ op: 'addTransition', start: 2, to: { turn: 5 } }], { newId: () => ids[calls++] });
    expect(project.phone3d!.transitions.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('refuses short or negative moves, a missing End, bad easings and conflicting fields', () => {
    const p = with3d(phoneProject());
    const bad: [EditOp, RegExp][] = [
      [{ op: 'addTransition', start: 2, end: 2.05, to: {} }, /at least 0\.1 s/],
      [{ op: 'addTransition', start: -1, end: 1, to: {} }, /start must be >= 0/],
      [{ op: 'addTransition', start: 2, end: 3 }, /"to" \(the End pose\) is required/],
      [{ op: 'addTransition', start: 2, to: {}, easing: 'bouncy' }, /easing must be smooth\|linear/],
      [{ op: 'addTransition', start: 2, to: {}, easing: 'spring', stiffness: 5000 }, /stiffness must be 1\.\.1000/],
      [{ op: 'addTransition', start: 2, to: {}, bezier: [1.5, 0, 0, 1] }, /x1 and x2 must be 0\.\.1/],
      [{ op: 'addTransition', start: 2, to: {}, bezier: [0.5, 3, 0, 1] }, /y1 and y2 must be -1\.\.2/],
      [{ op: 'addTransition', start: 2, to: {}, easing: 'linear', stiffness: 100 }, /need "easing": "spring"/],
      [{ op: 'addTransition', start: 2, to: {}, easing: 'linear', fitDuration: true }, /fitDuration needs "easing": "spring"/],
      [{ op: 'addTransition', start: 2, end: 3, to: {}, easing: 'spring', fitDuration: true }, /not both/],
      [{ op: 'addTransition', start: 2, to: { tilt: 99 } }, /to\.tilt must be -85\.\.85/],
      [{ op: 'addTransition', start: 2, to: {}, recipe: 'spin-in' }, /unknown field "recipe"/],
    ];
    for (const [o, re] of bad) expect(() => applyOps(p, [o], fresh()), JSON.stringify(o)).toThrow(re);
  });
});

describe('editTransition', () => {
  const two = () => with3d(phoneProject(), { transitions: [move('a', 1, 2, { turn: 90 }), move('m2', 3, 4, { tilt: 20 }, { from: P({ turn: 90, size: 1.1 }) })] });

  it('start/end, a partial End and an easing (the spec example)', () => {
    const p = run(two(), [{ op: 'editTransition', id: 'm2', start: 2.4, end: 3.6, to: { tilt: 12 }, easing: 'cinematic' }]);
    expect(p3of(p).transitions[1]).toMatchObject({ id: 'm2', start: 2.4, end: 3.6, to: P({ tilt: 12 }), easing: { kind: 'cinematic' } });
  });

  it('from:null links the Start; a partial from merges over the resolved Start', () => {
    const linked = run(two(), [{ op: 'editTransition', index: 1, from: null }]);
    expect(p3of(linked).transitions[1].from).toBeUndefined();
    const explicit = run(linked, [{ op: 'editTransition', id: 'm2', from: { y: 0.1 } }]);
    expect(p3of(explicit).transitions[1].from).toEqual(P({ turn: 90, y: 0.1 }));
  });

  it('by shifts both ends; the list re-sorts when a move passes another', () => {
    const p = run(two(), [{ op: 'editTransition', id: 'm2', by: -2.5 }]);
    expect(p3of(p).transitions.map((t) => [t.id, t.start, t.end])).toEqual([
      ['m2', 0.5, 1.5],
      ['a', 1, 2],
    ]);
    expect(() => applyOps(two(), [{ op: 'editTransition', id: 'm2', by: 1, start: 2 }], fresh())).toThrow(/not both/);
    expect(() => applyOps(two(), [{ op: 'editTransition', id: 'a', by: -5 }], fresh())).toThrow(/start must be >= 0/);
  });

  it('swap twice on an explicit move is the identity; swap materializes a linked Start', () => {
    const p = two();
    const twice = run(p, [
      { op: 'editTransition', id: 'm2', swap: true },
      { op: 'editTransition', id: 'm2', swap: true },
    ]);
    expect(p3of(twice)).toEqual(p3of(p));
    const once = run(p, [{ op: 'editTransition', id: 'a', swap: true }]);
    expect(p3of(once).transitions[0].from).toEqual(P({ turn: 90 }));
    expect(p3of(once).transitions[0].to).toEqual(P({}));
  });

  it('resetEnd: End = the resolved Start, so facing at the end equals facing at the start', () => {
    const p = run(two(), [{ op: 'editTransition', id: 'a', resetEnd: true }]);
    const p3 = p3of(p);
    const tr = p3.transitions[0];
    expect(facing(p3, tr.end)).toBeCloseTo(facing(p3, tr.start), 12);
    expect(Object.values(poseDelta(tr.to, resolveStarts(p3)[0])).every((d) => d === 0)).toBe(true);
    // swap and resetEnd together: swap first, then End = the (new) Start
    const both = run(two(), [{ op: 'editTransition', id: 'm2', swap: true, resetEnd: true }]);
    expect(p3of(both).transitions[1].to).toEqual(p3of(both).transitions[1].from);
  });

  it('a spring stiffness alone keeps the move a spring; fitDuration fits its length', () => {
    let p = run(two(), [{ op: 'editTransition', id: 'a', easing: 'spring' }]);
    p = run(p, [{ op: 'editTransition', id: 'a', stiffness: 300 }]);
    expect(p3of(p).transitions[0].easing).toEqual({ kind: 'spring', stiffness: 300, damping: 18 });
    p = run(p, [{ op: 'editTransition', id: 'a', fitDuration: true }]);
    const tr = p3of(p).transitions[0];
    expect(tr.end - tr.start).toBeCloseTo(springSettleTime(300, 18), 12);
    expect(() => applyOps(two(), [{ op: 'editTransition', id: 'a', fitDuration: true }], fresh())).toThrow(/needs a spring/);
  });

  it('refuses nothing to change, a bad index, and a move made too short', () => {
    expect(() => applyOps(two(), [{ op: 'editTransition', id: 'a' }], fresh())).toThrow(/nothing to change/);
    expect(() => applyOps(two(), [{ op: 'editTransition', index: 7, start: 1 }], fresh())).toThrow(/index 7 out of range \(0\.\.1\)/);
    expect(() => applyOps(two(), [{ op: 'editTransition', id: 'a', end: 1.05 }], fresh())).toThrow(/at least 0\.1 s/);
  });
});

describe('removeTransition, clearTransitions, Reset 3D Pose', () => {
  it('remove by id or index; clear empties the list; clear on a flat project creates nothing', () => {
    const p = with3d(phoneProject(), { transitions: [move('a', 1, 2, {}), move('b', 3, 4, {})] });
    expect(p3of(run(p, [{ op: 'removeTransition', id: 'a' }])).transitions.map((t) => t.id)).toEqual(['b']);
    expect(p3of(run(p, [{ op: 'removeTransition', index: 1 }])).transitions.map((t) => t.id)).toEqual(['a']);
    expect(p3of(run(p, [{ op: 'clearTransitions' }])).transitions).toEqual([]);
    expect('phone3d' in run(phoneProject(), [{ op: 'clearTransitions' }])).toBe(false);
  });

  it('Reset 3D Pose is clearTransitions + setPose base FRONT in one apply', () => {
    const p = with3d(phoneProject(), { pose: P({ turn: 33, size: 1.4, focus: 0.2 }), transitions: [move('a', 1, 2, { turn: 90 })] });
    const reset = run(p, [
      { op: 'clearTransitions' },
      { op: 'setPose', target: 'base', turn: 0, tilt: 0, rotate: 0, size: 1, x: 0, y: 0, light: 0, focus: 1 },
    ]);
    expect(p3of(reset).transitions).toEqual([]);
    expect(p3of(reset).pose).toEqual({ ...FRONT });
  });
});

describe('shot op', () => {
  it('inserts the recipe at `at` and replaces moves that overlap it', () => {
    const p = with3d(phoneProject({ duration: 20 }), { transitions: [move('old', 3, 4, { turn: 10 }), move('keep', 9, 10, { tilt: 5 })] });
    const q = run(p, [{ op: 'shot', recipe: 'turn-to-back', at: 2, duration: 2.6, intensity: 1, direction: 1, return: 'front' }]);
    expect(p3of(q).transitions.map((t) => [t.id, t.recipe ?? null])).toEqual([
      ['m1', 'turn-to-back'],
      ['m2', 'turn-to-back'],
      ['m3', 'turn-to-back'],
      ['keep', null],
    ]);
  });

  it('float turns on the idle float; return "stay" keeps only the outbound moves (the lean and its drift, which comes to rest)', () => {
    expect(p3of(run(phoneProject(), [{ op: 'shot', recipe: 'float' }])).float.on).toBe(true);
    const q = run(with3d(phoneProject()), [{ op: 'shot', recipe: 'hero-layback', at: 4, return: 'stay' }]);
    expect(p3of(q).transitions).toHaveLength(2);
    expect(p3of(q).transitions[0].to.tilt).toBe(16);
    expect(p3of(q).transitions[1].to.tilt).toBeGreaterThan(16);
    expect(p3of(q).transitions[1].easing.kind).toBe('bezier');
  });

  it('a shot after a turn-to-back starts from the same angle (rebased, explicit Start), so nothing jumps', () => {
    const q = run(with3d(phoneProject({ duration: 20 })), [
      { op: 'shot', recipe: 'turn-to-back', at: 1 },
      { op: 'shot', recipe: 'hero-layback', at: 6 },
    ]);
    const [, , , hero] = p3of(q).transitions;
    expect(hero.from).toMatchObject({ turn: 0 });
    expect(poseAt(p3of(q), 5).turn).toBe(360);
  });

  it('a round trip inserted before a linked move keeps that move from unwinding a full turn', () => {
    const p = with3d(phoneProject({ duration: 20 }), { transitions: [move('later', 10, 11, { turn: 25 })] });
    const q = run(p, [{ op: 'shot', recipe: 'turn-to-back', at: 2 }]);
    const later = p3of(q).transitions.find((t) => t.id === 'later')!;
    expect(later.from).toEqual(P({})); // its old Start (the base pose), written out
    // The move turns 25°, not 25 − 360.
    expect(Math.abs(poseAt(p3of(q), 10.5).turn)).toBeLessThan(25);
  });

  it('a shot that becomes the first move starts where the phone was shown, not from the base pose', () => {
    const p = with3d(phoneProject({ duration: 20 }), { pose: P({ tilt: 20 }), transitions: [move('spin', 8, 9, {}, { from: P({ turn: 40 }) })] });
    const q = run(p, [{ op: 'shot', recipe: 'hero-layback', at: 2 }]);
    const first = p3of(q).transitions[0];
    expect(first.recipe).toBe('hero-layback');
    expect(first.from).toEqual(P({ turn: 40 })); // the phone showed spin's Start before it
  });

  it('refuses a bad recipe, return, intensity, direction or a too-short duration', () => {
    const p = with3d(phoneProject());
    expect(() => applyOps(p, [{ op: 'shot', recipe: 'zoom', at: 1 }], fresh())).toThrow(/recipe must be spin-in\|turn-to-back/);
    expect(() => applyOps(p, [{ op: 'shot', recipe: 'settle', at: 1, return: 'back' }], fresh())).toThrow(/return must be/);
    expect(() => applyOps(p, [{ op: 'shot', recipe: 'settle', at: 1, intensity: 3 }], fresh())).toThrow(/intensity must be 0\.25\.\.2/);
    expect(() => applyOps(p, [{ op: 'shot', recipe: 'settle', at: 1, direction: 2 }], fresh())).toThrow(/direction must be 1 or -1/);
    expect(() => applyOps(p, [{ op: 'shot', recipe: 'turn-to-back', at: 1, duration: 0.15 }], fresh())).toThrow(/duration must be at least 0\.53 s for turn-to-back/);
    expect(() => applyOps(p, [{ op: 'shot', recipe: 'settle' }], fresh())).toThrow(/"at" must be a number/);
  });
});

describe('direct op', () => {
  const tapped = () => {
    const p = phoneProject({ duration: 30 });
    p.taps = [5, 12, 22].map((t, i) => ({ id: `tap${i}`, t, x: 0.5, y: 0.5, kind: 'tap' as const, confidence: 1 }));
    p.tapsAnalyzed = true;
    return p;
  };

  it('plans, is deterministic, and ends with the 3D phone on', () => {
    const a = run(tapped(), [{ op: 'direct', style: 'hero', replace: true, scenes: true }]);
    const b = run(tapped(), [{ op: 'direct', style: 'hero', replace: true, scenes: true }]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(p3of(a).enabled).toBe(true);
    expect(p3of(a).transitions.length).toBeGreaterThan(0);
  });

  it('reads ctx.scenes only when scenes is not false', () => {
    const p = tapped();
    p.waits = [{ start: 13, end: 21 }];
    // A cut 20 s or more after the spin-in (bold's one big move per 20 s, owner decision 18) takes a turn-to-back.
    const ctx = { newId, scenes: [25] };
    const withScenes = applyOp(p, { op: 'direct', style: 'bold' }, ctx);
    const without = applyOp(p, { op: 'direct', style: 'bold', scenes: false }, ctx);
    expect(withScenes.note).toMatch(/1 scene change/);
    expect(without.note).toMatch(/scene changes off/);
    expect(JSON.stringify(withScenes.project.phone3d!.transitions.map((t) => t.start))).not.toBe(JSON.stringify(without.project.phone3d!.transitions.map((t) => t.start)));
  });

  it('replace:false keeps the existing moves', () => {
    const p = with3d(tapped(), { transitions: [move('mine', 15, 16, { turn: 20 })] });
    const kept = run(p, [{ op: 'direct', style: 'hero', replace: false }]);
    expect(p3of(kept).transitions.find((t) => t.id === 'mine')).toEqual(move('mine', 15, 16, { turn: 20 }));
    const replaced = run(p, [{ op: 'direct', style: 'hero' }]);
    expect(p3of(replaced).transitions.find((t) => t.id === 'mine')).toBeUndefined();
  });

  it('a take with no room for a move: the note says why instead of a bare "nothing"', () => {
    const p = phoneProject({ duration: 8 });
    p.taps = Array.from({ length: 10 }, (_, i) => ({ id: `tap${i}`, t: 0.4 + i * 0.8, x: 0.5, y: 0.5, kind: 'tap' as const, confidence: 1 }));
    p.tapsAnalyzed = true;
    const r = applyOp(p, { op: 'direct', style: 'hero', scenes: false }, fresh());
    expect(r.note).toBe(
      'Auto 3D (hero; scene changes off): No moving shot fits: the phone must face front from 0.0 s (a tap or kept move starts there), so no intro fits; there is no free time between taps and kept moves. The phone rests at a posed angle instead (9.4° off front, inside the 12° rule for taps).',
    );
    expect(p3of(r.project).transitions).toEqual([]);
    expect(p3of(r.project).pose).toEqual(P({ turn: -8, tilt: 5 }));
    // With shots, the note lists them and adds nothing else.
    expect(applyOp(tapped(), { op: 'direct', style: 'hero', scenes: false }, fresh()).note).toMatch(/^Auto 3D \(hero; scene changes off\): spin-in 0\.00–1\.60 s(, [a-z-]+ \d+\.\d\d–\d+\.\d\d s)*$/);
  });

  it('refuses a bad style or unknown field', () => {
    expect(() => applyOps(tapped(), [{ op: 'direct', style: 'wild' }], fresh())).toThrow(/style must be subtle\|hero\|bold/);
    expect(() => applyOps(tapped(), [{ op: 'direct', keep: true }], fresh())).toThrow(/unknown field "keep"/);
  });

  it('needsScenes / needsCursor tell the CLI what to read', () => {
    expect(needsScenes([{ op: 'direct' }])).toBe(true);
    expect(needsScenes([{ op: 'direct', scenes: false }])).toBe(false);
    expect(needsScenes([{ op: 'shot', recipe: 'float' }])).toBe(false);
    expect(needsCursor([{ op: 'direct', scenes: false }])).toBe(true);
    expect(needsCursor([{ op: 'phone3d', enabled: true }])).toBe(false);
  });
});

describe('validation and the editor path', () => {
  it('validateProject reports phone3d problems; a raw set cannot sneak a bad value in', () => {
    const p = with3d(phoneProject());
    expect(validateProject(p)).toEqual([]);
    expect(() => applyOps(p, [{ op: 'set', path: '/phone3d/camera/fov', value: 99 }], fresh())).toThrow(/phone3d\.camera\.fov must be 8\.\.60/);
    expect(() => applyOps(phoneProject(), [{ op: 'set', path: '/phone3d', value: { enabled: true, camera: { fov: 99 } } }], fresh())).toThrow(/edited project is invalid/);
  });

  it('a raw set on /phone3d keeps the moves sorted', () => {
    const p = with3d(phoneProject(), { transitions: [move('a', 1, 2, {}), move('b', 3, 4, {})] });
    const q = run(p, [{ op: 'set', path: '/phone3d/transitions/0', value: move('a', 5, 6, {}) }]);
    expect(p3of(q).transitions.map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('old projects go through applyOps unchanged and gain no phone3d key', () => {
    const p = phoneProject();
    expect(JSON.stringify(applyOps(structuredClone(p), [], fresh()).project)).toBe(JSON.stringify(p));
    const cut = applyOps(structuredClone(p), [{ op: 'cut', ranges: [{ start: 2, end: 3 }] }], fresh()).project;
    expect('phone3d' in cut).toBe(false);
  });

  it('applyOps3d refuses exactly what applyOps refuses, with the same message, and agrees when it accepts', () => {
    const p = with3d(phoneProject({ duration: 20 }), { transitions: [move('a', 1, 2, { turn: 90 })] });
    const lists: EditOp[][] = [
      [],
      [{ op: 'setPose', at: 5, turn: 30 }],
      [{ op: 'setPose', at: 5, turn: 3000 }],
      [{ op: 'addTransition', start: 4, to: { turn: 10 } }, { op: 'editTransition', id: 'm1', swap: true }],
      [{ op: 'addTransition', start: 4, end: 4.01, to: {} }],
      [{ op: 'set', path: '/phone3d/glass', value: 7 }],
      [{ op: 'shot', recipe: 'turn-to-back', at: 3 }, { op: 'direct', style: 'bold' }],
      [{ op: 'phone3d', clear: true }],
      [{ op: 'nope' }],
      [{ op: 'editTransition', id: 'gone', start: 1 }],
      [{ op: 'phone3d', camera: { fov: 61 } }],
    ];
    for (const ops of lists) {
      let viaApply: unknown;
      try {
        viaApply = applyOps(p, ops, fresh());
      } catch (e) {
        expect(e).toBeInstanceOf(OpError);
        viaApply = { error: (e as Error).message };
      }
      expect(applyOps3d(p, ops, fresh()), JSON.stringify(ops)).toEqual(viaApply);
    }
  });
});

describe('describeTransitions (info)', () => {
  it('lists each move with its resolved Start, linked flag, easing and recipe', () => {
    const p3 = { ...defaultPhone3D(), pose: P({ tilt: 3 }), transitions: [move('a', 1, 2, { turn: 90 }, { recipe: 'settle' }), move('b', 3, 5, { turn: 0 }, { from: P({ turn: 100 }) })] };
    expect(describeTransitions(p3)).toEqual([
      { index: 0, id: 'a', start: 1, end: 2, duration: 1, linked: true, from: P({ tilt: 3 }), to: P({ turn: 90 }), easing: { kind: 'smooth' }, recipe: 'settle' },
      { index: 1, id: 'b', start: 3, end: 5, duration: 2, linked: false, from: P({ turn: 100 }), to: P({}), easing: { kind: 'smooth' } },
    ]);
  });
});
