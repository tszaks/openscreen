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
import { floatSampler, facingOf, lerpPose, moveProgress, poseDelta, poseRotation, poseTargetAt, resolveStarts, rotationAngle, SPEED_STEP } from './pose';
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

export const WARNING_CODES = ['inactive', 'tap-angle', 'tap-back', 'off-canvas', 'overlap', 'over-zoom', 'past-end', 'pose-jump', 'too-fast', 'floor-flat'] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

/** A tap must see the screen within this angle of straight on. */
export const TAP_ANGLE_DEG = 35;
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
type Found = Warning & { key: string };

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
    let minFacing = Infinity;
    let worst = tap.t;
    for (let k = 0; k <= n; k++) {
      const tt = a + ((b - a) * k) / n;
      const f = facingOf(sample(tt), elev);
      if (f < minFacing) {
        minFacing = f;
        worst = tt;
      }
    }
    out.push({ tapId: tap.id, t: tap.t, a, b, worst, minFacing });
  }
  return out;
}

function tapWarnings(c: Ctx): Found[] {
  const out: Found[] = [];
  for (const chk of tapChecks(c)) {
    if (chk.minFacing >= COS_TAP) continue;
    const tr = culprit(c.p3.transitions, chk.worst);
    const deg = Math.acos(Math.max(-1, Math.min(1, chk.minFacing))) / DEG;
    const back = chk.minFacing < 0;
    out.push({
      code: back ? 'tap-back' : 'tap-angle',
      key: `tap:${chk.tapId}`,
      message: back
        ? `The phone shows its back during the tap at ${s2(chk.t)}, so the tap is not visible`
        : `The phone is ${Math.round(deg)}° off front during the tap at ${s2(chk.t)} (keep it within ${TAP_ANGLE_DEG}°)`,
      at: r3(chk.t),
      ...(tr ? { transitionId: tr.id } : {}),
    });
  }
  return out;
}

/** Fix candidates for a tap warning, in order of preference. */
function tapFixes(c: Ctx, w: Found): EditOp[][] {
  const chk = tapChecks(c).find((x) => `tap:${x.tapId}` === w.key);
  if (!chk) return [];
  const list = c.p3.transitions;
  const tr = culprit(list, chk.worst);
  const target = poseTargetAt(c.p3, chk.t).pose;
  const face: EditOp = { op: 'setPose', at: r3(chk.t), turn: 360 * Math.round(target.turn / 360), tilt: 0 };
  const out: EditOp[][] = [];
  const inFlight = tr && tr.end > chk.a && tr.start <= chk.worst;
  if (inFlight && tr.start <= chk.a - MIN_TRANSITION) {
    const pull: EditOp = { op: 'editTransition', id: tr.id, end: floor3(chk.a) };
    out.push([pull], [face], [pull, face]);
  } else out.push([face]);
  // A move that starts inside the window: start it after the window instead.
  if (inFlight && tr.start > chk.a - MIN_TRANSITION) out.push([{ op: 'editTransition', id: tr.id, by: ceil3(chk.b - tr.start) }]);
  return out;
}

// ---------------------------------------------------------------------------
// Off canvas

interface Run {
  at: number;
  end: number;
  worst: number;
  over: number;
}

/** How far the body pokes out of the canvas at each sample time (px; ≤ 0 = inside). */
function overflowAt(s: Scene3D, t: number): number {
  const b = bodyBounds(s, t);
  if (!b) return 0;
  const W = s.canvas.width;
  const H = s.canvas.height;
  return Math.max(-b.x, -b.y, b.x + b.w - W, b.y + b.h - H);
}

function offCanvasTimes(c: Ctx): number[] {
  const n = Math.max(1, Math.ceil(c.D * OFF_CANVAS_HZ));
  const ts = Array.from({ length: n + 1 }, (_, k) => (c.D * k) / n);
  for (const tr of c.p3.transitions) for (const t of [tr.start, tr.end]) if (t >= 0 && t <= c.D) ts.push(t);
  return [...new Set(ts)].sort((a, b) => a - b);
}

function offCanvasRuns(c: Ctx, times = offCanvasTimes(c)): Run[] {
  const margin = OFF_CANVAS_FRACTION * Math.min(c.scene.canvas.width, c.scene.canvas.height);
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (const t of times) {
    const over = overflowAt(c.scene, t);
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

function offCanvasWarnings(c: Ctx): Found[] {
  return offCanvasRuns(c).map((r) => {
    const tr = culprit(c.p3.transitions, r.worst);
    return {
      code: 'off-canvas' as const,
      key: 'off-canvas',
      message: `The phone goes ${Math.round(r.over)} px off the canvas ${r.end > r.at ? `from ${s2(r.at)} to ${s2(r.end)}` : `at ${s2(r.at)}`}`,
      at: r3(r.at),
      end: r3(r.end),
      ...(tr ? { transitionId: tr.id } : {}),
    };
  });
}

/** A setPose that pulls the keyframe behind the worst moment back onto the canvas (clamped x/y/size). */
function offCanvasFixes(c: Ctx, w: Found): EditOp[][] {
  const run = offCanvasRuns(c).find((r) => r3(r.at) === w.at);
  if (!run) return [];
  const W = c.scene.canvas.width;
  const H = c.scene.canvas.height;
  const margin = OFF_CANVAS_FRACTION * Math.min(W, H);
  const target = poseTargetAt(c.p3, run.worst);
  const start: Pose = { ...target.pose };
  const pose: Pose = { ...start };
  const times = offCanvasTimes(c).filter((t) => t >= run.at - 1e-9 && t <= run.end + 1e-9);
  const opFor = (q: Pose): EditOp => {
    const op: EditOp = { op: 'setPose', at: r3(run.worst) };
    for (const k of ['x', 'y', 'size'] as const) if (q[k] !== start[k]) op[k] = Math.round(q[k] * 10000) / 10000;
    return op;
  };
  const clampKey = (k: 'x' | 'y' | 'size', v: number) => Math.min(POSE_RANGE[k][1], Math.max(POSE_RANGE[k][0], v));
  for (let iter = 0; iter < 8; iter++) {
    const fixed = applyFix(c.p, [opFor(pose)]);
    if (!fixed) return [];
    const fc = makeCtx(fixed, c.cursor);
    if (!fc) return [];
    let worst = -Infinity;
    let wt = run.worst;
    for (const t of times) {
      const o = overflowAt(fc.scene, t);
      if (o > worst) {
        worst = o;
        wt = t;
      }
    }
    if (worst <= margin * 0.5) return [[opFor(pose)]];
    const b = bodyBounds(fc.scene, wt)!;
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

function overZoomWarnings(c: Ctx): Found[] {
  const zooms = focusSegmentsFor(c.p, c.cursor);
  const out: Found[] = [];
  for (const tr of c.p3.transitions) {
    const hits = zooms.filter((z) => tr.start < z.outEnd && tr.end > z.inStart);
    if (!hits.length) continue;
    const z = hits[0];
    out.push({
      code: 'over-zoom',
      key: `move:${tr.id}`,
      message: `Move ${tr.id} (${s2(tr.start)}–${s2(tr.end)}) runs during a zoom (${s2(z.inStart)}–${s2(z.outEnd)})${hits.length > 1 ? ` and ${hits.length - 1} more` : ''}`,
      at: r3(Math.max(tr.start, z.inStart)),
      end: r3(Math.min(tr.end, z.outEnd)),
      transitionId: tr.id,
    });
  }
  return out;
}

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

function tooFastWarnings(c: Ctx): Found[] {
  const limit = c.p3.motionBlur.on ? TOO_FAST_DEG_S : TOO_FAST_NO_BLUR_DEG_S;
  const sample = floatSampler(c.p3);
  const speed = (t: number) => rotationAngle(poseRotation(sample(t - SPEED_STEP)), poseRotation(sample(t + SPEED_STEP))) / (2 * SPEED_STEP);
  const out: Found[] = [];
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
  'off-canvas': offCanvasWarnings,
  overlap: overlapWarnings,
  'over-zoom': overZoomWarnings,
  'past-end': pastEndWarnings,
  'pose-jump': poseJumpWarnings,
  'too-fast': tooFastWarnings,
  'floor-flat': floorFlatWarnings,
};

/** The warning is gone from `fixed` (tap-angle and tap-back count as the same issue). */
function cleared(w: Found, fixed: Project, cursor: readonly CursorSample[]): boolean {
  const c = makeCtx(fixed, cursor);
  if (!c) return false;
  const again = CHECKS[w.code]!(c);
  if (w.code === 'off-canvas') return !again.some((x) => x.at! <= w.end! + 1e-9 && x.end! >= w.at! - 1e-9);
  return !again.some((x) => x.key === w.key && (x.code === w.code || w.key.startsWith('tap:')));
}

/** The first candidate fix that clears `w`. */
function firstFix(c: Ctx, w: Found, candidates: EditOp[][]): EditOp[] | undefined {
  for (const ops of candidates) {
    const fixed = applyFix(c.p, ops);
    if (fixed && cleared(w, fixed, c.cursor)) return ops;
  }
  return undefined;
}

const FIXERS: Partial<Record<WarningCode, (c: Ctx, w: Found) => EditOp[][]>> = {
  'tap-angle': tapFixes,
  'tap-back': tapFixes,
  'off-canvas': offCanvasFixes,
  overlap: overlapFixes,
  'past-end': pastEndFixes,
};

// ---------------------------------------------------------------------------

/**
 * Every warning for `p`'s 3D phone, sorted by time. `cursor` is the
 * bundle's cursor.json samples (zooms from autofocus need them, D5): pass
 * the same samples the editor has, so the CLI and the editor agree.
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
    ...offCanvasWarnings(c),
    ...overlapWarnings(c),
    ...overZoomWarnings(c),
    ...pastEndWarnings(c),
    ...poseJumpWarnings(c),
    ...tooFastWarnings(c),
    ...floorFlatWarnings(c),
  ];
  const out = found.map(({ key: _key, ...w }) => w as Warning);
  found.forEach((w, i) => {
    const fixer = FIXERS[w.code];
    if (!fixer) return;
    const fix = firstFix(c, w, fixer(c, w));
    if (fix) out[i].fix = fix;
  });
  const order = (w: Warning) => WARNING_CODES.indexOf(w.code);
  return out
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (a.w.at ?? -1) - (b.w.at ?? -1) || order(a.w) - order(b.w) || (a.w.transitionId ?? '').localeCompare(b.w.transitionId ?? '', 'en') || a.i - b.i)
    .map(({ w }) => w);
}
