import { describe, expect, it } from 'vitest';
import { applyOps, type EditOp } from '../src/shared/agentOps';
import { ease } from '../src/shared/phone3d/easing3d';
import { FRONT, POSE_KEYS, SHOT_RECIPES, type Pose, type PoseTransition } from '../src/shared/phone3d/model';
import { facingOf, lerpPose, poseAt, poseDelta, poseInRange, poseRotation, resolveStarts, rotationAngle } from '../src/shared/phone3d/pose';
import { screenQuad } from '../src/shared/phone3d/projection';
import { defaultShotDuration, expandShot, SHOT_OVERSHOOT, shotKeys, shotRecipeList, SHOTS } from '../src/shared/phone3d/shots';
import { TOO_FAST_DEG_S } from '../src/shared/phone3d/warnings';
import { phoneProject, with3d } from './helpers/phone3dFixtures';

const ids = () => {
  let n = 0;
  return () => `s${++n}`;
};
const pose = (patch: Partial<Pose>): Pose => ({ ...FRONT, ...patch });
const MOVING = SHOT_RECIPES.filter((r) => r !== 'float');

/** Peak angular speed (°/s) of a list of moves played from `before`, sampled at 480 Hz. */
function peakSpeed(list: PoseTransition[], before: Pose): number {
  const p3 = { pose: before, transitions: list };
  const h = 1 / 240;
  let peak = 0;
  const t0 = list[0].start;
  const t1 = list[list.length - 1].end;
  for (let t = t0; t <= t1; t += 1 / 480) peak = Math.max(peak, rotationAngle(poseRotation(poseAt(p3, t - h)), poseRotation(poseAt(p3, t + h))) / (2 * h));
  return peak;
}

describe('SHOTS', () => {
  it('has every recipe, and info gets name, duration, summary and use in order', () => {
    expect(Object.keys(SHOTS).sort()).toEqual([...SHOT_RECIPES].sort());
    const list = shotRecipeList();
    expect(list.map((r) => r.name)).toEqual([...SHOT_RECIPES]);
    for (const r of list) {
      expect(r.summary.length).toBeGreaterThan(10);
      expect(r.use.length).toBeGreaterThan(10);
      expect(r.duration).toBe(SHOTS[r.name].duration);
    }
  });

  it('every key lies inside its shot (fractions ordered, 0..1)', () => {
    for (const r of MOVING) {
      for (const k of SHOTS[r].keys) {
        expect(k.frac[0]).toBeGreaterThanOrEqual(0);
        expect(k.frac[1]).toBeLessThanOrEqual(1);
        expect(k.frac[1]).toBeGreaterThan(k.frac[0]);
      }
    }
  });

  it('no recipe at its default length turns faster than the too-fast limit (from FRONT and from the bold base)', () => {
    for (const before of [pose({}), pose({ turn: -8, tilt: 5 })]) {
      for (const r of MOVING) {
        for (const ret of ['front', 'stay'] as const) {
          for (const direction of [1, -1] as const) {
            const { transitions } = expandShot(r, { start: 1, ret, direction }, before, ids());
            expect(peakSpeed(transitions, before), `${r} ${ret} ${direction}`).toBeLessThan(TOO_FAST_DEG_S);
          }
        }
      }
    }
  });
});

describe('shot timing (look round 2: no whips)', () => {
  /** Peak angular speed (°/s) inside [t0, t1] of a played list. */
  const peakIn = (list: PoseTransition[], before: Pose, t0: number, t1: number) => {
    const p3 = { pose: before, transitions: list };
    const h = 1 / 240;
    let peak = 0;
    for (let t = t0 + h; t <= t1 - h; t += 1 / 480) peak = Math.max(peak, rotationAngle(poseRotation(poseAt(p3, t - h)), poseRotation(poseAt(p3, t + h))) / (2 * h));
    return peak;
  };

  it('every recipe peaks under 300°/s at its default length (half the too-fast line), both ways, from FRONT and the bold base', () => {
    for (const before of [pose({}), pose({ turn: -8, tilt: 5 })]) {
      for (const r of MOVING) {
        for (const ret of ['front', 'stay'] as const) {
          for (const direction of [1, -1] as const) {
            const { transitions } = expandShot(r, { start: 1, ret, direction }, before, ids());
            expect(peakSpeed(transitions, before), `${r} ${ret} ${direction}`).toBeLessThan(300);
          }
        }
      }
    }
  });

  it('no move uses the quint-like cinematic curve or a spring from rest: every key eases in and out (cubic-type)', () => {
    for (const r of MOVING) {
      for (const k of SHOTS[r].keys) {
        expect(k.easing.kind, r).not.toBe('cinematic');
        // Peak slope of the curve, × the average: a cubic ease-in-out is about 1.7, cinematic 4.4.
        let m = 0;
        for (let i = 0; i < 1000; i++) m = Math.max(m, (ease(k.easing, (i + 1) / 1000, 1) - ease(k.easing, i / 1000, 1)) * 1000);
        expect(m, r).toBeLessThan(2);
      }
    }
  });

  it('hero-layback holds at least 0.8 s without ever freezing (a slow drift, joined at matching speed), and returns no faster than it went out', () => {
    const list = expandShot('hero-layback', { start: 0 }, FRONT, ids()).transitions;
    const [out, drift, back] = list;
    expect(drift.end - drift.start).toBeGreaterThanOrEqual(0.8 - 1e-9);
    const p3 = { pose: FRONT, transitions: list };
    const h = 1 / 480;
    const speed = (t: number) => rotationAngle(poseRotation(poseAt(p3, t - h)), poseRotation(poseAt(p3, t + h))) / (2 * h);
    // Round 2 held the pose dead still for 0.8 s. Now every moment of the hold moves, slowly (2-6°/s).
    for (let t = drift.start; t <= drift.end; t += 0.02) {
      expect(speed(t), `t ${t.toFixed(2)}`).toBeGreaterThan(1.5);
      expect(speed(t), `t ${t.toFixed(2)}`).toBeLessThan(8);
    }
    // No kick at either join: the speed just before and just after match.
    for (const at of [drift.start, drift.end]) expect(Math.abs(speed(at - 0.002) - speed(at + 0.002))).toBeLessThan(1);
    // About 2.5° more turn and under 1% of size through the hold.
    expect(drift.to.turn - out.to.turn).toBeCloseTo(-2.5, 1);
    expect(Math.abs(drift.to.size - out.to.size)).toBeLessThan(0.01);
    const vOut = peakIn(list, FRONT, out.start, out.end);
    const vBack = peakIn(list, FRONT, back.start, list[list.length - 1].end);
    expect(vBack).toBeLessThanOrEqual(vOut * 1.02);
  });

  it('spin-in and hero-layback carry a small visible overshoot past the pose, then settle onto it', () => {
    const spin = expandShot('spin-in', { start: 0 }, FRONT, ids()).transitions;
    const p3 = { pose: FRONT, transitions: spin };
    let over = 0;
    for (let t = 0; t <= 1.6; t += 1 / 240) over = Math.max(over, poseAt(p3, t).turn);
    expect(over).toBeGreaterThan(3);
    expect(over).toBeLessThan(5);
    expect(poseAt(p3, 1.6)).toEqual(FRONT);
    // The settle takes about 0.4 s.
    expect(spin[1].end - spin[1].start).toBeCloseTo(0.4, 9);
    const hero = expandShot('hero-layback', { start: 0 }, FRONT, ids()).transitions;
    expect(hero[2].to.turn).toBeCloseTo(24 * SHOT_OVERSHOOT, 9);
    expect(hero[3].to).toEqual({ ...FRONT });
  });

  it('turn-to-back lets the back be seen: about 0.7 s drifting slowly across a three-quarter back view, no hitch, no stop; "stay" comes to rest there', () => {
    const list = expandShot('turn-to-back', { start: 0 }, FRONT, ids()).transitions;
    const [out, drift, on] = list;
    expect(out.end).toBe(drift.start);
    expect(drift.end).toBe(on.start);
    const p3 = { pose: FRONT, transitions: list };
    const h = 1 / 480;
    const speed = (t: number) => rotationAngle(poseRotation(poseAt(p3, t - h)), poseRotation(poseAt(p3, t + h))) / (2 * h);
    // The back faces the viewer (turn 165..179) for the whole drift, moving at about 20°/s, never stopped.
    expect(drift.end - drift.start).toBeCloseTo(0.7, 9);
    for (let t = drift.start; t <= drift.end; t += 0.02) {
      expect(poseAt(p3, t).turn).toBeGreaterThanOrEqual(165 - 1e-9);
      expect(poseAt(p3, t).turn).toBeLessThanOrEqual(179 + 1e-9);
      expect(speed(t)).toBeGreaterThan(15);
      expect(speed(t)).toBeLessThan(25);
    }
    // One speed curve: it slows into the drift and picks up out of it with no jump (round 2: two eases met at
    // 25°/0.2 s on the back and read as a hitch).
    for (const at of [drift.start, drift.end]) expect(Math.abs(speed(at - 0.005) - speed(at + 0.005))).toBeLessThan(2);
    // Slower than round 2's 270°/s peak, and the whole turn takes 3 s or more.
    expect(peakIn(list, FRONT, 0, on.end)).toBeLessThan(230);
    expect(on.end - out.start).toBeGreaterThanOrEqual(3);
    const stay = expandShot('turn-to-back', { start: 0, ret: 'stay' }, FRONT, ids()).transitions;
    const ps = { pose: FRONT, transitions: stay };
    const end = stay[stay.length - 1].end;
    expect(rotationAngle(poseRotation(poseAt(ps, end - 2 * h)), poseRotation(poseAt(ps, end))) / (2 * h)).toBeLessThan(2);
  });
});

describe('expandShot', () => {
  it('spin-in starts soft, small and turned away, and lands exactly on `before`', () => {
    const before = pose({ turn: 10, size: 1.2 });
    const [tr, settle] = expandShot('spin-in', { start: 0 }, before, ids()).transitions;
    expect(tr).toMatchObject({ id: 's1', start: 0, recipe: 'spin-in', easing: { kind: 'bezier' } });
    expect(tr.end).toBeCloseTo(1.2, 9);
    expect(tr.from).toMatchObject({ turn: -190, tilt: 14, size: 1.2 - 0.45, y: 0.06, light: -60, focus: 1.8 });
    // It carries 4° past the pose, then settles back onto `before` exactly.
    expect(tr.to).toEqual({ ...before, turn: 14 });
    expect(settle.start).toBeCloseTo(1.2, 9);
    expect(settle.end).toBe(1.6);
    expect(settle.from).toBeUndefined();
    expect(settle.to).toEqual(before);
  });

  it('turn-to-back is a round trip that ends at +360 by default; return "stay" ends on the back', () => {
    const rt = expandShot('turn-to-back', { start: 2 }, FRONT, ids()).transitions;
    expect(rt).toHaveLength(3);
    const ends = [2 + 1.45, 2 + 2.15, 2 + 3.6];
    rt.forEach((t, i) => expect(t.end).toBeCloseTo(ends[i], 9));
    expect(rt[0].to).toMatchObject({ turn: 165, tilt: 8, light: 40 });
    expect(rt[1].to.turn).toBe(179);
    expect(rt[2].to).toMatchObject({ turn: 360, tilt: 0, light: 0 });
    expect(rt.every((t) => !t.from)).toBe(true); // linked: continues from wherever the phone is

    const stay = expandShot('turn-to-back', { start: 2, ret: 'stay' }, FRONT, ids()).transitions;
    expect(stay).toHaveLength(2);
    expect(stay[1].to.turn).toBe(179);
    // The outbound keys fill the shot; the default length is the outbound part of the recipe's.
    expect(defaultShotDuration('turn-to-back', 'stay')).toBeCloseTo(2.15, 9);
    expect(stay[1].end - stay[0].start).toBeCloseTo(2.15, 9);
    // Ending the shot, the drift comes to rest on the back (its stay easing) instead of drifting on.
    expect(stay[1].easing).toEqual(SHOTS['turn-to-back'].keys[1].stayEasing);
    expect(rt[1].easing).toEqual({ kind: 'linear' });
    const custom = expandShot('turn-to-back', { start: 0, ret: 'stay', duration: 2 }, FRONT, ids()).transitions;
    expect([custom[0].start, custom[custom.length - 1].end]).toEqual([0, 2]);
    expect(shotKeys('hero-layback', 'stay').keys.map((k) => k.frac[1])).toEqual([expect.any(Number), 1]);
  });

  it('hero-layback leans the top away (+tilt) and swings back past the pose, then settles; its tilt is positive', () => {
    const [out, , back, settle] = expandShot('hero-layback', { start: 0 }, FRONT, ids()).transitions;
    expect(out.to.tilt).toBeGreaterThan(0);
    expect(out.to).toMatchObject({ turn: -24, tilt: 16, rotate: -4, size: 0.92, light: -25 });
    expect(back.to.turn).toBeGreaterThan(0);
    expect(back.to.tilt).toBeLessThan(0);
    expect(settle.to).toEqual({ ...FRONT });
    // + tilt = layback: on the canvas the screen's top edge is narrower than its bottom edge.
    const p = with3d(phoneProject(), { pose: { ...FRONT, tilt: out.to.tilt } });
    const q = screenQuad(p, 0)!.quad;
    expect(Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y)).toBeLessThan(Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y));
  });

  it('settle drops in large and leaned back, carries just past the pose, then settles', () => {
    const [tr, back] = expandShot('settle', { start: 0 }, FRONT, ids()).transitions;
    expect(tr.from).toMatchObject({ tilt: 8, size: 1.06, y: -0.03 });
    expect(tr.to.tilt).toBeCloseTo(-8 * SHOT_OVERSHOOT, 9);
    expect(back.to).toEqual({ ...FRONT });
  });

  it('float adds no moves and asks for the float', () => {
    expect(expandShot('float', { start: 3 }, FRONT, ids())).toEqual({ transitions: [], float: true });
  });

  it('intensity scales the deltas, not focus and not the turn-to-back turn; direction -1 mirrors turn and rotate', () => {
    const half = expandShot('hero-layback', { start: 0, intensity: 0.5 }, FRONT, ids()).transitions[0].to;
    expect(half).toMatchObject({ turn: -12, tilt: 8, rotate: -2, size: 0.96, light: -12.5 });
    const ttb = expandShot('turn-to-back', { start: 0, intensity: 0.5 }, FRONT, ids()).transitions;
    expect(ttb[0].to).toMatchObject({ turn: 165, tilt: 4, light: 20 });
    expect(ttb[2].to.turn).toBe(360);
    const soft = expandShot('spin-in', { start: 0, intensity: 0.5 }, FRONT, ids()).transitions[0].from!;
    expect(soft).toMatchObject({ turn: -100, focus: 1.8 });
    const mirrored = expandShot('hero-layback', { start: 0, direction: -1 }, FRONT, ids()).transitions[0].to;
    expect(mirrored).toMatchObject({ turn: 24, rotate: 4, tilt: 16, light: -25 });
    const back = expandShot('turn-to-back', { start: 0, direction: -1 }, FRONT, ids()).transitions;
    expect(back.map((t) => t.to.turn)).toEqual([-165, -179, -360]);
  });

  it('every recipe lands inside POSE_RANGE, from FRONT and from turn ±700, at any intensity and direction', () => {
    const befores = [pose({}), pose({ turn: 700 }), pose({ turn: -700 }), pose({ turn: 700, tilt: 85, size: 3, x: 1, y: -1, light: 180, focus: 2 }), pose({ turn: -700, tilt: -85, size: 0.2, focus: 0 })];
    for (const before of befores) {
      for (const r of MOVING) {
        for (const intensity of [0.25, 1, 2]) {
          for (const direction of [1, -1] as const) {
            for (const ret of ['front', 'stay'] as const) {
              const list = expandShot(r, { start: 0, intensity, direction, ret }, before, ids()).transitions;
              for (const tr of list) {
                expect(poseInRange(tr.to)).toBe(true);
                if (tr.from) expect(poseInRange(tr.from)).toBe(true);
                expect(Math.abs(tr.to.turn)).toBeLessThanOrEqual(560);
              }
            }
          }
        }
      }
    }
  });

  it('D21: a far-wound turn is rebased into [-180, 180] with an explicit Start that is the same angle', () => {
    const before = pose({ turn: 700, tilt: 3 });
    const [first, , last] = expandShot('turn-to-back', { start: 0 }, before, ids()).transitions;
    expect(first.from).toMatchObject({ turn: -20, tilt: 3 });
    expect(poseDelta(first.from!, before).turn).toBe(0);
    expect(first.to.turn).toBe(145);
    expect(last.to.turn).toBe(340);
    // Nothing to rebase: no explicit Start.
    expect(expandShot('hero-layback', { start: 0 }, pose({ turn: 170 }), ids()).transitions[0].from).toBeUndefined();
  });

  it('every round trip ends facing exactly as it started', () => {
    for (const before of [pose({}), pose({ turn: -8, tilt: 5 }), pose({ turn: 400, tilt: -10, rotate: 30 })]) {
      for (const r of MOVING) {
        for (const direction of [1, -1] as const) {
          const list = expandShot(r, { start: 0, direction }, before, ids()).transitions;
          const end = list[list.length - 1].to;
          expect(facingOf(end)).toBeCloseTo(facingOf(before), 12);
          expect(Object.values(poseDelta(end, before)).every((d) => Math.abs(d) < 1e-9)).toBe(true);
        }
      }
    }
  });

  it('is deterministic: the same input gives the same moves and asks newId once per move, in order', () => {
    const a = expandShot('turn-to-back', { start: 1.5, intensity: 1.3, direction: -1 }, pose({ turn: 250 }), ids());
    const b = expandShot('turn-to-back', { start: 1.5, intensity: 1.3, direction: -1 }, pose({ turn: 250 }), ids());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.transitions.map((t) => t.id)).toEqual(['s1', 's2', 's3']);
  });

  it('a linked round trip played from `before` is continuous: no jump at any key', () => {
    const before = pose({ turn: 30 });
    const list = expandShot('turn-to-back', { start: 0 }, before, ids()).transitions;
    const starts = resolveStarts({ pose: before, transitions: list });
    expect(starts[0]).toEqual(before);
    expect(starts[1]).toEqual(list[0].to);
    expect(lerpPose(starts[0], list[0].to, 1)).toEqual(list[0].to);
    expect(POSE_KEYS.length).toBe(8);
  });
});

describe('shot op chains (D21 through applyOps)', () => {
  it('10 turn-to-back shots in a row, both directions and alternating with hero-layback, stay in range and never throw', () => {
    const chains: EditOp[][] = [
      Array.from({ length: 10 }, (_, i) => ({ op: 'shot', recipe: 'turn-to-back', at: 1 + i * 3.5 })),
      Array.from({ length: 10 }, (_, i) => ({ op: 'shot', recipe: 'turn-to-back', at: 1 + i * 3.5, direction: -1 })),
      Array.from({ length: 10 }, (_, i) => ({ op: 'shot', recipe: 'turn-to-back', at: 1 + i * 3.5, direction: i % 2 ? -1 : 1 })),
      Array.from({ length: 20 }, (_, i) => (i % 2 ? { op: 'shot', recipe: 'hero-layback', at: 1 + i * 3.5, direction: -1, return: 'stay' } : { op: 'shot', recipe: 'turn-to-back', at: 1 + i * 3.5 })),
      Array.from({ length: 10 }, (_, i) => ({ op: 'shot', recipe: 'turn-to-back', at: 1 + i * 3.5, return: 'stay' })),
    ];
    for (const ops of chains) {
      let n = 0;
      const { project } = applyOps(with3d(phoneProject({ duration: 80 })), [{ op: 'phone3d', enabled: true }, ...ops], { newId: () => `m${++n}` });
      const p3 = project.phone3d!;
      for (const tr of p3.transitions) {
        expect(poseInRange(tr.to)).toBe(true);
        if (tr.from) expect(poseInRange(tr.from)).toBe(true);
      }
      // Every shot starts where the phone was: no visible jump (angles compared modulo 360).
      const starts = resolveStarts(p3);
      p3.transitions.forEach((tr, i) => {
        if (i === 0) return;
        const prev = p3.transitions[i - 1];
        const at = lerpPose(starts[i - 1], prev.to, 1);
        expect(Object.values(poseDelta(starts[i], at)).every((d) => Math.abs(d) < 1e-9)).toBe(true);
      });
    }
  });
});
