import { describe, expect, it } from 'vitest';
import { defaultPhone3D, FRONT, type Phone3D, type Pose } from '../src/shared/phone3d/model';
import {
  facing,
  facingOf,
  lerpPose,
  poseAt,
  poseAtWithFloat,
  poseDelta,
  poseSpeed,
  poseTargetAt,
  rebaseTurn,
  resolveStarts,
  wrap180,
} from '../src/shared/phone3d/pose';
import { camAt, project, scene3d } from '../src/shared/phone3d/projection';
import { move, phoneProject, with3d } from './helpers/phone3dFixtures';

const p3With = (patch: Partial<Phone3D>): Phone3D => ({ ...defaultPhone3D(), ...patch });
const near = (a: Pose, b: Pose, eps = 1e-9) => {
  for (const k of Object.keys(a) as (keyof Pose)[]) expect(Math.abs(a[k] - b[k])).toBeLessThan(eps);
};

describe('poseAt', () => {
  it('holds the base pose with no moves, and holds each End after its move', () => {
    const base = { ...FRONT, turn: 10 };
    expect(poseAt(p3With({ pose: base }), 3)).toEqual(base);
    const p3 = p3With({ pose: base, transitions: [move('a', 1, 2, { turn: 90 })] });
    expect(poseAt(p3, 0)).toEqual(base); // before: the first move's resolved (linked) start
    expect(poseAt(p3, 2)).toMatchObject({ turn: 90 });
    expect(poseAt(p3, 50)).toMatchObject({ turn: 90 });
    expect(poseAt(p3, 1.5).turn).toBeCloseTo(50, 9); // smootherstep(0.5) = 0.5
  });

  it('a linked move starts from where the previous one left the phone (continuous)', () => {
    const p3 = p3With({ transitions: [move('a', 1, 2, { turn: 90 }), move('b', 3, 4, { tilt: 20 })] });
    const starts = resolveStarts(p3);
    expect(starts[1]).toMatchObject({ turn: 90, tilt: 0 });
    near(poseAt(p3, 3), poseAt(p3, 2.999999), 1e-6);
    near(poseAt(p3, 3 + 1e-9), poseAt(p3, 3), 1e-6);
  });

  it('a linked move that overlaps an earlier one starts from its mid-flight pose', () => {
    const p3 = p3With({ transitions: [move('a', 1, 3, { turn: 100 }), move('b', 2, 4, { tilt: 30 })] });
    const mid = poseAt(p3With({ transitions: [move('a', 1, 3, { turn: 100 })] }), 2);
    expect(resolveStarts(p3)[1]).toEqual(mid);
    // No jump at the overlap start.
    near(poseAt(p3, 2), poseAt(p3, 2 - 1e-9), 1e-6);
    // The later start wins: b's End is reached at 4.
    expect(poseAt(p3, 4)).toMatchObject({ tilt: 30, turn: 0 }); // `to` is a full pose
  });

  it('an explicit from is used as the Start (and can jump)', () => {
    const p3 = p3With({ transitions: [move('a', 1, 2, { turn: 90 }, { from: { ...FRONT, turn: -40 } })] });
    expect(poseAt(p3, 0)).toMatchObject({ turn: -40 });
    expect(poseAt(p3, 1)).toMatchObject({ turn: -40 });
  });

  it('spins 720° with no wrap', () => {
    const p3 = p3With({ transitions: [move('a', 0, 2, { turn: 720 }, { easing: { kind: 'linear' } })] });
    expect(poseAt(p3, 1).turn).toBeCloseTo(360, 9);
    expect(poseAt(p3, 1.5).turn).toBeCloseTo(540, 9);
    expect(poseAt(p3, 2).turn).toBe(720);
  });

  it('focus lerps like every other channel', () => {
    expect(lerpPose(FRONT, { ...FRONT, focus: 0 }, 0.25).focus).toBeCloseTo(0.75, 12);
    const p3 = p3With({ transitions: [move('a', 0, 1, { focus: 2 }, { easing: { kind: 'linear' } })] });
    expect(poseAt(p3, 0.5).focus).toBeCloseTo(1.5, 12);
  });

  it('allows spring overshoot past the End', () => {
    const p3 = p3With({ transitions: [move('a', 0, 2, { turn: 100 }, { easing: { kind: 'spring', stiffness: 180, damping: 18 } })] });
    let max = 0;
    for (let i = 0; i <= 400; i++) max = Math.max(max, poseAt(p3, (2 * i) / 400).turn);
    expect(max).toBeGreaterThan(100);
  });
});

describe('float', () => {
  it('is periodic in its period and off when float.on is false', () => {
    const p3 = p3With({ float: { on: true, amount: 0.6, period: 5 } });
    for (const t of [0, 0.7, 2.2, 4.9]) near(poseAtWithFloat(p3, t), poseAtWithFloat(p3, t + 5), 1e-9);
    expect(poseAtWithFloat(p3, 1.3)).not.toEqual(poseAt(p3, 1.3));
    const off = p3With({ float: { on: false, amount: 0.6, period: 5 } });
    expect(poseAtWithFloat(off, 1.3)).toEqual(poseAt(off, 1.3));
  });

  it('drifts by the documented amplitudes', () => {
    const p3 = p3With({ float: { on: true, amount: 1, period: 4 } });
    let y = 0;
    let turn = 0;
    let tilt = 0;
    for (let i = 0; i < 400; i++) {
      const q = poseAtWithFloat(p3, (4 * i) / 400);
      y = Math.max(y, Math.abs(q.y));
      turn = Math.max(turn, Math.abs(q.turn));
      tilt = Math.max(tilt, Math.abs(q.tilt));
    }
    expect(y).toBeCloseTo(0.012, 4);
    expect(turn).toBeCloseTo(4, 2);
    expect(tilt).toBeCloseTo(2.5, 2);
  });
});

describe('poseTargetAt', () => {
  const two = p3With({
    pose: { ...FRONT, turn: 5 },
    transitions: [move('a', 2, 4, { turn: 90 }), move('b', 6, 8, { tilt: 20 }, { from: { ...FRONT, turn: 90, tilt: 5 } })],
  });

  it('no moves: the base pose', () => {
    expect(poseTargetAt(p3With({}), 3)).toEqual({ kind: 'base', pose: FRONT });
  });

  it("'Base pose' chosen: the base pose even when moves exist", () => {
    expect(poseTargetAt(two, 3, null, 'base')).toMatchObject({ kind: 'base', pose: { turn: 5 } });
  });

  it('before the first move: its Start, materialized when linked', () => {
    expect(poseTargetAt(two, 1)).toMatchObject({ kind: 'from', id: 'a', index: 0, materialize: true, pose: { turn: 5 } });
  });

  it('inside a move: its nearer end', () => {
    expect(poseTargetAt(two, 2.5)).toMatchObject({ kind: 'from', id: 'a' });
    expect(poseTargetAt(two, 3.6)).toMatchObject({ kind: 'to', id: 'a', pose: { turn: 90 } });
  });

  it('in the hold after move k: k.to', () => {
    expect(poseTargetAt(two, 5)).toMatchObject({ kind: 'to', id: 'a' });
    expect(poseTargetAt(two, 20)).toMatchObject({ kind: 'to', id: 'b' });
  });

  it('a selected move: its nearer end, wherever t is; an explicit from is not re-materialized', () => {
    expect(poseTargetAt(two, 0, 'b')).toMatchObject({ kind: 'from', id: 'b', materialize: false, pose: { tilt: 5 } });
    expect(poseTargetAt(two, 20, 'b')).toMatchObject({ kind: 'to', id: 'b' });
    expect(poseTargetAt(two, 20, 'gone')).toMatchObject({ kind: 'to', id: 'b' });
  });
});

describe('signs and facing', () => {
  it('+tilt leans the top away: the top edge projects narrower than the bottom', () => {
    const p = with3d(phoneProject(), { pose: { ...FRONT, tilt: 30 } });
    const s = scene3d(p)!;
    const cam = camAt(s, 0);
    const { width: bw, height: bh } = s.bodyMm;
    const z = s.body3d.depthMm / 2;
    const w = (y: number) => project([bw / 2, y, z], cam)[0] - project([-bw / 2, y, z], cam)[0];
    expect(w(bh / 2)).toBeLessThan(w(-bh / 2));
    // ...and −tilt the other way round (the test can fail).
    const s2 = scene3d(with3d(phoneProject(), { pose: { ...FRONT, tilt: -30 } }))!;
    const cam2 = camAt(s2, 0);
    const w2 = (y: number) => project([bw / 2, y, z], cam2)[0] - project([-bw / 2, y, z], cam2)[0];
    expect(w2(bh / 2)).toBeGreaterThan(w2(-bh / 2));
  });

  it('+turn turns the screen toward the right; +rotate is clockwise on the canvas', () => {
    const s = scene3d(with3d(phoneProject(), { pose: { ...FRONT, turn: 30 } }))!;
    const cam = camAt(s, 0);
    const z = s.body3d.depthMm / 2;
    // The right edge recedes: it projects shorter than the left edge.
    const h = (x: number) => project([x, -50, z], cam)[1] - project([x, 50, z], cam)[1];
    expect(h(30)).toBeLessThan(h(-30));
    const r = scene3d(with3d(phoneProject(), { pose: { ...FRONT, rotate: 20 } }))!;
    const cr = camAt(r, 0);
    // The top-centre point moves right on the canvas when rotated clockwise.
    expect(project([0, 60, z], cr)[0]).toBeGreaterThan(project([0, 60, z], camAt(scene3d(with3d(phoneProject()))!, 0))[0]);
  });

  it('facing: 1 at FRONT, cos 60 at turn 60, < 0 from behind', () => {
    expect(facingOf(FRONT)).toBeCloseTo(1, 12);
    expect(facingOf({ ...FRONT, turn: 60 })).toBeCloseTo(0.5, 12);
    expect(facingOf({ ...FRONT, turn: 180 })).toBeLessThan(0);
    const p3 = p3With({ transitions: [move('a', 0, 1, { turn: 180 })] });
    expect(facing(p3, 0)).toBeCloseTo(1, 12);
    expect(facing(p3, 2)).toBeCloseTo(-1, 12);
  });

  it('poseSpeed measures the angular speed in °/s', () => {
    const p3 = p3With({ transitions: [move('a', 0, 2, { turn: 360 }, { easing: { kind: 'linear' } })] });
    expect(poseSpeed(p3, 1)).toBeCloseTo(180, 3);
    expect(poseSpeed(p3, 5)).toBe(0);
  });
});

describe('poseDelta and rebaseTurn', () => {
  it('compares turn and rotate modulo 360 into (−180, 180]', () => {
    expect(poseDelta({ turn: 360 }, { turn: 0 }).turn).toBe(0);
    expect(poseDelta({ turn: 190 }, { turn: 0 }).turn).toBeCloseTo(-170, 12);
    expect(poseDelta({ rotate: -180 }, { rotate: 0 }).rotate).toBe(180);
    expect(poseDelta({ tilt: 30 }, { tilt: 10 }).tilt).toBe(20); // not an angle key: plain difference
    expect(poseDelta({ size: 1.5 }, {}).size).toBeCloseTo(0.5, 12);
    expect(wrap180(-540)).toBe(180);
  });

  it('rebaseTurn keeps the angle and lands in [−180, 180]', () => {
    for (const t of [-720, -541, -180, -179, 0, 179, 180, 181, 359, 360, 700, 720]) {
      const r = rebaseTurn({ ...FRONT, turn: t });
      expect(r.turn).toBeGreaterThanOrEqual(-180);
      expect(r.turn).toBeLessThanOrEqual(180);
      expect(poseDelta(r, { turn: t }).turn).toBeCloseTo(0, 9);
    }
  });
});

describe('pose breaks and the cut shutter (no double image on an unlinked Start)', () => {
  it('only an unlinked Start that differs from the pose before it is a break', async () => {
    const { poseBreaks } = await import('../src/shared/phone3d/pose');
    const linked = with3d(phoneProject(), { transitions: [move('a', 1, 2, { turn: 90 }), move('b', 3, 3.6, { turn: 30 })] }).phone3d!;
    expect(poseBreaks(linked)).toEqual([]);
    const same = with3d(phoneProject(), { transitions: [move('a', 1, 2, { turn: 90 }), move('b', 3, 3.6, { turn: 30 }, { from: { ...FRONT, turn: 90 } })] }).phone3d!;
    expect(poseBreaks(same)).toEqual([]); // unlinked but continuous
    const jump = with3d(phoneProject(), { transitions: [move('a', 1, 2, { turn: 90 }), move('b', 3, 3.6, { turn: 30 }, { from: { ...FRONT, turn: -20 } })] }).phone3d!;
    expect(poseBreaks(jump)).toEqual([3]);
  });

  it('cuts the shutter at the nearest break on each side; null when none falls inside', async () => {
    const { BREAK_EPS, shutterWindow } = await import('../src/shared/phone3d/pose');
    const sh = 0.5 / 30;
    expect(shutterWindow([], 3, sh)).toBeNull();
    expect(shutterWindow([5], 3, sh)).toBeNull();
    expect(shutterWindow([3], 3, sh)).toEqual({ lo: 3, hi: 3 + sh / 2 }); // a break belongs to the pose after it
    expect(shutterWindow([3.004], 3, sh)).toEqual({ lo: 3 - sh / 2, hi: 3.004 - BREAK_EPS });
    expect(shutterWindow([2.999, 3.004], 3, sh)).toEqual({ lo: 2.999, hi: 3.004 - BREAK_EPS });
  });
});
