// Auto 3D (SPEC §2.6). The plan is deterministic, adds no warnings, keeps
// the phone facing the viewer whenever something happens on screen, and
// stays inside the density caps; a property test runs 500 seeded projects.
import { describe, expect, it } from 'vitest';
import { applyOps, type EditOp } from '../src/shared/agentOps';
import { focusSegmentsFor } from '../src/shared/focusSegments';
import { tapsToOutput } from '../src/shared/mobileProject';
import { BOLD_BASE, BUSY_FACING_DEG, edgeOnOffset, MIDDLE_EVERY, MOVING_CAP, planDirect, type DirectOptions, type DirectStyle } from '../src/shared/phone3d/direct';
import { FRONT, type Phone3D } from '../src/shared/phone3d/model';
import { facing, poseInRange } from '../src/shared/phone3d/pose';
import { bodyBounds, scene3d } from '../src/shared/phone3d/projection';
import { OFF_CANVAS_FRACTION, projectWarnings } from '../src/shared/phone3d/warnings';
import { Timeline } from '../src/shared/timeline';
import type { CursorSample, Project } from '../src/shared/types';
import type { TapSuggestion } from '../src/shared/taps';
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

/** The project after the `direct` op, with its plan inputs. */
function directed(p: Project, opts: DirectOptions): Project {
  let n = 0;
  return applyOps(p, [{ op: 'direct', style: opts.style, replace: opts.replace, ...(opts.scenes ? {} : { scenes: false }) }], { newId: () => `d${++n}`, scenes: opts.scenes ? [...opts.scenes] : undefined, cursor: opts.cursor ? [...opts.cursor] : undefined }).project;
}

/** The busy intervals by the spec's formulas (output s): taps, typing runs and zooms. */
function busyOf(p: Project, cursor: readonly CursorSample[] = []): { start: number; end: number }[] {
  const tl = new Timeline(p.recording.duration, p.clips);
  const out = tapsToOutput(p.taps, tl).map((t) =>
    t.kind === 'typing'
      ? { start: t.t - 0.6, end: t.t + (t.duration ?? 0) + 0.8 }
      : { start: t.t - 0.6, end: Math.max(t.t + 0.8, t.settleT !== undefined ? t.settleT + 0.3 : -Infinity, t.t + (t.duration ?? 0) + 0.4) },
  );
  for (const z of focusSegmentsFor(p, cursor)) out.push({ start: z.inStart, end: z.outEnd });
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
    expect(warnings, `${label}: warnings`).toEqual([]);
    // While busy, the phone faces the viewer within 12°.
    for (const b of busyOf(p, opts.cursor)) {
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
  // Shots never overlap each other and each fits the timeline.
  for (let i = 0; i < moving.length; i++) {
    expect(moving[i].start).toBeGreaterThanOrEqual(0);
    expect(moving[i].end).toBeLessThanOrEqual(D + 1e-9);
    if (i) expect(moving[i].start).toBeGreaterThanOrEqual(moving[i - 1].end);
  }
  return { plan, out };
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
    // A tap at 1.5 s leaves no room for an intro.
    expect(planDirect(take(20, [tap(1.5)]), { style: 'hero', replace: true }).shots.some((s) => s.reason.startsWith('intro'))).toBe(false);
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
    const p = take(90, [tap(3), tap(45), tap(87)], [{ start: 5, end: 43 }, { start: 47, end: 85 }]);
    const ops = planDirect(p, { style: 'hero', replace: true }).ops.filter((o) => o.op === 'shot' && o.recipe === 'hero-layback' && o.return !== 'stay');
    expect(ops.length).toBeGreaterThan(3);
    ops.forEach((o, i) => expect(o.direction).toBe(i % 2 === 0 ? 1 : -1));
  });

  it('scene-change wipe: the turn passes edge-on within 1/60 s of the cut', () => {
    for (const s of [14.2, 27.75]) {
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

  it('cursor samples: autofocus zooms are busy time, and the same samples give the same plan', () => {
    const p = take(30);
    p.zoom = { ...p.zoom, autofocus: true };
    const cursor: CursorSample[] = [
      { time: 9, x: 0.4, y: 0.5, kind: 'clickDown' },
      { time: 9.1, x: 0.4, y: 0.5, kind: 'clickUp' },
      { time: 21, x: 0.6, y: 0.3, kind: 'clickDown' },
    ];
    const zooms = focusSegmentsFor(p, cursor);
    expect(zooms.length).toBe(2);
    const fromFile = JSON.parse(JSON.stringify({ samples: cursor })).samples as CursorSample[];
    const a = planDirect(p, { style: 'hero', replace: true, cursor });
    const b = planDirect(p, { style: 'hero', replace: true, cursor: fromFile });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const s of a.shots) for (const z of zooms) expect(s.end <= z.inStart || s.start >= z.outEnd).toBe(true);
    checkPlan(p, { style: 'hero', replace: true, cursor }, 'cursor');
    expect(JSON.stringify(planDirect(p, { style: 'hero', replace: true }))).not.toBe(JSON.stringify(a));
  });

  it('self-check: a shot that would push a large phone off the canvas is re-planned (turn-to-back → hero-layback)', () => {
    const p = take(30, [tap(10)]);
    p.style = { ...p.style, contentTransform: { scale: 1.24 } };
    const { plan } = checkPlan(p, { style: 'bold', replace: true }, 'large phone');
    expect(plan.check.rounds).toBeGreaterThan(0);
    expect(plan.check.dropped.map((s) => s.recipe)).toContain('turn-to-back');
    expect(plan.shots.filter((s) => s.reason.startsWith('middle')).every((s) => s.recipe === 'hero-layback')).toBe(true);
  });

  it('self-check: an overflow the layout already has is not blamed on the shots, but a shot that pushes further out is', () => {
    const p = take(30, [tap(10)]);
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
  });

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

  it('self-check: a shot that pushes the phone past a NEW edge is dropped, even when another edge is further out', () => {
    // The review repro: a kept move parks the phone up and to the right, so its top pokes about 50 px out all take
    // (the float bobs it). The outro's hero angle pulls the top back in but pushes the right side about 20 px past
    // the right edge, which the kept pose never crosses. Comparing only the worst edge (50 px vs 50 px) excused it.
    const p = with3d(take(52, [tap(9.76)]), { transitions: [move('k', 1, 2, { x: 0.1457, y: -0.1234 })], float: { on: true, amount: 1, period: 2 } });
    const plan = planDirect(p, { style: 'hero', replace: false });
    expect(plan.check.dropped.map((s) => `${s.recipe}@${s.start}`)).toContain('hero-layback@50.5');
    expect(plan.shots.some((s) => s.reason.startsWith('outro'))).toBe(false);
    expect(plan.shots.length).toBeGreaterThan(0);
    expect(offCanvasAddedByShots(p, plan)).toEqual([]);
    // The outro on its own does push the right side out: the oracle is not blind to it.
    const outro = planDirect(p, { style: 'hero', replace: false }).ops.slice(0, 1).concat([{ op: 'shot', recipe: 'hero-layback', at: 50.5, duration: 1.4, direction: 1, intensity: 1, return: 'stay' }]);
    const added = offCanvasAddedByShots(p, { ...plan, ops: outro });
    expect(added.length).toBeGreaterThan(0);
    expect(new Set(added.map((x) => x.edge))).toEqual(new Set(['right']));
    let n = 0;
    const out = applyOps(p, plan.ops, { newId: () => `d${++n}` }).project;
    const planned = new Set(out.phone3d!.transitions.map((t) => t.id).filter((id) => id.startsWith('d')));
    expect(projectWarnings(out).filter((w) => w.transitionId && planned.has(w.transitionId))).toEqual([]);
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
    expect(shots.filter((o) => o.recipe === 'turn-to-back').length).toBeGreaterThan(5);
    expect(new Set(shots.filter((o) => o.recipe === 'turn-to-back').map((o) => o.direction))).toEqual(new Set([1, -1]));
    expect(shots.some((o) => o.recipe === 'hero-layback')).toBe(true);
    for (const tr of out.phone3d!.transitions) expect(Math.abs(tr.to.turn)).toBeLessThanOrEqual(560);
  });
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
