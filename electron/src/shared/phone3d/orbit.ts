// Drag-to-orbit on the preview: screen points → a pose. Absolute: every move
// is computed from the drag-start pose, so a drag can be replayed exactly
// and never accumulates error.

import { POSE_RANGE, type Pose } from './model';

/** Degrees per screen point. */
export const ORBIT_DEG_PER_PT = 0.45;
/** Movement before Shift decides the locked axis, in points. */
export const ORBIT_LOCK_PT = 4;

export type OrbitAxis = 'x' | 'y';

export interface OrbitMods {
  /** Lock the dominant axis. */
  shift?: boolean;
  /** Pan x/y instead of rotating. */
  alt?: boolean;
  /** The axis Shift locked (from orbitLock, decided once per drag). */
  lock?: OrbitAxis | null;
  /** The preview's on-screen size in points: Alt-panning then follows the pointer. Default 1000 × 1000. */
  view?: { width: number; height: number };
}

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** The dominant axis once the drag has moved ORBIT_LOCK_PT, else null (not decided yet). */
export function orbitLock(dxPt: number, dyPt: number): OrbitAxis | null {
  if (Math.hypot(dxPt, dyPt) < ORBIT_LOCK_PT) return null;
  return Math.abs(dxPt) >= Math.abs(dyPt) ? 'x' : 'y';
}

/**
 * `start` orbited by a drag of (dx, dy) screen points: dx → turn (drag right
 * turns the screen to the right), dy → tilt (drag up leans the top away),
 * 0.45° per point. Shift keeps only the locked axis (until it is decided,
 * nothing moves); Alt pans x/y instead and never rotates. Tilt clamps to
 * ±85 and turn to POSE_RANGE.turn, so a long drag never makes a pose that
 * setPose refuses.
 */
export function orbitPose(start: Readonly<Pose>, dxPt: number, dyPt: number, mods: OrbitMods = {}): Pose {
  let dx = dxPt;
  let dy = dyPt;
  if (mods.shift) {
    const lock = mods.lock ?? null;
    if (lock === null) return { ...start };
    if (lock === 'x') dy = 0;
    else dx = 0;
  }
  if (mods.alt) {
    const view = mods.view ?? { width: 1000, height: 1000 };
    return {
      ...start,
      x: clamp(start.x + dx / Math.max(1, view.width), POSE_RANGE.x),
      y: clamp(start.y + dy / Math.max(1, view.height), POSE_RANGE.y),
    };
  }
  return {
    ...start,
    turn: clamp(start.turn + dx * ORBIT_DEG_PER_PT, POSE_RANGE.turn),
    tilt: clamp(start.tilt - dy * ORBIT_DEG_PER_PT, POSE_RANGE.tilt),
  };
}

/**
 * One drag, with the Shift lock remembered: the editor creates it on
 * pointerdown and calls move() on every pointermove.
 */
export function orbitDrag(start: Readonly<Pose>): { move(dxPt: number, dyPt: number, mods?: Omit<OrbitMods, 'lock'>): Pose; readonly lock: OrbitAxis | null } {
  let lock: OrbitAxis | null = null;
  return {
    move(dxPt, dyPt, mods = {}) {
      if (mods.shift && lock === null) lock = orbitLock(dxPt, dyPt);
      return orbitPose(start, dxPt, dyPt, { ...mods, lock });
    },
    get lock() {
      return lock;
    },
  };
}
