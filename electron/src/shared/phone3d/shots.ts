// Shot recipes as data, and how one expands into 3D moves. Pure: no clock,
// no randomness; ids come from the caller.
//
// Every key is a delta from `before` (the keyed pose at the shot's start),
// in the model's units and signs: + tilt leans the top away (layback, D12),
// + turn turns the screen to the viewer's right. A key with `from` starts
// from before + from (an explicit Start keyframe); a key without one is
// linked and continues from wherever the phone is.
//
// Two numbers differ from the spec's recipe table (§2.5), because the table
// broke the spec's own `too-fast` rule (§2.7: > 600°/s with motion blur on)
// and so the planner could never reach "zero warnings":
//   spin-in      spring 120/16 peaks at 983°/s (and settles at 0.91 s, then
//                holds still for the last 0.7 s of its 1.6 s). Spring 40/9.5
//                (ζ 0.75, one 2.8% overshoot) settles at 1.54 s: the spin
//                fills the whole shot and peaks at 558°/s.
//   turn-to-back 2.6 s gave each 180° half 1.17 s of `cinematic`, peaking at
//                678°/s. 3.2 s (1.44 s a half) peaks at 551°/s.
// test/shots.test.ts pins both peaks under 600°/s.

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

export const SHOTS: Record<ShotRecipe, ShotSpec> = {
  'spin-in': {
    duration: 1.6,
    keys: [
      {
        from: { turn: -200, tilt: 14, size: -0.45, y: 0.06, light: -60, focus: 0.8 },
        to: {},
        frac: [0, 1],
        easing: { kind: 'spring', stiffness: 40, damping: 9.5 },
      },
    ],
    summary: 'Spins in from the back, small and soft, and lands sharp on the pose with one soft overshoot.',
    use: 'Intro: the first 1.5-2 s, before the first tap.',
  },
  'turn-to-back': {
    duration: 3.2,
    keys: [
      { to: { turn: 180, tilt: 6, light: 40 }, frac: [0, 0.45], easing: { kind: 'cinematic' }, fixed: ['turn'] },
      { to: { turn: 360, tilt: 0, light: 0 }, frac: [0.55, 1], easing: { kind: 'cinematic' }, ret: true, fixed: ['turn'] },
    ],
    summary: 'Turns to show the back, then all the way round to the front again (a full 360°).',
    use: 'A long wait or a scene change (the edge-on moment hides the cut). Bold promos.',
  },
  'hero-layback': {
    duration: 1.4,
    keys: [
      { to: { turn: -24, tilt: 16, rotate: -4, size: -0.08, light: -25 }, frac: [0, 0.45], easing: { kind: 'cinematic' } },
      { to: {}, frac: [0.55, 1], easing: { kind: 'spring', stiffness: 180, damping: 18 }, ret: true },
    ],
    summary: 'Leans back into a three-quarter hero angle, then springs back to the pose.',
    use: 'A short wait (2.4 s or more) in the middle; one-way (return: stay) as the outro.',
  },
  settle: {
    duration: 1.0,
    keys: [{ from: { tilt: 8, size: 0.06, y: -0.03 }, to: {}, frac: [0, 1], easing: { kind: 'spring', stiffness: 220, damping: 20 } }],
    summary: 'Drops in slightly large and leaned back, and settles onto the pose.',
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

/** The keys a shot keeps for `ret`, with fracs stretched so the last kept key ends at 1. */
export function shotKeys(recipe: ShotRecipe, ret: ShotReturn = 'front'): { keys: ShotKey[]; span: number } {
  const all = SHOTS[recipe].keys;
  const kept = ret === 'stay' ? all.filter((k) => !k.ret) : all;
  const span = kept.length ? kept[kept.length - 1].frac[1] : 1;
  return { keys: kept.map((k) => ({ ...k, frac: [k.frac[0] / span, k.frac[1] / span] as [number, number] })), span };
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
