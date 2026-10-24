// Auto 3D (SPEC §2.6): plans 3D shots around what happens on screen. The
// editor's Auto 3D button and the CLI's `direct` command/op call this with
// the same inputs (style, replace, scene changes, the bundle's cursor.json),
// so they make the same plan. Pure: no clock, no randomness.
//
// The rule it plans by: while something happens on screen (a tap, a typing
// run, a zoom) the phone faces the viewer; it only moves in the free time
// between. All times are OUTPUT seconds on the edited timeline.

import { focusSegmentsFor } from '../focusSegments';
import { isPhoneProject, rangesToOutput, tapsToOutput } from '../mobileProject';
import { Timeline } from '../timeline';
import type { CursorSample, Project } from '../types';
import type { EditOp } from '../agentOps';
import { ease } from './easing3d';
import { FRONT, type Pose, type ShotRecipe } from './model';
import { facing, facingOf } from './pose';
import { applyPhone3dOp, NOT_IPHONE } from './ops';
import { SHOTS, shotBase, shotKeys } from './shots';
import { phone3dProblems } from './validate';
import { offCanvasAdded, offCanvasMeter, projectWarnings, type Warning, type WarningCode } from './warnings';

export type DirectStyle = 'subtle' | 'hero' | 'bold';
export const DIRECT_STYLES: readonly DirectStyle[] = ['subtle', 'hero', 'bold'];

export interface DirectOptions {
  style: DirectStyle;
  /** Scene changes, SOURCE seconds (absent: scene changes are not used). */
  scenes?: readonly number[];
  /** true: clear the existing moves first; false: keep them (and plan around them). */
  replace: boolean;
  /** cursor.json samples (autofocus zooms are busy time, D5). */
  cursor?: readonly CursorSample[];
}

export interface PlannedShot {
  recipe: ShotRecipe;
  start: number;
  end: number;
  reason: string;
}

export interface DirectPlan {
  ops: EditOp[];
  shots: PlannedShot[];
  /** What the self-check did: re-plan rounds, shots it dropped, and retries after a refused apply (must stay 0). */
  check: { rounds: number; dropped: PlannedShot[]; retries: number };
  /** Present when the plan has no moving shot: why none fits, and what the phone does instead (one line). */
  note?: string;
}

// Busy time (§2.6 step 1)
export const TAP_BEFORE = 0.6;
export const TAP_AFTER = 0.8;
export const SETTLE_PAD = 0.3;
export const DURATION_PAD = 0.4;
export const TYPING_PAD = 0.8;
export const MERGE_GAP = 1.2;
/** Free windows shrink by this next to busy time. */
export const WINDOW_INSET = 0.15;
/** A move ends at least this long before the next busy time starts. */
export const END_GAP = 0.25;
/** While busy, the phone stays within this angle of straight on. */
export const BUSY_FACING_DEG = 12;
// Shot choice
export const INTRO_MIN_OUTPUT = 4;
export const SPIN_IN_MIN = 2.0;
export const SETTLE_MIN = 1.0;
export const INTRO_GUARD = 0.2;
/** Shortest intro (owner decision 12): when the full intro does not fit before the first tap, a settle this long
 *  or longer still opens the video in 3D. It may use the END_GAP before the first busy start. */
export const SHORT_INTRO_MIN = 0.6;
export const TURN_TO_BACK_MIN = 4.5;
export const LAYBACK_MIN = 2.4;
export const MIDDLE_EVERY = 6;
/** The phone holds still at least this long between two planned shots. */
export const SHOT_GAP = 1.0;
/** Between two middle shots in one window the phone rests this long, so even a long wait gets at most one
 *  middle shot per MIDDLE_EVERY seconds (start to start, for a hero-layback). */
export const MIDDLE_REST = MIDDLE_EVERY - SHOTS['hero-layback'].duration;
export const MOVING_CAP: Record<DirectStyle, number> = { subtle: 0.2, hero: 0.35, bold: 0.35 };
export const OUTRO_MIN = 1.5;
export const OUTRO_END_GAP = 0.1;
export const OUTRO_DURATION = 1.4;
/** Bold's resting pose: 9.4° off straight on, inside the 12° rule. */
export const BOLD_BASE: Pose = { ...FRONT, turn: -8, tilt: 5 };
/** The resting pose when no move fits at all (owner decision 12): the bold angle, so the phone still reads as 3D
 *  while staying inside the 12° rule for taps. */
export const POSED_REST: Pose = { ...BOLD_BASE };
/** Every plan on a layout that has room for it turns the phone at least this far off straight on at some moment:
 *  settle's lean (8°), any bigger shot, or the posed rest (9.4°). */
export const VISIBLE_DEG = 8;
/** Self-check: re-plan rounds before offenders are just dropped. */
export const MAX_ROUNDS = 4;
/** Warnings a planned shot must not cause (every code a move can cause). */
const SHOT_CODES: readonly WarningCode[] = ['tap-angle', 'tap-back', 'off-canvas', 'overlap', 'over-zoom', 'past-end', 'pose-jump', 'too-fast'];

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const s1 = (x: number) => `${x.toFixed(1)} s`;
const DEG = Math.PI / 180;
const COS_BUSY = Math.cos(BUSY_FACING_DEG * DEG);

interface Span {
  start: number;
  end: number;
}

interface Window {
  /** Usable part: shrunk next to busy time, and ending END_GAP before the next busy start. */
  start: number;
  end: number;
  /** The shrunk window's length (what the size thresholds read). */
  len: number;
  atZero: boolean;
  atEnd: boolean;
  quiet: boolean;
}

/** One shot before ops are made. `key` identifies it across self-check rounds. */
interface Draft {
  key: string;
  recipe: ShotRecipe;
  start: number;
  duration: number;
  ret: 'front' | 'stay';
  direction: 1 | -1;
  reason: string;
  /** Middle turn-to-back that hides this scene change (OUTPUT s): its start is set once its direction is known. */
  scene?: number;
}

/** Busy intervals merged when closer than MERGE_GAP, clipped to [0, D]. */
function mergeBusy(list: Span[], D: number): Span[] {
  const sorted = list.filter((s) => s.end > 0 && s.start < D).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start - last.end < MERGE_GAP) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out.map((s) => ({ start: Math.max(0, s.start), end: Math.min(D, s.end) }));
}

interface Inputs {
  D: number;
  busy: Span[];
  windows: Window[];
  firstTap?: number;
  scenes: number[];
  waits: Span[];
}

function readInputs(p: Project, opts: DirectOptions): Inputs {
  const tl = new Timeline(p.recording.duration, p.clips);
  const D = tl.outputDuration;
  const taps = tapsToOutput(p.taps ?? [], tl);
  const raw: Span[] = [];
  for (const t of taps) {
    const dur = t.duration ?? 0;
    if (t.kind === 'typing') raw.push({ start: t.t - TAP_BEFORE, end: t.t + dur + TYPING_PAD });
    else raw.push({ start: t.t - TAP_BEFORE, end: Math.max(t.t + TAP_AFTER, t.settleT !== undefined ? t.settleT + SETTLE_PAD : -Infinity, t.t + dur + DURATION_PAD) });
  }
  for (const z of focusSegmentsFor(p, opts.cursor ?? [])) raw.push({ start: z.inStart, end: z.outEnd });
  if (!opts.replace) for (const tr of p.phone3d?.transitions ?? []) raw.push({ start: tr.start, end: tr.end });
  const busy = mergeBusy(raw, D);
  const waits = rangesToOutput(p.waits ?? [], tl).map((w) => ({ start: w.start, end: w.end }));

  const windows: Window[] = [];
  let cursor = 0;
  const push = (gs: number, ge: number, nextBusy: number | null) => {
    const atZero = gs === 0;
    const atEnd = nextBusy === null;
    const start = atZero ? 0 : gs + WINDOW_INSET;
    const shrunkEnd = atEnd ? D : ge - WINDOW_INSET;
    const end = atEnd ? D : Math.min(shrunkEnd, nextBusy - END_GAP);
    const len = shrunkEnd - start;
    if (end - start <= 0) return;
    windows.push({ start, end, len, atZero, atEnd, quiet: waits.some((w) => w.start < shrunkEnd && w.end > start) });
  };
  for (const b of busy) {
    if (b.start > cursor) push(cursor, b.start, b.start);
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < D) push(cursor, D, null);
  const scenes = (opts.scenes ?? [])
    .map((s) => tl.outputTime(s))
    .filter((t): t is number => t !== null && t > 0 && t < D)
    .sort((a, b) => a - b);
  return { D, busy, windows, firstTap: taps[0]?.t, scenes, waits };
}

/** Free time from 0 to the first busy start (the whole take with nothing busy). */
const introRoom = (inp: Inputs) => (inp.busy.length ? inp.busy[0].start : inp.D);

/** Seconds into a turn-to-back (from its start) where the eased turn passes edge-on, for `base` and `direction`. */
export function edgeOnOffset(base: Readonly<Pose>, direction: 1 | -1, duration = SHOTS['turn-to-back'].duration): number {
  const key = shotKeys('turn-to-back', 'front').keys[0];
  const b = shotBase(base);
  const from = b.turn;
  const to = from + 180 * direction;
  // The edge-on angle (90 + 180k) strictly between from and to.
  const lo = Math.min(from, to);
  const target = 90 + 180 * Math.ceil((lo - 90) / 180 + 1e-12);
  const want = (target - from) / (to - from);
  const len = (key.frac[1] - key.frac[0]) * duration;
  let a = 0;
  let c = 1;
  for (let i = 0; i < 40; i++) {
    const m = (a + c) / 2;
    if (ease(key.easing, m, len) < want) a = m;
    else c = m;
  }
  return key.frac[0] * duration + ((a + c) / 2) * len;
}

/** The plan's shots for `excluded` keys (self-check rounds re-plan without them). */
function draftShots(opts: DirectOptions, inp: Inputs, base: Pose, excluded: ReadonlySet<string>, forced: ReadonlyMap<string, 1 | -1>): Draft[] {
  const { D, windows } = inp;
  const style = opts.style;
  const budget = MOVING_CAP[style] * D;
  const shots: Draft[] = [];
  let used = 0;
  const reserved: Span[] = [];
  const reserve = (d: Draft) => {
    shots.push(d);
    used += d.duration;
    reserved.push({ start: d.start - SHOT_GAP, end: d.start + d.duration + SHOT_GAP });
  };
  const tapNote = inp.firstTap !== undefined ? `first tap at ${s1(inp.firstTap)}` : 'no taps';

  // Intro (always allowed: it opens the video; the moving-time cap applies to the rest).
  const w0 = windows.find((w) => w.atZero);
  if (w0 && style !== 'subtle' && D >= INTRO_MIN_OUTPUT && w0.len >= SPIN_IN_MIN && !excluded.has('spin-in@0')) {
    reserve({ key: 'spin-in@0', recipe: 'spin-in', start: 0, duration: Math.min(SHOTS['spin-in'].duration, w0.len - INTRO_GUARD, w0.end), ret: 'front', direction: 1, reason: `intro; ${tapNote}` });
  } else if (w0 && w0.len >= SETTLE_MIN && !excluded.has('settle@0')) {
    reserve({ key: 'settle@0', recipe: 'settle', start: 0, duration: Math.min(SHOTS.settle.duration, w0.len - INTRO_GUARD, w0.end), ret: 'front', direction: 1, reason: `intro; ${tapNote}` });
  } else if (introRoom(inp) >= SHORT_INTRO_MIN && !excluded.has('settle@0')) {
    // Owner decision 12: a short take dense with taps still opens in 3D. The settle only leans 8° and lands on the
    // base pose when it ends, so it may run up to the first busy start (into the END_GAP), never past it.
    const duration = Math.min(SHOTS.settle.duration, Math.max(SHORT_INTRO_MIN, introRoom(inp) - END_GAP));
    reserve({ key: 'settle@0', recipe: 'settle', start: 0, duration, ret: 'front', direction: 1, reason: `intro (short, before busy time at ${s1(introRoom(inp))}); ${tapNote}` });
  }

  // Outro: a one-way hero-layback that ends just before the video does.
  const tail = windows[windows.length - 1];
  if (style !== 'subtle' && tail?.atEnd && tail.len >= OUTRO_MIN && !excluded.has('outro')) {
    const start = D - OUTRO_END_GAP - OUTRO_DURATION;
    const clear = start >= tail.start && reserved.every((r) => start >= r.end || start + OUTRO_DURATION <= r.start);
    if (clear && used + OUTRO_DURATION <= budget + 1e-9) {
      reserve({ key: 'outro', recipe: 'hero-layback', start, duration: OUTRO_DURATION, ret: 'stay', direction: 1, reason: 'outro; ends on a hero angle' });
    }
  }

  // Middle: quiet windows first, then longer ones, one shot per window per
  // round; what is left of a window on either side of its shot (MIDDLE_REST
  // away) goes back into the pool for the next round.
  if (style !== 'subtle') {
    type Free = Span & { quiet: boolean; len: number };
    const free = (a: number, b: number): Free => ({ start: a, end: b, len: b - a, quiet: inp.waits.some((w) => w.start < b && w.end > a) });
    let pool: Free[] = [];
    for (const w of windows) {
      let parts: Span[] = [{ start: w.start, end: w.end }];
      for (const r of reserved) parts = parts.flatMap((x) => (r.end <= x.start || r.start >= x.end ? [x] : [{ start: x.start, end: r.start }, { start: r.end, end: x.end }]));
      for (const x of parts) if (x.end - x.start > 0) pool.push(free(x.start, x.end));
    }
    let middle = 0;
    const maxMiddle = Math.floor(D / MIDDLE_EVERY);
    while (pool.length && middle < maxMiddle) {
      pool.sort((a, b) => Number(b.quiet) - Number(a.quiet) || b.len - a.len || a.start - b.start);
      const next: Free[] = [];
      for (const x of pool) {
        if (middle >= maxMiddle) break;
        const options: ShotRecipe[] = style === 'bold' && x.len >= TURN_TO_BACK_MIN ? ['turn-to-back', 'hero-layback'] : x.len >= LAYBACK_MIN ? ['hero-layback'] : [];
        for (const recipe of options) {
          const key = `${recipe}@${r3(x.start)}`;
          const duration = SHOTS[recipe].duration;
          if (excluded.has(key) || used + duration > budget + 1e-9 || duration > x.len) continue;
          let start = x.start + (x.len - duration) / 2;
          let lo = start;
          let hi = start;
          const why = x.quiet ? `quiet wait in ${s1(x.start)}–${s1(x.end)}` : `free ${s1(x.start)}–${s1(x.end)}`;
          let reason = `middle; ${why}`;
          let scene: number | undefined;
          if (recipe === 'turn-to-back') {
            // Scene-change wipe: a cut inside the window that the turn can pass edge-on in either direction
            // (the direction is set later by time order).
            const offs = [edgeOnOffset(base, 1, duration), edgeOnOffset(base, -1, duration)];
            scene = inp.scenes.find((t) => offs.every((o) => t - o >= x.start - 1e-9 && t - o + duration <= x.end + 1e-9));
            if (scene !== undefined) {
              const starts = offs.map((o) => scene! - o);
              lo = Math.min(...starts);
              hi = Math.max(...starts);
              start = starts[0];
              reason = `scene change at ${s1(scene)} hidden edge-on; ${why}`;
            }
          }
          reserve({ key, recipe, start, duration, ret: 'front', direction: 1, reason, ...(scene !== undefined ? { scene } : {}) });
          middle++;
          if (lo - MIDDLE_REST - x.start > 0) next.push(free(x.start, lo - MIDDLE_REST));
          if (x.end - (hi + duration + MIDDLE_REST) > 0) next.push(free(hi + duration + MIDDLE_REST, x.end));
          break;
        }
      }
      pool = next;
    }
  }

  // Directions alternate by shot index after the intro (time order). The self-check may force the other direction
  // on a shot that pushed the phone off the canvas (a lean to the left fits where a lean to the right does not).
  const ordered = shots.sort((a, b) => a.start - b.start);
  let k = 0;
  for (const d of ordered) if (d.recipe !== 'spin-in' && d.recipe !== 'settle') d.direction = k++ % 2 === 0 ? 1 : -1;
  for (const d of ordered) d.direction = forced.get(d.key) ?? d.direction;

  // Scene-change wipe: the turn passes edge-on exactly at the cut.
  for (const d of ordered) if (d.scene !== undefined) d.start = d.scene - edgeOnOffset(base, d.direction, d.duration);
  return ordered;
}

function opsFor(style: DirectStyle, base: Pose, replace: boolean, drafts: readonly Draft[]): EditOp[] {
  const ops: EditOp[] = [{ op: 'phone3d', enabled: true, pose: { ...base }, light: { preset: style === 'subtle' ? 'soft' : 'studio' }, motionBlur: { on: true } }];
  if (replace) ops.push({ op: 'clearTransitions' });
  for (const d of drafts) {
    const op: EditOp = { op: 'shot', recipe: d.recipe, at: r3(d.start), duration: r3(d.duration), direction: d.direction, intensity: 1 };
    if (d.ret === 'stay') op.return = 'stay';
    ops.push(op);
  }
  if (style === 'subtle') ops.push({ op: 'shot', recipe: 'float' });
  return ops;
}

/** The plan's ops applied to a copy; which shot made which move. Throws when an op or the result is refused. */
function tryPlan(p: Project, ops: EditOp[], drafts: readonly Draft[]): { project: Project; owner: Map<string, Draft> } {
  let cur = p;
  let n = 0;
  const owner = new Map<string, Draft>();
  let shotIndex = 0;
  for (const o of ops) {
    const before = new Set((cur.phone3d?.transitions ?? []).map((t) => t.id));
    cur = applyPhone3dOp(cur, o, () => `direct-check-${++n}`).project;
    if (o.op === 'shot' && o.recipe !== 'float') {
      const d = drafts[shotIndex++];
      for (const t of cur.phone3d?.transitions ?? []) if (!before.has(t.id)) owner.set(t.id, d);
    }
  }
  const errs = phone3dProblems(cur);
  if (errs.length) throw new Error(errs.join('; '));
  return { project: cur, owner };
}

/** Two warnings cover overlapping time (a warning without `end` is the instant `at`). */
const overlaps = (a: Warning, b: Warning) => (a.at ?? 0) <= (b.end ?? b.at ?? 0) + 1e-9 && (b.at ?? 0) <= (a.end ?? a.at ?? 0) + 1e-9;

const toShot = (d: Draft): PlannedShot => ({ recipe: d.recipe, start: r3(d.start), end: r3(d.start + d.duration), reason: d.reason });

/** A self-checked plan for one base pose. */
interface Checked {
  ops: EditOp[];
  drafts: Draft[];
  rounds: number;
  dropped: PlannedShot[];
  /** The warning codes behind each dropped shot (for the note). */
  droppedFor: Set<WarningCode>;
  retries: number;
  /** The project with no planned shot, its warnings and its per-edge overflow (what the shots are judged against). */
  baseProject: Project;
  baseline: Warning[];
  baseOverflow: ReturnType<typeof offCanvasMeter>;
}

/**
 * The plan's shots for `base`, self-checked: the ops are applied to a copy and
 * any shot that causes a warning is re-planned without (at most MAX_ROUNDS
 * rounds), then dropped. A shot blamed for off-canvas first gets one more try
 * in the other direction (the lean mirrored), since an edge is on one side.
 */
function selfChecked(p: Project, opts: DirectOptions, inp: Inputs, base: Pose): Checked {
  const excluded = new Set<string>();
  const forced = new Map<string, 1 | -1>();
  const dropped: PlannedShot[] = [];
  const droppedFor = new Set<WarningCode>();
  let retries = 0;
  let rounds = 0;
  // The project with no planned shot: the user's layout, kept moves and the style (subtle's float included, since
  // dropping shots cannot remove it). What it already has is not the shots' fault.
  const baseProject = tryPlan(p, opsFor(opts.style, base, opts.replace, []), []).project;
  const baseline = projectWarnings(baseProject, { cursor: opts.cursor });
  const baseOverflow = offCanvasMeter(baseProject);
  const preExisting = (w: Warning) => baseline.some((b) => b.code === w.code && overlaps(b, w));
  let drafts = draftShots(opts, inp, base, excluded, forced);
  for (let guard = 0; guard < 64; guard++) {
    const ops = opsFor(opts.style, base, opts.replace, drafts);
    let tried: ReturnType<typeof tryPlan>;
    try {
      tried = tryPlan(p, ops, drafts);
    } catch {
      // Must not happen (D21 keeps every pose in range); dropping the last shot keeps Auto 3D usable if it does.
      retries++;
      const last = drafts[drafts.length - 1];
      if (!last) throw new Error('Auto 3D: the plan was refused with no shots in it');
      excluded.add(last.key);
      dropped.push(toShot(last));
      drafts = drafts.slice(0, -1);
      continue;
    }
    const bad = new Map<Draft, Set<WarningCode>>();
    const blame = (d: Draft, code: WarningCode) => bad.set(d, (bad.get(d) ?? new Set<WarningCode>()).add(code));
    for (const w of projectWarnings(tried.project, { cursor: opts.cursor })) {
      if (!SHOT_CODES.includes(w.code) || w.code === 'off-canvas' || !w.transitionId || preExisting(w)) continue;
      const d = tried.owner.get(w.transitionId);
      if (d) blame(d, w.code);
    }
    // Off-canvas, moment by moment and edge by edge. The move behind an added overflow is a shot's (a shot returns
    // to the pose it started from, so kept moves after it do not change). If it ever is not, the last shot that
    // starts by then is blamed, so an added overflow can never stay in the plan.
    for (const r of offCanvasAdded(tried.project, baseOverflow)) {
      const d = (r.transitionId && tried.owner.get(r.transitionId)) || drafts.filter((x) => x.start <= r.worst).at(-1) || drafts[0];
      if (d) blame(d, 'off-canvas');
    }
    if (!bad.size) return { ops, drafts, rounds, dropped, droppedFor, retries, baseProject, baseline, baseOverflow };
    for (const [d, codes] of bad) {
      // Only an off-canvas problem can be one-sided; settle has no turn to mirror.
      if (rounds < MAX_ROUNDS && codes.size === 1 && codes.has('off-canvas') && d.recipe !== 'settle' && !forced.has(d.key)) {
        forced.set(d.key, d.direction === 1 ? -1 : 1);
        continue;
      }
      excluded.add(d.key);
      dropped.push(toShot(d));
      for (const c of codes) droppedFor.add(c);
    }
    rounds++;
    drafts = rounds <= MAX_ROUNDS ? draftShots(opts, inp, base, excluded, forced) : drafts.filter((d) => !bad.has(d));
  }
  throw new Error('Auto 3D: the self-check did not settle');
}

/** How far `pose` is off straight on (degrees, camera at eye level). */
const offFront = (pose: Pose) => Math.acos(Math.min(1, facingOf(pose, 0))) / DEG;

/**
 * Whether the posed rest can replace the style's base pose when no shot fits:
 * it must stay inside the 12° busy rule at every moment (float and camera
 * height included) and add no warning and no overflow past any edge over the
 * project as it is. Returns the reason it cannot, or null when it can.
 */
function posedRestRefusal(p: Project, opts: DirectOptions, inp: Inputs, checked: Checked): string | null {
  const posed = tryPlan(p, opsFor(opts.style, POSED_REST, opts.replace, []), []).project;
  const p3 = posed.phone3d!;
  const n = Math.max(1, Math.ceil(inp.D * 30));
  for (let k = 0; k <= n; k++) if (facing(p3, (inp.D * k) / n) < COS_BUSY) return `turn the phone more than ${BUSY_FACING_DEG}° off front during taps`;
  if (offCanvasAdded(posed, checked.baseOverflow).length) return 'push the phone further off the canvas';
  const known = (w: Warning) => checked.baseline.some((b) => b.code === w.code && overlaps(b, w));
  const added = projectWarnings(posed, { cursor: opts.cursor }).filter((w) => !known(w));
  return added.length ? `add a ${added[0].code} warning` : null;
}

/** Why no moving shot fits (one clause per cause), for DirectPlan.note. */
function noShotCauses(opts: DirectOptions, inp: Inputs, checked: Checked): string[] {
  const out: string[] = [];
  const room = introRoom(inp);
  if (room < SHORT_INTRO_MIN) {
    out.push(room <= 0 ? 'the phone must face front from 0.0 s (a tap, zoom or kept move starts there), so no intro fits' : `the phone must face front from ${s1(room)} (the first tap, zoom or kept move), under the ${SHORT_INTRO_MIN} s an intro needs`);
  }
  if (opts.style === 'subtle') out.push('subtle plans no moves after the intro');
  else {
    const free = inp.windows.filter((w) => !w.atZero || room >= SHORT_INTRO_MIN);
    const longest = Math.max(0, ...free.map((w) => w.len));
    out.push(free.length ? `the longest free gap is ${s1(longest)} (a middle move needs ${LAYBACK_MIN} s, the closing move ${OUTRO_MIN} s at the end)` : 'there is no free time between taps, zooms and kept moves');
  }
  if (checked.dropped.length) {
    const n = checked.dropped.length;
    out.push(`the self-check dropped ${n} shot${n === 1 ? '' : 's'} that would cause ${[...checked.droppedFor].join(', ')} warnings`);
  }
  return out;
}

/**
 * The Auto 3D plan for `p` (§2.6): busy time (taps, typing, zooms, and kept
 * moves) → free windows → intro, outro and middle shots within the density
 * caps → a scene-change wipe → ops, in this order: `phone3d` (on, base pose,
 * lighting, motion blur), `clearTransitions` when replacing, one `shot` per
 * shot in time order (float last for subtle). Then a self-check: the ops are
 * applied to a copy and any shot that causes a warning is re-planned without
 * (at most MAX_ROUNDS rounds), then dropped, so a plan adds no warnings. A
 * warning the project already has with no shot planned (for example a phone
 * the user scaled past the canvas edge, or the float bobbing a kept pose past
 * it) is not blamed on the shots. Off-canvas is judged moment by moment and
 * edge by edge, not by warning span (one off-canvas warning may span most of
 * the take): a shot is blamed wherever the phone pokes further past an edge
 * than it does without the shots at the same time.
 *
 * Owner decision 12: Auto 3D always gives a visible 3D result. A take too
 * dense with taps for the full intro gets a short settle (≥ SHORT_INTRO_MIN s)
 * that lands before the first busy start; when no moving shot fits at all and
 * there are no kept moves, the phone rests at POSED_REST (inside the 12° rule)
 * instead of straight on. A plan with no moving shot always says why in
 * `note`.
 */
export function planDirect(p: Project, opts: DirectOptions): DirectPlan {
  if (!isPhoneProject(p)) throw new Error(NOT_IPHONE);
  const inp = readInputs(p, opts);
  const styleBase = opts.style === 'bold' ? { ...BOLD_BASE } : { ...FRONT };
  const checked = selfChecked(p, opts, inp, styleBase);
  let ops = checked.ops;
  let note: string | undefined;
  if (!checked.drafts.length) {
    const causes = noShotCauses(opts, inp, checked);
    const kept = (checked.baseProject.phone3d?.transitions.length ?? 0) > 0;
    let rest: string;
    if (kept) rest = 'Your own moves stay as they are.';
    else if (offFront(styleBase) >= VISIBLE_DEG) rest = `The phone rests at the ${opts.style} angle (${offFront(styleBase).toFixed(1)}° off front).`;
    else {
      const refusal = posedRestRefusal(p, opts, inp, checked);
      if (refusal) rest = `The phone stays straight on: a posed angle would ${refusal}.`;
      else {
        ops = opsFor(opts.style, POSED_REST, opts.replace, []);
        rest = `The phone rests at a posed angle instead (${offFront(POSED_REST).toFixed(1)}° off front, inside the ${BUSY_FACING_DEG}° rule for taps).`;
      }
    }
    note = `No moving shot fits: ${causes.join('; ')}. ${rest}`;
  }
  const shots = [...checked.drafts.map(toShot), ...(opts.style === 'subtle' ? [{ recipe: 'float' as const, start: 0, end: r3(inp.D), reason: 'subtle; idle float' }] : [])];
  return { ops, shots, check: { rounds: checked.rounds, dropped: checked.dropped, retries: checked.retries }, ...(note ? { note } : {}) };
}
