// Where the 3D phone is at an output time: keyframe interpolation, linked
// starts, the idle float, which keyframe an edit changes, and the small
// rotation math the rest of the 3D code shares. Pure functions of the
// Phone3D and t: no clock, no randomness.

import { ease } from './easing3d';
import { ANGLE_KEYS, FRONT, POSE_KEYS, POSE_RANGE, type Phone3D, type Pose, type PoseTransition } from './model';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Interpolation

/** Each channel from a to b at s, with no wrap (0 → 360 is a full spin).
 *  s > 1 (a spring's overshoot) and s < 0 are allowed. */
export function lerpPose(a: Readonly<Pose>, b: Readonly<Pose>, s: number): Pose {
  const out = {} as Pose;
  for (const k of POSE_KEYS) out[k] = a[k] + (b[k] - a[k]) * s;
  return out;
}

/** Progress of move `tr` at t (0 before, 1 after), eased. */
export function moveProgress(tr: Pick<PoseTransition, 'start' | 'end' | 'easing'>, t: number): number {
  const len = tr.end - tr.start;
  if (!(len > 0) || t >= tr.end) return 1;
  if (t <= tr.start) return 0;
  return ease(tr.easing, (t - tr.start) / len, len);
}

/**
 * The resolved Start keyframe of every move, in list order: its own `from`,
 * or, when linked, the pose the earlier moves leave at its start. With the
 * list sorted by start, that pose comes from the move just before it (the
 * later start wins), so a linked start that overlaps an earlier move starts
 * from the mid-flight pose and the motion stays continuous. O(n).
 */
export function resolveStarts(p3: Pick<Phone3D, 'pose' | 'transitions'>): Pose[] {
  const list = p3.transitions;
  const starts: Pose[] = [];
  for (let i = 0; i < list.length; i++) {
    const tr = list[i];
    if (tr.from) {
      starts.push({ ...tr.from });
      continue;
    }
    if (i === 0) {
      starts.push({ ...p3.pose });
      continue;
    }
    const prev = list[i - 1];
    starts.push(lerpPose(starts[i - 1], prev.to, moveProgress(prev, tr.start)));
  }
  return starts;
}

/** Index of the last move with start ≤ t (−1 before the first). Moves are sorted by start. */
function activeIndex(list: readonly PoseTransition[], t: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * A sampler for one Phone3D: resolves the starts once, then each call is
 * O(log n). Use it when sampling many times (warnings, ROI, travel).
 * Holds no float; see poseAtWithFloat.
 */
export function poseSampler(p3: Pick<Phone3D, 'pose' | 'transitions'>): (t: number) => Pose {
  const list = p3.transitions;
  if (!list.length) return () => ({ ...p3.pose });
  const starts = resolveStarts(p3);
  return (t: number) => {
    const k = activeIndex(list, t);
    if (k < 0) return { ...starts[0] };
    const tr = list[k];
    if (t >= tr.end) return { ...tr.to };
    return lerpPose(starts[k], tr.to, moveProgress(tr, t));
  };
}

/** A pose channel moving more than this across 1 µs counts as a jump. */
const BREAK_JUMP = 1e-4;
/** How far before a break the shutter stops (output s), so its last sample still sees the old pose. */
export const BREAK_EPS = 1e-6;

/**
 * The times where the keyed pose jumps: the Start of an unlinked move whose
 * own `from` differs from the pose just before it. Motion blur must not
 * sample across one (it would blend both poses into a double image). Sorted;
 * empty for linked moves (old projects), whose pose is continuous.
 */
export function poseBreaks(p3: Pick<Phone3D, 'pose' | 'transitions'>): number[] {
  if (!p3.transitions.some((tr) => tr.from)) return [];
  const at = poseSampler(p3);
  const out: number[] = [];
  for (const tr of p3.transitions) {
    if (!tr.from) continue;
    const a = at(tr.start - BREAK_EPS);
    const b = at(tr.start);
    if ((Object.keys(b) as (keyof Pose)[]).some((k) => Math.abs(b[k] - a[k]) > BREAK_JUMP)) out.push(tr.start);
  }
  return out;
}

/** A shutter window in output seconds. */
export interface ShutterWindow {
  lo: number;
  hi: number;
}

/**
 * The shutter of the frame at t, [t − s/2, t + s/2], cut at the nearest pose
 * break on each side so every sample sees one pose only. A break at b belongs
 * to the pose after it (poseAt(b) is the new pose): a break ≤ t moves the
 * start up to b, a break > t moves the end to just before b. Null when no
 * break falls inside, so an uncut frame keeps the exact old arithmetic.
 */
export function shutterWindow(breaks: readonly number[], t: number, shutterSec: number): ShutterWindow | null {
  let lo = t - shutterSec / 2;
  let hi = t + shutterSec / 2;
  let cut = false;
  for (const b of breaks) {
    if (b > lo && b <= t) {
      lo = b;
      cut = true;
    } else if (b > t && b < hi) {
      hi = Math.max(t, b - BREAK_EPS);
      cut = true;
    }
  }
  return cut ? { lo, hi } : null;
}

/**
 * The keyed pose at output time t (no float): the base pose with no moves;
 * the first move's resolved start before it; else the last move with
 * start ≤ t (when moves overlap, the later start wins) — its End once
 * t ≥ end, otherwise eased from its resolved start.
 */
export function poseAt(p3: Pick<Phone3D, 'pose' | 'transitions'>, t: number): Pose {
  return poseSampler(p3)(t);
}

/** The idle drift added to `pose` at t when float is on (a pure function of t). */
export function withFloat(pose: Readonly<Pose>, float: Phone3D['float'], t: number): Pose {
  if (!float.on) return { ...pose };
  const A = float.amount;
  const w = (2 * Math.PI) / float.period;
  return {
    ...pose,
    y: pose.y + A * 0.012 * Math.sin(w * t),
    turn: pose.turn + A * 4 * Math.sin(w * t + 1.1),
    tilt: pose.tilt + A * 2.5 * Math.cos(w * t),
  };
}

/** The pose drawn at output time t: poseAt plus the idle float. Everything
 *  outside this file samples the phone through this (or floatSampler). */
export function poseAtWithFloat(p3: Pick<Phone3D, 'pose' | 'transitions' | 'float'>, t: number): Pose {
  return withFloat(poseAt(p3, t), p3.float, t);
}

/** poseSampler with the float: O(log n) per call. */
export function floatSampler(p3: Pick<Phone3D, 'pose' | 'transitions' | 'float'>): (t: number) => Pose {
  const keyed = poseSampler(p3);
  return (t) => withFloat(keyed(t), p3.float, t);
}

// ---------------------------------------------------------------------------
// Which keyframe an edit changes

export type PoseTarget =
  | { kind: 'base'; pose: Pose }
  | {
      kind: 'from' | 'to';
      /** The move's id and its index in p3.transitions. */
      id: string;
      index: number;
      /** The keyframe's current value (a linked Start: its resolved pose). */
      pose: Pose;
      /** A linked Start: editing it writes an explicit `from` (materializes it). */
      materialize: boolean;
    };

/**
 * The keyframe a pose edit at output time t changes (sliders, orbit, the
 * `setPose` op):
 * - `target: 'base'` → the base pose, even when moves exist
 * - a move selected → its nearer end to t
 * - t inside a move → its nearer end
 * - t in the hold after move k → k's End
 * - t before the first move → the first move's Start (materialized)
 * - no moves → the base pose
 * An unknown `selectedId` is ignored.
 */
export function poseTargetAt(
  p3: Pick<Phone3D, 'pose' | 'transitions'>,
  t: number,
  selectedId?: string | null,
  target: 'auto' | 'base' = 'auto',
): PoseTarget {
  const list = p3.transitions;
  if (target === 'base' || !list.length) return { kind: 'base', pose: { ...p3.pose } };
  const starts = resolveStarts(p3);
  const end = (i: number, kind: 'from' | 'to'): PoseTarget => ({
    kind,
    id: list[i].id,
    index: i,
    pose: kind === 'from' ? { ...starts[i] } : { ...list[i].to },
    materialize: kind === 'from' && !list[i].from,
  });
  const nearer = (i: number) => {
    const tr = list[i];
    return end(i, Math.abs(t - tr.start) <= Math.abs(t - tr.end) ? 'from' : 'to');
  };
  const sel = selectedId ? list.findIndex((tr) => tr.id === selectedId) : -1;
  if (sel >= 0) return nearer(sel);
  const k = activeIndex(list, t);
  if (k < 0) return end(0, 'from');
  if (t < list[k].end) return nearer(k);
  return end(k, 'to');
}

// ---------------------------------------------------------------------------
// Rotation math (y up, the screen faces +z, the camera looks down −z)

/** 3×3 row-major. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

const mul3 = (a: Mat3, b: Mat3): Mat3 => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
export const rotX = (a: number): Mat3 => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
export const rotY = (a: number): Mat3 => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
export const rotZ = (a: number): Mat3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
export const mulMat3 = mul3;

/**
 * The pose's rotation, R = Rz(−rotate)·Rx(−tilt)·Ry(turn) in a right-handed
 * y-up frame (radians from degrees). The negations implement the model's
 * signs: +tilt leans the top away, +rotate is clockwise on the canvas. In
 * three.js this is `new Euler(-tilt°, turn°, -rotate°, 'ZXY')`.
 */
export function poseRotation(pose: Pick<Pose, 'turn' | 'tilt' | 'rotate'>): Mat3 {
  return mul3(mul3(rotZ(-pose.rotate * DEG), rotX(-pose.tilt * DEG)), rotY(pose.turn * DEG));
}

/** The screen normal (unit) after the pose's rotation. */
export function screenNormal(pose: Pick<Pose, 'turn' | 'tilt' | 'rotate'>): [number, number, number] {
  const r = poseRotation(pose);
  return [r[2], r[5], r[8]];
}

/** Unit vector from the phone toward a camera raised by `elevation` degrees. */
export function viewAxis(elevationDeg: number): [number, number, number] {
  return [0, Math.sin(elevationDeg * DEG), Math.cos(elevationDeg * DEG)];
}

/**
 * How squarely the screen faces the camera at t: the cosine between the
 * screen normal and the camera's view axis (1 = straight on, 0 = edge-on,
 * < 0 = the back). Uses the view axis, not the ray to each pixel, so it is a
 * property of the pose alone; projection.ts screenQuad gives the exact
 * per-placement value. `cam` defaults to p3.camera.
 */
export function facing(p3: Pick<Phone3D, 'pose' | 'transitions' | 'float' | 'camera'>, t: number, cam: Pick<Phone3D['camera'], 'elevation'> = p3.camera): number {
  return facingOf(poseAtWithFloat(p3, t), cam.elevation);
}

/** facing() for a known pose. */
export function facingOf(pose: Pick<Pose, 'turn' | 'tilt' | 'rotate'>, elevationDeg = 0): number {
  const n = screenNormal(pose);
  const v = viewAxis(elevationDeg);
  return n[0] * v[0] + n[1] * v[1] + n[2] * v[2];
}

/** Geodesic angle between two rotations, degrees. */
export function rotationAngle(a: Mat3, b: Mat3): number {
  // trace(aᵀ·b)
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tr += a[j * 3 + i] * b[j * 3 + i];
  const c = Math.min(1, Math.max(-1, (tr - 1) / 2));
  return Math.acos(c) / DEG;
}

/** Central-difference step for poseSpeed, seconds. */
export const SPEED_STEP = 1 / 240;

/** Angular speed of the drawn phone at t in °/s (central difference at a fixed 1/240 s). */
export function poseSpeed(p3: Pick<Phone3D, 'pose' | 'transitions' | 'float'>, t: number): number {
  const s = floatSampler(p3);
  return rotationAngle(poseRotation(s(t - SPEED_STEP)), poseRotation(s(t + SPEED_STEP))) / (2 * SPEED_STEP);
}

// ---------------------------------------------------------------------------
// Comparing and rebasing

/** `d` taken modulo 360 into (−180, 180]. */
export function wrap180(d: number): number {
  let r = ((d % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return r === 0 ? 0 : r; // no −0
}

/** a − b per channel; turn and rotate (ANGLE_KEYS) modulo 360 into (−180, 180].
 *  Missing channels count as FRONT's. */
export function poseDelta(a: Partial<Pose>, b: Partial<Pose>): Pose {
  const out = {} as Pose;
  for (const k of POSE_KEYS) {
    const d = (a[k] ?? FRONT[k]) - (b[k] ?? FRONT[k]);
    out[k] = (ANGLE_KEYS as readonly string[]).includes(k) ? wrap180(d) : d;
  }
  return out;
}

/** The pose with `turn` moved by a whole number of turns into [−180, 180]
 *  (the same angle, so nothing visible changes). */
export function rebaseTurn<P extends Pick<Pose, 'turn'>>(pose: P): P {
  const turn = pose.turn - 360 * Math.round(pose.turn / 360);
  return { ...pose, turn: turn === 0 ? 0 : turn };
}

/** `pose` lies inside POSE_RANGE on every channel. */
export function poseInRange(pose: Readonly<Pose>): boolean {
  return POSE_KEYS.every((k) => Number.isFinite(pose[k]) && pose[k] >= POSE_RANGE[k][0] && pose[k] <= POSE_RANGE[k][1]);
}
