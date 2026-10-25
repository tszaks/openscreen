// Shot recipes as data, and how one expands into 3D moves. Pure: no clock,
// no randomness; ids come from the caller.
//
// Every key is a delta from `before` (the keyed pose at the shot's start),
// in the model's units and signs: + tilt leans the top away (layback, D12),
// + turn turns the screen to the viewer's right. A key with `from` starts
// from before + from (an explicit Start keyframe); a key without one is
// linked and continues from wherever the phone is.
//
// Timing (look round 2). The judges read round 1's moves as whips: the
// `cinematic` curve (0.7, 0, 0.16, 1) is quint-like, its peak slope is 4.4×
// the average, so a turn-to-back crossed 146° in 0.53 s, and a spring from
// rest put 133° of the spin-in into its first 0.29 s, then crept for a
// second. Now every move is a cubic-type ease-in-out (CSS ease-in-out,
// peak 1.72× the average) or the softer 1.67× one, and:
//   spin-in      1.6 s: 204° to 4° past the pose (1.2 s, peak 292°/s), then
//                a 0.4 s settle back: one visible overshoot that lands.
//   hero-layback 2.3 s: out in 0.58 s, holds 0.8 s, returns no faster than
//                it went out to 8% past the pose, then settles in 0.32 s.
//   turn-to-back 2.4 s: one 360° that slows to half speed on the back
//                (two halves of 1.2 s, peak 231°/s, 75°/s at the back), no
//                stop on the bare back; `return: stay` ends on the back at
//                rest (stayEasing).
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
/** Turn-to-back halves: the first eases in and leaves at half its average speed, the second picks up at that
 *  speed and eases out (slopes match at the join: (1 − 0.85)/(1 − 0.7) = 0.15/0.3 = 0.5). */
const LINGER_OUT: Easing = { kind: 'bezier', x1: 0.45, y1: 0, x2: 0.7, y2: 0.85 };
const LINGER_IN: Easing = { kind: 'bezier', x1: 0.3, y1: 0.15, x2: 0.55, y2: 1 };
/** How far past the pose a return or spin-in carries before it settles back, as a fraction of the move. */
export const SHOT_OVERSHOOT = 0.08;

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
    duration: 2.4,
    keys: [
      { to: { turn: 180, tilt: 6, light: 40 }, frac: [0, 0.5], easing: LINGER_OUT, stayEasing: EASE_IN_OUT, fixed: ['turn'] },
      { to: { turn: 360, tilt: 0, light: 0 }, frac: [0.5, 1], easing: LINGER_IN, ret: true, fixed: ['turn'] },
    ],
    summary: 'Turns all the way round (a full 360°), slowing as it passes the back.',
    use: 'A long wait or a scene change (the edge-on moment hides the cut). Bold promos.',
  },
  'hero-layback': {
    duration: 2.3,
    keys: [
      { to: { turn: -24, tilt: 16, rotate: -4, size: -0.08, light: -25 }, frac: [0, 0.25], easing: EASE_IN_OUT },
      {
        to: { turn: 24 * SHOT_OVERSHOOT, tilt: -16 * SHOT_OVERSHOOT, rotate: 4 * SHOT_OVERSHOOT, size: 0.08 * SHOT_OVERSHOOT, light: 25 * SHOT_OVERSHOOT },
        frac: [0.6, 0.86],
        easing: EASE_SOFT,
        ret: true,
      },
      { to: {}, frac: [0.86, 1], easing: EASE_SOFT, ret: true },
    ],
    summary: 'Leans back into a three-quarter hero angle, holds it, then swings back just past the pose and settles.',
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
