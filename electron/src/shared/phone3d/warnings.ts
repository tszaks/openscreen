// Soft problems with a 3D setup (SPEC §2.7). Warnings never block applyOps:
// structural problems are errors (validate.ts); everything that depends on
// timing, angles or the canvas is a warning here, so a trim can never lock
// the project (D6).
//
// A warning may carry `fix`: edit ops that clear it. Every fix is checked
// before it is offered: it is applied to a copy and the same check runs
// again; a fix that would not clear its warning is not offered. Pure and
// deterministic (no clock, no randomness).

import { focusSegmentsFor } from '../focusSegments';
import { tapsToOutput } from '../mobileProject';
import { Timeline } from '../timeline';
import type { CursorSample, Project } from '../types';
import type { EditOp } from '../agentOps';
import { MIN_TRANSITION, POSE_KEYS, POSE_RANGE, type Phone3D, type Pose, type PoseKey, type PoseTransition } from './model';
import { applyPhone3dOp, isPhone3dOp } from './ops';
import { phone3dActive, type Phone3DInactiveReason } from './placement';
import { floatSampler, facingOf, lerpPose, moveProgress, poseAt, poseDelta, poseRotation, poseTargetAt, resolveStarts, rotationAngle, SPEED_STEP, type PoseTarget } from './pose';
import { bodyBounds, scene3d, type Scene3D } from './projection';
import { phone3dProblems } from './validate';

export interface Warning {
  code: WarningCode;
  message: string;
  /** OUTPUT seconds: where to look (the editor seeks here). */
  at?: number;
  end?: number;
  /** The move the warning is about. */
  transitionId?: string;
  /** Ops that clear it, applied as one apply (one undo step). */
  fix?: EditOp[];
}

export const WARNING_CODES = ['inactive', 'tap-angle', 'tap-back', 'zoom-angle', 'off-canvas', 'overlap', 'past-end', 'pose-jump', 'too-fast', 'floor-flat'] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

/** A tap must see the screen within this angle of straight on. */
export const TAP_ANGLE_DEG = 35;
/** During a zoom the screen must face within this angle of straight on (owner decision 20: the steep-angle limit,
 *  the same as a tap's). */
export const ZOOM_ANGLE_DEG = TAP_ANGLE_DEG;
/** Seconds checked on each side of a tap (and after a swipe or typing run ends). */
export const TAP_WINDOW = 0.3;
/** Samples per second inside a tap window. */
export const TAP_SAMPLE_HZ = 30;
/** How far the body may poke out of the canvas, as a fraction of its short side. */
export const OFF_CANVAS_FRACTION = 0.02;
/** Samples per second for the off-canvas check (plus every keyframe time). */
export const OFF_CANVAS_HZ = 15;
/** Fastest turn (°/s) before a move strobes, with and without motion blur. */
export const TOO_FAST_DEG_S = 600;
export const TOO_FAST_NO_BLUR_DEG_S = 360;
/** A fix may not make a move turn faster than this (°/s) unless it already did: a product turn reads at about
 *  half the strobe limit (the shot recipes stay under it). */
export const COMFORT_DEG_S = 300;
/** Samples per second for the speed check. */
export const SPEED_SAMPLE_HZ = 120;
/** An explicit Start further than this from where the phone is, is a jump. */
export const JUMP_DEG = 1;
export const JUMP_FRACTION = 0.005;
/** Below this camera elevation a floor shadow is edge-on (invisible). */
export const FLOOR_MIN_ELEVATION = 4;
/** The floor-flat fix's camera elevation. */
export const FLOOR_FIX_ELEVATION = 12;

const DEG = Math.PI / 180;
const ANGLE_CHANNELS: readonly PoseKey[] = ['turn', 'tilt', 'rotate', 'light'];
const COS_TAP = Math.cos(TAP_ANGLE_DEG * DEG);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const ceil3 = (x: number) => Math.ceil(x * 1000 - 1e-6) / 1000;
const floor3 = (x: number) => Math.floor(x * 1000 + 1e-6) / 1000;
const s2 = (x: number) => `${x.toFixed(2)} s`;

const INACTIVE_TEXT: Record<Phone3DInactiveReason, string> = {
  disabled: 'The 3D phone is off',
  'not-iphone': 'The 3D phone needs an iPhone or iPad recording, so it renders flat',
  'frame-off': 'The 3D phone needs the device frame: it renders flat while the frame is off',
  'app-store': 'App Store layouts stay flat (Apple needs the exact screen)',
  'mac-iphone': 'Mac + iPhone takes keep the phone flat',
  'frameless-layout': 'This layout has no device frame, so the phone renders flat',
};

/** Everything the checks share for one project. */
interface Ctx {
  p: Project;
  p3: Phone3D;
  /** Output duration. */
  D: number;
  scene: Scene3D;
  cursor: readonly CursorSample[];
}

/** A warning plus the identity used to tell whether a fix cleared it. */
type Found = Warning & { key: string; offCanvas?: OffCanvas; offCanvasCause?: OffCanvasCause['kind'] };

function makeCtx(p: Project, cursor: readonly CursorSample[]): Ctx | null {
  if (!p.phone3d) return null;
  const scene = scene3d(p);
  if (!scene) return null;
  return { p, p3: p.phone3d, D: new Timeline(p.recording.duration, p.clips).outputDuration, scene, cursor };
}

/** Index of the last move with start ≤ t (−1 before the first). */
function activeIndex(list: readonly PoseTransition[], t: number): number {
  let k = -1;
  for (let i = 0; i < list.length && list[i].start <= t; i++) k = i;
  return k;
}

/** The move responsible for the pose at t: the active one, or the first move before it starts. */
function culprit(list: readonly PoseTransition[], t: number): PoseTransition | undefined {
  return list[Math.max(0, activeIndex(list, t))];
}

// ---------------------------------------------------------------------------
// Taps

interface TapCheck {
  tapId: string;
  t: number;
  a: number;
  b: number;
  worst: number;
  minFacing: number;
}

function tapChecks(c: Ctx): TapCheck[] {
  const tl = new Timeline(c.p.recording.duration, c.p.clips);
  const sample = floatSampler(c.p3);
  const elev = c.p3.camera.elevation;
  const out: TapCheck[] = [];
  for (const tap of tapsToOutput(c.p.taps ?? [], tl)) {
    const a = Math.max(0, tap.t - TAP_WINDOW);
    const b = Math.min(c.D, tap.t + (tap.duration ?? 0) + TAP_WINDOW);
    if (!(b >= a)) continue;
    const n = Math.max(1, Math.ceil((b - a) * TAP_SAMPLE_HZ));
    // The worst moment in the window; the tap's own time when the phone is no better there (a held pose).
    let minFacing = facingOf(sample(tap.t), elev);
    let worst = tap.t;
    for (let k = 0; k <= n; k++) {
      const tt = a + ((b - a) * k) / n;
      const f = facingOf(sample(tt), elev);
      if (f < minFacing - 1e-6) {
        minFacing = f;
        worst = tt;
      }
    }
    out.push({ tapId: tap.id, t: tap.t, a, b, worst, minFacing });
  }
  return out;
}

/** Where `worst` sits relative to the tap at `t`, in words. */
function tapRelative(worst: number, t: number): string {
  const d = worst - t;
  if (Math.abs(d) < 0.005) return 'at';
  return `${Math.abs(d).toFixed(2)} s ${d < 0 ? 'before' : 'after'}`;
}

function tapWarnings(c: Ctx): Found[] {
  const out: Found[] = [];
  for (const chk of tapChecks(c)) {
    if (chk.minFacing >= COS_TAP) continue;
    const tr = culprit(c.p3.transitions, chk.worst);
    const deg = Math.acos(Math.max(-1, Math.min(1, chk.minFacing))) / DEG;
    const back = chk.minFacing < 0;
    // Name the moment the check failed: the window starts TAP_WINDOW before the tap, and round 2's message put the
    // worst angle in that window at the tap's own time, where the phone was nearly front.
    const when = tapRelative(chk.worst, chk.t);
    const rule = `the screen must face within ${TAP_ANGLE_DEG}° from ${TAP_WINDOW} s before a tap to ${TAP_WINDOW} s after it`;
    out.push({
      code: back ? 'tap-back' : 'tap-angle',
      key: `tap:${chk.tapId}`,
      message: back
        ? `The phone shows its back at ${s2(chk.worst)}, ${when} the tap at ${s2(chk.t)}, so the tap is not visible (${rule})`
        : `The phone is ${Math.round(deg)}° off front at ${s2(chk.worst)}, ${when} the tap at ${s2(chk.t)} (${rule})`,
      at: r3(chk.t),
      ...(tr ? { transitionId: tr.id } : {}),
    });
  }
  return out;
}

/** Fix candidates for a tap warning, in order of preference. */
function tapFixes(c: Ctx, w: Found): EditOp[][] {
  const chk = tapChecks(c).find((x) => `tap:${x.tapId}` === w.key);
  return chk ? windowFixes(c, chk) : [];
}

/**
 * Fix candidates for a window the screen must face through ([a, b], worst
 * moment `worst`, the moment `t` it is about), in order of preference.
 */
function windowFixes(c: Ctx, chk: { t: number; a: number; b: number; worst: number }): EditOp[][] {
  const list = c.p3.transitions;
  const tr = culprit(list, chk.worst);
  // Face front at the moment: the keyframe poseTargetAt edits gets turn = the whole turn nearest the move's
  // other end (so the move does not gain a spin) and tilt 0.
  const target = poseTargetAt(c.p3, chk.t);
  const ref = target.kind === 'to' ? resolveStarts(c.p3)[target.index].turn : target.kind === 'from' ? list[target.index].to.turn : target.pose.turn;
  const face: EditOp = { op: 'setPose', at: r3(chk.t), turn: 360 * Math.round(ref / 360), tilt: 0 };
  const out: EditOp[][] = [];
  const inFlight = tr && tr.end > chk.a && tr.start <= chk.worst;
  if (inFlight) {
    // First the fixes that keep the move's length (its speed): the whole move earlier, so it lands before the
    // window, or later, so it starts after it.
    if (tr.end - chk.a <= tr.start) out.push([{ op: 'editTransition', id: tr.id, by: -ceil3(tr.end - chk.a) }]);
    out.push([{ op: 'editTransition', id: tr.id, by: ceil3(chk.b - tr.start) }]);
  }
  if (inFlight && tr.start <= chk.a - MIN_TRANSITION) {
    const pull: EditOp = { op: 'editTransition', id: tr.id, end: floor3(chk.a) };
    out.push([pull], [face], [pull, face]);
  } else out.push([face]);
  return out;
}

// ---------------------------------------------------------------------------
// Zooms (owner decision 20: a zoom pushes the 3D camera in toward the screen, so the screen must face the viewer)

interface ZoomCheck {
  key: string;
  /** The zoom's span (output s) and the moment it is at its focus. */
  a: number;
  b: number;
  t: number;
  worst: number;
  minFacing: number;
}

function zoomChecks(c: Ctx): ZoomCheck[] {
  const sample = floatSampler(c.p3);
  const elev = c.p3.camera.elevation;
  const out: ZoomCheck[] = [];
  focusSegmentsFor(c.p, c.cursor).forEach((z, i) => {
    const a = Math.max(0, z.inStart);
    const b = Math.min(c.D, z.outEnd);
    if (!(b >= a)) return;
    const t = Math.min(b, Math.max(a, z.holdStart));
    const n = Math.max(1, Math.ceil((b - a) * TAP_SAMPLE_HZ));
    let minFacing = facingOf(sample(t), elev);
    let worst = t;
    for (let k = 0; k <= n; k++) {
      const tt = a + ((b - a) * k) / n;
      const f = facingOf(sample(tt), elev);
      if (f < minFacing - 1e-6) {
        minFacing = f;
        worst = tt;
      }
    }
    out.push({ key: `zoom:${i}:${r3(z.inStart)}`, a, b, t, worst, minFacing });
  });
  return out;
}

const COS_ZOOM = Math.cos(ZOOM_ANGLE_DEG * DEG);

function zoomAngleWarnings(c: Ctx): Found[] {
  const out: Found[] = [];
  for (const chk of zoomChecks(c)) {
    if (chk.minFacing >= COS_ZOOM) continue;
    const tr = culprit(c.p3.transitions, chk.worst);
    const deg = Math.acos(Math.max(-1, Math.min(1, chk.minFacing))) / DEG;
    out.push({
      code: 'zoom-angle',
      key: chk.key,
      message: `The phone is ${Math.round(deg)}° off front at ${s2(chk.worst)}, during the zoom at ${s2(chk.a)}–${s2(chk.b)} (the screen must face within ${ZOOM_ANGLE_DEG}° while a zoom plays)`,
      at: r3(chk.a),
      end: r3(chk.b),
      ...(tr ? { transitionId: tr.id } : {}),
    });
  }
  return out;
}

function zoomFixes(c: Ctx, w: Found): EditOp[][] {
  const chk = zoomChecks(c).find((x) => x.key === w.key);
  return chk ? windowFixes(c, chk) : [];
}

// ---------------------------------------------------------------------------
// Off canvas
//
// Cost: one scan of the timeline per projectWarnings call (15 Hz plus every
// keyframe), then work per warning that only reads the warning's own span.
// With the idle float on every sample is a new pose, so the bounds cache never
// hits and a scan of a 10-minute take is ~10k hull projections: the fix and the
// fix check must never rescan the whole timeline per warning.

interface Run {
  at: number;
  end: number;
  worst: number;
  over: number;
}

/** Off-canvas runs that the same keyframe causes, reported as one warning with one fix. */
interface OffCanvas {
  runs: Run[];
  /** First run's start and last run's end (raw seconds). */
  at: number;
  end: number;
  /** The worst moment over all the runs and its overflow (px). */
  worst: number;
  over: number;
  /** The keyframe a setPose at `worst` edits. */
  target: PoseTarget;
}

/** The canvas edges, in the order EdgeOverflow lists them. */
export const EDGES = ['left', 'top', 'right', 'bottom'] as const;
export type Edge = (typeof EDGES)[number];
/** How far the body pokes past each canvas edge (px; ≤ 0 = inside that edge). */
export type EdgeOverflow = readonly [left: number, top: number, right: number, bottom: number];

const INSIDE: EdgeOverflow = [0, 0, 0, 0];

/** Bounds per pose: with the float off the phone holds still most of the time, so most samples repeat a pose. */
type BoundsCache = Map<string, EdgeOverflow>;

/** How far the body pokes past each edge of the canvas at t (px; ≤ 0 = inside). */
function edgesAt(s: Scene3D, t: number, cache: BoundsCache = new Map(), pose: Pose = s.poseAt(t)): EdgeOverflow {
  const key = `${pose.turn},${pose.tilt},${pose.rotate},${pose.size},${pose.x},${pose.y}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const b = bodyBounds({ ...s, poseAt: () => pose }, t);
  const edges: EdgeOverflow = b ? [-b.x, -b.y, b.x + b.w - s.canvas.width, b.y + b.h - s.canvas.height] : INSIDE;
  cache.set(key, edges);
  return edges;
}

/** How far the body pokes out of the canvas at t, past its worst edge (px; ≤ 0 = inside). */
const overflowAt = (s: Scene3D, t: number, cache?: BoundsCache, pose?: Pose): number => Math.max(...edgesAt(s, t, cache, pose));

/** Allowed overflow (px): OFF_CANVAS_FRACTION of the canvas's short side. */
const offCanvasMargin = (s: Scene3D) => OFF_CANVAS_FRACTION * Math.min(s.canvas.width, s.canvas.height);

function offCanvasTimes(c: Ctx): number[] {
  const n = Math.max(1, Math.ceil(c.D * OFF_CANVAS_HZ));
  const ts = Array.from({ length: n + 1 }, (_, k) => (c.D * k) / n);
  for (const tr of c.p3.transitions) for (const t of [tr.start, tr.end]) if (t >= 0 && t <= c.D) ts.push(t);
  return [...new Set(ts)].sort((a, b) => a - b);
}

/** Samples per second inside every move for the Auto 3D self-check (offCanvasAdded): every frame at 60 fps. */
export const OFF_CANVAS_MOVING_HZ = 60;

/**
 * offCanvasTimes plus every 60 fps frame inside each move. While the phone
 * moves, an edge can poke out and back between two 15 Hz samples (a fast
 * turn near an edge peaks for a few frames), and a shot is the only thing
 * that moves the phone fast, so the self-check reads every frame there.
 */
function movingTimes(c: Ctx): number[] {
  const ts = offCanvasTimes(c);
  for (const tr of c.p3.transitions) {
    const a = Math.max(0, tr.start);
    const b = Math.min(c.D, tr.end);
    for (let k = Math.ceil(a * OFF_CANVAS_MOVING_HZ - 1e-9); k <= Math.floor(b * OFF_CANVAS_MOVING_HZ + 1e-9); k++) ts.push(k / OFF_CANVAS_MOVING_HZ);
  }
  return [...new Set(ts)].sort((x, y) => x - y);
}

/** The sample times inside [a, b] (sorted). */
const timesIn = (times: readonly number[], a: number, b: number) => times.filter((t) => t >= a - 1e-9 && t <= b + 1e-9);

/** The largest overflow over `times` and when (−Infinity with no times). */
function worstOverflow(s: Scene3D, times: readonly number[], fallback: number): { over: number; at: number } {
  const cache: BoundsCache = new Map();
  let over = -Infinity;
  let at = fallback;
  for (const t of times) {
    const o = overflowAt(s, t, cache);
    if (o > over) {
      over = o;
      at = t;
    }
  }
  return { over, at };
}

function offCanvasRuns(c: Ctx, times: readonly number[]): Run[] {
  const margin = offCanvasMargin(c.scene);
  const runs: Run[] = [];
  let cur: Run | null = null;
  const cache: BoundsCache = new Map();
  for (const t of times) {
    const over = overflowAt(c.scene, t, cache);
    if (over > margin) {
      if (!cur) cur = { at: t, end: t, worst: t, over };
      cur.end = t;
      if (over > cur.over) {
        cur.over = over;
        cur.worst = t;
      }
    } else if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

const targetKey = (t: PoseTarget) => (t.kind === 'base' ? 'base' : `${t.kind}:${t.id}`);

/**
 * The runs grouped by the keyframe behind each run's worst moment. The float
 * bobbing a phone that sits near an edge makes one run per float period (100+
 * on a long take); they share one cause and one fix, so they are one warning.
 */
function offCanvasGroups(c: Ctx, times: readonly number[]): OffCanvas[] {
  const groups = new Map<string, OffCanvas>();
  for (const r of offCanvasRuns(c, times)) {
    const target = poseTargetAt(c.p3, r.worst);
    const key = targetKey(target);
    const g = groups.get(key);
    if (!g) groups.set(key, { runs: [r], at: r.at, end: r.end, worst: r.worst, over: r.over, target });
    else {
      g.runs.push(r);
      g.end = Math.max(g.end, r.end);
      if (r.over > g.over) {
        g.over = r.over;
        g.worst = r.worst;
      }
    }
  }
  return [...groups.values()];
}

/** Every sample of `g`'s runs (the off-canvas check's own times inside each run). */
const runTimes = (times: readonly number[], g: OffCanvas) => g.runs.flatMap((r) => timesIn(times, r.at, r.end));

/**
 * The move an off-canvas group is named after (advisor ruling 3, owner
 * decision 19), or undefined. A move is named only when the per-edge
 * comparison shows it ADDS overflow: at some sample of the group's runs, an
 * edge is past the margin and more than OFF_CANVAS_ADDED_PX further past it
 * than on the same timeline without that move. The candidates are the move
 * active at the worst moment and the moves that lead straight into it (no
 * hold between them: one shot's lean, drift and return), latest first, so a
 * drift that only carries on a lean does not hide the lean. A run the
 * candidates do not push out (the float alone, or a pose the phone already
 * rests at) names no move.
 */
function offCanvasMove(c: Ctx, g: OffCanvas, times: readonly number[]): PoseTransition | undefined {
  const list = c.p3.transitions;
  const margin = offCanvasMargin(c.scene);
  const samples = runTimes(times, g);
  const cache: BoundsCache = new Map();
  const mine = samples.map((t) => edgesAt(c.scene, t, cache));
  let i = activeIndex(list, g.worst);
  if (i < 0) i = list.length ? 0 : -1;
  for (; i >= 0; i--) {
    const tr = list[i];
    const without = applyFix(c.p, [{ op: 'removeTransition', id: tr.id }]);
    const wc = without && makeCtx(without, c.cursor);
    if (!wc) continue;
    const wcache: BoundsCache = new Map();
    const adds = samples.some((t, k) => {
      const base = edgesAt(wc.scene, t, wcache);
      return mine[k].some((o, e) => o > margin && o > base[e] + OFF_CANVAS_ADDED_PX);
    });
    if (adds) return tr;
    // Only moves that lead straight into this one (no hold between) are part of the same motion.
    const prev = list[i - 1];
    if (!prev || prev.end < tr.start - 1e-3) break;
  }
  return undefined;
}

/** What makes an off-canvas group: a move (named), else the idle float, else the pose the phone rests at. */
type OffCanvasCause = { kind: 'move'; tr: PoseTransition } | { kind: 'float' } | { kind: 'pose' };

/** The float is the cause when it is on and the keyframes alone keep every sample of the group's runs inside. */
function floatCarries(c: Ctx, g: OffCanvas, times: readonly number[]): boolean {
  if (!c.p3.float.on) return false;
  const margin = offCanvasMargin(c.scene);
  const cache: BoundsCache = new Map();
  return runTimes(times, g).every((t) => overflowAt(c.scene, t, cache, poseAt(c.p3, t)) <= margin);
}

/**
 * Float first: when the keyframes alone stay inside the margin, the float is what carries the phone out, even when a
 * move brought the phone near the edge (both are then needed to poke out, so both "add" overflow). Lowering the float
 * clears it without touching the moves, and Auto 3D's own float must not get a kept move blamed (owner decision 19
 * keeps direct.test's "the float is part of the style" case, which is exactly this shape; a move-first order fails
 * it). Then a move that adds overflow (offCanvasMove); else the pose the phone rests at (the base pose or a kept hold).
 */
function offCanvasCause(c: Ctx, g: OffCanvas, times: readonly number[]): OffCanvasCause {
  if (floatCarries(c, g, times)) return { kind: 'float' };
  const tr = offCanvasMove(c, g, times);
  return tr ? { kind: 'move', tr } : { kind: 'pose' };
}

function offCanvasWarnings(c: Ctx): Found[] {
  const times = offCanvasTimes(c);
  return offCanvasGroups(c, times).map((g) => {
    const cause = offCanvasCause(c, g, times);
    const n = g.runs.length;
    const span = g.end > g.at ? `from ${s2(g.at)} to ${s2(g.end)}` : `at ${s2(g.at)}`;
    const why = cause.kind === 'float' ? ' (the idle float carries it past the edge)' : '';
    return {
      code: 'off-canvas' as const,
      key: `off-canvas:${targetKey(g.target)}`,
      message: `The phone goes ${Math.round(g.over)} px off the canvas ${n > 1 ? `${n} times ` : ''}${span}${why}`,
      at: r3(g.at),
      end: r3(g.end),
      ...(cause.kind === 'move' ? { transitionId: cause.tr.id } : {}),
      offCanvas: g,
      offCanvasCause: cause.kind,
    };
  });
}

/** Times a fix for `g` must clear: every sample in its span (keyframe times of `c`'s moves included). */
const groupTimes = (c: Ctx, g: OffCanvas) => timesIn(offCanvasTimes(c), g.at, g.end);

/** Float amounts a float-caused off-canvas fix tries, as fractions of the current amount (the gentlest first). */
export const FLOAT_FIX_STEPS = [0.8, 0.6, 0.4, 0.2, 0] as const;

/**
 * Fixes for an off-canvas warning. When the idle float carries the phone out
 * (advisor ruling 3), first a lower `float.amount` (the largest that clears
 * it), then the setPose below. Otherwise only the setPose.
 */
function* offCanvasFixes(c: Ctx, w: Found): Iterable<EditOp[]> {
  if (w.offCanvasCause === 'float') {
    const amount = c.p3.float.amount;
    for (const a of new Set(FLOAT_FIX_STEPS.map((f) => Math.round(amount * f * 100) / 100))) if (a < amount) yield [{ op: 'phone3d', float: { amount: a } }];
  }
  // Only worked out when no float fix cleared it (each round re-renders the warning's span).
  yield* offCanvasPoseFixes(c, w);
}

/** A setPose that pulls the keyframe behind the worst moment back onto the canvas (clamped x/y/size). */
function offCanvasPoseFixes(c: Ctx, w: Found): EditOp[][] {
  const g = w.offCanvas;
  if (!g) return [];
  const W = c.scene.canvas.width;
  const H = c.scene.canvas.height;
  const margin = offCanvasMargin(c.scene);
  const start: Pose = { ...g.target.pose };
  const pose: Pose = { ...start };
  const times = groupTimes(c, g);
  const opFor = (q: Pose): EditOp => {
    const op: EditOp = { op: 'setPose', at: r3(g.worst) };
    for (const k of ['x', 'y', 'size'] as const) if (q[k] !== start[k]) op[k] = Math.round(q[k] * 10000) / 10000;
    return op;
  };
  const clampKey = (k: 'x' | 'y' | 'size', v: number) => Math.min(POSE_RANGE[k][1], Math.max(POSE_RANGE[k][0], v));
  // Round 0 is the project as it is: the run scan already found its worst moment (g), so it is not rescanned.
  let scene = c.scene;
  let wt = g.worst;
  for (let iter = 0; iter < 8; iter++) {
    if (iter > 0) {
      const fixed = applyFix(c.p, [opFor(pose)]);
      const fc = fixed && makeCtx(fixed, c.cursor);
      if (!fc) return [];
      const worst = worstOverflow(fc.scene, times, g.worst);
      if (worst.over <= margin * 0.5) return [[opFor(pose)]];
      scene = fc.scene;
      wt = worst.at;
    }
    const b = bodyBounds(scene, wt)!;
    const inset = margin * 0.25;
    if (b.w > W - 2 * inset || b.h > H - 2 * inset) {
      pose.size = clampKey('size', pose.size * Math.min((W - 2 * inset) / b.w, (H - 2 * inset) / b.h) * 0.98);
      continue;
    }
    const dx = b.x < inset ? inset - b.x : b.x + b.w > W - inset ? W - inset - (b.x + b.w) : 0;
    const dy = b.y < inset ? inset - b.y : b.y + b.h > H - inset ? H - inset - (b.y + b.h) : 0;
    pose.x = clampKey('x', pose.x + dx / W);
    pose.y = clampKey('y', pose.y + dy / H);
  }
  return [];
}

/** No sample in the warning's span pokes out of `fc`'s canvas (only the span is rescanned, not the timeline). */
function offCanvasCleared(g: OffCanvas, fc: Ctx): boolean {
  return worstOverflow(fc.scene, groupTimes(fc, g), g.worst).over <= offCanvasMargin(fc.scene);
}

/** A shot may add up to this much overflow (px) past an edge over the project without it before the self-check blames it. */
export const OFF_CANVAS_ADDED_PX = 0.5;

/** A stretch where a planned project pokes further past a canvas edge than it does without the shots (direct.ts). */
export interface OffCanvasAdded {
  /** First and last sample of the stretch, and its worst moment (OUTPUT s, raw). */
  at: number;
  end: number;
  worst: number;
  /** The edge the phone is pushed past at `worst`. */
  edge: Edge;
  /** The overflow (px) past `edge` at `worst`, and the project-without-shots overflow past the same edge at the same time (absent with no baseline). */
  over: number;
  baseline?: number;
  /** The move behind the worst moment (as the off-canvas warning names it). */
  transitionId?: string;
}

/** The phone is on, valid and active, so the off-canvas checks apply (else projectWarnings has no geometry warnings). */
const geometryChecked = (p: Project) => !!p.phone3d?.enabled && !phone3dProblems(p).length && phone3dActive(p).active;

/**
 * How far `p`'s body pokes past each edge of its canvas at t (px; ≤ 0 =
 * inside), memoized per time so a planner can reuse it across rounds. null
 * when projectWarnings would not check the geometry (3D off, inactive or
 * invalid).
 */
export function offCanvasMeter(p: Project): ((t: number) => EdgeOverflow) | null {
  if (!geometryChecked(p)) return null;
  const scene = scene3d(p);
  if (!scene) return null;
  const cache: BoundsCache = new Map();
  const memo = new Map<number, EdgeOverflow>();
  return (t) => {
    let v = memo.get(t);
    if (v === undefined) memo.set(t, (v = edgesAt(scene, t, cache)));
    return v;
  };
}

/**
 * For the Auto 3D self-check, which must not judge by warning spans: one
 * off-canvas warning covers every run its keyframe causes, so its span can
 * be most of the take. This compares moment by moment and edge by edge
 * instead. Returns the stretches where `p` pokes past the margin at some
 * edge AND further past that same edge than `baseline` (the same project
 * without the shots; offCanvasMeter) at the same time, by more than
 * OFF_CANVAS_ADDED_PX. A kept pose near an edge, or the float, that already
 * pokes out is not counted; a shot that pushes the phone further out is,
 * wherever it does, and so is a shot that pushes it past a different edge
 * (a big overflow at the top never excuses a new one at the side). Samples:
 * the off-canvas check's own (15 Hz plus every keyframe of `p`) plus every
 * 60 fps frame inside each move of `p`. With no baseline every overflow past
 * the margin counts.
 */
export function offCanvasAdded(p: Project, baseline: ((t: number) => EdgeOverflow) | null): OffCanvasAdded[] {
  if (!geometryChecked(p)) return [];
  const c = makeCtx(p, []);
  if (!c) return [];
  const margin = offCanvasMargin(c.scene);
  const cache: BoundsCache = new Map();
  const out: OffCanvasAdded[] = [];
  let cur: OffCanvasAdded | null = null;
  let worstExcess = 0;
  for (const t of movingTimes(c)) {
    const edges = edgesAt(c.scene, t, cache);
    const base = baseline && edges.some((o) => o > margin) ? baseline(t) : null;
    // The edge furthest past both the margin and the baseline's overflow at that edge.
    let k = -1;
    let excess = -Infinity;
    for (let i = 0; i < 4; i++) {
      const o = edges[i];
      if (!(o > margin) || (base && !(o > base[i] + OFF_CANVAS_ADDED_PX))) continue;
      const e = o - Math.max(margin, base ? base[i] : -Infinity);
      if (e > excess) {
        excess = e;
        k = i;
      }
    }
    if (k >= 0) {
      const at = { worst: t, edge: EDGES[k], over: edges[k], ...(base ? { baseline: base[k] } : {}) };
      if (!cur) {
        cur = { at: t, end: t, ...at };
        worstExcess = excess;
      }
      cur.end = t;
      if (excess > worstExcess) {
        worstExcess = excess;
        Object.assign(cur, at);
      }
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  for (const r of out) {
    const tr = culprit(c.p3.transitions, r.worst);
    if (tr) r.transitionId = tr.id;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timing

function overlapWarnings(c: Ctx): Found[] {
  const list = c.p3.transitions;
  const out: Found[] = [];
  let lead: PoseTransition | null = null;
  for (const tr of list) {
    if (lead && lead.end > tr.start + 1e-3) {
      out.push({
        code: 'overlap',
        key: `move:${tr.id}`,
        message: `Move ${tr.id} starts at ${s2(tr.start)} while ${lead.id} runs until ${s2(lead.end)} (the later move wins)`,
        at: r3(tr.start),
        end: r3(lead.end),
        transitionId: tr.id,
      });
    }
    if (!lead || tr.end > lead.end) lead = tr;
  }
  return out;
}

function overlapFixes(c: Ctx, w: Found): EditOp[][] {
  const tr = c.p3.transitions.find((t) => t.id === w.transitionId);
  if (!tr || w.end === undefined) return [];
  const lead = Math.max(...c.p3.transitions.filter((t) => compareStart(t, tr) < 0).map((t) => t.end));
  const start = ceil3(lead);
  return tr.end - start >= MIN_TRANSITION ? [[{ op: 'editTransition', id: tr.id, start }]] : [[{ op: 'editTransition', id: tr.id, by: ceil3(lead - tr.start) }]];
}
const compareStart = (a: PoseTransition, b: PoseTransition) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function pastEndWarnings(c: Ctx): Found[] {
  return c.p3.transitions
    .filter((tr) => tr.end > c.D + 1e-6)
    .map((tr) => ({
      code: 'past-end' as const,
      key: `move:${tr.id}`,
      message: `Move ${tr.id} ends at ${s2(tr.end)}, after the video ends (${s2(c.D)})`,
      at: r3(Math.min(tr.start, c.D)),
      end: r3(tr.end),
      transitionId: tr.id,
    }));
}

function pastEndFixes(c: Ctx, w: Found): EditOp[][] {
  const tr = c.p3.transitions.find((t) => t.id === w.transitionId);
  if (!tr) return [];
  const by = floor3(c.D - tr.end);
  if (tr.start + by >= 0) return [[{ op: 'editTransition', id: tr.id, by }]];
  return floor3(c.D) >= MIN_TRANSITION ? [[{ op: 'editTransition', id: tr.id, start: 0, end: floor3(c.D) }]] : [];
}

function poseJumpWarnings(c: Ctx): Found[] {
  const list = c.p3.transitions;
  const starts = resolveStarts(c.p3);
  const out: Found[] = [];
  for (let i = 1; i < list.length; i++) {
    const tr = list[i];
    if (!tr.from) continue;
    const prev = list[i - 1];
    const linked = lerpPose(starts[i - 1], prev.to, moveProgress(prev, tr.start));
    const d = poseDelta(tr.from, linked);
    const big = POSE_KEYS.filter((k) => Math.abs(d[k]) > (ANGLE_CHANNELS.includes(k) ? JUMP_DEG : JUMP_FRACTION));
    if (!big.length) continue;
    out.push({
      code: 'pose-jump',
      key: `move:${tr.id}`,
      message: `Move ${tr.id} jumps at ${s2(tr.start)}: its Start differs from where the phone is (${big.map((k) => `${k} ${d[k] > 0 ? '+' : ''}${+d[k].toFixed(ANGLE_CHANNELS.includes(k) ? 1 : 3)}`).join(', ')})`,
      at: r3(tr.start),
      transitionId: tr.id,
      fix: [{ op: 'editTransition', id: tr.id, from: null }],
    });
  }
  return out;
}

/** Each move's peak angular speed (°/s) and when, sampled at SPEED_SAMPLE_HZ on the drawn pose (float included). */
function peakSpeeds(c: Ctx): Map<string, { peak: number; at: number }> {
  const sample = floatSampler(c.p3);
  const speed = (t: number) => rotationAngle(poseRotation(sample(t - SPEED_STEP)), poseRotation(sample(t + SPEED_STEP))) / (2 * SPEED_STEP);
  const out = new Map<string, { peak: number; at: number }>();
  for (const tr of c.p3.transitions) {
    const n = Math.max(2, Math.ceil((tr.end - tr.start) * SPEED_SAMPLE_HZ));
    let peak = 0;
    let at = tr.start;
    for (let k = 0; k <= n; k++) {
      const t = tr.start + ((tr.end - tr.start) * k) / n;
      const v = speed(t);
      if (v > peak) {
        peak = v;
        at = t;
      }
    }
    out.set(tr.id, { peak, at });
  }
  return out;
}

function tooFastWarnings(c: Ctx): Found[] {
  const limit = c.p3.motionBlur.on ? TOO_FAST_DEG_S : TOO_FAST_NO_BLUR_DEG_S;
  const speeds = peakSpeeds(c);
  const out: Found[] = [];
  for (const tr of c.p3.transitions) {
    const { peak, at } = speeds.get(tr.id)!;
    if (peak <= limit) continue;
    out.push({
      code: 'too-fast',
      key: `move:${tr.id}`,
      message: `Move ${tr.id} turns at ${Math.round(peak)}°/s, over ${limit}°/s${c.p3.motionBlur.on ? '' : ' with motion blur off'}: it will strobe (make it longer or smaller)`,
      at: r3(at),
      transitionId: tr.id,
    });
  }
  return out;
}

function floorFlatWarnings(c: Ctx): Found[] {
  const { shadow, camera } = c.p3;
  if (!shadow.on || shadow.kind !== 'floor' || camera.elevation >= FLOOR_MIN_ELEVATION) return [];
  return [
    {
      code: 'floor-flat',
      key: 'floor-flat',
      message: `A floor shadow is invisible with the camera height under ${FLOOR_MIN_ELEVATION}° (it is ${camera.elevation}°)`,
      fix: [{ op: 'phone3d', camera: { elevation: FLOOR_FIX_ELEVATION } }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Fixes

/** `ops` applied to a copy of `p` (3D ops and `device`), or null when one is refused or the result is invalid. */
function applyFix(p: Project, ops: EditOp[]): Project | null {
  let cur = p;
  try {
    for (const o of ops) {
      if (o.op === 'device') cur = { ...cur, device: { ...cur.device, ...(typeof o.frame === 'boolean' ? { frame: o.frame } : {}) } };
      else if (isPhone3dOp(o.op)) cur = applyPhone3dOp(cur, o, () => 'fix-check').project;
      else return null;
    }
  } catch {
    return null;
  }
  return phone3dProblems(cur).length ? null : cur;
}

type Check = (c: Ctx) => Found[];
const CHECKS: Partial<Record<WarningCode, Check>> = {
  'tap-angle': tapWarnings,
  'tap-back': tapWarnings,
  'zoom-angle': zoomAngleWarnings,
  overlap: overlapWarnings,
  'past-end': pastEndWarnings,
  'pose-jump': poseJumpWarnings,
  'too-fast': tooFastWarnings,
  'floor-flat': floorFlatWarnings,
};

/** The warning is gone from `fixed` (tap-angle and tap-back count as the same issue). */
function cleared(w: Found, fixed: Project, cursor: readonly CursorSample[]): boolean {
  const c = makeCtx(fixed, cursor);
  if (!c) return false;
  if (w.offCanvas) return offCanvasCleared(w.offCanvas, c);
  const again = CHECKS[w.code]!(c);
  return !again.some((x) => x.key === w.key && (x.code === w.code || w.key.startsWith('tap:')));
}

/** Warnings a fix must not add (cheap to re-check; off-canvas has its own fixes). */
const SIDE_CHECKS: readonly Check[] = [tapWarnings, zoomAngleWarnings, overlapWarnings, pastEndWarnings, poseJumpWarnings];

/**
 * A fix that clears one warning must not make the project worse: no new
 * warning of another kind (a later tap, an overlap, past the end, a jump), and
 * no move faster than it was, unless it stays under COMFORT_DEG_S. Round 2's
 * tap fix squeezed a 200° spin into 0.66 s (about 520°/s) to clear a tap.
 */
function noWorse(c: Ctx, fixed: Project): boolean {
  const f = makeCtx(fixed, c.cursor);
  if (!f) return false;
  // tap-angle and tap-back are one issue per tap.
  const id = (x: Found) => (x.key.startsWith('tap:') ? x.key : `${x.code}|${x.key}`);
  for (const check of SIDE_CHECKS) {
    const before = new Set(check(c).map(id));
    if (check(f).some((x) => !before.has(id(x)))) return false;
  }
  const was = peakSpeeds(c);
  for (const [id, now] of peakSpeeds(f)) {
    if (now.peak > Math.max(COMFORT_DEG_S, (was.get(id)?.peak ?? 0) + 1)) return false;
  }
  return true;
}

/** The first candidate fix that clears `w` and makes nothing else worse. */
function firstFix(c: Ctx, w: Found, candidates: Iterable<EditOp[]>): EditOp[] | undefined {
  for (const ops of candidates) {
    const fixed = applyFix(c.p, ops);
    if (fixed && cleared(w, fixed, c.cursor) && noWorse(c, fixed)) return ops;
  }
  return undefined;
}

const FIXERS: Partial<Record<WarningCode, (c: Ctx, w: Found) => Iterable<EditOp[]>>> = {
  'tap-angle': tapFixes,
  'tap-back': tapFixes,
  'zoom-angle': zoomFixes,
  'off-canvas': offCanvasFixes,
  overlap: overlapFixes,
  'past-end': pastEndFixes,
};

// ---------------------------------------------------------------------------

const codePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every warning for `p`'s 3D phone, sorted by time. `cursor` is the
 * bundle's cursor.json samples (D5), passed by the CLI and the editor alike.
 * zoom-angle reads it: the autofocus zooms come from it (focusSegmentsFor),
 * and each zoom pushes the 3D camera in, so the screen must face front then.
 * [] when there is no phone3d, it is off, or it has structural errors
 * (those are validateProject's).
 */
export function projectWarnings(p: Project, opts: { cursor?: readonly CursorSample[] } = {}): Warning[] {
  const p3 = p.phone3d;
  if (!p3 || !p3.enabled || phone3dProblems(p).length) return [];
  const gate = phone3dActive(p);
  if (!gate.active) {
    const reason = gate.reason ?? 'disabled';
    const w: Warning = { code: 'inactive', message: INACTIVE_TEXT[reason] };
    if (reason === 'frame-off') {
      const fix: EditOp[] = [{ op: 'device', frame: true }];
      const fixed = applyFix(p, fix);
      if (fixed && phone3dActive(fixed).active) w.fix = fix;
    }
    return [w];
  }
  const c = makeCtx(p, opts.cursor ?? []);
  if (!c) return [];
  const found: Found[] = [
    ...tapWarnings(c),
    ...zoomAngleWarnings(c),
    ...offCanvasWarnings(c),
    ...overlapWarnings(c),
    ...pastEndWarnings(c),
    ...poseJumpWarnings(c),
    ...tooFastWarnings(c),
    ...floorFlatWarnings(c),
  ];
  const out = found.map(({ key: _key, offCanvas: _oc, offCanvasCause: _cause, ...w }) => w as Warning);
  found.forEach((w, i) => {
    const fixer = FIXERS[w.code];
    if (!fixer) return;
    const fix = firstFix(c, w, fixer(c, w));
    if (fix) out[i].fix = fix;
  });
  const order = (w: Warning) => WARNING_CODES.indexOf(w.code);
  return out
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (a.w.at ?? -1) - (b.w.at ?? -1) || order(a.w) - order(b.w) || codePoint(a.w.transitionId ?? '', b.w.transitionId ?? '') || a.i - b.i)
    .map(({ w }) => w);
}
