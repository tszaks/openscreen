// Shot recipes as data, and how one expands into 3D moves. Pure: no clock,
// no randomness; ids come from the caller.
//
// Every key is a delta from `before` (the keyed pose at the shot's start),
// in the model's units and signs: + tilt leans the top away (layback, D12),
// + turn turns the screen to the viewer's right. A key with `from` starts
// from before + from (an explicit Start keyframe); a key without one is
// linked and continues from wherever the phone is.
//
// Timing. Round 1's moves read as whips (the quint-like `cinematic` curve
// peaks at 4.4× the average speed). Every move is a cubic-type ease
// (peak about 1.7× the average), and no move stops dead in the middle of a
// shot: a hold is a slow drift, joined to the moves either side at matching
// speed (easeInTo / easeOutFrom), so the phone never freezes and never
// jerks. Look round 2's judges saw a frozen hero hold and a hitch where two
// eases met on the back.
//   spin-in      1.6 s: 204° to 4° past the pose (1.2 s, peak 292°/s), then
//                a 0.4 s settle back: one visible overshoot that lands.
//   hero-layback 2.4 s: out in 0.58 s, a 0.8 s drift on through about 2.5°
//                of turn, then back no faster than it went out to 8% past
//                the pose, and a 0.32 s settle.
//   turn-to-back 3.6 s: 165° to a three-quarter back view (1.45 s), a 0.7 s
//                drift across the back (165 → 179°) so the viewer sees it,
//                then on round to the front (1.45 s); peak about 215°/s.
//                `return: stay` ends on the back at rest (stayEasing).
// Peak angular speed stays under 300°/s at the default durations
// (test/shots.test.ts pins it), half the §2.7 too-fast line.

import { clampPose, FRONT, POSE_KEYS, SHOT_RECIPES, type Easing, type Pose, type PoseKey, type PoseTransition, type ShotRecipe } from './model';
import { rebaseTurn } from './pose';

export { SHOT_RECIPES, type ShotRecipe };

export interface ShotKey {
  /** Start keyframe as deltas from `before` (absent = linked). */
  from?: Partial<Pose>;
  /** End keyframe as deltas from `before` ({} = back to `before`). */
  to: Partial<Pose>;
  /** Where the move sits in the shot, fractions of its duration. */
  frac: [number, number];
  easing: Easing;
  /** The key that brings the phone back (dropped by `return: 'stay'`). */
  ret?: true;
  /** Channels `intensity` does not scale (a turn-to-back must still reach the back). */
  fixed?: PoseKey[];
  /** The easing when this key ends the shot (`return: 'stay'` dropped the keys after it): it must come to rest. */
  stayEasing?: Easing;
}

export interface ShotSpec {
  /** Default length in seconds, with the return key. */
  duration: number;
  keys: ShotKey[];
  /** The recipe turns phone3d.float on instead of adding moves. */
  float?: true;
  /** One line for `info` and the gallery tile. */
  summary: string;
  /** When to use it. */
  use: string;
}

/** CSS ease-in-out: a cubic-type ease, peak speed 1.72× the average. */
const EASE_IN_OUT: Easing = { kind: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
/** A softer ease-in-out (peak 1.67× the average): returns and settles, never faster than the move out. */
const EASE_SOFT: Easing = { kind: 'bezier', x1: 0.4, y1: 0, x2: 0.6, y2: 1 };

/**
 * An ease-in-out that ends still moving, at `endSlope` × its average speed
 * (a bezier's end slope is (1 − y2) / (1 − x2)), to hand over to a drift.
 */
export const easeInTo = (endSlope: number): Easing => ({ kind: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 - endSlope * 0.42 });
/** An ease-in-out that starts already moving, at `startSlope` × its average speed (start slope y1 / x1; negative
 *  when the drift was going the other way: the move first carries on a touch, then turns). */
export const easeOutFrom = (startSlope: number): Easing => ({ kind: 'bezier', x1: 0.42, y1: startSlope * 0.42, x2: 0.58, y2: 1 });
/** A drift that comes to rest: starts at its average speed (slope 1, as the linear drift), eases out. */
const DRIFT_TO_REST: Easing = { kind: 'bezier', x1: 0.3, y1: 0.3, x2: 0.6, y2: 1 };
const LINEAR: Easing = { kind: 'linear' };

/**
 * The easings that join move → drift → move at matching speed, in one
 * reference channel (every channel of the drift is the same fraction of the
 * move out, so they all join): a move's speed at an end is its slope there ×
 * its delta / its length, and the drift is linear (slope 1). Deltas are
 * signed, lengths in seconds.
 */
function driftEasings(outDelta: number, tOut: number, driftDelta: number, tHold: number, nextDelta: number, tNext: number): { out: Easing; next: Easing } {
  const v = driftDelta / tHold;
  return { out: easeInTo((v * tOut) / outDelta), next: easeOutFrom((v * tNext) / nextDelta) };
}

/** How far past the pose a return or spin-in carries before it settles back, as a fraction of the move. */
export const SHOT_OVERSHOOT = 0.08;

/** hero-layback: the lean, and how far the hold drifts on (× the lean: about 2.5° of turn and 0.8% of size). */
const HERO_LEAN = { turn: -24, tilt: 16, rotate: -4, size: -0.08, light: -25 } as const;
const HERO_DRIFT = 0.104;
/** hero-layback's parts, seconds: out, drift, back past the pose, settle. */
const HERO_T = { out: 0.575, hold: 0.805, back: 0.72, settle: 0.3 } as const;
const scaled = (d: Partial<Pose>, k: number): Partial<Pose> => Object.fromEntries(Object.entries(d).map(([c, v]) => [c, (v as number) * k]));
const HERO_JOIN = driftEasings(HERO_LEAN.turn, HERO_T.out, HERO_LEAN.turn * HERO_DRIFT, HERO_T.hold, -HERO_LEAN.turn * (1 + HERO_DRIFT + SHOT_OVERSHOOT), HERO_T.back);

/** turn-to-back: to a three-quarter back view, a slow drift across the back, then on round to the front. */
const TTB = { out: 165, drift: 14, tilt: 8, light: 40 } as const;
const TTB_T = { out: 1.45, hold: 0.7, on: 1.45 } as const;
const TTB_JOIN = driftEasings(TTB.out, TTB_T.out, TTB.drift, TTB_T.hold, 360 - TTB.out - TTB.drift, TTB_T.on);
const ttbAt = (turn: number): Partial<Pose> => ({ turn, tilt: (TTB.tilt * turn) / TTB.out, light: (TTB.light * turn) / TTB.out });

/** Shot fractions from part lengths (seconds). */
function fracs(parts: readonly number[]): [number, number][] {
  const total = parts.reduce((a, b) => a + b, 0);
  let t = 0;
  return parts.map((d) => {
    const f: [number, number] = [t / total, (t + d) / total];
    t += d;
    return f;
  });
}
const HERO_F = fracs([HERO_T.out, HERO_T.hold, HERO_T.back, HERO_T.settle]);
const TTB_F = fracs([TTB_T.out, TTB_T.hold, TTB_T.on]);

export const SHOTS: Record<ShotRecipe, ShotSpec> = {
  'spin-in': {
    duration: 1.6,
    keys: [
      {
        from: { turn: -200, tilt: 14, size: -0.45, y: 0.06, light: -60, focus: 0.8 },
        to: { turn: 4 },
        frac: [0, 0.75],
        easing: EASE_IN_OUT,
      },
      { to: {}, frac: [0.75, 1], easing: EASE_SOFT },
    ],
    summary: 'Spins in from the back, small and soft, carries 4° past the pose and settles back onto it.',
    use: 'Intro: the first 1.5-2 s, before the first tap.',
  },
  'turn-to-back': {
    duration: TTB_T.out + TTB_T.hold + TTB_T.on,
    keys: [
      { to: ttbAt(TTB.out), frac: TTB_F[0], easing: TTB_JOIN.out, fixed: ['turn'] },
      { to: ttbAt(TTB.out + TTB.drift), frac: TTB_F[1], easing: LINEAR, stayEasing: DRIFT_TO_REST, fixed: ['turn'] },
      { to: { turn: 360, tilt: 0, light: 0 }, frac: TTB_F[2], easing: TTB_JOIN.next, ret: true, fixed: ['turn'] },
    ],
    summary: 'Turns to a three-quarter view of the back, drifts slowly across it, then on round to the front (a full 360°).',
    use: 'A long wait (3.6 s or more) or a scene change; keep taps out of it. Bold promos.',
  },
  'hero-layback': {
    duration: HERO_T.out + HERO_T.hold + HERO_T.back + HERO_T.settle,
    keys: [
      { to: HERO_LEAN, frac: HERO_F[0], easing: HERO_JOIN.out },
      { to: scaled(HERO_LEAN, 1 + HERO_DRIFT), frac: HERO_F[1], easing: LINEAR, stayEasing: DRIFT_TO_REST },
      { to: scaled(HERO_LEAN, -SHOT_OVERSHOOT), frac: HERO_F[2], easing: HERO_JOIN.next, ret: true },
      { to: {}, frac: HERO_F[3], easing: EASE_SOFT, ret: true },
    ],
    summary: 'Leans back into a three-quarter hero angle, keeps drifting gently while it holds, then swings back just past the pose and settles.',
    use: 'A short wait (2.4 s or more) in the middle; one-way (return: stay) as the outro.',
  },
  settle: {
    duration: 1.0,
    keys: [
      { from: { tilt: 8, size: 0.06, y: -0.03 }, to: { tilt: -8 * SHOT_OVERSHOOT }, frac: [0, 0.65], easing: EASE_IN_OUT },
      { to: {}, frac: [0.65, 1], easing: EASE_SOFT },
    ],
    summary: 'Drops in slightly large and leaned back, carries just past the pose and settles onto it.',
    use: 'A gentle intro, or any intro shorter than 2 s.',
  },
  float: {
    duration: 0,
    keys: [],
    float: true,
    summary: 'Turns on the idle float: a slow drift in height, turn and tilt.',
    use: 'Calm tutorials; under taps it stays within a few degrees of the pose.',
  },
};

/** The recipe list `info` prints (name, default duration, summary, use), in SHOT_RECIPES order. */
export function shotRecipeList(): { name: ShotRecipe; duration: number; summary: string; use: string }[] {
  return SHOT_RECIPES.map((name) => ({ name, duration: SHOTS[name].duration, summary: SHOTS[name].summary, use: SHOTS[name].use }));
}

export const INTENSITY_RANGE = [0.25, 2] as const;
export type ShotReturn = 'front' | 'stay';

export interface ShotOptions {
  /** OUTPUT seconds. */
  start: number;
  /** Length of the kept keys; default: the recipe's (only the outbound part with `ret: 'stay'`). */
  duration?: number;
  /** × every delta except focus and the key's fixed channels, 0.25..2. */
  intensity?: number;
  /** -1 mirrors turn and rotate. */
  direction?: 1 | -1;
  /** 'stay' drops the return key of turn-to-back and hero-layback. */
  ret?: ShotReturn;
}

/** The keys a shot keeps for `ret`, with fracs stretched so the last kept key ends at 1; a last kept key with a
 *  `stayEasing` takes it (it ends the shot, so it must come to rest). */
export function shotKeys(recipe: ShotRecipe, ret: ShotReturn = 'front'): { keys: ShotKey[]; span: number } {
  const all = SHOTS[recipe].keys;
  const kept = ret === 'stay' ? all.filter((k) => !k.ret) : all;
  const span = kept.length ? kept[kept.length - 1].frac[1] : 1;
  return {
    keys: kept.map((k, i) => {
      const out: ShotKey = { ...k, frac: [k.frac[0] / span, k.frac[1] / span] as [number, number] };
      if (i === kept.length - 1 && k.stayEasing && kept.length < all.length) out.easing = k.stayEasing;
      return out;
    }),
    span,
  };
}

/** A shot's default length for `ret` (seconds). */
export function defaultShotDuration(recipe: ShotRecipe, ret: ShotReturn = 'front'): number {
  return Math.round(SHOTS[recipe].duration * shotKeys(recipe, ret).span * 1000) / 1000;
}

/** The pose a shot is built on: `before` (clamped) with its turn moved by whole turns into [-180, 180] (D21). */
export function shotBase(before: Readonly<Pose>): Pose {
  return rebaseTurn(clampPose({ ...FRONT, ...before }));
}

const MIRRORED: readonly PoseKey[] = ['turn', 'rotate'];

/** before + delta, with intensity and direction applied, clamped to POSE_RANGE (focus to 0..2 like the rest). */
function applyDelta(before: Pose, delta: Partial<Pose>, intensity: number, direction: 1 | -1, fixed: readonly PoseKey[] = []): Pose {
  const out = { ...before };
  for (const k of POSE_KEYS) {
    const d = delta[k];
    if (d === undefined) continue;
    let v = d;
    if (k !== 'focus' && !fixed.includes(k)) v *= intensity;
    if (MIRRORED.includes(k)) v *= direction;
    out[k] = before[k] + v;
  }
  return clampPose(out);
}

/**
 * The moves of `recipe` starting at `opts.start`, relative to `before`.
 * - keys scale to the duration; `intensity` scales the deltas (not focus,
 *   not a key's fixed channels); `direction: -1` mirrors turn and rotate;
 *   `ret: 'stay'` drops the return key
 * - turn rebase (D21): `before` is first moved by whole turns into
 *   [-180, 180]. When that changes its turn, the first key gets an explicit
 *   `from` (the rebased pose plus its own from-deltas), so nothing jumps
 *   (the same angle mod 360) and turns never run away: every recipe ends in
 *   [-560, 560], inside POSE_RANGE
 * - every pose is clamped to POSE_RANGE
 * Replacing moves that overlap the shot is the `shot` op's job.
 */
export function expandShot(
  recipe: ShotRecipe,
  opts: ShotOptions,
  before: Readonly<Pose>,
  newId: () => string,
): { transitions: PoseTransition[]; float?: true } {
  const spec = SHOTS[recipe];
  if (spec.float) return { transitions: [], float: true };
  const ret = opts.ret ?? 'front';
  const intensity = opts.intensity ?? 1;
  const direction = opts.direction ?? 1;
  const { keys } = shotKeys(recipe, ret);
  const duration = opts.duration ?? defaultShotDuration(recipe, ret);
  const base = shotBase(before);
  const rebased = base.turn !== clampPose({ ...FRONT, ...before }).turn;
  return {
    transitions: keys.map((k, i) => {
      const tr: PoseTransition = {
        id: newId(),
        start: opts.start + k.frac[0] * duration,
        end: opts.start + k.frac[1] * duration,
        to: applyDelta(base, k.to, intensity, direction, k.fixed),
        easing: { ...k.easing },
        recipe,
      };
      if (k.from || (i === 0 && rebased)) tr.from = applyDelta(base, k.from ?? {}, intensity, direction, k.fixed);
      // Key order matches the normalizer's (id, start, end, from?, to, easing, recipe).
      const { id, start, end, from, to, easing } = tr;
      return from ? { id, start, end, from, to, easing, recipe } : { id, start, end, to, easing, recipe };
    }),
  };
}
