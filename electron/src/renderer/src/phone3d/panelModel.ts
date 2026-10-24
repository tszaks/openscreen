// The 3D tab's and the 3D lane's decisions, with no DOM and no React, so the
// rules are tested (test/phone3dPanel.test.ts). Every edit this file plans is
// a list of agent ops (EditOp): the editor sends them through apply3d, the
// same applyOps the CLI runs (SPEC D1).
//
// Nouns, one set everywhere:
//   shot     what you insert (a gallery tile, or what Auto 3D adds); one or
//            two moves
//   move     one block on the 3D lane (a PoseTransition)
//   keyframe a move's Start or End

import type { EditOp } from '../../../shared/agentOps';
import { BEZIER_PRESETS, ease, springSettleTime } from '../../../shared/phone3d/easing3d';
import {
  MIN_TRANSITION,
  POSE_RANGE,
  SPRING_DEFAULT,
  SPRING_RANGE,
  type Easing,
  type EasingName,
  type Phone3D,
  type Pose,
  type PoseKey,
  type PoseTransition,
  type ShotRecipe,
} from '../../../shared/phone3d/model';
import { DEFAULT_MOVE_LENGTH } from '../../../shared/phone3d/ops';
import { poseAt, poseTargetAt, resolveStarts, type PoseTarget } from '../../../shared/phone3d/pose';
import type { Warning } from '../../../shared/phone3d/warnings';
import type { Phone3DInactiveReason } from '../../../shared/phone3d/placement';

type P3 = Pick<Phone3D, 'pose' | 'transitions'>;

// ---------------------------------------------------------------------------
// Words

export const RECIPE_LABEL: Record<ShotRecipe, string> = {
  'spin-in': 'Spin in',
  'turn-to-back': 'To back',
  'hero-layback': 'Layback',
  settle: 'Settle',
  float: 'Float',
};

/** Gallery order (spec §5.2 lists the five tiles). */
export const GALLERY: readonly ShotRecipe[] = ['spin-in', 'turn-to-back', 'hero-layback', 'settle', 'float'];

export const EASE_LABEL: Record<EasingName, string> = {
  smooth: 'Smooth',
  linear: 'Linear',
  easeIn: 'Ease In',
  easeOut: 'Ease Out',
  cinematic: 'Cinematic',
  spring: 'Spring',
  bezier: 'Custom',
};

/** The Easing pop-up's items, in menu order. */
export const EASE_MENU: readonly EasingName[] = ['smooth', 'linear', 'easeIn', 'easeOut', 'cinematic', 'spring', 'bezier'];

/** The curve each menu item shows (Custom shows the cinematic shape). */
export const EASE_PRESET: Record<EasingName, Easing> = {
  smooth: { kind: 'smooth' },
  linear: { kind: 'linear' },
  easeIn: { kind: 'easeIn' },
  easeOut: { kind: 'easeOut' },
  cinematic: { kind: 'cinematic' },
  spring: { kind: 'spring', ...SPRING_DEFAULT },
  bezier: { kind: 'bezier', x1: 0.7, y1: 0, x2: 0.16, y2: 1 },
};

/** True minus for a negative number shown to a person (−24°, not -24°). */
export const minus = (v: number | string) => String(v).replace(/^-(?=\d)/, '−');

/** m:ss.ss (keyframe times, warnings). */
export function clock(t: number): string {
  const c = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(c / 6000);
  const s = (c - m * 6000) / 100;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

const REL_TIME = /^([+-])\s*(\d*\.?\d+)$/;
const CLOCK_TIME = /^(\d+):(\d{1,2}(?:\.\d*)?)$/;

/** A typed keyframe time: "0:53.20", "53.2", "+0.1" or "-0.25" (relative to `current`). Null when it is not a time. */
export function parseTime(text: string, current: number): number | null {
  const s = text.trim().replace(/−/g, '-');
  const rel = s.match(REL_TIME);
  if (rel) return current + (rel[1] === '-' ? -1 : 1) * Number(rel[2]);
  const ms = s.match(CLOCK_TIME);
  if (ms) {
    const sec = Number(ms[2]);
    return sec < 60 ? Number(ms[1]) * 60 + sec : null;
  }
  return /^\d*\.?\d+$/.test(s) ? Number(s) : null;
}

/** One plain line under a curve. Custom describes its handles in words. */
export function easeCaption(e: Easing): string {
  if (e.kind === 'bezier') {
    const s0 = e.x1 > 0 ? e.y1 / e.x1 : 9;
    const s1 = e.x2 < 1 ? (1 - e.y2) / (1 - e.x2) : 9;
    const a = e.y1 < 0 ? 'winds up first' : s0 < 0.6 ? 'slow start' : s0 > 1.6 ? 'quick start' : 'even start';
    const b = e.y2 > 1 ? 'overshoots, then lands' : s1 < 0.6 ? 'soft landing' : s1 > 1.6 ? 'quick end' : 'even end';
    return `Your curve: ${a}, ${b}.`;
  }
  return {
    cinematic: 'Slow away, fast through the middle, a long soft landing.',
    smooth: 'Even start and landing, like zooms.',
    linear: 'Constant speed.',
    easeIn: 'Starts gently, ends at full speed.',
    easeOut: 'Starts fast and settles gently.',
    spring: 'Moves like a spring: a quick start and one soft bounce.',
  }[e.kind];
}

/** The handles Custom starts from, so picking it does not change the motion much. */
export function bezierFrom(e: Easing): [number, number, number, number] {
  switch (e.kind) {
    case 'bezier':
      return [e.x1, e.y1, e.x2, e.y2];
    case 'easeIn':
    case 'easeOut':
    case 'cinematic':
      return [...BEZIER_PRESETS[e.kind]];
    case 'linear':
      return [0, 0, 1, 1];
    case 'smooth':
      // smootherstep's closest cubic-bezier
      return [0.45, 0, 0.55, 1];
    case 'spring':
      // an overshoot that lands, like the spring it replaces
      return [0.34, 1.3, 0.64, 1];
  }
}

/** "cubic-bezier(.7,0,.16,1)", "(.7, 0, .16, 1)" or ".7 0 .16 1" → [x1, y1, x2, y2]; x must be 0..1, y −1..2 (BEZIER_RANGE). */
export function parseBezier(text: string): [number, number, number, number] | null {
  const nums = String(text).replace(/−/g, '-').replace(/cubic-bezier/i, '').match(/-?\d*\.?\d+/g);
  if (!nums || nums.length !== 4) return null;
  const q = nums.map(Number) as [number, number, number, number];
  if (q.some((v) => !Number.isFinite(v))) return null;
  if (q[0] < 0 || q[0] > 1 || q[2] < 0 || q[2] > 1) return null;
  if (q[1] < -1 || q[1] > 2 || q[3] < -1 || q[3] > 2) return null;
  return q;
}

/** The cubic-bezier() text shown for copying (a plain hyphen: it is code). */
export const bezierText = (e: Extract<Easing, { kind: 'bezier' }>) =>
  `cubic-bezier(${[e.x1, e.y1, e.x2, e.y2].map((v) => +v.toFixed(2)).join(', ')})`;

// ---------------------------------------------------------------------------
// Springs in Apple's words (WWDC23 "Animate with springs"): pace = 2π/√k
// seconds, bounce = 1 − ζ. Mass is 1.

export const springPace = (k: number) => (2 * Math.PI) / Math.sqrt(k);
export const springBounce = (k: number, c: number) => 1 - c / (2 * Math.sqrt(k));
/** The paces SPRING_RANGE allows, rounded inward to what the field shows (0.2 s .. 2 s). */
export const PACE_RANGE = [Math.ceil(springPace(SPRING_RANGE.stiffness[1]) * 100) / 100, 2] as const;

/** Stiffness and damping for a pace (s) and bounce (0..1), inside SPRING_RANGE. */
export function springFrom(pace: number, bounce: number): { stiffness: number; damping: number } {
  const p = Math.min(Math.max(pace, PACE_RANGE[0]), springPace(SPRING_RANGE.stiffness[0]));
  const k = Math.min(SPRING_RANGE.stiffness[1], Math.max(SPRING_RANGE.stiffness[0], ((2 * Math.PI) / p) ** 2));
  const zeta = 1 - Math.min(1, Math.max(0, bounce));
  const c = Math.min(SPRING_RANGE.damping[1], Math.max(SPRING_RANGE.damping[0], 2 * Math.sqrt(k) * zeta));
  return { stiffness: Math.round(k * 10) / 10, damping: Math.round(c * 100) / 100 };
}

/** A spring move whose length is its settle time (Fit length, or Spring just picked). */
export function isFitted(tr: Pick<PoseTransition, 'start' | 'end' | 'easing'>): boolean {
  return tr.easing.kind === 'spring' && Math.abs(tr.end - tr.start - springSettleTime(tr.easing.stiffness, tr.easing.damping)) < 0.005;
}

/** How much longer a squeezed spring needs than its move (seconds), else 0 (D8). */
export function springShortfall(tr: Pick<PoseTransition, 'start' | 'end' | 'easing'>): number {
  if (tr.easing.kind !== 'spring') return 0;
  const d = springSettleTime(tr.easing.stiffness, tr.easing.damping) - (tr.end - tr.start);
  return d > 0.005 ? d : 0;
}

/** The curve as drawn: `n + 1` samples of the shared ease() over the move's length. */
export const easeSamples = (e: Easing, durationSec: number, n = 64) => Array.from({ length: n + 1 }, (_, j) => ease(e, j / n, durationSec));

// ---------------------------------------------------------------------------
// Lens: the vertical field of view as a 35 mm focal length (24 mm frame height).

const DEG = Math.PI / 180;
export const lensMm = (fovDeg: number) => 12 / Math.tan((fovDeg * DEG) / 2);
export const fovForMm = (mm: number) => (2 * Math.atan(12 / mm)) / DEG;
/** The focal lengths the fov range allows (60° → 21 mm, 8° → 171 mm). */
export const LENS_RANGE = [Math.ceil(lensMm(60)), Math.floor(lensMm(8))] as const;

// ---------------------------------------------------------------------------
// Shots and move names

/** Moves grouped into shots: same recipe, at most two, the second starting within 0.35 s after the first ends. */
export function shotGroups(list: readonly PoseTransition[]): PoseTransition[][] {
  const out: PoseTransition[][] = [];
  for (const m of list) {
    const g = out[out.length - 1];
    const last = g?.[g.length - 1];
    if (g && last && m.recipe && g.length < 2 && last.recipe === m.recipe && m.start - last.end <= 0.35 && m.start >= last.end - 1e-6) g.push(m);
    else out.push([m]);
  }
  return out;
}

export interface ShotInfo {
  /** 1-based shot number, and how many shots there are. */
  n: number;
  total: number;
  /** 1-based move number inside the shot, and how many moves it has. */
  part: number;
  parts: number;
}

export function shotInfo(list: readonly PoseTransition[], id: string): ShotInfo {
  const groups = shotGroups(list);
  const n = groups.findIndex((g) => g.some((m) => m.id === id));
  if (n < 0) return { n: 0, total: groups.length, part: 1, parts: 1 };
  const g = groups[n];
  return { n: n + 1, total: groups.length, part: g.findIndex((m) => m.id === id) + 1, parts: g.length };
}

/** "Layback · out", "Layback · back", "Spin in", or "Smooth move" for a hand-made move. */
export function moveName(list: readonly PoseTransition[], id: string): string {
  const m = list.find((x) => x.id === id);
  if (!m) return 'Move';
  const base = m.recipe ? RECIPE_LABEL[m.recipe] : `${EASE_LABEL[m.easing.kind]} move`;
  const s = shotInfo(list, id);
  return s.parts > 1 ? `${base} · ${s.part === 1 ? 'out' : 'back'}` : base;
}

/** "Shot 2 of 57 · move 1 of 2". */
export function shotLine(list: readonly PoseTransition[], id: string): string {
  const s = shotInfo(list, id);
  return `Shot ${s.n} of ${s.total}${s.parts > 1 ? ` · move ${s.part} of ${s.parts}` : ''}`;
}

/** Ids for the lane menu's Select All "Layback" Moves. */
export function sameRecipe(list: readonly PoseTransition[], id: string): string[] {
  const m = list.find((x) => x.id === id);
  if (!m?.recipe) return [];
  return list.filter((x) => x.recipe === m.recipe).map((x) => x.id);
}

/** Ids for Select All "Layback · out" Moves: the same move of every shot like this one. */
export function samePart(list: readonly PoseTransition[], id: string): string[] {
  const m = list.find((x) => x.id === id);
  if (!m?.recipe) return [];
  const want = shotInfo(list, id);
  return shotGroups(list)
    .filter((g) => g.length === want.parts && g[want.part - 1]?.recipe === m.recipe)
    .map((g) => g[want.part - 1].id);
}

// ---------------------------------------------------------------------------
// The target chip: what a pose change edits, in one of five plain states
//   on      the playhead is within half a frame of a keyframe; a change edits it
//   near    inside a move; a change edits its nearer end (the playhead jumps there first)
//   holding a hold, or before the first move; a change edits the held keyframe
//   none    Auto key on and not on a keyframe; a change adds a move
//   base    the base pose (no moves, or Base pose chosen)

export type ChipMode = 'on' | 'near' | 'holding' | 'none' | 'base';

export interface Chip {
  mode: ChipMode;
  /** The keyframe an edit changes (the base pose for 'base'). */
  target: PoseTarget;
  /** "End of Layback · out" (keyframe modes). */
  label: string;
  /** The keyframe's time (keyframe modes). */
  keyTime?: number;
  /** Seconds from the playhead to the keyframe ('near'). */
  dist?: number;
  /** The pose the panel shows. */
  pose: Pose;
}

export interface ChipOptions {
  /** The "Editing" menu: automatic, or the base pose. */
  editing: 'auto' | 'base';
  autoKey: boolean;
  fps: number;
}

/** The last move with start ≤ t (the later start wins when moves overlap), or −1. */
function activeIndex(list: readonly PoseTransition[], t: number): number {
  let k = -1;
  for (let i = 0; i < list.length; i++) if (list[i].start <= t) k = i;
  return k;
}

export function chipFor(p3: P3, t: number, o: ChipOptions): Chip {
  const list = p3.transitions;
  if (o.editing === 'base' || !list.length) {
    const target = poseTargetAt(p3, t, null, 'base');
    if (!list.length && o.autoKey && o.editing !== 'base') return { mode: 'none', target, label: '', pose: { ...p3.pose } };
    return { mode: 'base', target, label: '', pose: target.pose };
  }
  const target = poseTargetAt(p3, t);
  if (target.kind === 'base') return { mode: 'base', target, label: '', pose: target.pose };
  const tr = list[target.index];
  const keyTime = target.kind === 'from' ? tr.start : tr.end;
  const label = `${target.kind === 'from' ? 'Start' : 'End'} of ${moveName(list, tr.id)}`;
  const half = 0.5 / Math.max(1, o.fps);
  if (Math.abs(t - keyTime) <= half + 1e-9) return { mode: 'on', target, label, keyTime, pose: target.pose };
  const k = activeIndex(list, t);
  if (k >= 0 && t < list[k].end) return { mode: 'near', target, label, keyTime, dist: Math.abs(keyTime - t), pose: target.pose };
  if (o.autoKey) return { mode: 'none', target, label, keyTime, pose: poseAt(p3, t) };
  return { mode: 'holding', target, label, keyTime, pose: target.pose };
}

/** Every keyframe time, sorted, without repeats (J / K and the ‹ › buttons). */
export function keyTimes(list: readonly PoseTransition[]): number[] {
  const all = list.flatMap((m) => [m.start, m.end]).sort((a, b) => a - b);
  return all.filter((v, i) => i === 0 || v - all[i - 1] > 1e-6);
}
export function prevKey(list: readonly PoseTransition[], t: number, eps = 1e-3): number | null {
  const ks = keyTimes(list).filter((k) => k < t - eps);
  return ks.length ? ks[ks.length - 1] : null;
}
export function nextKey(list: readonly PoseTransition[], t: number, eps = 1e-3): number | null {
  return keyTimes(list).find((k) => k > t + eps) ?? null;
}

/** A pose change from the 3D tab or the canvas, as ops that follow the chip. */
export function poseEditOps(p3: P3, chip: Chip, patch: Partial<Pose>, t: number): { ops: EditOp[]; seek?: number } | { error: string } {
  if (chip.mode === 'base') return { ops: [{ op: 'setPose', target: 'base', ...patch }] };
  if (chip.mode === 'none') {
    // Auto key: a move that ends here, starting where the phone was held.
    const before = p3.transitions.filter((m) => m.end <= t + 1e-9);
    const prevEnd = before.length ? Math.max(...before.map((m) => m.end)) : 0;
    const start = Math.max(0, prevEnd, t - DEFAULT_MOVE_LENGTH);
    if (t - start < MIN_TRANSITION - 1e-9) return { error: 'Too close to the move before. Move the playhead later to add a move.' };
    return { ops: [{ op: 'addTransition', start, end: t, to: patch, easing: 'smooth' }] };
  }
  const tg = chip.target;
  if (tg.kind === 'base') return { ops: [{ op: 'setPose', target: 'base', ...patch }] };
  return { ops: [{ op: 'setPose', id: tg.id, end: tg.kind, ...patch }], ...(chip.mode === 'near' ? { seek: chip.keyTime } : {}) };
}

/** Option-click on the lane, T, "Add 3D Move Here": a 1.2 s move that turns 25° from where the phone is. */
export function addMoveOp(p3: P3, t: number): EditOp {
  const held = poseAt(p3, t);
  const turn = Math.min(POSE_RANGE.turn[1], held.turn + 25);
  return { op: 'addTransition', start: Math.max(0, t), end: Math.max(0, t) + DEFAULT_MOVE_LENGTH, to: { turn } };
}

/** Duplicate: the same move again, starting where it ends. */
export function duplicateOp(m: PoseTransition): EditOp {
  const d = m.end - m.start;
  const op: EditOp = { op: 'addTransition', start: m.end, end: m.end + d, to: { ...m.to }, easing: { ...m.easing } };
  if (m.from) op.from = { ...m.from };
  return op;
}

// ---------------------------------------------------------------------------
// Values across a selection

/** The keyframe each selected move shows (its resolved Start, or its End), in lane order. */
export function keyPoses(p3: P3, ids: readonly string[], which: 'from' | 'to'): Pose[] {
  const starts = resolveStarts(p3);
  return p3.transitions.flatMap((m, i) => (ids.includes(m.id) ? [which === 'from' ? starts[i] : m.to] : []));
}

/** Channels whose values differ across `poses` (shown as "–"). */
export function mixedChannels(poses: readonly Pose[]): Set<PoseKey> {
  const out = new Set<PoseKey>();
  if (!poses.length) return out;
  for (const k of Object.keys(poses[0]) as PoseKey[]) if (!poses.every((p) => Math.abs(p[k] - poses[0][k]) < 1e-6)) out.add(k);
  return out;
}

const clampTo = (k: PoseKey, v: number) => Math.min(POSE_RANGE[k][1], Math.max(POSE_RANGE[k][0], v));

/**
 * A pose field changed on many moves at once. `set` (typing) gives every
 * move the value; `add` (dragging a "–" field) adds the same change to each,
 * from `base` (the poses at the start of the drag), so mirrored moves stay
 * mirrored. One op per move, sent as one list (one undo step).
 */
export function multiPoseOps(p3: P3, ids: readonly string[], which: 'from' | 'to', key: PoseKey, value: number, mode: 'set' | 'add', base?: readonly Pose[]): EditOp[] {
  const poses = base ?? keyPoses(p3, ids, which);
  const chosen = p3.transitions.filter((m) => ids.includes(m.id));
  return chosen.map((m, i) => ({ op: 'setPose', id: m.id, end: which, [key]: clampTo(key, mode === 'set' ? value : poses[i][key] + value) }));
}

/** An easing for every selected move (with `fit`, a spring's length becomes its settle time). */
export function easingOps(ids: readonly string[], e: Easing, fit = false): EditOp[] {
  return ids.map((id) => ({ op: 'editTransition', id, easing: { ...e }, ...(fit && e.kind === 'spring' ? { fitDuration: true } : {}) }));
}

/** A duration for every selected move: Start stays (`keepEnd`: End stays). */
export function durationOps(list: readonly PoseTransition[], ids: readonly string[], d: number, keepEnd = false): EditOp[] {
  const len = Math.max(MIN_TRANSITION, d);
  return list
    .filter((m) => ids.includes(m.id))
    .map((m) => (keepEnd ? { op: 'editTransition', id: m.id, start: Math.max(0, m.end - len) } : { op: 'editTransition', id: m.id, end: m.start + len }));
}

// ---------------------------------------------------------------------------
// The lane

/** Where a pointer drag puts a move: absolute times from the move as it was at pointerdown (§5.3). */
export function dragTimes(orig: { start: number; end: number }, part: 'start' | 'end' | 'body', dt: number, outDur: number): { start: number; end: number } {
  const len = orig.end - orig.start;
  if (part === 'body') {
    const start = Math.min(Math.max(0, orig.start + dt), Math.max(0, outDur - len));
    return { start, end: start + len };
  }
  if (part === 'start') return { start: Math.min(Math.max(0, orig.start + dt), orig.end - MIN_TRANSITION), end: orig.end };
  const end = Math.min(Math.max(orig.start + MIN_TRANSITION, orig.end + dt), Math.max(orig.start + MIN_TRANSITION, outDur));
  return { start: orig.start, end };
}

/**
 * Snap a time to the nearest candidate (the playhead, a tap) within
 * `thresholdPx` on screen, else to the frame grid. Returns the time and what
 * it snapped to.
 */
export function snapTime(t: number, candidates: readonly { t: number; what: string }[], pxPerSec: number, fps: number, thresholdPx = 6): { t: number; what: string } {
  let best: { t: number; what: string } | null = null;
  let bestPx = thresholdPx + 1e-9;
  for (const c of candidates) {
    const px = Math.abs(c.t - t) * pxPerSec;
    if (px <= bestPx) {
      best = c;
      bestPx = px;
    }
  }
  return best ?? { t: Math.round(t * fps) / fps, what: 'frame' };
}

/** The window Frame Selection zooms to: the moves (with a squeezed spring's cut tail) plus a little room. */
export function frameWindow(moves: readonly PoseTransition[]): { start: number; end: number } | null {
  if (!moves.length) return null;
  const a = Math.min(...moves.map((m) => m.start));
  const b = Math.max(...moves.map((m) => m.end + springShortfall(m)));
  const pad = Math.max(0.12, (b - a) * 0.12);
  return { start: Math.max(0, a - pad), end: b + pad };
}

export type KeyShape = 'full' | 'left' | 'right';

export interface LaneKey {
  /** x in lane pixels. */
  x: number;
  moveId: string;
  which: 'start' | 'end';
  shape: KeyShape;
  /** A linked Start: a hollow diamond. */
  hollow: boolean;
  /** Hit area, lane pixels [from, to]. */
  hit: [number, number];
}

export interface LaneBlock {
  id: string;
  x: number;
  w: number;
  /** The recipe or easing name, when the block is wide enough for it. */
  label: string | null;
  /** The part a squeezed spring cuts off, in lane pixels (one selected block only). */
  tail: number;
  /** A thin link from the previous move of the same shot, lane pixels [from, to]. */
  link: [number, number] | null;
}

export interface LaneLayout {
  blocks: LaneBlock[];
  /** Moves too narrow to draw (zoomed out): a tick at their middle, lane pixels. */
  ticks: number[];
  keys: LaneKey[];
}

/** Keys are 12 px with 20 px hit areas (approved mockups, revision 2). */
export const KEY_HIT = 20;
/** Under this width a block hides its keys, so keys never cover it. */
export const KEYS_MIN_BLOCK = 28;
/** Under this width a move is drawn as a tick. */
export const TICK_MAX = 6;

/** The 3D lane drawn at `pxPerSec`, only what lies near the visible part [x0, x1]. */
export function laneLayout(list: readonly PoseTransition[], o: { pxPerSec: number; x0?: number; x1?: number; selected: readonly string[] }): LaneLayout {
  const X = (t: number) => t * o.pxPerSec;
  const vis = (a: number, b: number) => (o.x1 === undefined || X(a) <= o.x1 + 40) && (o.x0 === undefined || X(b) >= o.x0 - 40);
  const blocks: LaneBlock[] = [];
  const ticks: number[] = [];
  const keys: Omit<LaneKey, 'shape' | 'hit'>[] = [];
  const single = o.selected.length === 1;
  for (const g of shotGroups(list)) {
    g.forEach((m, i) => {
      const springTail = springShortfall(m);
      if (!vis(m.start, m.end + springTail)) return;
      const x = X(m.start);
      const w = X(m.end) - x;
      if (w < TICK_MAX) {
        ticks.push(x + w / 2);
        return;
      }
      const name = m.recipe ? RECIPE_LABEL[m.recipe] : EASE_LABEL[m.easing.kind];
      const label = i === 0 && w >= Math.max(48, name.length * 6.6 + 22) ? name : null;
      const sel = o.selected.includes(m.id);
      const prev = i > 0 ? g[i - 1] : null;
      const link: [number, number] | null = prev && X(m.start) - X(prev.end) - 14 > 1 ? [X(prev.end) + 7, X(m.start) - 7] : null;
      blocks.push({ id: m.id, x, w, label, tail: sel && single && springTail ? springTail * o.pxPerSec : 0, link });
      if (w >= KEYS_MIN_BLOCK) {
        keys.push({ x, moveId: m.id, which: 'start', hollow: !m.from });
        keys.push({ x: X(m.end), moveId: m.id, which: 'end', hollow: false });
      }
    });
  }
  keys.sort((a, b) => a.x - b.x || (a.which === 'end' ? -1 : 1));
  const out: LaneKey[] = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const n = keys[i + 1];
    if (n && k.which === 'end' && n.which === 'start' && n.x - k.x < KEY_HIT) {
      // Touching keys: two halves, each pointing into its own move, the hit areas split at the midpoint.
      const push = Math.max(0, (2 - (n.x - k.x)) / 2);
      const mid = (k.x + n.x) / 2;
      out.push({ ...k, x: k.x - push, shape: 'left', hit: [mid - KEY_HIT, mid] });
      out.push({ ...n, x: n.x + push, shape: 'right', hit: [mid, mid + KEY_HIT] });
      i++;
    } else out.push({ ...k, shape: 'full', hit: [k.x - KEY_HIT / 2, k.x + KEY_HIT / 2] });
  }
  return { blocks, ticks, keys: out };
}

export type LaneHit =
  | { kind: 'key'; key: LaneKey }
  | { kind: 'edge'; id: string; part: 'start' | 'end' }
  | { kind: 'body'; id: string; part: 'body' }
  | { kind: 'empty' };

/** What a press at lane-pixel x hits: a key, a block edge (retime), a block body (slide), or nothing. */
export function laneHit(layout: LaneLayout, x: number, edgePx = 6): LaneHit {
  const key = layout.keys.find((k) => x >= k.hit[0] && x <= k.hit[1]);
  if (key) return { kind: 'key', key };
  // Topmost first: later blocks draw over earlier ones.
  for (let i = layout.blocks.length - 1; i >= 0; i--) {
    const b = layout.blocks[i];
    if (x < b.x - edgePx || x > b.x + b.w + edgePx) continue;
    if (b.w > edgePx * 3 && Math.abs(x - b.x) <= edgePx) return { kind: 'edge', id: b.id, part: 'start' };
    if (b.w > edgePx * 3 && Math.abs(x - (b.x + b.w)) <= edgePx) return { kind: 'edge', id: b.id, part: 'end' };
    if (x >= b.x && x <= b.x + b.w) return { kind: 'body', id: b.id, part: 'body' };
  }
  return { kind: 'empty' };
}

/** Moves a selection box from lane-pixel x0 to x1 touches. */
export function marqueeIds(list: readonly PoseTransition[], x0: number, x1: number, pxPerSec: number): string[] {
  const a = Math.min(x0, x1) / pxPerSec;
  const b = Math.max(x0, x1) / pxPerSec;
  return list.filter((m) => m.end >= a && m.start <= b).map((m) => m.id);
}

// ---------------------------------------------------------------------------
// Warnings and the inactive line, in the panel's own words (the CLI's
// messages name raw move ids; a person sees what happens).

export function warningText(w: Pick<Warning, 'code' | 'at' | 'message'>, kindAt: (t: number) => string | null): string {
  const kind = w.at !== undefined ? kindAt(w.at) : null;
  const what = kind === 'swipe' ? 'swipe' : kind === 'typing' ? 'typing' : kind === 'longpress' ? 'long press' : 'tap';
  switch (w.code) {
    case 'tap-back':
      return `Faces away at this ${what}`;
    case 'tap-angle':
      return `Turned too far at this ${what}`;
    case 'off-canvas':
      return 'Goes off the canvas';
    case 'overlap':
      return 'Starts before the move ahead ends';
    case 'over-zoom':
      return 'Turns during a zoom';
    case 'past-end':
      return 'Ends after the video';
    case 'pose-jump':
      return 'Jumps at its Start';
    case 'too-fast':
      return 'Too fast: it will strobe';
    case 'floor-flat':
      return 'Floor shadow is hidden at this camera height';
    case 'inactive':
      return w.message;
  }
}

/** The 3D tab's one quiet line when 3D is on but drawn flat. */
export function inactiveText(reason: Phone3DInactiveReason | undefined): { title: string; body: string } | null {
  switch (reason) {
    case 'app-store':
      return { title: 'Flat in App Store layouts.', body: 'Apple needs the real screen. Your moves are kept.' };
    case 'frame-off':
      return { title: 'Needs the device frame.', body: 'The 3D phone is built from it.' };
    case 'frameless-layout':
      return { title: 'Flat in this layout.', body: 'Pick a framed canvas to see it in 3D.' };
    case 'mac-iphone':
      return { title: 'Flat with a phone layer.', body: 'Mac + iPhone takes draw the phone flat.' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Export quality

/** Rough export cost against the defaults (12 samples at 1×), for the Quality hint. */
export function exportCost(p3: Pick<Phone3D, 'motionBlur' | 'supersample'>): number {
  const samples = p3.motionBlur.on ? Math.max(8, p3.motionBlur.samples) : 8;
  return (samples / 12) * p3.supersample * p3.supersample;
}

/** "Edges are already smooth at 1×", or the estimated slowdown when samples > 16 or the quality is 2× or 3×. */
export function qualityHint(p3: Pick<Phone3D, 'motionBlur' | 'supersample'>): string {
  if (p3.supersample === 1 && !(p3.motionBlur.on && p3.motionBlur.samples > 16)) return 'Edges are already smooth at 1×';
  const k = exportCost(p3);
  return `Exports about ${k >= 10 ? Math.round(k) : +k.toFixed(1)}× slower`;
}

// ---------------------------------------------------------------------------
// Copy as edits.json

/** The 3D setup as ops an agent can apply to rebuild it. */
export function phone3dAsOps(p3: Phone3D): EditOp[] {
  const { transitions, ...settings } = p3;
  const ops: EditOp[] = [{ op: 'phone3d', ...JSON.parse(JSON.stringify(settings)) }, { op: 'clearTransitions' }];
  for (const m of transitions) {
    const op: EditOp = { op: 'addTransition', start: m.start, end: m.end, to: { ...m.to }, easing: { ...m.easing } };
    if (m.from) op.from = { ...m.from };
    ops.push(op);
  }
  return ops;
}
