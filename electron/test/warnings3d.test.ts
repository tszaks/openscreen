// SPEC §2.7: one positive and one negative test per warning code, and every
// fix clears its warning when applied through applyOps (as the editor's Fix
// button and an agent's `apply` do).
import { describe, expect, it } from 'vitest';
import { applyOps, ZOOM_3D_NOTE, type EditOp } from '../src/shared/agentOps';
import { FRONT, type Phone3D, type Pose, type PoseTransition } from '../src/shared/phone3d/model';
import { OFF_CANVAS_ADDED_PX, offCanvasAdded, offCanvasMeter, projectWarnings, WARNING_CODES, type Warning } from '../src/shared/phone3d/warnings';
import type { Project } from '../src/shared/types';
import { move, phoneProject, with3d } from './helpers/phone3dFixtures';

const P = (patch: Partial<Pose>): Pose => ({ ...FRONT, ...patch });

/** A 20 s iPhone take (9:16 canvas) with 3D on, no tap zooms (so only the warning under test shows). */
function take(patch: Partial<Phone3D> = {}, taps: number[] = []): Project {
  const p = with3d(phoneProject({ duration: 20 }), patch);
  p.zoom = { ...p.zoom, fromTaps: false };
  p.taps = taps.map((t, i) => ({ id: `tap${i}`, t, x: 0.5, y: 0.5, kind: 'tap' as const, confidence: 1 }));
  p.tapsAnalyzed = true;
  return p;
}

const codes = (p: Project) => projectWarnings(p).map((w) => w.code);
const only = (p: Project, code: Warning['code']) => projectWarnings(p).filter((w) => w.code === code);

/** Applies the warning's fix like the editor does (one applyOps call) and returns the result. */
function applyFix(p: Project, w: Warning): Project {
  expect(w.fix, `${w.code} has a fix`).toBeDefined();
  return applyOps(p, w.fix!, { newId: () => 'fix' }).project;
}

/** The same issue is gone after the fix (same code and move/time). */
function expectCleared(p: Project, w: Warning) {
  const after = projectWarnings(applyFix(p, w));
  const same = after.filter((x) => x.code === w.code && x.transitionId === w.transitionId && (w.code.startsWith('tap') ? x.at === w.at : true));
  expect(same, `${w.code} after its fix: ${JSON.stringify(after)}`).toEqual([]);
}

describe('projectWarnings: scope', () => {
  it('is empty with no phone3d, with 3D off, and for a clean setup', () => {
    expect(projectWarnings(phoneProject())).toEqual([]);
    expect(projectWarnings(take({ enabled: false, transitions: [move('a', 1, 3, {}), move('b', 2, 4, {})] }))).toEqual([]);
    expect(projectWarnings(take({ transitions: [move('a', 1, 2, { turn: 20 })] }, [5]))).toEqual([]);
  });

  it('knows exactly the spec codes', () => {
    expect([...WARNING_CODES]).toEqual(['inactive', 'tap-angle', 'tap-back', 'off-canvas', 'overlap', 'past-end', 'pose-jump', 'too-fast', 'floor-flat', 'zoom-3d']);
  });

  it('never blocks applyOps: a project full of warnings still takes edits', () => {
    const p = take({ transitions: [move('a', 1, 3, { turn: 180 }), move('b', 2, 25, { turn: 180 })] }, [10]);
    expect(projectWarnings(p).length).toBeGreaterThan(2);
    expect(() => applyOps(p, [{ op: 'setPose', target: 'base', size: 0.9 }], { newId: () => 'x' })).not.toThrow();
  });

  it('is sorted by time, then by code', () => {
    const p = take({ transitions: [move('a', 1, 3, { turn: 180 }), move('b', 2, 25, { turn: 180 })] }, [10]);
    const ws = projectWarnings(p);
    for (let i = 1; i < ws.length; i++) {
      const a = ws[i - 1];
      const b = ws[i];
      expect((a.at ?? -1) < (b.at ?? -1) || ((a.at ?? -1) === (b.at ?? -1) && WARNING_CODES.indexOf(a.code) <= WARNING_CODES.indexOf(b.code))).toBe(true);
    }
  });
});

describe('inactive', () => {
  it('frame off: says why, and the fix turns the frame on', () => {
    const p = take();
    p.device = { ...p.device, frame: false };
    const [w] = projectWarnings(p);
    expect(w).toMatchObject({ code: 'inactive', fix: [{ op: 'device', frame: true }] });
    expect(w.message).toMatch(/device frame/);
    expect(codes(applyFix(p, w))).not.toContain('inactive');
  });

  it('App Store layout: flat by design, no fix', () => {
    const p = take();
    p.layout = { ...p.layout, presetId: 'appstore' };
    const [w] = projectWarnings(p);
    expect(w.code).toBe('inactive');
    expect(w.message).toMatch(/App Store layouts stay flat/);
    expect(w.fix).toBeUndefined();
  });

  it('negative: an active 3D phone has no inactive warning', () => {
    expect(codes(take())).not.toContain('inactive');
  });
});

describe('tap-angle / tap-back', () => {
  it('a phone held 50° off front during a tap: tap-angle; the fix faces it front', () => {
    const p = take({ transitions: [move('a', 1, 2, { turn: 50 })] }, [5]);
    const [w] = only(p, 'tap-angle');
    expect(w).toMatchObject({ at: 5, transitionId: 'a' });
    expect(w.message).toMatch(/50° off front at 5\.00 s, at the tap at 5\.00 s/);
    expect(w.fix).toEqual([{ op: 'setPose', at: 5, turn: 0, tilt: 0 }]);
    expectCleared(p, w);
  });

  it('a move that swings past 35° in the middle of a tap: the fix moves the whole move before the tap window (same speed)', () => {
    // Lands on 30° (fine) but overshoots to ~50° on the way.
    const swing = move('a', 3, 6, { turn: 30 }, { easing: { kind: 'bezier', x1: 0.2, y1: 2, x2: 0.5, y2: 1.6 } });
    const p = take({ transitions: [swing] }, [5]);
    const [w] = only(p, 'tap-angle');
    expect(w.fix).toEqual([{ op: 'editTransition', id: 'a', by: -1.3 }]);
    expectCleared(p, w);
  });

  it('names the moment that fails: a spin still turning 0.3 s before the tap is reported there, not at the tap', () => {
    // A 200° spin-in ending at 1.2 s, tap at 0.96 s: at 0.96 s the phone is about 20° off, at 0.66 s about 80°.
    const spin = move('a', 0, 1.2, { turn: 0 }, { from: { turn: -200, tilt: 0, rotate: 0, size: 1, x: 0, y: 0, light: 0, focus: 1 }, easing: { kind: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 } });
    const p = take({ transitions: [spin] }, [0.96]);
    const [w] = only(p, 'tap-angle');
    expect(w.message).toMatch(/off front at 0\.66 s, 0\.30 s before the tap at 0\.96 s/);
    expect(w.message).toMatch(/from 0\.3 s before a tap to 0\.3 s after it/);
  });

  it('a fix never speeds a move up past 300°/s to clear a tap (round 2 offered a 200° spin squeezed into 0.66 s)', () => {
    const spin = move('a', 0, 1.2, { turn: 0 }, { from: { turn: -200, tilt: 0, rotate: 0, size: 1, x: 0, y: 0, light: 0, focus: 1 }, easing: { kind: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 } });
    const p = take({ transitions: [spin] }, [0.96]);
    const [w] = only(p, 'tap-angle');
    // The spin starts at 0, so it cannot move earlier; pulling its end to 0.66 s would turn it at about 520°/s.
    for (const op of w.fix ?? []) expect(op).not.toMatchObject({ op: 'editTransition', end: expect.any(Number) });
    // Control: the same spin with room before it is moved earlier whole instead.
    const later = take({ transitions: [{ ...spin, start: 1, end: 2.2 }] }, [1.96]);
    expect(only(later, 'tap-angle')[0].fix).toEqual([{ op: 'editTransition', id: 'a', by: -0.54 }]);
  });

  it('a move that starts inside the tap window is moved after it', () => {
    const p = take({ transitions: [move('a', 4.9, 5.5, { turn: 50 }), move('b', 9, 10, { turn: 0 })] }, [5]);
    const [w] = only(p, 'tap-angle');
    expect(w.fix).toBeDefined();
    expectCleared(p, w);
  });

  it('the back shown during a tap: tap-back (not tap-angle); the fix brings the front back without a spin', () => {
    const p = take({ transitions: [move('a', 1, 2, { turn: 180 })] }, [5]);
    expect(only(p, 'tap-angle')).toEqual([]);
    const [w] = only(p, 'tap-back');
    expect(w.message).toMatch(/shows its back/);
    expect(w.fix).toEqual([{ op: 'setPose', at: 5, turn: 0, tilt: 0 }]);
    expectCleared(p, w);
  });

  it('a swipe is checked for its whole length', () => {
    const p = take({ transitions: [move('a', 6, 6.5, { turn: 60 })] }, []);
    p.taps = [{ id: 's', t: 5, x: 0.5, y: 0.5, kind: 'swipe', duration: 1.5, confidence: 1 }];
    expect(only(p, 'tap-angle').length).toBe(1);
  });

  it('negative: 30° off front is fine, and so is a big turn well away from the tap', () => {
    expect(codes(take({ transitions: [move('a', 1, 2, { turn: 30 })] }, [5]))).toEqual([]);
    expect(codes(take({ transitions: [move('a', 7, 9, { turn: 360 })] }, [5]))).toEqual([]);
  });
});

describe('off-canvas', () => {
  it('a phone pushed off the right edge: one run; the fix brings it back with clamped x', () => {
    const p = take({ pose: P({ x: 0.6 }) });
    const [w] = only(p, 'off-canvas');
    expect(w).toMatchObject({ at: 0, end: 20 });
    expect(w.fix![0]).toMatchObject({ op: 'setPose', at: expect.any(Number) });
    expect((w.fix![0] as EditOp).x as number).toBeLessThan(0.6);
    expectCleared(p, w);
  });

  it('a phone too big for the canvas: the fix shrinks it', () => {
    const p = take({ pose: P({ size: 2.2 }) });
    const [w] = only(p, 'off-canvas');
    expect((w.fix![0] as EditOp).size as number).toBeLessThan(2.2);
    expectCleared(p, w);
  });

  it('a move that only pokes out for a moment is a run from its start to its end', () => {
    const p = take({ transitions: [move('a', 4, 5, { x: 0.6 }), move('b', 6, 7, { x: 0 })] });
    const [w] = only(p, 'off-canvas');
    expect(w.at).toBeGreaterThan(4);
    expect(w.end).toBeLessThan(7);
    expectCleared(p, w);
  });

  it('negative: the home pose and small moves stay inside', () => {
    expect(only(take({ pose: P({ x: 0.05, size: 1.05 }) }), 'off-canvas')).toEqual([]);
  });
});

describe('off-canvas: one warning per cause, and fast on long takes', () => {
  /** A strong, fast float near the top edge: the keyframe pose is inside, the float pokes it out once per period. */
  const BOB: Partial<Phone3D> = { pose: P({ y: 0.1 }), float: { on: true, amount: 1, period: 2 } };
  function longTake(duration: number, patch: Partial<Phone3D>): Project {
    const p = with3d(phoneProject({ duration }), patch);
    p.zoom = { ...p.zoom, fromTaps: false };
    p.taps = [];
    p.tapsAnalyzed = true;
    return p;
  }

  it('runs the float makes from one keyframe are one warning with one fix, and the message says the float did it', () => {
    const p = longTake(20, BOB);
    const ws = only(p, 'off-canvas');
    expect(ws).toHaveLength(1);
    const [w] = ws;
    expect(w.message).toMatch(/ 10 times from 0\.27 s to 18\.53 s \(the idle float carries it past the edge\)$/);
    expect(w.fix).toEqual([{ op: 'setPose', at: expect.any(Number), y: expect.any(Number) }]);
    expect((w.fix![0] as EditOp).y as number).toBeLessThan(0.1);
    expect(only(applyFix(p, w), 'off-canvas')).toEqual([]);
  });

  it('negative: a pose that is out on its own does not blame the float', () => {
    const [w] = only(longTake(20, { ...BOB, pose: P({ y: 0.13 }) }), 'off-canvas');
    expect(w.message).toBe('The phone goes 85 px off the canvas from 0.00 s to 20.00 s');
  });

  it('two keyframes that each push it out are two warnings, each with a fix that clears it', () => {
    const p = take({ transitions: [move('a', 4, 5, { x: 0.6 }), move('b', 6, 7, { x: 0 }), move('c', 10, 11, { x: -0.6 }), move('d', 12, 13, { x: 0 })] });
    const ws = only(p, 'off-canvas');
    expect(ws.map((w) => w.transitionId)).toEqual(['a', 'c']);
    for (const w of ws) expectCleared(p, w);
  });

  it('one warning spans every float run from its keyframe, so the planner compares moment by moment (offCanvasAdded)', () => {
    const baseline = longTake(20, BOB);
    // The warning covers 0.27-18.53 s, but the phone is only out for a moment once per period.
    const [w] = only(baseline, 'off-canvas');
    expect([w.at, w.end]).toEqual([0.267, 18.533]);
    const meter = offCanvasMeter(baseline)!;
    // Out past the 2% margin at the run, about at the edge between runs.
    expect(meter(w.at!)).toBeGreaterThan(20);
    expect(Math.abs(meter(1))).toBeLessThan(5);
    // The same project is no further out than itself: nothing added.
    expect(offCanvasAdded(baseline, meter)).toEqual([]);
    // A move that pushes it further up at 9-10 s, inside the warning's span, is caught there and blamed on itself,
    // even where the float alone already pokes out (and was excused by the span before).
    const pushed = longTake(20, { ...BOB, transitions: [move('up', 9, 9.5, { y: 0.14 }), move('back', 9.5, 10, { y: 0.1 })] });
    const added = offCanvasAdded(pushed, meter);
    expect(added.length).toBeGreaterThan(0);
    for (const r of added) {
      expect(r.at).toBeGreaterThanOrEqual(9);
      expect(r.end).toBeLessThanOrEqual(10.6);
      expect(['up', 'back']).toContain(r.transitionId);
      expect(r.over).toBeGreaterThan(r.baseline! + OFF_CANVAS_ADDED_PX);
    }
    // With no baseline, every overflow past the margin counts.
    expect(offCanvasAdded(baseline, null).length).toBe(10);
  });

  it('negative: no meter and nothing added for a phone that is off, inactive, or has errors', () => {
    const off = { ...longTake(20, BOB), phone3d: { ...longTake(20, BOB).phone3d!, enabled: false } };
    expect(offCanvasMeter(off)).toBeNull();
    expect(offCanvasAdded(off, null)).toEqual([]);
    const appStore = longTake(20, BOB);
    appStore.layout = { ...appStore.layout, presetId: 'appstore' };
    expect(projectWarnings(appStore).map((w) => w.code)).toEqual(['inactive']);
    expect(offCanvasMeter(appStore)).toBeNull();
    expect(offCanvasAdded(appStore, null)).toEqual([]);
  });

  it('a 10-minute take with ~300 float runs: one warning with a fix, in well under a second', () => {
    const p = longTake(600, BOB);
    projectWarnings(longTake(20, BOB)); // warm up the JIT so the timing is the algorithm's
    const t0 = performance.now();
    const ws = projectWarnings(p);
    const ms = performance.now() - t0;
    // Rescanning the whole timeline for every run (the old way) took ~30 s here and returned ~300 warnings, each with its own fix.
    expect(ws.filter((w) => w.code === 'off-canvas')).toHaveLength(1);
    expect(ws[0].message).toMatch(/ (29\d|30\d) times from /);
    expect(ws[0].fix).toBeDefined();
    expect(ms, `projectWarnings took ${Math.round(ms)} ms`).toBeLessThan(1500);
    expect(only(applyFix(p, ws[0]), 'off-canvas')).toEqual([]);
  });
});

describe('overlap', () => {
  it('two overlapping moves: the later one is flagged; the fix starts it when the earlier ends', () => {
    const p = take({ transitions: [move('a', 1, 3, { turn: 20 }), move('b', 2, 4, { turn: -20 })] });
    const [w] = only(p, 'overlap');
    expect(w).toMatchObject({ transitionId: 'b', at: 2, end: 3, fix: [{ op: 'editTransition', id: 'b', start: 3 }] });
    expectCleared(p, w);
  });

  it('when starting later would leave it too short, the fix shifts it instead', () => {
    const p = take({ transitions: [move('a', 1, 3, { turn: 20 }), move('b', 2.5, 3.05, { turn: -20 })] });
    const [w] = only(p, 'overlap');
    expect(w.fix).toEqual([{ op: 'editTransition', id: 'b', by: 0.5 }]);
    expectCleared(p, w);
  });

  it('a long move overlapping a later non-neighbour is caught too', () => {
    const p = take({ transitions: [move('a', 1, 9, { turn: 20 }), move('b', 2, 3, {}), move('c', 5, 6, {})] });
    expect(only(p, 'overlap').map((w) => w.transitionId)).toEqual(['b', 'c']);
  });

  it('negative: moves that touch end to start do not overlap', () => {
    expect(only(take({ transitions: [move('a', 1, 2, { turn: 20 }), move('b', 2, 3, {})] }), 'overlap')).toEqual([]);
  });
});

describe('past-end', () => {
  it('a move that ends after the video: the fix shifts it back by D − end', () => {
    const p = take({ transitions: [move('a', 19.5, 21, { turn: 20 })] });
    const [w] = only(p, 'past-end');
    expect(w.fix).toEqual([{ op: 'editTransition', id: 'a', by: -1 }]);
    expectCleared(p, w);
  });

  it('a move longer than the video: the fix fits it to 0..D', () => {
    const p = take({ transitions: [move('a', 1, 25, { turn: 20 })] });
    const [w] = only(p, 'past-end');
    expect(w.fix).toEqual([{ op: 'editTransition', id: 'a', start: 0, end: 20 }]);
    expectCleared(p, w);
  });

  it('is a warning, not an error: a move past the end is accepted', () => {
    const p = applyOps(take(), [{ op: 'addTransition', start: 19, end: 23, to: { turn: 20 } }], { newId: () => 'late' }).project;
    expect(codes(p)).toContain('past-end');
  });

  it('negative: a move that ends exactly at the end', () => {
    expect(only(take({ transitions: [move('a', 18, 20, { turn: 20 })] }), 'past-end')).toEqual([]);
  });
});

describe('pose-jump', () => {
  it('an explicit Start far from where the phone is: the fix links it', () => {
    const p = take({ transitions: [move('a', 1, 2, { turn: 90 }), move('b', 3, 4, { turn: 20 }, { from: P({ turn: 0, size: 1.2 }) })] });
    const [w] = only(p, 'pose-jump');
    expect(w).toMatchObject({ transitionId: 'b', at: 3, fix: [{ op: 'editTransition', id: 'b', from: null }] });
    expect(w.message).toMatch(/turn -90.*size \+0\.2/);
    expectCleared(p, w);
  });

  it('negative: the same angle a whole turn away (a D21 rebase) is not a jump, and neither is a tiny difference', () => {
    expect(only(take({ transitions: [move('a', 1, 2, { turn: 360 }), move('b', 3, 4, { turn: 20 }, { from: P({ turn: 0 }) })] }), 'pose-jump')).toEqual([]);
    expect(only(take({ transitions: [move('a', 1, 2, { turn: 90 }), move('b', 3, 4, {}, { from: P({ turn: 90.5, size: 1.004 }) })] }), 'pose-jump')).toEqual([]);
    // The first move has nothing before it on screen: its Start is what the phone shows.
    expect(only(take({ transitions: [move('a', 1, 2, {}, { from: P({ turn: 120 }) })] }), 'pose-jump')).toEqual([]);
  });
});

describe('too-fast', () => {
  const quick = (end: number, turn: number, blur = true): Project => {
    const p = take({ transitions: [move('a', 1, end, { turn })] });
    p.phone3d!.motionBlur = { ...p.phone3d!.motionBlur, on: blur };
    return p;
  };

  it('a full spin in half a second', () => {
    const [w] = only(quick(1.5, 360), 'too-fast');
    expect(w).toMatchObject({ transitionId: 'a' });
    expect(w.message).toMatch(/turns at \d+°\/s, over 600°\/s/);
  });

  it('the limit drops to 360°/s with motion blur off', () => {
    // 180° in 0.75 s with smootherstep peaks near 450°/s.
    expect(only(quick(1.75, 180, true), 'too-fast')).toEqual([]);
    expect(only(quick(1.75, 180, false), 'too-fast').length).toBe(1);
  });

  it('negative: a calm move', () => {
    expect(only(quick(4, 90), 'too-fast')).toEqual([]);
  });
});

describe('floor-flat', () => {
  it('a floor shadow seen edge-on; the fix raises the camera to 12°', () => {
    const p = take({ shadow: { on: true, kind: 'floor', opacity: 0.4, softness: 0.5 } });
    const [w] = only(p, 'floor-flat');
    expect(w.fix).toEqual([{ op: 'phone3d', camera: { elevation: 12 } }]);
    expectCleared(p, w);
  });

  it('negative: a raised camera, a wall shadow, or no shadow', () => {
    expect(only(take({ shadow: { on: true, kind: 'floor', opacity: 0.4, softness: 0.5 }, camera: { fov: 22, elevation: 12 } }), 'floor-flat')).toEqual([]);
    expect(only(take(), 'floor-flat')).toEqual([]);
    expect(only(take({ shadow: { on: false, kind: 'floor', opacity: 0.4, softness: 0.5 } }), 'floor-flat')).toEqual([]);
  });
});

describe('zoom-3d', () => {
  it('names each manual zoom while the phone is 3D (zooms do not play there), with no fix', () => {
    const p = applyOps(take(), [{ op: 'addZoom', at: 4, scale: 2 }, { op: 'addZoom', at: 11, scale: 1.5 }]).project;
    const ws = only(p, 'zoom-3d');
    expect(ws.map((w) => w.at)).toEqual([4, 11]);
    for (const w of ws) {
      expect(w.end).toBeGreaterThan(w.at!);
      expect(w.fix).toBeUndefined();
      expect(w.message).toContain('does not play while the phone is 3D');
    }
  });

  it('negative: no manual zooms, or 3D off (the zooms play)', () => {
    expect(only(take(), 'zoom-3d')).toEqual([]);
    const off = applyOps(take({ enabled: false }), [{ op: 'addZoom', at: 4 }]).project;
    expect(projectWarnings(off)).toEqual([]);
  });

  it('zoom ops still apply, and their notes say the zooms do not play while the phone is 3D', () => {
    const ops: EditOp[] = [{ op: 'addZoom', at: 4 }, { op: 'zoomSettings', autofocus: true }, { op: 'clearZooms' }];
    const on = applyOps(take(), ops);
    expect(on.notes.every((n) => n.endsWith(ZOOM_3D_NOTE))).toBe(true);
    const off = applyOps(take({ enabled: false }), ops);
    expect(off.notes.some((n) => n.includes(ZOOM_3D_NOTE))).toBe(false);
    expect(off.project.zoom).toEqual(on.project.zoom);
  });
});

describe('every offered fix clears its warning', () => {
  it('across a messy project', () => {
    const list: PoseTransition[] = [
      move('a', 1, 2, { turn: 50 }),
      move('b', 1.5, 2.6, { turn: 180 }),
      move('c', 3, 4, { turn: 20 }, { from: P({ turn: -60 }) }),
      move('d', 6, 6.4, { turn: 360, x: 0.7 }),
      move('e', 19, 22, { turn: 10 }),
    ];
    const p = take({ transitions: list, shadow: { on: true, kind: 'floor', opacity: 0.4, softness: 0.5 } }, [2.2, 5, 8]);
    const ws = projectWarnings(p);
    expect(new Set(ws.map((w) => w.code)).size).toBeGreaterThan(5);
    for (const w of ws) if (w.fix) expectCleared(p, w);
  });
});
