// Auto 3D (SPEC §2.6). The plan is deterministic, adds no warnings, keeps
// the phone facing the viewer whenever something happens on screen, and
// stays inside the density caps; a property test runs 500 seeded projects.
import { describe, expect, it } from 'vitest';
import { applyOps, type EditOp } from '../src/shared/agentOps';
import { focusSegmentsFor } from '../src/shared/focusSegments';
import { tapsToOutput } from '../src/shared/mobileProject';
import { BIG_EVERY, BIG_GAP, BIG_MOVES, BOLD_BASE, BUSY_FACING_DEG, edgeOnOffset, LONG_TAKE, MAX_TURN_TO_BACKS, MIDDLE_EVERY, MOVING_CAP, nearestAllowed, planDirect, POSED_REST, SHORT_INTRO_MIN, VISIBLE_DEG, type DirectOptions, type DirectStyle } from '../src/shared/phone3d/direct';
import { FRONT, type Phone3D } from '../src/shared/phone3d/model';
import { facing, poseInRange } from '../src/shared/phone3d/pose';
import { bodyBounds, scene3d } from '../src/shared/phone3d/projection';
import { OFF_CANVAS_FRACTION, projectWarnings } from '../src/shared/phone3d/warnings';
import { Timeline } from '../src/shared/timeline';
import type { CursorSample, Project } from '../src/shared/types';
import type { TapSuggestion } from '../src/shared/taps';
import { loadGoldenFixture } from './helpers/compositorHarness';
import { lcg, phoneProject, move, with3d } from './helpers/phone3dFixtures';

const STYLES: DirectStyle[] = ['subtle', 'hero', 'bold'];
const COS_BUSY = Math.cos((BUSY_FACING_DEG * Math.PI) / 180);

function tap(t: number, extra: Partial<TapSuggestion> = {}, i = 0): TapSuggestion {
  return { id: `tap-${i}-${t}`, t, x: 0.5, y: 0.5, kind: 'tap', confidence: 1, ...extra };
}

function take(duration: number, taps: TapSuggestion[] = [], waits: { start: number; end: number }[] = [], presetId?: string): Project {
  const p = phoneProject({ duration, ...(presetId ? { presetId } : {}) });
  p.taps = taps;
  p.waits = waits;
  p.tapsAnalyzed = true;
  return p;
}

/**
 * A plan note never contradicts itself: every stated shortfall is under the
 * limit it names, the cap it quotes is the style's share of the take, the take
 * length rules match the take, and a free gap long enough for a middle move is
 * never given as the reason one is missing.
 */
function expectNoteConsistent(note: string, D: number, style: DirectStyle, label: string): void {
  const at = `${label}: ${note}`;
  for (const m of note.matchAll(/([\d.]+) s, under the ([\d.]+) s/g)) expect(Number(m[1]), at).toBeLessThan(Number(m[2]));
  for (const m of note.matchAll(/takes ([\d.]+) s, more than the (?:([\d.]+) s left of the )?moving-time cap \((\d+)% of the take, ([\d.]+) s\)/g)) {
    expect(Number(m[2] ?? m[4]), at).toBeLessThan(Number(m[1]));
    expect(Number(m[3]), at).toBe(Math.round(MOVING_CAP[style] * 100));
    expect(Math.abs(Number(m[4]) - MOVING_CAP[style] * D), at).toBeLessThanOrEqual(0.05 + 1e-9);
  }
  const spinTake = note.match(/the take is ([\d.]+) s, under the 4 s a spin-in needs/);
  if (spinTake) expect(D, at).toBeLessThan(4);
  const middleTake = note.match(/a middle move needs a take of 6 s or more \(this one is ([\d.]+) s\)/);
  if (middleTake) expect(D, at).toBeLessThan(MIDDLE_EVERY);
  const gap = note.match(/longest free gap[^;]* is ([\d.]+) s[^;]*a middle move needs/);
  if (gap && Number(gap[1]) >= 2.4) expect(note, at).toMatch(/dropped|moving-time cap/);
}

/** The project after the `direct` op, with its plan inputs. */
function directed(p: Project, opts: DirectOptions): Project {
  let n = 0;
  return applyOps(p, [{ op: 'direct', style: opts.style, replace: opts.replace, ...(opts.scenes ? {} : { scenes: false }) }], { newId: () => `d${++n}`, scenes: opts.scenes ? [...opts.scenes] : undefined, cursor: opts.cursor ? [...opts.cursor] : undefined }).project;
}

/** Busy time: taps and typing only (a zoom is not busy: owner decision 20 makes it a 35° angle limit, not a hold). */
function busyOf(p: Project): { start: number; end: number }[] {
  const tl = new Timeline(p.recording.duration, p.clips);
  const out = tapsToOutput(p.taps, tl).map((t) =>
    t.kind === 'typing'
      ? { start: t.t - 0.6, end: t.t + (t.duration ?? 0) + 0.8 }
      : { start: t.t - 0.6, end: Math.max(t.t + 0.8, t.settleT !== undefined ? t.settleT + 0.3 : -Infinity, t.t + (t.duration ?? 0) + 0.4) },
  );
  return out;
}

/** How far the body pokes past each canvas edge at t: [left, top, right, bottom] (px; <= 0 inside). Measured here, not with warnings.ts. */
function edgesOf(p: Project): (t: number) => number[] {
  const s = scene3d(p)!;
  return (t) => {
    const b = bodyBounds(s, t)!;
    return [-b.x, -b.y, b.x + b.w - s.canvas.width, b.y + b.h - s.canvas.height];
  };
}

const EDGE_NAMES = ['left', 'top', 'right', 'bottom'];

/**
 * Moments where the planned project pokes further past a canvas edge than the
 * same project without the shots pokes past THAT edge (past the 2% margin, by
 * more than 0.5 px), sampled at 20 Hz plus every keyframe. A kept pose near an
 * edge or the float may already poke out; a shot must never push it further,
 * and a big overflow at one edge never excuses a new one at another.
 */
function offCanvasAddedByShots(p: Project, plan: ReturnType<typeof planDirect>): { t: number; edge: string; planned: number; baseline: number }[] {
  let n = 0;
  const out = applyOps(p, plan.ops, { newId: () => `d${++n}` }).project;
  const base = applyOps(p, plan.ops.filter((o) => o.op !== 'shot' || o.recipe === 'float'), { newId: () => `b${++n}` }).project;
  const s = scene3d(out);
  if (!s) return [];
  const margin = OFF_CANVAS_FRACTION * Math.min(s.canvas.width, s.canvas.height);
  const D = new Timeline(p.recording.duration, p.clips).outputDuration;
  const ts = Array.from({ length: Math.ceil(D * 20) + 1 }, (_, k) => Math.min(D, k / 20));
  for (const tr of out.phone3d!.transitions) ts.push(tr.start, tr.end);
  const [po, bo] = [edgesOf(out), edgesOf(base)];
  const bad: { t: number; edge: string; planned: number; baseline: number }[] = [];
  for (const t of ts) {
    if (t < 0 || t > D) continue;
    const planned = po(t);
    if (planned.every((o) => o <= margin)) continue;
    const baseline = bo(t);
    planned.forEach((o, i) => {
      if (o > margin && o > baseline[i] + 0.5) bad.push({ t: Math.round(t * 1000) / 1000, edge: EDGE_NAMES[i], planned: Math.round(o), baseline: Math.round(baseline[i]) });
    });
  }
  return bad;
}

/** Every SPEC §2.6 guarantee for one planned project. */
function checkPlan(p: Project, opts: DirectOptions, label: string) {
  const plan = planDirect(p, opts);
  expect(plan.check.retries, `${label}: retries`).toBe(0);
  const again = planDirect(p, opts);
  expect(JSON.stringify(again), `${label}: deterministic`).toBe(JSON.stringify(plan));

  const out = directed(p, opts);
  const p3 = out.phone3d!;
  for (const tr of p3.transitions) {
    expect(poseInRange(tr.to), `${label}: to in range`).toBe(true);
    if (tr.from) expect(poseInRange(tr.from), `${label}: from in range`).toBe(true);
  }
  // The op applies exactly the plan's ops.
  let n = 0;
  const manual = applyOps(p, plan.ops, { newId: () => `d${++n}` }).project;
  expect(JSON.stringify(manual.phone3d), `${label}: op == plan`).toBe(JSON.stringify(p3));

  const D = new Timeline(p.recording.duration, p.clips).outputDuration;
  const warnings = projectWarnings(out, { cursor: opts.cursor });
  if (opts.replace) {
    // A fresh plan adds no warnings. Zooms play in 3D (owner decision 20: a camera push-in), so a manual zoom is not
    // a warning on its own; only a shot steeper than 35° during one would be (zoom-angle), and the plan avoids that.
    expect(warnings, `${label}: warnings`).toEqual([]);
    // While busy, the phone faces the viewer within 12°.
    for (const b of busyOf(p)) {
      for (let t = Math.max(0, b.start); t <= Math.min(D, b.end); t += 1 / 60) expect(facing(p3, t), `${label}: facing at ${t.toFixed(3)}`).toBeGreaterThanOrEqual(COS_BUSY - 1e-9);
    }
  } else {
    const planned = new Set(p3.transitions.map((t) => t.id).filter((id) => id.startsWith('d')));
    expect(warnings.filter((w) => w.transitionId && planned.has(w.transitionId)), `${label}: warnings from planned moves`).toEqual([]);
  }
  // An off-canvas warning spans every run from one keyframe, so its culprit is not enough: measure each moment.
  expect(offCanvasAddedByShots(p, plan), `${label}: shots push the phone further off the canvas`).toEqual([]);

  // Density caps: middle shots ≤ one per 6 s; moving time ≤ the style's share (the intro alone may exceed it).
  const moving = plan.shots.filter((s) => s.recipe !== 'float');
  const intro = moving.filter((s) => s.reason.startsWith('intro'));
  const middle = moving.filter((s) => !s.reason.startsWith('intro') && !s.reason.startsWith('outro'));
  expect(middle.length, `${label}: middle count`).toBeLessThanOrEqual(Math.floor(D / MIDDLE_EVERY));
  const total = moving.reduce((a, s) => a + s.end - s.start, 0);
  const introLen = intro.reduce((a, s) => a + s.end - s.start, 0);
  expect(total, `${label}: moving time`).toBeLessThanOrEqual(Math.max(MOVING_CAP[opts.style] * D, introLen) + 1e-6);
  if (opts.style === 'subtle') expect(middle, `${label}: subtle has no middle moves`).toEqual([]);
  // Owner decision 18 (restraint): at most one big move per BIG_EVERY s (start to start), never two within BIG_GAP s,
  // at most MAX_TURN_TO_BACKS turn-to-backs.
  const big = moving.filter((s) => BIG_MOVES.includes(s.recipe));
  for (let i = 0; i < big.length; i++) {
    for (let j = i + 1; j < big.length; j++) {
      expect(big[j].start - big[i].start, `${label}: big moves ${i} and ${j} start ${BIG_EVERY[opts.style]} s apart`).toBeGreaterThanOrEqual(BIG_EVERY[opts.style] - 1e-6);
      expect(big[j].start - big[i].end, `${label}: big moves ${i} and ${j} ${BIG_GAP} s apart`).toBeGreaterThanOrEqual(BIG_GAP - 1e-6);
    }
  }
  expect(moving.filter((s) => s.recipe === 'turn-to-back').length, `${label}: turn-to-backs`).toBeLessThanOrEqual(MAX_TURN_TO_BACKS);
  // Shots never overlap each other and each fits the timeline.
  for (let i = 0; i < moving.length; i++) {
    expect(moving[i].start).toBeGreaterThanOrEqual(0);
    expect(moving[i].end).toBeLessThanOrEqual(D + 1e-9);
    if (i) expect(moving[i].start).toBeGreaterThanOrEqual(moving[i - 1].end);
  }
  return { plan, out };
}

/** The most the drawn phone turns off straight on over the take (degrees; 60 Hz plus every keyframe). Measured here. */
function maxOffFront(out: Project): number {
  const p3 = out.phone3d!;
  const D = new Timeline(out.recording.duration, out.clips).outputDuration;
  const ts = Array.from({ length: Math.ceil(D * 60) + 1 }, (_, k) => Math.min(D, k / 60));
  for (const tr of p3.transitions) ts.push(tr.start, tr.end);
  return Math.max(...ts.filter((t) => t >= 0 && t <= D).map((t) => (Math.acos(Math.min(1, facing(p3, t))) * 180) / Math.PI));
}

const moving = (plan: ReturnType<typeof planDirect>) => plan.shots.filter((s) => s.recipe !== 'float');
const turning = (plan: ReturnType<typeof planDirect>) => plan.shots.filter((s) => ['spin-in', 'hero-layback', 'turn-to-back'].includes(s.recipe));

/** Share of the take (60 Hz samples) where the drawn phone is at least `deg` off straight on. */
function heldOff(out: Project, deg: number): number {
  const p3 = out.phone3d!;
  const D = new Timeline(out.recording.duration, out.clips).outputDuration;
  const n = Math.ceil(D * 60);
  let hit = 0;
  for (let k = 0; k <= n; k++) if ((Math.acos(Math.min(1, facing(p3, (D * k) / n))) * 180) / Math.PI >= deg) hit++;
  return hit / (n + 1);
}

const FIXTURES: { name: string; p: () => Project; scenes?: number[] }[] = [
  { name: 'no taps', p: () => take(30) },
  { name: 'dense taps', p: () => take(24, Array.from({ length: 14 }, (_, i) => tap(1 + i * 1.6, {}, i))) },
  {
    name: 'long waits',
    p: () =>
      take(
        60,
        [tap(5), tap(30, { kind: 'typing', duration: 2 }, 1), tap(56, { settleT: 57.2 }, 2)],
        [
          { start: 8, end: 28 },
          { start: 34, end: 54 },
        ],
      ),
  },
  { name: 'scene changes', p: () => take(40, [tap(4), tap(20), tap(36, {}, 2)], [{ start: 6, end: 18 }]), scenes: [12.5, 27, 31] },
  {
    name: 'a cut project',
    p: () => {
      const p = take(50, [tap(3), tap(12), tap(25, { kind: 'swipe', duration: 1 }, 2), tap(41, {}, 3)], [{ start: 28, end: 40 }]);
      return applyOps(p, [{ op: 'cut', ranges: [{ start: 14, end: 20 }, { start: 30, end: 33 }] }, { op: 'speed', start: 34, end: 39, speed: 2 }], { newId: () => 'c' }).project;
    },
    scenes: [22, 36],
  },
  { name: 'classic layout', p: () => take(30, [tap(6), tap(14)], [{ start: 16, end: 28 }], 'none') },
  { name: 'landscape take', p: () => take(30, [tap(6), tap(14)], [{ start: 16, end: 28 }], 'landscape-16x9') },
];

describe('planDirect on fixtures', () => {
  for (const f of FIXTURES) {
    for (const style of STYLES) {
      it(`${f.name}, ${style}: deterministic, no warnings, faces front while busy, within the caps`, () => {
        checkPlan(f.p(), { style, replace: true, scenes: f.scenes }, `${f.name}/${style}`);
      });
    }
  }

  it('a landscape iPhone capture plans and stays clean too', () => {
    const p = phoneProject({ width: 2622, height: 1206, duration: 30, presetId: 'landscape-16x9' });
    p.taps = [tap(6), tap(14)];
    p.tapsAnalyzed = true;
    checkPlan(p, { style: 'bold', replace: true }, 'landscape capture');
  });
});

describe('planDirect: rules', () => {
  it('a 2.5 s clip gets settle only', () => {
    for (const style of ['hero', 'bold'] as const) {
      const { plan } = checkPlan(take(2.5), { style, replace: true }, `2.5 s ${style}`);
      expect(plan.shots.map((s) => s.recipe)).toEqual(['settle']);
    }
  });

  it('hero and bold open with spin-in when the first 2 s are free; subtle settles and floats', () => {
    expect(planDirect(take(20, [tap(8)]), { style: 'hero', replace: true }).shots[0]).toMatchObject({ recipe: 'spin-in', start: 0, end: 1.6 });
    expect(planDirect(take(20, [tap(8)]), { style: 'bold', replace: true }).shots[0]).toMatchObject({ recipe: 'spin-in', start: 0 });
    expect(planDirect(take(20, [tap(8)]), { style: 'subtle', replace: true }).shots.map((s) => s.recipe)).toEqual(['settle', 'float']);
    // A tap at 1.5 s leaves 0.9 s before its busy time: too little for spin-in or a full settle, so a short settle
    // (owner decision 12) lands 0.25 s before it.
    expect(planDirect(take(20, [tap(1.5)]), { style: 'hero', replace: true }).shots[0]).toMatchObject({ recipe: 'settle', start: 0, end: 0.65 });
    // A tap at 1.1 s leaves 0.5 s, under the 0.6 s shortest intro: none.
    expect(planDirect(take(20, [tap(1.1)]), { style: 'hero', replace: true }).shots.some((s) => s.reason.startsWith('intro'))).toBe(false);
  });

  it('ops come in the fixed order: phone3d, clearTransitions (when replacing), shots by time, float last', () => {
    const { ops } = planDirect(take(40, [tap(10), tap(30)], [{ start: 12, end: 28 }]), { style: 'subtle', replace: true });
    expect(ops[0]).toEqual({ op: 'phone3d', enabled: true, pose: { ...FRONT }, light: { preset: 'soft' }, motionBlur: { on: true } });
    expect(ops[1]).toEqual({ op: 'clearTransitions' });
    expect(ops[ops.length - 1]).toEqual({ op: 'shot', recipe: 'float' });
    const bold = planDirect(take(40, [tap(10), tap(30)], [{ start: 12, end: 28 }]), { style: 'bold', replace: false }).ops;
    expect(bold[0]).toMatchObject({ op: 'phone3d', pose: { ...BOLD_BASE }, light: { preset: 'studio' } });
    expect(bold.some((o) => o.op === 'clearTransitions')).toBe(false);
    const ats = bold.filter((o) => o.op === 'shot').map((o) => o.at as number);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
  });

  it('bold’s resting pose is within the 12° busy rule', () => {
    const p3 = { pose: BOLD_BASE, transitions: [], float: { on: false, amount: 0, period: 6 }, camera: { fov: 22, elevation: 0 } } as unknown as Phone3D;
    expect(facing(p3, 0)).toBeGreaterThanOrEqual(COS_BUSY);
  });

  it('middle shots alternate direction by time order', () => {
    // 150 s so hero's one big move per 30 s (owner decision 18) still leaves four middle moves.
    const p = take(150, [tap(3), tap(75), tap(147)], [{ start: 5, end: 73 }, { start: 77, end: 145 }]);
    const ops = planDirect(p, { style: 'hero', replace: true }).ops.filter((o) => o.op === 'shot' && o.recipe === 'hero-layback' && o.return !== 'stay');
    expect(ops.length).toBeGreaterThanOrEqual(3);
    ops.forEach((o, i) => expect(o.direction).toBe(i % 2 === 0 ? 1 : -1));
  });

  it('scene-change wipe: the turn passes edge-on within 1/60 s of the cut', () => {
    // Cuts at least 20 s after the spin-in: bold allows one big move per 20 s (owner decision 18).
    for (const s of [24.2, 27.75]) {
      const p = take(40, [tap(3), tap(36)], [{ start: 6, end: 33 }]);
      const opts: DirectOptions = { style: 'bold', replace: true, scenes: [s] };
      const { plan, out } = checkPlan(p, opts, `wipe ${s}`);
      const shot = plan.shots.find((x) => x.reason.includes(`scene change at ${s.toFixed(1)}`))!;
      expect(shot.recipe).toBe('turn-to-back');
      // Find where facing crosses 0 during the outbound half (bisection on the real project).
      const p3 = out.phone3d!;
      let a = shot.start;
      let b = shot.start + 0.45 * (shot.end - shot.start);
      expect(facing(p3, a)).toBeGreaterThan(0);
      expect(facing(p3, b)).toBeLessThan(0);
      for (let i = 0; i < 60; i++) {
        const m = (a + b) / 2;
        if (facing(p3, m) > 0) a = m;
        else b = m;
      }
      expect(Math.abs((a + b) / 2 - s)).toBeLessThanOrEqual(1 / 60);
    }
  });

  it('edgeOnOffset solves the eased turn for either direction and base', () => {
    for (const base of [FRONT, BOLD_BASE]) {
      for (const dir of [1, -1] as const) {
        const off = edgeOnOffset(base, dir, 3.2);
        expect(off).toBeGreaterThan(0.2);
        expect(off).toBeLessThan(0.45 * 3.2);
      }
    }
    // FRONT is symmetric; the bold base (turn −8) reaches +90 later than −90.
    expect(edgeOnOffset(FRONT, 1)).toBeCloseTo(edgeOnOffset(FRONT, -1), 9);
    expect(edgeOnOffset(BOLD_BASE, 1)).toBeGreaterThan(edgeOnOffset(BOLD_BASE, -1));
  });

  it('scenes:false (or none analysed) leaves the plan without wipes', () => {
    const p = take(40, [tap(3), tap(36)], [{ start: 6, end: 33 }]);
    const off = planDirect(p, { style: 'bold', replace: true });
    expect(off.shots.some((s) => s.reason.includes('scene change'))).toBe(false);
  });

  it('replace:false keeps existing moves and plans around them', () => {
    const p = take(40, [tap(10), tap(30)], [{ start: 12, end: 28 }]);
    const mine = applyOps(p, [{ op: 'phone3d', enabled: true }], { newId: () => 'x' }).project;
    mine.phone3d!.transitions = [move('mine', 19, 21, { turn: 20 })];
    const { out } = checkPlan(mine, { style: 'hero', replace: false }, 'keep');
    const list = out.phone3d!.transitions;
    expect(list.find((t) => t.id === 'mine')).toEqual(move('mine', 19, 21, { turn: 20 }));
    for (const t of list) if (t.id !== 'mine') expect(t.end <= 19 || t.start >= 21).toBe(true);
  });

  it('cursor samples: zooms are not busy time, but no steep shot runs through one (owner decision 20); the same samples give the same plan', () => {
    const p = take(70);
    p.zoom = { ...p.zoom, autofocus: true };
    const mid = (x: { start: number; end: number }) => (x.start + x.end) / 2;
    const click = (t: number): CursorSample[] => [
      { time: t, x: 0.4, y: 0.5, kind: 'clickDown' },
      { time: t + 0.1, x: 0.4, y: 0.5, kind: 'clickUp' },
    ];
    // Hero: a zoom right on the middle hero-layback (under the 35° limit). Zooms are not busy, so it stays.
    const heroFree = planDirect(p, { style: 'hero', replace: true });
    const lay = heroFree.shots.find((x) => x.recipe === 'hero-layback' && x.reason.startsWith('middle'))!;
    expect(lay).toBeTruthy();
    const cursor = click(mid(lay));
    const zooms = focusSegmentsFor(p, cursor);
    expect(zooms.length).toBe(1);
    const fromFile = JSON.parse(JSON.stringify({ samples: cursor })).samples as CursorSample[];
    const a = planDirect(p, { style: 'hero', replace: true, cursor });
    const b = planDirect(p, { style: 'hero', replace: true, cursor: fromFile });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const overlaps = (x: { start: number; end: number }) => zooms.some((z) => x.start < z.outEnd && x.end > z.inStart);
    expect(a.shots.some((x) => x.recipe === 'hero-layback' && x.start === lay.start && overlaps(x))).toBe(true);
    const hero = checkPlan(p, { style: 'hero', replace: true, cursor }, 'cursor hero');
    expect(projectWarnings(hero.out, { cursor }).filter((w) => w.code === 'zoom-angle')).toEqual([]);
    // Bold: a zoom right on the middle turn-to-back. It leaves front by far more than 35°, so it moves off the zoom.
    const boldFree = planDirect(p, { style: 'bold', replace: true });
    const ttb = boldFree.shots.find((x) => x.recipe === 'turn-to-back')!;
    expect(ttb).toBeTruthy();
    const c2 = click(mid(ttb));
    const z2 = focusSegmentsFor(p, c2);
    const bold = checkPlan(p, { style: 'bold', replace: true, cursor: c2 }, 'cursor bold');
    const steep = bold.plan.shots.filter((x) => x.recipe === 'turn-to-back' || x.recipe === 'spin-in');
    expect(steep.some((x) => x.recipe === 'turn-to-back')).toBe(true);
    expect(steep.some((x) => z2.some((z) => x.start < z.outEnd && x.end > z.inStart))).toBe(false);
    expect(projectWarnings(bold.out, { cursor: c2 }).filter((w) => w.code === 'zoom-angle')).toEqual([]);
  });

  it('self-check: a shot that would push a large phone off the canvas is re-planned (turn-to-back → hero-layback)', () => {
    // 60 s: room for a middle move one big-move spacing (20 s, owner decision 18) from the intro and the outro.
    const p = take(60, [tap(10)]);
    p.style = { ...p.style, contentTransform: { scale: 1.24 } };
    const { plan } = checkPlan(p, { style: 'bold', replace: true }, 'large phone');
    expect(plan.check.rounds).toBeGreaterThan(0);
    expect(plan.check.dropped.map((s) => s.recipe)).toContain('turn-to-back');
    expect(plan.shots.filter((s) => s.reason.startsWith('middle')).every((s) => s.recipe === 'hero-layback')).toBe(true);
  });

  it('self-check: an overflow the layout already has is not blamed on the shots, but a shot that pushes further out is', () => {
    const p = take(60, [tap(10)]);
    p.style = { ...p.style, contentTransform: { scale: 1.3 } }; // the flat phone itself pokes 38 px past the canvas
    const plan = planDirect(p, { style: 'hero', replace: true });
    // The outro keeps within the layout's own overflow, so it stays; spin-in (65 px) and the middle
    // hero-laybacks (49 px) push the phone further out, so they go.
    expect(plan.shots.map((s) => s.reason.split(';')[0])).toEqual(['outro']);
    expect(plan.check.dropped.map((s) => s.recipe)).toEqual(expect.arrayContaining(['spin-in', 'hero-layback']));
    expect(offCanvasAddedByShots(p, plan)).toEqual([]);
    let n = 0;
    const out = applyOps(p, plan.ops, { newId: () => `d${++n}` }).project;
    const warnings = projectWarnings(out);
    expect(warnings.map((w) => w.code)).toEqual(['off-canvas']);
    expect(warnings[0].message).toMatch(/^The phone goes 38 px off the canvas/);
  });

  it('self-check: a kept pose near the top edge with the float on does not excuse shots that push the phone further out', () => {
    // A kept move parks the phone near the top edge; the float bobs it a little past the margin every period, all
    // take long. That is the user's layout, not a shot's fault, but a shot that pushes the phone further out is.
    const cases: { D: number; y: number; period: number; taps: number[] }[] = [
      { D: 35, y: 0.1018, period: 2, taps: [8.6, 16.2, 24.4, 31.5] },
      { D: 120, y: 0.105, period: 3, taps: [14, 33, 52, 71, 96, 115] },
      { D: 120, y: 0.11, period: 3, taps: [14, 33, 52, 71, 96, 115] },
    ];
    for (const c of cases) {
      const p = with3d(take(c.D, c.taps.map((t, i) => tap(t, {}, i))), { transitions: [move('k', 1, 2, { y: c.y })], float: { on: true, amount: 1, period: c.period } });
      for (const style of ['hero', 'bold'] as const) {
        const label = `D ${c.D}, y ${c.y}, ${style}`;
        const plan = planDirect(p, { style, replace: false });
        expect(plan.shots.length, `${label}: still plans shots`).toBeGreaterThan(0);
        expect(offCanvasAddedByShots(p, plan), `${label}: shots push the phone further off the canvas`).toEqual([]);
        // The kept pose's own overflow stays (one warning, from the kept keyframe), and is not blamed on a shot.
        let n = 0;
        const out = applyOps(p, plan.ops, { newId: () => `d${++n}` }).project;
        expect(projectWarnings(out).some((w) => w.code === 'off-canvas'), `${label}: the kept pose still pokes out`).toBe(true);
      }
    }
  }, 60_000);

  it('self-check: the float is part of the style, so an overflow the float alone causes is not blamed on subtle\'s intro', () => {
    // A kept move parks the phone near the top edge at 20-21 s; subtle turns the float on and it bobs the phone
    // past the margin after that. Auto 3D cannot drop the float, so the settle intro (the last shot before those
    // moments) is not blamed for it.
    const p = with3d(take(30, [tap(10)]), { transitions: [move('k', 20, 21, { y: 0.1 })], float: { on: false, amount: 1, period: 2 } });
    const plan = planDirect(p, { style: 'subtle', replace: false });
    expect(plan.check.dropped).toEqual([]);
    expect(plan.shots.map((s) => s.recipe)).toEqual(['settle', 'float']);
    expect(offCanvasAddedByShots(p, plan)).toEqual([]);
    let n = 0;
    const out = applyOps(p, plan.ops, { newId: () => `d${++n}` }).project;
    expect(projectWarnings(out).map((w) => w.message)).toEqual([expect.stringContaining('(the idle float carries it past the edge)')]);
  });

  it('self-check: a shot that pushes the phone past a NEW edge is mirrored or dropped, even when another edge is further out', () => {
    // The review repro: a kept move parks the phone up and to the right, so its top pokes about 50 px out all take
    // (the float bobs it). The outro's hero angle (leaning right) pulls the top back in but pushes the right side
    // about 20 px past the right edge, which the kept pose never crosses. Comparing only the worst edge (50 px vs
    // 50 px) excused it. Now the outro leans the other way, which keeps the right side in.
    const p = with3d(take(52, [tap(9.76)]), { transitions: [move('k', 1, 2, { x: 0.1457, y: -0.1234 })], float: { on: true, amount: 1, period: 2 } });
    const plan = planDirect(p, { style: 'hero', replace: false });
    const outro = plan.ops.find((o) => o.op === 'shot' && o.return === 'stay');
    expect(outro).toMatchObject({ recipe: 'hero-layback', at: 50.5, direction: -1 });
    expect(offCanvasAddedByShots(p, plan)).toEqual([]);
    // The outro leaning right does push the right side out: the oracle is not blind to it.
    const right = plan.ops.map((o) => (o === outro ? { ...o, direction: 1 } : o));
    const added = offCanvasAddedByShots(p, { ...plan, ops: right });
    expect(added.length).toBeGreaterThan(0);
    expect(new Set(added.map((x) => x.edge))).toEqual(new Set(['right']));
    expect(Math.max(...added.map((x) => x.planned))).toBeGreaterThan(15);
    let n = 0;
    const out = applyOps(p, plan.ops, { newId: () => `d${++n}` }).project;
    const planned = new Set(out.phone3d!.transitions.map((t) => t.id).filter((id) => id.startsWith('d')));
    expect(projectWarnings(out).filter((w) => w.transitionId && planned.has(w.transitionId))).toEqual([]);
  });

  it('off-canvas culprit (advisor ruling 3): the 50.60 s split names the kept move, then the float, never the outro', () => {
    // Same take as above. The kept pose's top pokes out from 1.73 s; the outro's lean pulls it back under the margin
    // at 50.60 s, and the float carries it out again at 51.27-51.67 s, during the outro's drift. That second run is
    // not added by any move: the outro without its drift (or without the whole outro) is no less far out at the top.
    const p = with3d(take(52, [tap(9.76)]), { transitions: [move('k', 1, 2, { x: 0.1457, y: -0.1234 })], float: { on: true, amount: 1, period: 2 } });
    const plan = planDirect(p, { style: 'hero', replace: false });
    let n = 0;
    const out = applyOps(p, plan.ops, { newId: () => `d${++n}` }).project;
    const ws = projectWarnings(out).filter((w) => w.code === 'off-canvas');
    expect(ws.map((w) => [w.at, w.end, w.transitionId ?? null])).toEqual([
      [expect.any(Number), 50.6, 'k'],
      [51.267, 51.667, null],
    ]);
    const [kept, floated] = ws;
    // The kept move does push it out (without it the phone is inside), so it is named, and its fix moves its pose.
    expect(kept.fix).toEqual([expect.objectContaining({ op: 'setPose' })]);
    // The float run: the float is the culprit, and the fix lowers its amount; applying it clears that run.
    expect(floated.message).toMatch(/\(the idle float carries it past the edge\)$/);
    expect(floated.fix).toEqual([{ op: 'phone3d', float: { amount: expect.any(Number) } }]);
    const fixed = applyOps(out, floated.fix!, { newId: () => 'f' }).project;
    expect(projectWarnings(fixed).filter((w) => w.code === 'off-canvas' && w.at! > 50.6)).toEqual([]);
  });

  it('self-check: when neither direction fits, the shot is dropped', () => {
    // A phone scaled to the canvas width: a hero lean pokes past one side or the other, whichever way it leans.
    const p = take(60, [tap(10)]);
    p.style = { ...p.style, contentTransform: { scale: 1.3 } };
    const plan = planDirect(p, { style: 'hero', replace: true });
    const middle = plan.check.dropped.filter((s) => s.reason.startsWith('middle'));
    expect(middle.length).toBeGreaterThan(0);
    expect(plan.shots.some((s) => s.reason.startsWith('middle'))).toBe(false);
    expect(offCanvasAddedByShots(p, plan)).toEqual([]);
  });

  it('self-check sweep: 300 kept poses near every edge, with and without the float; no shot pushes the phone past any edge', () => {
    let withShots = 0;
    let edgeDrops = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = lcg(seed * 104729);
      const D = 20 + Math.floor(r() * 60);
      const taps = Array.from({ length: Math.floor(r() * 8) }, () => Math.round(r() * D * 100) / 100).sort((a, b) => a - b);
      // A kept pose near a corner: up or down 0.08-0.16 and sideways up to 0.15, so two edges are in play.
      const to = { y: (r() < 0.5 ? -1 : 1) * (0.08 + r() * 0.08), x: (r() - 0.5) * 0.3 };
      const p = with3d(
        take(
          D,
          taps.map((t, i) => tap(t, {}, i)),
        ),
        { transitions: [move('k', 1, 2, to)], float: { on: r() < 0.6, amount: 1, period: 2 } },
      );
      for (const style of STYLES) {
        const label = `seed ${seed} ${style} D ${D} kept ${JSON.stringify(to)}`;
        const plan = planDirect(p, { style, replace: false });
        expect(plan.check.retries, label).toBe(0);
        expect(offCanvasAddedByShots(p, plan), `${label}: shots push the phone further past an edge`).toEqual([]);
        if (plan.shots.some((s) => s.recipe !== 'float')) withShots++;
        if (plan.check.dropped.length) edgeDrops++;
      }
    }
    // The sweep plans real shots and exercises the self-check (it is not passing by planning nothing).
    expect(withShots).toBeGreaterThan(600);
    expect(edgeDrops).toBeGreaterThan(10);
  }, 240_000);

  it('a 120 s bold plan with long waits: many middle shots, both directions, a hero-layback among them, all in range', () => {
    const p = take(
      120,
      [tap(2.5), tap(20), tap(38), tap(57), tap(75), tap(93), tap(111), tap(118)],
      [
        { start: 3, end: 19 },
        { start: 21, end: 37 },
        { start: 40, end: 56 },
        { start: 58, end: 74 },
        { start: 76, end: 92 },
        { start: 95, end: 110 },
      ],
    );
    const { plan, out } = checkPlan(p, { style: 'bold', replace: true, scenes: [10, 30, 64, 100] }, '120 s bold');
    const shots = plan.ops.filter((o): o is EditOp & { direction: number } => o.op === 'shot');
    // Owner decision 18: at most 3 turn-to-backs, and (a take over 90 s) the middle moves go to its natural breaks,
    // scene changes and waits. Many big turns in a row stay in range: shots.test.ts runs 10 turn-to-backs in a row.
    expect(shots.filter((o) => o.recipe === 'turn-to-back').length).toBe(3);
    for (const s of plan.shots.filter((x) => x.reason.startsWith('middle') || x.reason.startsWith('scene'))) expect(s.reason, JSON.stringify(s)).toMatch(/^(scene change at |middle; quiet wait)/);
    expect(new Set(shots.filter((o) => o.recipe !== 'spin-in' && o.recipe !== 'settle').map((o) => o.direction))).toEqual(new Set([1, -1]));
    for (const tr of out.phone3d!.transitions) expect(Math.abs(tr.to.turn)).toBeLessThanOrEqual(560);
    expect(plan.note).toMatch(/^This take is 120 s long: .* trim it to its best 15-45 s/);
  });
});

/** What a note says the phone does matches the plan's own ops and shots (item 4: posed rest vs styled plan). */
function expectNoteTruthful(plan: ReturnType<typeof planDirect>, label: string): void {
  const note = plan.note ?? '';
  const at = `${label}: ${note}`;
  const first = plan.ops[0] as EditOp & { pose?: unknown };
  const pose = JSON.stringify(first.pose);
  if (/The phone rests at a posed angle instead/.test(note)) expect(pose, at).toBe(JSON.stringify(POSED_REST));
  if (/The phone stays straight on/.test(note)) expect(pose, at).toBe(JSON.stringify(FRONT));
  if (/The phone rests at the bold angle/.test(note)) expect(pose, at).toBe(JSON.stringify(BOLD_BASE));
  const shots = moving(plan);
  if (/spin-in/.test(note) && /No (turning|moving) shot fits/.test(note)) expect(shots.some((x) => x.recipe === 'spin-in'), at).toBe(false);
  if (/the closing move/.test(note)) expect(shots.some((x) => x.reason.startsWith('outro')), at).toBe(false);
  if (/(a|for a) middle move/.test(note)) expect(shots.some((x) => !x.reason.startsWith('intro') && !x.reason.startsWith('outro')), at).toBe(false);
}
/** A seeded iPhone take of `D` output seconds with taps at `rate` per second, some waits and (optionally) scene changes. */
function seededTake(seed: number, D: number, rate: number, withScenes: boolean): { p: Project; scenes?: number[] } {
  const rnd = lcg(seed);
  const taps: TapSuggestion[] = [];
  const waits: { start: number; end: number }[] = [];
  for (let t = 0.5 + rnd() * 3, i = 0; t < D - 0.5; i++) {
    if (rnd() < 0.15) {
      // A wait: a quiet stretch with no taps.
      const len = 4 + rnd() * 20;
      waits.push({ start: t + 0.5, end: Math.min(D, t + 0.5 + len) });
      t += len + 1;
      continue;
    }
    taps.push(tap(Math.round(t * 100) / 100, rnd() < 0.1 ? { kind: 'typing', duration: rnd() * 2 } : {}, i));
    t += (0.3 + rnd() * 1.7) / rate;
  }
  const scenes = withScenes ? Array.from({ length: Math.max(1, Math.floor(D / 25)) }, () => Math.round(rnd() * D * 100) / 100).sort((a, b) => a - b) : undefined;
  return { p: take(D, taps, waits), ...(scenes ? { scenes } : {}) };
}

describe('planDirect: restraint (owner decision 18)', () => {
  it('nearestAllowed: the start in range nearest the wanted one, outside every open forbidden interval', () => {
    expect(nearestAllowed(0, 10, [], 4)).toBe(4);
    expect(nearestAllowed(0, 10, [{ start: 2, end: 6 }], 4.5)).toBe(6);
    // A tie goes to the earlier start.
    expect(nearestAllowed(0, 10, [{ start: 2, end: 6 }], 4)).toBe(2);
    expect(nearestAllowed(0, 10, [{ start: 2, end: 5 }], 4)).toBe(5);
    expect(nearestAllowed(0, 10, [{ start: 3, end: 6 }], 4)).toBe(3);
    // Interval ends are allowed (one big move exactly the spacing away).
    expect(nearestAllowed(5, 5, [{ start: -15, end: 5 }], 5)).toBe(5);
    expect(nearestAllowed(0, 10, [{ start: -1, end: 11 }], 4)).toBeNull();
    expect(nearestAllowed(0, 10, [{ start: -1, end: 4 }, { start: 4, end: 11 }], 7)).toBe(4);
    expect(nearestAllowed(3, 2, [], 2)).toBeNull();
  });

  it('a 637 s take (the real take\'s shape: 69 taps, long waits): bold gives a calm plan and recommends a trim', () => {
    const { p } = seededTake(637, 637, 0.25, false);
    const D = new Timeline(p.recording.duration, p.clips).outputDuration;
    expect(D).toBeGreaterThan(600);
    for (const style of STYLES) {
      const { plan } = checkPlan(p, { style, replace: true }, `637 s ${style}`);
      const moves = moving(plan);
      const big = moves.filter((s) => BIG_MOVES.includes(s.recipe));
      // Calm: the phone holds still at least 85% of the time, big moves at most one per BIG_EVERY s.
      const movingTime = moves.reduce((a, s) => a + s.end - s.start, 0);
      expect(movingTime / D, style).toBeLessThan(0.15);
      expect(big.length, style).toBeLessThanOrEqual(Math.floor(D / BIG_EVERY[style]) + 1);
      expect(moves.filter((s) => s.recipe === 'turn-to-back').length, style).toBeLessThanOrEqual(MAX_TURN_TO_BACKS);
      expect(plan.note, style).toMatch(/This take is \d+ s long: a social video reads best at 15-45 s, so trim it to its best 15-45 s \(trim, cut\) and run Auto 3D again; until then this plan moves only at scene changes and in waits, at most one big move per (20|30) s\.$/);
      if (style !== 'subtle') expect(big.length, `${style} still moves`).toBeGreaterThan(3);
    }
    const bold = planDirect(p, { style: 'bold', replace: true });
    expect(bold.shots.filter((s) => s.recipe === 'turn-to-back').length).toBe(MAX_TURN_TO_BACKS);
    // The old planner put 56 turn-to-backs in the real take; the cap holds however many waits there are.
    // A long take moves only at its natural breaks: scene changes (first) and waits. On a phone take a scene change
    // lands right after the tap that caused it (in busy time), so the move follows it as soon as the phone is free.
    const scenes = [40.5, 101.2, 180.7, 260.3, 333.3, 410.9, 480.1, 555.5, 600.2];
    const atScenes = checkPlan(p, { style: 'bold', replace: true, scenes }, '637 s bold, scenes').plan;
    const middles = atScenes.shots.filter((s) => !s.reason.startsWith('intro') && !s.reason.startsWith('outro'));
    expect(middles.length).toBeGreaterThan(0);
    for (const m of middles) expect(m.reason, JSON.stringify(m)).toMatch(/^(scene change at |middle; quiet wait)/);
    expect(middles.some((m) => m.reason.startsWith('scene change at '))).toBe(true);
    expect(atScenes.note).toMatch(/until then this plan moves only at scene changes and in waits, at most one big move per 20 s\.$/);
    // A take with neither scene changes nor waits spaces its moves out over the free time.
    const bare = take(200, Array.from({ length: 10 }, (_, i) => tap(10 + i * 19, {}, i)));
    const spaced = checkPlan(bare, { style: 'bold', replace: true }, '200 s bare').plan;
    expect(spaced.note).toMatch(/until then this plan spaces its moves out, at most one big move per 20 s\.$/);
    expect(moving(spaced).filter((s) => s.reason.startsWith('middle; free')).length).toBeGreaterThan(2);
  }, 120_000);

  it('the 6 s and 8 s golden takes still give a visible 3D result in every style (owner decision 12)', () => {
    for (const name of ['ios-social', 'ios-16x9', 'ios-landscape'] as const) {
      const { project, cursor } = loadGoldenFixture(name);
      const D = new Timeline(project.recording.duration, project.clips).outputDuration;
      expect(D).toBeLessThan(LONG_TAKE);
      for (const style of STYLES) {
        const { plan, out } = checkPlan(project, { style, replace: true, cursor }, `${name}/${style}`);
        expect(maxOffFront(out), `${name}/${style} (D ${D.toFixed(2)})`).toBeGreaterThanOrEqual(VISIBLE_DEG - 1e-6);
        expect(plan.note ?? '', `${name}/${style}`).not.toMatch(/This take is/);
      }
    }
  });

  it('kept big moves count: planned big moves keep their distance, and three kept turn-to-backs leave no room for a fourth', () => {
    const p = take(120, [tap(60)], [{ start: 2, end: 58 }, { start: 62, end: 118 }]);
    const kept = applyOps(p, [{ op: 'shot', recipe: 'turn-to-back', at: 30 }], { newId: (() => { let n = 0; return () => `k${++n}`; })() }).project;
    const plan = planDirect(kept, { style: 'bold', replace: false });
    const keptStart = 30;
    for (const s of moving(plan).filter((x) => BIG_MOVES.includes(x.recipe))) {
      expect(Math.abs(s.start - keptStart), JSON.stringify(s)).toBeGreaterThanOrEqual(BIG_EVERY.bold - 1e-6);
      expect(s.end <= keptStart - BIG_GAP + 1e-6 || s.start >= 30 + 3.7 - 1e-3 + BIG_GAP - 1e-6, JSON.stringify(s)).toBe(true);
    }
    let n = 0;
    const three = applyOps(p, [10, 40, 90].map((at) => ({ op: 'shot', recipe: 'turn-to-back', at })), { newId: () => `k${++n}` }).project;
    const more = planDirect(three, { style: 'bold', replace: false });
    expect(more.shots.filter((s) => s.recipe === 'turn-to-back')).toEqual([]);
    // Replacing them frees the cap again.
    expect(planDirect(three, { style: 'bold', replace: true }).shots.filter((s) => s.recipe === 'turn-to-back').length).toBeGreaterThan(0);
  });

  it('scene changes come first: a cut takes its move before the closing move does', () => {
    // 40 s bold: a turn-to-back hiding the cut at 24.2 s and a closing move at 38.5 s are under 20 s apart; the cut wins.
    const p = take(40, [tap(3), tap(36)], [{ start: 6, end: 33 }]);
    const plan = checkPlan(p, { style: 'bold', replace: true, scenes: [24.2] }, 'cut first').plan;
    expect(plan.shots.map((s) => s.recipe)).toEqual(['spin-in', 'turn-to-back']);
    expect(plan.shots[1].reason).toMatch(/^scene change at 24\.2 s hidden edge-on/);
    // Without the cut the closing move is planned (and a middle move fits 20 s from both ends).
    expect(planDirect(p, { style: 'bold', replace: true }).shots.some((s) => s.reason.startsWith('outro'))).toBe(true);
  });

  it('sweep: 160 takes of 10-400 s, every style: restraint caps hold, long takes recommend a trim and move only at scene changes and waits', () => {
    const tally = { long: 0, sceneOnly: 0, ttb3: 0, multiBig: 0 };
    for (let seed = 1; seed <= 160; seed++) {
      const rnd = lcg(seed * 7919);
      const D = Math.round((10 + rnd() * 390) * 100) / 100;
      const { p, scenes } = seededTake(seed * 31, D, 0.05 + rnd() * 0.8, rnd() < 0.5);
      for (const style of STYLES) {
        const label = `seed ${seed} ${style} D ${D}${scenes ? ` scenes ${scenes.length}` : ''}`;
        const { plan } = checkPlan(p, { style, replace: true, scenes }, label);
        expectNoteTruthful(plan, label);
        const long = D > LONG_TAKE;
        expect(/This take is \d+ s long/.test(plan.note ?? ''), `${label}: trim note iff long (${plan.note})`).toBe(long);
        const middles = moving(plan).filter((s) => !s.reason.startsWith('intro') && !s.reason.startsWith('outro'));
        if (long && (scenes || p.waits.length)) {
          for (const m of middles) expect(m.reason, label).toMatch(/^(scene change at |middle; quiet wait)/);
          if (middles.some((m) => m.reason.startsWith('scene change at '))) tally.sceneOnly++;
        }
        if (long) tally.long++;
        if (moving(plan).filter((s) => s.recipe === 'turn-to-back').length === MAX_TURN_TO_BACKS) tally.ttb3++;
        if (moving(plan).filter((s) => BIG_MOVES.includes(s.recipe)).length > 1) tally.multiBig++;
      }
    }
    // The sweep reaches every branch (measured counts are well above these).
    expect(tally.long).toBeGreaterThan(200);
    expect(tally.sceneOnly).toBeGreaterThan(20);
    expect(tally.ttb3).toBeGreaterThan(10);
    expect(tally.multiBig).toBeGreaterThan(150);
  }, 300_000);
});

describe('planDirect: always a visible 3D result (owner decision 12)', () => {
  it('the 8 s ios-social golden take (dense taps, a cut, tap zooms) opens with a short settle in every style', () => {
    const { project, cursor } = loadGoldenFixture('ios-social');
    for (const style of STYLES) {
      const opts: DirectOptions = { style, replace: true, cursor };
      const { plan, out } = checkPlan(project, opts, `ios-social/${style}`);
      expect(moving(plan).map((s) => s.recipe), style).toEqual(['settle']);
      const intro = plan.shots[0];
      expect(intro.start).toBe(0);
      expect(intro.end - intro.start).toBeGreaterThanOrEqual(SHORT_INTRO_MIN);
      // It lands before the first busy start (the tap at 1.2 s is busy from 0.6 s), and before the first zoom.
      expect(intro.end).toBeLessThanOrEqual(0.6 + 1e-9);
      expect(intro.end).toBeLessThanOrEqual(Math.min(...focusSegmentsFor(project, cursor).map((z) => z.inStart)));
      expect(maxOffFront(out), style).toBeGreaterThanOrEqual(VISIBLE_DEG - 1e-6);
    }
    // Hero fits no turning shot, so it rests at the posed angle and holds it (a settle alone is a 0.2 s lean); bold
    // holds its own angle; subtle keeps straight on with its float.
    const hero = checkPlan(project, { style: 'hero', replace: true, cursor }, 'ios-social/hero');
    expect(hero.plan.ops[0]).toMatchObject({ op: 'phone3d', pose: { ...POSED_REST } });
    expect(heldOff(hero.out, VISIBLE_DEG)).toBeGreaterThan(0.9);
    expect(hero.plan.note).toBe(
      'No turning shot fits: the phone must face front from 0.6 s, which leaves a spin-in 0.4 s, under the 2.0 s it needs; no free time is left beside the planned shots (with the 1.0 s rest around each) for a middle move; the free time at the end is 0.0 s, under the 1.5 s the closing move needs. The phone rests at a posed angle instead (9.4° off front, inside the 12° rule for taps).',
    );
    const bold = checkPlan(project, { style: 'bold', replace: true, cursor }, 'ios-social/bold');
    expect(bold.plan.ops[0]).toMatchObject({ pose: { ...BOLD_BASE } });
    expect(heldOff(bold.out, VISIBLE_DEG)).toBeGreaterThan(0.9);
    expect(bold.plan.note).toBeUndefined();
    const subtle = checkPlan(project, { style: 'subtle', replace: true, cursor }, 'ios-social/subtle');
    expect(subtle.plan.ops[0]).toMatchObject({ pose: { ...FRONT } });
    expect(subtle.plan.note).toBeUndefined();
  });

  it('a take with no room for any move rests at a posed angle and says why', () => {
    // Taps every 0.8 s from 0.4 s: busy from 0 to the end, so no intro, middle or closing move fits.
    const p = take(8, Array.from({ length: 10 }, (_, i) => tap(0.4 + i * 0.8, {}, i)));
    for (const style of STYLES) {
      const { plan, out } = checkPlan(p, { style, replace: true }, `no room/${style}`);
      expect(moving(plan), style).toEqual([]);
      expect(plan.ops[0]).toMatchObject({ op: 'phone3d', pose: style === 'bold' ? { ...BOLD_BASE } : { ...POSED_REST } });
      expect(maxOffFront(out), style).toBeGreaterThanOrEqual(VISIBLE_DEG - 1e-6);
      expect(plan.note, style).toMatch(/^No moving shot fits: the phone must face front from 0\.0 s \(a tap or kept move starts there\), so no intro fits; /);
    }
    expect(planDirect(p, { style: 'hero', replace: true }).note).toBe(
      'No moving shot fits: the phone must face front from 0.0 s (a tap or kept move starts there), so no intro fits; there is no free time between taps and kept moves. The phone rests at a posed angle instead (9.4° off front, inside the 12° rule for taps).',
    );
    expect(planDirect(p, { style: 'bold', replace: true }).note).toMatch(/\. The phone rests at the bold angle \(9\.4° off front\)\.$/);
    expect(planDirect(p, { style: 'subtle', replace: true }).note).toMatch(/; subtle plans no moves after the intro\. The phone rests at a posed angle instead/);
  });

  it('the dense-taps fixture (first tap at 1 s) names the short first gap and the longest free gap', () => {
    const p = FIXTURES.find((f) => f.name === 'dense taps')!.p();
    const plan = planDirect(p, { style: 'hero', replace: true });
    expect(moving(plan)).toEqual([]);
    expect(plan.note).toBe(
      'No moving shot fits: the phone must face front from 0.4 s (the first tap or kept move), under the 0.6 s an intro needs; the longest free gap is 1.3 s, under the 2.4 s a middle move needs; the free time at the end is 1.3 s, under the 1.5 s the closing move needs. The phone rests at a posed angle instead (9.4° off front, inside the 12° rule for taps).',
    );
  });

  it('kept moves are not touched: the note says so and the base pose stays the style\'s', () => {
    const p = take(8, Array.from({ length: 10 }, (_, i) => tap(0.4 + i * 0.8, {}, i)));
    const mine = applyOps(p, [{ op: 'phone3d', enabled: true }], { newId: () => 'x' }).project;
    mine.phone3d!.transitions = [move('mine', 3, 4, { turn: 10 }), move('back', 4, 5, { turn: 0 })];
    const plan = planDirect(mine, { style: 'hero', replace: false });
    expect(moving(plan)).toEqual([]);
    expect(plan.ops[0]).toMatchObject({ pose: { ...FRONT } });
    expect(plan.note).toMatch(/\. Your own moves stay as they are\.$/);
  });

  it('a posed angle that would push a phone scaled past the canvas further out is refused, and the note says so', () => {
    const p = take(8, Array.from({ length: 10 }, (_, i) => tap(0.4 + i * 0.8, {}, i)));
    p.style = { ...p.style, contentTransform: { scale: 1.3 } };
    const plan = planDirect(p, { style: 'hero', replace: true });
    expect(plan.ops[0]).toMatchObject({ pose: { ...FRONT } });
    expect(plan.note).toMatch(/\. The phone stays straight on: a posed angle would push the phone further off the canvas\.$/);
  });

  it('a posed angle that would break the 12° tap rule (with a strong float) is refused, and the note says so', () => {
    // The user turned the float up to full: ±4° turn and ±2.5° tilt on top of 9.4° would pass 12° during taps.
    const p = with3d(take(8, Array.from({ length: 10 }, (_, i) => tap(0.4 + i * 0.8, {}, i))), { float: { on: false, amount: 1, period: 6 } });
    const { plan, out } = checkPlan(p, { style: 'subtle', replace: true }, 'strong float');
    expect(plan.ops[0]).toMatchObject({ pose: { ...FRONT } });
    expect(out.phone3d!.float).toEqual({ on: true, amount: 1, period: 6 });
    expect(plan.note).toMatch(/\. The phone stays straight on: a posed angle would turn the phone more than 12° off front during taps\.$/);
    // At the default float amount the posed angle fits.
    const calm = planDirect(with3d(take(8, Array.from({ length: 10 }, (_, i) => tap(0.4 + i * 0.8, {}, i)))), { style: 'subtle', replace: true });
    expect(calm.ops[0]).toMatchObject({ pose: { ...POSED_REST } });
  });

  it('a note exactly when the style\'s own moves do not fit: no moving shot, or hero with no turning shot', () => {
    const cases: [Project, DirectStyle, boolean][] = [
      [take(30, [tap(10)]), 'hero', false],
      [take(30, [tap(10)]), 'subtle', false],
      [take(8, [tap(0.3), tap(1.2), tap(2.1), tap(3), tap(3.9), tap(4.8), tap(5.7), tap(6.6), tap(7.5)]), 'subtle', true],
      [take(2.5), 'bold', false],
      // A 2.5 s clip: hero gets settle only (no room for spin-in), so it rests posed and says why.
      [take(2.5), 'hero', true],
    ];
    for (const [p, style, noted] of cases) {
      const plan = planDirect(p, { style, replace: true });
      expect(plan.note !== undefined, `${style} ${JSON.stringify(plan.shots)}`).toBe(noted);
    }
    expect(planDirect(take(2.5), { style: 'hero', replace: true }).note).toMatch(/^No turning shot fits: the take is 2\.5 s, under the 4 s a spin-in needs; /);
  });

  it('the note names the gate that actually refused each shot (short takes: the take length, the 6 s middle rule, the moving-time cap)', () => {
    // 3.9 s, no taps: the whole take is free, so free time is never the reason. The spin-in needs a 4 s take, no
    // middle move is planned under 6 s, and the closing move (1.4 s) is over the 35% cap (1.365 s).
    expect(0.35 * 3.9).toBeLessThan(1.4);
    const plan = planDirect(take(3.9), { style: 'hero', replace: true });
    expect(plan.shots.map((s) => `${s.recipe} ${s.start}-${s.end}`)).toEqual(['settle 0-1']);
    expect(plan.note).toBe(
      'No turning shot fits: the take is 3.9 s, under the 4 s a spin-in needs; a middle move needs a take of 6 s or more (this one is 3.9 s); the closing move takes 1.4 s, more than the moving-time cap (35% of the take, 1.36 s). The phone rests at a posed angle instead (9.4° off front, inside the 12° rule for taps).',
    );
    // 3 s: the closing move would also start too soon after the intro (settle 0-1 then a 1 s rest; it starts at 1.5 s).
    expect(planDirect(take(3), { style: 'hero', replace: true }).note).toBe(
      'No turning shot fits: the take is 3.0 s, under the 4 s a spin-in needs; a middle move needs a take of 6 s or more (this one is 3.0 s); the closing move would start 0.5 s after the intro ends, under the 1.0 s rest between shots, and the closing move takes 1.4 s, more than the moving-time cap (35% of the take, 1.0 s). The phone rests at a posed angle instead (9.4° off front, inside the 12° rule for taps).',
    );
  });

  it('the note reports the spin-in\'s own window (busy start minus the inset), shown precisely enough to read as short', () => {
    // First tap at 2.7 s: busy from 2.1 s, so the first window is 2.1 - 0.15 = 1.95 s, under the 2.0 s a spin-in
    // needs (at one decimal 1.95 would round to "2.0 s" and contradict itself). Dense taps after it, to the end.
    const taps = [2.7];
    for (let t = 3.5; t < 10; t += 0.8) taps.push(Math.round(t * 100) / 100);
    const plan = planDirect(take(10, taps.map((t, i) => tap(t, {}, i))), { style: 'hero', replace: true });
    expect(plan.shots.map((s) => s.recipe)).toEqual(['settle']);
    expect(plan.note).toBe(
      'No turning shot fits: the phone must face front from 2.1 s, which leaves a spin-in 1.95 s, under the 2.0 s it needs; no free time is left beside the planned shots (with the 1.0 s rest around each) for a middle move; the free time at the end is 0.0 s, under the 1.5 s the closing move needs. The phone rests at a posed angle instead (9.4° off front, inside the 12° rule for taps).',
    );
    // A first tap 0.05 s later leaves the spin-in its 2.0 s, so it is planned and there is no note.
    taps[0] = 2.75;
    const later = planDirect(take(10, taps.map((t, i) => tap(t, {}, i))), { style: 'hero', replace: true });
    expect(later.shots.map((s) => s.recipe)).toEqual(['spin-in']);
    expect(later.note).toBeUndefined();
  });

  it('a middle move refused by the moving-time cap says so, not the free gap it would fit in', () => {
    // 6.5 s, one tap at 2 s (busy from 1.4 s; its tap zoom is not busy, zooms do not play in 3D): a settle opens it
    // (1.25 s is too short for a spin-in), then the rest of the take is free, more than both the 2.4 s a middle move
    // needs and the 1.5 s the closing move needs. The 35% cap is 2.275 s: the 2.4 s middle move is longer than the
    // whole cap, and the settle uses 1.0 s, so the 1.4 s closing move does not fit the 1.275 s left.
    const p = take(6.5, [tap(2)]);
    expect(focusSegmentsFor(p, []).map((z) => [z.inStart, z.outEnd])).toEqual([[1.75, 3.5]]);
    const plan = planDirect(p, { style: 'hero', replace: true });
    expect(plan.shots.map((s) => s.recipe)).toEqual(['settle']);
    expect(plan.note).toBe(
      'No turning shot fits: the phone must face front from 1.4 s, which leaves a spin-in 1.3 s, under the 2.0 s it needs; a middle move takes 2.4 s, more than the moving-time cap (35% of the take, 2.3 s); the closing move takes 1.4 s, more than the 1.3 s left of the moving-time cap (35% of the take, 2.3 s) after the other planned shots. The phone rests at a posed angle instead (9.4° off front, inside the 12° rule for taps).',
    );
  });

  it('sweep: 400 iPhone takes of 3-30 s, dense taps from the first moment, every style: visible 3D, clean, and a note whenever the style\'s own moves do not fit', () => {
    const presets = ['social-9x16', 'feed-4x5', 'square', 'landscape-16x9', 'none'];
    const tally = { short: 0, posed: 0, full: 0 };
    let notes = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rnd = lcg(seed * 6151);
      const D = 3 + rnd() * 27;
      // 0.1 to 2 taps a second; the first one anywhere in the first 2.5 s (often before 1.2 s, where no intro fits).
      const rate = 0.1 + rnd() * 1.9;
      const taps: TapSuggestion[] = [];
      for (let t = rnd() * 2.5, i = 0; t < D; t += (0.4 + rnd() * 1.6) / rate, i++) {
        const k = rnd();
        if (k < 0.15) taps.push(tap(t, { kind: 'typing', duration: rnd() * 2 }, i));
        else if (k < 0.3) taps.push(tap(t, { kind: 'swipe', duration: rnd() * 0.8 }, i));
        else taps.push(tap(t, rnd() < 0.5 ? { settleT: t + rnd() * 1.2 } : {}, i));
      }
      let p = take(D, taps, [], presets[Math.floor(rnd() * presets.length)]);
      if (rnd() < 0.3 && D > 8) {
        const s = 1 + rnd() * (D - 6);
        p = applyOps(p, [{ op: 'cut', ranges: [{ start: s, end: s + 0.5 + rnd() * 2 }] }], { newId: () => 'c' }).project;
      }
      const outD = new Timeline(p.recording.duration, p.clips).outputDuration;
      for (const style of STYLES) {
        const label = `seed ${seed} (${style}, D ${outD.toFixed(1)}, ${taps.length} taps)`;
        const { plan, out } = checkPlan(p, { style, replace: true }, label);
        if (outD >= 3) expect(maxOffFront(out), `${label}: visible 3D`).toBeGreaterThanOrEqual(VISIBLE_DEG - 1e-6);
        const moves = moving(plan);
        const ownMovesFit = moves.length > 0 && (style !== 'hero' || turning(plan).length > 0);
        expect(plan.note === undefined, `${label}: note iff the style's own moves do not fit (${plan.note})`).toBe(ownMovesFit);
        expectNoteMatchesPlan(plan, style, label);
        if (plan.note) {
          expect(plan.note, label).toMatch(/^No (moving|turning) shot fits: .+\. The phone rests at (a posed angle instead|the bold angle)/);
          expectNoteConsistent(plan.note, outD, style, label);
          notes++;
        }
        // Hero and bold read as 3D for most of the take, unless a turning shot carries it.
        if (style !== 'subtle' && !turning(plan).length) expect(heldOff(out, VISIBLE_DEG), `${label}: holds a 3D angle`).toBeGreaterThan(0.75);
        if (plan.ops[0].op === 'phone3d' && JSON.stringify(plan.ops[0].pose) === JSON.stringify(POSED_REST) && style !== 'bold') tally.posed++;
        if (moves[0]?.reason.startsWith('intro (short')) tally.short++;
        if (turning(plan).length) tally.full++;
      }
    }
    // Every branch is exercised many times (the sweep is not passing by planning the same thing everywhere).
    // (Measured: 255 short intros, 547 posed rests, 92 plans with a turning shot.)
    expect(tally.short).toBeGreaterThan(150);
    expect(tally.posed).toBeGreaterThan(300);
    expect(tally.full).toBeGreaterThan(50);
    expect(notes).toBeGreaterThan(300);
  }, 240_000);

  /** The note describes the plan it is attached to: its kind of shortfall and its dropped count match the shots. */
  function expectNoteMatchesPlan(plan: ReturnType<typeof planDirect>, style: DirectStyle, label: string): void {
    const ownMovesFit = moving(plan).length > 0 && (style !== 'hero' || turning(plan).length > 0);
    expect(plan.note === undefined, `${label}: note iff the style's own moves do not fit (${plan.note})`).toBe(ownMovesFit);
    if (!plan.note) return;
    expect(plan.note.startsWith('No moving shot fits'), `${label}: "No moving" iff no moving shot (${plan.note})`).toBe(moving(plan).length === 0);
    const dropped = plan.note.match(/the self-check dropped (\d+) shots? /);
    expect(dropped ? Number(dropped[1]) : 0, `${label}: the note's dropped count is the plan's (${plan.note})`).toBe(plan.check.dropped.length);
    expectNoteTruthful(plan, label);
  }



  it('moved layouts, where straight on and the posed angle drop different shots: the note comes from the run whose shots the plan returns', () => {
    // Two takes found by a review sweep. Straight on, every shot pushes the moved phone off the canvas and is dropped;
    // from the posed angle the same shots fit. The note used to come from the straight-on run ("No moving shot fits
    // ... the self-check dropped 2 shots") while the plan carried three turning shots and one dropped shot.
    // (The hero take was found again by the same kind of sweep at integration: look round 4's 2.4 s hero-layback and
    // zooms that are no longer busy let the old take keep a straight-on outro, so it no longer showed the case.)
    const hero = take(27.41, [tap(1.922, {}, 0), tap(25.183, {}, 1)], [], 'feed-4x5');
    hero.style = { ...hero.style, contentTransform: { scale: 0.983, x: 0.63, y: 0.382 } };
    const h = checkPlan(hero, { style: 'hero', replace: true }, 'moved hero').plan;
    expect(h.ops[0]).toMatchObject({ op: 'phone3d', pose: POSED_REST });
    // One big move per 30 s for hero (owner decision 18): the one middle hero-layback.
    expect(h.shots.map((s) => `${s.recipe} ${s.start}`)).toEqual(['hero-layback 12.403']);
    expect(h.check.dropped.map((s) => s.recipe)).toEqual(['settle']);
    expect(h.note).toBeUndefined();
    const subtle = take(28.755, [tap(3.36, {}, 0), tap(23.223, {}, 1)], [], 'square');
    subtle.style = { ...subtle.style, contentTransform: { scale: 0.9217379806097598, x: 0.6025434959679843, y: 0.4070532980374992 } };
    const s = checkPlan(subtle, { style: 'subtle', replace: true }, 'moved subtle').plan;
    expect(s.ops[0]).toMatchObject({ op: 'phone3d', pose: POSED_REST });
    expect(moving(s).map((x) => `${x.recipe} ${x.start}-${x.end}`)).toEqual(['settle 0-1']);
    expect(s.check.dropped).toEqual([]);
    expect(s.note).toBeUndefined();
    // The other way round: straight on keeps the short settle, from the posed angle it pokes the moved phone off the
    // canvas and is dropped. The plan has no shot, so the note must give the posed run's reasons and its dropped shot.
    const busy = take(9.5, [1.86, 4.38, 4.85, 7.47, 8.65].map((t, i) => tap(t, {}, i)), [], 'social-9x16');
    busy.style = { ...busy.style, contentTransform: { scale: 0.9, x: 0.68, y: 0.47 } };
    const b = checkPlan(busy, { style: 'hero', replace: true }, 'moved busy hero').plan;
    expect(b.ops[0]).toMatchObject({ op: 'phone3d', pose: POSED_REST });
    expect(b.shots).toEqual([]);
    expect(b.check.dropped.map((x) => `${x.recipe} ${x.start}-${x.end}`)).toEqual(['settle 0-0.91']);
    expect(b.note).toBe(
      'No moving shot fits: the longest free gap is 1.0 s, under the 2.4 s a middle move needs; the free time at the end is 0.0 s, under the 1.5 s the closing move needs; the self-check dropped 1 shot that would cause off-canvas warnings. The phone rests at a posed angle instead (9.4° off front, inside the 12° rule for taps).',
    );
  });

  it('sweep: 400 takes with a moved or scaled phone, every style: a note exactly when the style\'s own moves do not fit, and its dropped count is the plan\'s', () => {
    const presets = ['social-9x16', 'feed-4x5', 'square', 'landscape-16x9', 'none'];
    let posedWithOwnMoves = 0;
    let droppedNotes = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rnd = lcg(seed * 4447 + 7);
      const D = 3 + rnd() * 37;
      const rate = 0.05 + rnd() * 1.2;
      const taps: TapSuggestion[] = [];
      for (let t = rnd() * 4, i = 0; t < D; t += (0.4 + rnd() * 3) / rate, i++) taps.push(tap(t, {}, i));
      const p = take(D, taps, [], presets[Math.floor(rnd() * presets.length)]);
      p.style = { ...p.style, contentTransform: { scale: 0.8 + rnd() * 0.6, x: 0.3 + rnd() * 0.4, y: 0.3 + rnd() * 0.4 } };
      for (const style of STYLES) {
        const label = `seed ${seed} (${style}, D ${D.toFixed(2)}, ${JSON.stringify(p.style.contentTransform)})`;
        const plan = planDirect(p, { style, replace: true });
        expectNoteMatchesPlan(plan, style, label);
        if (plan.note && /dropped/.test(plan.note)) droppedNotes++;
        const posed = plan.ops[0].op === 'phone3d' && JSON.stringify(plan.ops[0].pose) === JSON.stringify(POSED_REST);
        if (style !== 'bold' && posed && plan.note === undefined) posedWithOwnMoves++;
      }
    }
    // The case under test is reached (a posed rest whose shots include the style's own moves), and many notes carry a
    // dropped count. (Measured: 2 and 494.)
    expect(posedWithOwnMoves).toBeGreaterThan(0);
    expect(droppedNotes).toBeGreaterThan(300);
  }, 240_000);
});

describe('planDirect: 500 seeded projects', () => {
  it('never throws or retries, adds no warnings, faces front while busy, stays in range and within the caps', () => {
    const presets = ['social-9x16', 'feed-4x5', 'square', 'landscape-16x9', 'none'];
    for (let seed = 1; seed <= 500; seed++) {
      const rnd = lcg(seed * 7919);
      const D = 2 + rnd() * 48;
      const taps: TapSuggestion[] = [];
      const nTaps = Math.floor(rnd() * 10);
      for (let i = 0; i < nTaps; i++) {
        const t = rnd() * D;
        const k = rnd();
        if (k < 0.15) taps.push(tap(t, { kind: 'typing', duration: rnd() * 3 }, i));
        else if (k < 0.3) taps.push(tap(t, { kind: 'swipe', duration: rnd() * 1.2 }, i));
        else taps.push(tap(t, rnd() < 0.5 ? { settleT: t + rnd() * 1.5 } : {}, i));
      }
      taps.sort((a, b) => a.t - b.t);
      const waits = Array.from({ length: Math.floor(rnd() * 3) }, () => {
        const s = rnd() * D;
        return { start: s, end: Math.min(D, s + 1 + rnd() * 10) };
      });
      let p = take(D, taps, waits, presets[Math.floor(rnd() * presets.length)]);
      if (rnd() < 0.3 && D > 8) {
        const s = 1 + rnd() * (D - 6);
        p = applyOps(p, [{ op: 'cut', ranges: [{ start: s, end: s + 1 + rnd() * 3 }] }], { newId: () => 'c' }).project;
      }
      const replace = rnd() < 0.8;
      if (!replace) p = applyOps(p, [{ op: 'phone3d', enabled: true }, { op: 'addTransition', start: rnd() * D * 0.8, to: { turn: 20 } }], { newId: () => 'mine' }).project;
      const scenes = Array.from({ length: Math.floor(rnd() * 4) }, () => rnd() * D);
      const style = STYLES[Math.floor(rnd() * 3)];
      checkPlan(p, { style, replace, scenes }, `seed ${seed} (${style}, D ${D.toFixed(1)})`);
    }
  }, 240_000);
});
