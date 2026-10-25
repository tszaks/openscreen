// Auto 3D (SPEC §2.6): plans 3D shots around what happens on screen. The
// editor's Auto 3D button and the CLI's `direct` command/op call this with
// the same inputs (style, replace, scene changes, the bundle's cursor.json),
// so they make the same plan. Pure: no clock, no randomness.
//
// The rule it plans by: while something happens on screen (a tap, a typing
// run) the phone faces the viewer; it only moves in the free time between.
// Zooms are not busy time: they do not play while the phone is 3D
// (compositor.ts), so they can never clash with a move. All times are OUTPUT
// seconds on the edited timeline.

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
  /** cursor.json samples: the self-check's warnings use them, as the editor's do (D5). */
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
  /** Present when the style's own moves do not fit (no moving shot at all, or hero with no turning shot): why,
   *  and what the phone does instead (one line). */
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
/** The resting pose when the style's own moves do not fit (owner decision 12): the bold angle, so the phone still
 *  reads as 3D while staying inside the 12° rule for taps. */
export const POSED_REST: Pose = { ...BOLD_BASE };
/** Every plan on a layout that has room for it turns the phone at least this far off straight on: settle's lean
 *  (8°, subtle), a turning shot, or the posed rest (9.4°, held all take). */
export const VISIBLE_DEG = 8;
/** Self-check: re-plan rounds before offenders are just dropped. */
export const MAX_ROUNDS = 4;
/** Warnings a planned shot must not cause (every code a move can cause). */
const SHOT_CODES: readonly WarningCode[] = ['tap-angle', 'tap-back', 'off-canvas', 'overlap', 'past-end', 'pose-jump', 'too-fast'];

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
  // The first key's own turn (the three-quarter back view it eases to), not an assumed 180.
  const to = from + (key.to.turn ?? 0) * direction;
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

/** `x` seconds, with as many decimals (1 to 3) as it takes to read as under `limit`, so a stated shortfall never
 *  rounds up to the limit it misses (1.95 s under 2.0 s, not "2.0 s"). */
function below(x: number, limit: number): string {
  const v = Math.max(0, x);
  for (const d of [1, 2]) {
    const s = v.toFixed(d);
    if (Number(s) < limit) return `${s} s`;
  }
  return `${(Math.floor(v * 1000) / 1000).toFixed(3)} s`;
}

/**
 * Why draftShots planned no shot of a kind: one clause from the gate that
 * refused it, for DirectPlan.note. Absent when one was planned, or when the
 * only candidates were excluded (the note reports those as dropped shots).
 */
export interface Misses {
  /** No spin-in (hero and bold). */
  spinIn?: string;
  /** No intro at all. */
  intro?: string;
  /** No middle shot (hero and bold). */
  middle?: string;
  /** No closing move (hero and bold). */
  outro?: string;
}

/** The plan's shots for `excluded` keys (self-check rounds re-plan without them), and why the missing kinds are missing. */
function draftShots(opts: DirectOptions, inp: Inputs, base: Pose, excluded: ReadonlySet<string>, forced: ReadonlyMap<string, 1 | -1>): { drafts: Draft[]; misses: Misses } {
  const { D, windows } = inp;
  const style = opts.style;
  const budget = MOVING_CAP[style] * D;
  const shots: Draft[] = [];
  const misses: Misses = {};
  let used = 0;
  const reserved: Span[] = [];
  const reserve = (d: Draft) => {
    shots.push(d);
    used += d.duration;
    reserved.push({ start: d.start - SHOT_GAP, end: d.start + d.duration + SHOT_GAP });
  };
  /** The moving-time cap refused a `what` of `duration` seconds: the cap itself is too small, or the other planned
   *  shots use it up. */
  const overCap = (what: string, duration: number) => {
    const cap = `${Math.round(MOVING_CAP[style] * 100)}% of the take`;
    const left = budget - used;
    if (budget < duration) return `${what} takes ${r3(duration)} s, more than the moving-time cap (${cap}, ${below(budget, duration)})`;
    if (left <= 1e-9) return `${what} takes ${r3(duration)} s, and the other planned shots already use all of the moving-time cap (${cap}, ${s1(budget)})`;
    return `${what} takes ${r3(duration)} s, more than the ${below(left, duration)} left of the moving-time cap (${cap}, ${s1(budget)}) after the other planned shots`;
  };
  const tapNote = inp.firstTap !== undefined ? `first tap at ${s1(inp.firstTap)}` : 'no taps';

  // Intro (always allowed: it opens the video; the moving-time cap applies to the rest).
  const room = introRoom(inp);
  const w0 = windows.find((w) => w.atZero);
  if (style !== 'subtle') {
    // The first free window's shrunk length (what the spin-in gate reads); a window too short to keep has room - inset.
    const firstLen = w0 ? w0.len : Math.max(0, room - WINDOW_INSET);
    if (D < INTRO_MIN_OUTPUT) misses.spinIn = `the take is ${below(D, INTRO_MIN_OUTPUT)}, under the ${INTRO_MIN_OUTPUT} s a spin-in needs`;
    else if (firstLen < SPIN_IN_MIN) misses.spinIn = `the phone must face front from ${s1(room)}, which leaves a spin-in ${below(firstLen, SPIN_IN_MIN)}, under the ${SPIN_IN_MIN.toFixed(1)} s it needs`;
  }
  if (w0 && style !== 'subtle' && D >= INTRO_MIN_OUTPUT && w0.len >= SPIN_IN_MIN && !excluded.has('spin-in@0')) {
    reserve({ key: 'spin-in@0', recipe: 'spin-in', start: 0, duration: Math.min(SHOTS['spin-in'].duration, w0.len - INTRO_GUARD, w0.end), ret: 'front', direction: 1, reason: `intro; ${tapNote}` });
  } else if (w0 && w0.len >= SETTLE_MIN && !excluded.has('settle@0')) {
    reserve({ key: 'settle@0', recipe: 'settle', start: 0, duration: Math.min(SHOTS.settle.duration, w0.len - INTRO_GUARD, w0.end), ret: 'front', direction: 1, reason: `intro; ${tapNote}` });
  } else if (room >= SHORT_INTRO_MIN && !excluded.has('settle@0')) {
    // Owner decision 12: a short take dense with taps still opens in 3D. The settle only leans 8° and lands on the
    // base pose when it ends, so it may run up to the first busy start (into the END_GAP), never past it.
    const duration = Math.min(SHOTS.settle.duration, Math.max(SHORT_INTRO_MIN, room - END_GAP));
    reserve({ key: 'settle@0', recipe: 'settle', start: 0, duration, ret: 'front', direction: 1, reason: `intro (short, before busy time at ${s1(room)}); ${tapNote}` });
  } else if (room < SHORT_INTRO_MIN) {
    misses.intro =
      room <= 0
        ? 'the phone must face front from 0.0 s (a tap or kept move starts there), so no intro fits'
        : `the phone must face front from ${below(room, SHORT_INTRO_MIN)} (the first tap or kept move), under the ${SHORT_INTRO_MIN} s an intro needs`;
  }

  // Outro: a one-way hero-layback that ends just before the video does.
  if (style !== 'subtle') {
    const tail = windows[windows.length - 1];
    const lastBusyEnd = inp.busy.length ? inp.busy[inp.busy.length - 1].end : 0;
    const endLen = tail?.atEnd ? tail.len : Math.max(0, D - lastBusyEnd - WINDOW_INSET);
    if (!tail?.atEnd || tail.len < OUTRO_MIN) {
      misses.outro = `the free time at the end is ${below(endLen, OUTRO_MIN)}, under the ${OUTRO_MIN} s the closing move needs`;
    } else if (!excluded.has('outro')) {
      const start = D - OUTRO_END_GAP - OUTRO_DURATION;
      const inTail = start >= tail.start;
      const clash = shots.find((d) => !(start >= d.start + d.duration + SHOT_GAP || start + OUTRO_DURATION <= d.start - SHOT_GAP));
      const fits = used + OUTRO_DURATION <= budget + 1e-9;
      if (inTail && !clash && fits) {
        reserve({ key: 'outro', recipe: 'hero-layback', start, duration: OUTRO_DURATION, ret: 'stay', direction: 1, reason: 'outro; ends on a hero angle' });
      } else {
        const why: string[] = [];
        if (!inTail) why.push(`the closing move would start at ${s1(start)}, before the free time at the end (from ${s1(tail.start)})`);
        if (clash) why.push(`the closing move would start ${below(start - (clash.start + clash.duration), SHOT_GAP)} after the intro ends, under the ${SHOT_GAP.toFixed(1)} s rest between shots`);
        if (!fits) why.push(overCap('the closing move', OUTRO_DURATION));
        misses.outro = why.join(', and ');
      }
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
    /** The longest free gap a middle shot could use (first round: before any middle shot), and the shortest middle
     *  shot the moving-time cap refused. */
    const longest = Math.max(0, ...pool.map((x) => x.len));
    let capped: number | undefined;
    while (pool.length && middle < maxMiddle) {
      pool.sort((a, b) => Number(b.quiet) - Number(a.quiet) || b.len - a.len || a.start - b.start);
      const next: Free[] = [];
      for (const x of pool) {
        if (middle >= maxMiddle) break;
        const options: ShotRecipe[] = style === 'bold' && x.len >= TURN_TO_BACK_MIN ? ['turn-to-back', 'hero-layback'] : x.len >= LAYBACK_MIN ? ['hero-layback'] : [];
        for (const recipe of options) {
          const key = `${recipe}@${r3(x.start)}`;
          const duration = SHOTS[recipe].duration;
          if (excluded.has(key) || duration > x.len) continue;
          if (used + duration > budget + 1e-9) {
            capped = Math.min(capped ?? Infinity, duration);
            continue;
          }
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
    if (!middle) {
      if (maxMiddle === 0) misses.middle = `a middle move needs a take of ${MIDDLE_EVERY} s or more (this one is ${below(D, MIDDLE_EVERY)})`;
      else if (capped !== undefined) misses.middle = overCap('a middle move', capped);
      else if (longest < LAYBACK_MIN) {
        const beside = shots.length ? ` beside the planned shots (with the ${SHOT_GAP.toFixed(1)} s rest around each)` : '';
        misses.middle =
          longest > 0
            ? `the longest free gap${beside} is ${below(longest, LAYBACK_MIN)}, under the ${LAYBACK_MIN} s a middle move needs`
            : `no free time is left${beside} for a middle move`;
      }
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
  return { drafts: ordered, misses };
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
  /** Why the missing kinds of shot are missing, from the draftShots run that made `drafts`. */
  misses: Misses;
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
  let { drafts, misses } = draftShots(opts, inp, base, excluded, forced);
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
    if (!bad.size) return { ops, drafts, misses, rounds, dropped, droppedFor, retries, baseProject, baseline, baseOverflow };
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
    if (rounds <= MAX_ROUNDS) ({ drafts, misses } = draftShots(opts, inp, base, excluded, forced));
    else drafts = drafts.filter((d) => !bad.has(d));
  }
  throw new Error('Auto 3D: the self-check did not settle');
}

/** How far `pose` is off straight on (degrees, camera at eye level). */
const offFront = (pose: Pose) => Math.acos(Math.min(1, facingOf(pose, 0))) / DEG;

/** Shots that turn the phone to a hero angle (what makes hero read as 3D; settle only leans 8° for a moment). */
const TURNING: readonly ShotRecipe[] = ['spin-in', 'hero-layback', 'turn-to-back'];

/** Whether the style's own moves are in `drafts`: a turning shot for hero, any shot for subtle and bold. */
const ownMovesFit = (style: DirectStyle, drafts: Draft[]) => (style === 'hero' ? drafts.some((d) => TURNING.includes(d.recipe)) : drafts.length > 0);

/**
 * The style could not use its own moves, so the posed rest stands in: hero
 * (base straight on) with no turning shot, or subtle with no shot at all.
 * Never with kept moves (they are the user's 3D), and not for bold (its base
 * is already posed).
 */
function needsPosedRest(opts: DirectOptions, styleBase: Pose, checked: Checked): boolean {
  if ((checked.baseProject.phone3d?.transitions.length ?? 0) > 0 || offFront(styleBase) >= VISIBLE_DEG) return false;
  return !ownMovesFit(opts.style, checked.drafts);
}

/**
 * Whether the posed plan can replace the style's plan: during busy time it
 * stays inside the 12° rule (float and camera height included), and over the
 * style's base project without shots it adds no warning and pushes the phone
 * no further past any edge. Returns the reason it cannot, or null when it can.
 */
function posedRestRefusal(p: Project, opts: DirectOptions, inp: Inputs, styled: Checked, posed: Checked): string | null {
  const project = tryPlan(p, posed.ops, posed.drafts).project;
  const p3 = project.phone3d!;
  for (const b of inp.busy) {
    const n = Math.max(1, Math.ceil((b.end - b.start) * 60));
    for (let k = 0; k <= n; k++) if (facing(p3, b.start + ((b.end - b.start) * k) / n) < COS_BUSY) return `turn the phone more than ${BUSY_FACING_DEG}° off front during taps`;
  }
  if (offCanvasAdded(project, styled.baseOverflow).length) return 'push the phone further off the canvas';
  const known = (w: Warning) => styled.baseline.some((b) => b.code === w.code && overlaps(b, w));
  const added = projectWarnings(project, { cursor: opts.cursor }).filter((w) => !known(w));
  return added.length ? `add a ${added[0].code} warning` : null;
}

/**
 * Why the style's own moves do not fit (one clause per cause), for
 * DirectPlan.note. Each clause comes from the draftShots gate that refused the
 * shot (Misses), or from the self-check that dropped it. `turning`: only
 * turning shots are missing (hero has a settle), so the intro clause is about
 * the spin-in.
 */
function missingCauses(opts: DirectOptions, inp: Inputs, checked: Checked, turning: boolean): string[] {
  const { misses } = checked;
  const out: string[] = [];
  const intro = turning ? misses.spinIn : misses.intro;
  if (intro) out.push(intro);
  if (opts.style === 'subtle') out.push('subtle plans no moves after the intro');
  else if (!inp.windows.length) out.push('there is no free time between taps and kept moves');
  else for (const c of [misses.middle, misses.outro]) if (c) out.push(c);
  if (checked.dropped.length) {
    const n = checked.dropped.length;
    out.push(`the self-check dropped ${n} shot${n === 1 ? '' : 's'} that would cause ${[...checked.droppedFor].join(', ')} warnings`);
  }
  return out;
}

/**
 * The Auto 3D plan for `p` (§2.6): busy time (taps, typing and kept moves;
 * zooms do not play in 3D, so they are not busy) → free windows → intro, outro and middle shots within the density
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
 * that lands before the first busy start. A settle alone is only a quick 8°
 * lean (its spring lands in about 0.2 s), so when hero fits no turning shot,
 * or subtle fits no shot at all, and there are no kept moves, the phone rests
 * at POSED_REST (inside the 12° rule) instead of straight on, after a check
 * that this adds no warning and no edge overflow. Every plan whose own moves
 * still do not fit (and so every plan with no moving shot) says why in `note`,
 * from the self-check run whose shots it returns. When the shots planned on
 * POSED_REST do include the style's own moves, the plan has no note.
 */
export function planDirect(p: Project, opts: DirectOptions): DirectPlan {
  if (!isPhoneProject(p)) throw new Error(NOT_IPHONE);
  const inp = readInputs(p, opts);
  const styleBase = opts.style === 'bold' ? { ...BOLD_BASE } : { ...FRONT };
  const styled = selfChecked(p, opts, inp, styleBase);
  let checked = styled;
  let rest: string | undefined;
  if (needsPosedRest(opts, styleBase, styled)) {
    const posed = selfChecked(p, opts, inp, POSED_REST);
    const refusal = posedRestRefusal(p, opts, inp, styled, posed);
    if (refusal) rest = `The phone stays straight on: a posed angle would ${refusal}.`;
    else {
      checked = posed;
      // The posed base can fit moves the straight-on base could not (a shot that pushed the phone off the canvas from
      // straight on may not from the posed angle). Then the style's own moves fit and there is nothing to explain.
      if (!ownMovesFit(opts.style, posed.drafts)) rest = `The phone rests at a posed angle instead (${offFront(POSED_REST).toFixed(1)}° off front, inside the ${BUSY_FACING_DEG}° rule for taps).`;
    }
  } else if (!styled.drafts.length) {
    const kept = (styled.baseProject.phone3d?.transitions.length ?? 0) > 0;
    rest = kept ? 'Your own moves stay as they are.' : `The phone rests at the ${opts.style} angle (${offFront(styleBase).toFixed(1)}° off front).`;
  }
  // A note whenever the style's own moves did not fit: no moving shot at all, or (hero) no turning shot. It is built
  // from the run whose shots the plan returns, so its reasons and its dropped count describe this plan.
  const someMove = checked.drafts.length > 0;
  const note = rest ? `${someMove ? 'No turning shot fits' : 'No moving shot fits'}: ${missingCauses(opts, inp, checked, someMove).join('; ')}. ${rest}` : undefined;
  const shots = [...checked.drafts.map(toShot), ...(opts.style === 'subtle' ? [{ recipe: 'float' as const, start: 0, end: r3(inp.D), reason: 'subtle; idle float' }] : [])];
  return { ops: checked.ops, shots, check: { rounds: checked.rounds, dropped: checked.dropped, retries: checked.retries }, ...(note ? { note } : {}) };
}
