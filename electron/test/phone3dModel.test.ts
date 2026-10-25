import { describe, expect, it } from 'vitest';
import {
  compareTransitions,
  defaultPhone3D,
  FRONT,
  MIN_TRANSITION,
  normalizePhone3D,
  POSE_KEYS,
  SPRING_DEFAULT,
  type Phone3D,
} from '../src/shared/phone3d/model';
import { phone3dActive } from '../src/shared/phone3d/placement';
import { phone3dProblems } from '../src/shared/phone3d/validate';
import { defaultProject, normalizeProject, type Project } from '../src/shared/types';
import { lcg, move, phoneProject, with3d } from './helpers/phone3dFixtures';

const N = normalizePhone3D;
const json = (v: unknown) => JSON.stringify(v);

describe('defaultPhone3D', () => {
  it('has the documented values, no moves, and validates', () => {
    const d = defaultPhone3D();
    expect(d).toMatchObject({
      enabled: true,
      pose: FRONT,
      camera: { fov: 22, elevation: 0 },
      light: { preset: 'studio', azimuth: -35, intensity: 1 },
      glass: 0.25,
      back: 'auto',
      shadow: { kind: 'wall', opacity: 0.4, softness: 0.5 },
      dof: { amount: 0.35, background: 0 },
      float: { on: false, amount: 0.4, period: 6 },
      motionBlur: { shutter: 0.5, samples: 12 },
      supersample: 1,
      transitions: [],
    });
    expect(phone3dProblems({ phone3d: d })).toEqual([]);
    // Fresh objects each call (no shared state).
    expect(defaultPhone3D().pose).not.toBe(defaultPhone3D().pose);
  });
});

describe('normalizePhone3D', () => {
  it('drops non-objects', () => {
    for (const v of [null, 1, 'x', [], true]) expect(N(v)).toBeUndefined();
  });

  it('rebuilds in declared key order from the defaults', () => {
    const n = N({ transitions: [], supersample: 2, enabled: false, pose: { focus: 0.5, turn: 30 } })!;
    expect(Object.keys(n)).toEqual(['enabled', 'pose', 'camera', 'light', 'glass', 'back', 'shadow', 'dof', 'float', 'motionBlur', 'supersample', 'transitions']);
    expect(Object.keys(n.pose)).toEqual([...POSE_KEYS]);
    expect(n.pose).toEqual({ ...FRONT, turn: 30, focus: 0.5 });
    expect(n.enabled).toBe(false);
    expect(n.supersample).toBe(2);
  });

  it('clamps numbers, fixes enums, rounds samples', () => {
    const n = N({
      pose: { turn: 9999, tilt: -200, size: 0, x: NaN, light: 'a' },
      camera: { fov: 1, elevation: 99 },
      light: { preset: 'disco', azimuth: -400, intensity: Infinity },
      glass: 3,
      back: 'velvet',
      shadow: { on: 'yes', kind: 'ceiling', opacity: -1, softness: 2 },
      motionBlur: { samples: 7.6, shutter: 2 },
      float: { period: 0.5 },
      supersample: 4,
    })!;
    expect(n.pose).toMatchObject({ turn: 720, tilt: -85, size: 0.2, x: 0, light: 0 });
    expect(n.camera).toEqual({ fov: 8, elevation: 30 });
    expect(n.light).toEqual({ preset: 'studio', azimuth: -180, intensity: 1 });
    expect(n.glass).toBe(1);
    expect(n.back).toBe('auto');
    expect(n.shadow).toEqual({ on: true, kind: 'wall', opacity: 0, softness: 1 });
    expect(n.motionBlur).toMatchObject({ samples: 8, shutter: 1 });
    expect(n.float.period).toBe(2);
    expect(n.supersample).toBe(1);
  });

  it('keeps easing params only for their kind; spring defaults; malformed bezier → cinematic', () => {
    const tr = (easing: unknown) => N({ transitions: [{ id: 'a', start: 0, end: 1, to: {}, easing }] })!.transitions[0].easing;
    expect(tr({ kind: 'linear', stiffness: 5 })).toEqual({ kind: 'linear' });
    expect(tr({ kind: 'spring' })).toEqual({ kind: 'spring', ...SPRING_DEFAULT });
    expect(tr({ kind: 'spring', stiffness: 5000, damping: 0 })).toEqual({ kind: 'spring', stiffness: 1000, damping: 0.1 });
    expect(tr({ kind: 'bezier', x1: 0.2, y1: 0 })).toEqual({ kind: 'cinematic' });
    expect(tr({ kind: 'bezier', x1: 2, y1: 5, x2: -1, y2: -3 })).toEqual({ kind: 'bezier', x1: 1, y1: 2, x2: 0, y2: -1 });
    expect(tr({ kind: 'warp' })).toEqual({ kind: 'smooth' });
    expect(tr(undefined)).toEqual({ kind: 'smooth' });
  });

  it('drops bad transitions, fills ids deterministically, merges partial poses over FRONT, sorts', () => {
    const n = N({
      transitions: [
        { id: 'z', start: 5, end: 6, to: { turn: 90 } },
        { start: 1, end: 2, to: { tilt: 10 }, from: { turn: 20 } },
        { id: 'short', start: 1, end: 1 + MIN_TRANSITION / 2, to: {} },
        { id: 'nan', start: NaN, end: 3, to: {} },
        { id: 'str', start: '1', end: 3, to: {} },
        'junk',
        { id: 'neg', start: -1, end: 0.5, to: {}, recipe: 'spin-in' },
        { id: 'r', start: 5, end: 7, to: {}, recipe: 'moonwalk' },
      ],
    })!;
    expect(n.transitions.map((t) => t.id)).toEqual(['neg', 't1', 'r', 'z']);
    const t1 = n.transitions[1];
    expect(t1.from).toEqual({ ...FRONT, turn: 20 });
    expect(t1.to).toEqual({ ...FRONT, tilt: 10 });
    expect(n.transitions[0]).toMatchObject({ start: 0, end: 0.5, recipe: 'spin-in' });
    expect(n.transitions[2]).not.toHaveProperty('recipe');
    expect(n.transitions[3]).not.toHaveProperty('from'); // linked stays linked
    expect(n.transitions.every((t, i, a) => i === 0 || compareTransitions(a[i - 1], t) <= 0)).toBe(true);
  });

  it('an old pose (saved before focus existed) gains focus 1 inside phone3d only', () => {
    const old = { enabled: true, pose: { turn: 10, tilt: 0, rotate: 0, size: 1, x: 0, y: 0, light: 0 }, transitions: [{ id: 'a', start: 0, end: 1, to: { turn: 5, tilt: 0, rotate: 0, size: 1, x: 0, y: 0, light: 0 }, easing: { kind: 'smooth' } }] };
    const n = N(old)!;
    expect(n.pose.focus).toBe(1);
    expect(n.transitions[0].to.focus).toBe(1);
  });

  it('makes transition ids unique: first use keeps its id, a generated id never takes an explicit one', () => {
    const to = {};
    const ids = (raw: unknown) => N({ transitions: raw })!.transitions.map((t) => t.id);
    // The reviewer's repro: the missing id would have become t1, which the first one already uses.
    expect(ids([{ id: 't1', start: 0, end: 1, to }, { start: 2, end: 3, to }])).toEqual(['t1', 't1-2']);
    // An explicit id later in the list is still reserved before t0 is generated.
    expect(ids([{ start: 0, end: 1, to }, { id: 't0', start: 2, end: 3, to }])).toEqual(['t0-2', 't0']);
    // Repeats get the first free suffix, skipping suffixes already in use.
    expect(ids([{ id: 'x', start: 0, end: 1, to }, { id: 'x', start: 2, end: 3, to }, { id: 'x-2', start: 4, end: 5, to }, { id: 'x', start: 6, end: 7, to }])).toEqual(['x', 'x-3', 'x-2', 'x-4']);
    // Dropped entries free their id; the index used for t{i} is the saved index.
    expect(ids([{ id: 'a', start: 0, end: 0, to }, { start: 1, end: 2, to }, { id: 'a', start: 3, end: 4, to }])).toEqual(['t1', 'a']);
    // Sorting happens after ids are settled: the first use in SAVED order keeps the id, even if it starts later.
    expect(N({ transitions: [{ id: 'k', start: 5, end: 6, to }, { id: 'k', start: 0, end: 1, to }] })!.transitions.map((t) => [t.id, t.start])).toEqual([['k-2', 0], ['k', 5]]);
    // id stays the first key (byte-stable project.json).
    expect(Object.keys(N({ transitions: [{ id: 'z', start: 0, end: 1, to }, { id: 'z', start: 2, end: 3, to }] })!.transitions[1])[0]).toBe('id');
  });

  it('is idempotent and always valid on 2000 hostile inputs', () => {
    const r = lcg(1234);
    const junk = (depth: number): unknown => {
      const k = r();
      if (depth > 3 || k < 0.15) return [null, undefined, NaN, Infinity, -1e9, 'x', true, 0.5, 3, []][Math.floor(r() * 10)];
      if (k < 0.3) return Array.from({ length: Math.floor(r() * 4) }, () => junk(depth + 1));
      const keys = ['enabled', 'pose', 'turn', 'tilt', 'size', 'focus', 'camera', 'fov', 'light', 'preset', 'transitions', 'start', 'end', 'id', 'to', 'from', 'easing', 'kind', 'stiffness', 'x1', 'samples', 'supersample', 'shadow', 'on', 'motionBlur'];
      const o: Record<string, unknown> = {};
      for (let i = 0; i < 6; i++) o[keys[Math.floor(r() * keys.length)]] = junk(depth + 1);
      if (r() < 0.5) o.transitions = Array.from({ length: 1 + Math.floor(r() * 6) }, () => ({ id: ['m', 'm', 'm-2', 't0', 't1', 't2', 't1-2', '', 7, undefined, undefined][Math.floor(r() * 11)], start: r() * 10 - 2, end: r() * 12, to: junk(depth + 2), from: r() < 0.4 ? junk(depth + 2) : undefined, easing: { kind: ['spring', 'bezier', 'cinematic', 'x'][Math.floor(r() * 4)], stiffness: r() * 2000, x1: r() * 2, y1: 1, x2: 0.5, y2: 1 } }));
      return o;
    };
    let withMoves = 0;
    for (let i = 0; i < 2000; i++) {
      const raw = junk(0);
      const once = N(raw);
      if (once === undefined) continue;
      expect(json(N(JSON.parse(json(once))))).toBe(json(once));
      // Whatever was saved, the normalized setup passes validation, so applyOps can never be locked by it.
      expect(phone3dProblems({ phone3d: once })).toEqual([]);
      if (once.transitions.length > 1) withMoves++;
    }
    // The generator really exercises id clashes (not a vacuous pass).
    expect(withMoves).toBeGreaterThan(300);
  });
});

describe('a 0.1 s move typed in decimals is kept everywhere', () => {
  it('normalize, the validator and a remap keep 4.0–4.1 (0.0999999999999996 in floating point)', async () => {
    const { applyOps } = await import('../src/shared/agentOps');
    const { remapTransitions } = await import('../src/shared/remap');
    const { Timeline } = await import('../src/shared/timeline');
    expect(4.1 - 4.0).toBeLessThan(MIN_TRANSITION);
    const n = normalizePhone3D({ enabled: true, transitions: [{ id: 'a', start: 4.0, end: 4.1, to: { turn: 180 } }] })!;
    expect(n.transitions.map((t) => [t.start, t.end])).toEqual([[4.0, 4.1]]);
    // The op accepts it and the saved project still has it after a normalize round trip.
    const p = applyOps(with3d(phoneProject()), [{ op: 'addTransition', start: 4.0, end: 4.1, to: { turn: 180 } }]).project;
    expect(normalizeProject(JSON.parse(JSON.stringify(p))).phone3d!.transitions).toHaveLength(1);
    expect(phone3dProblems(p)).toEqual([]);
    const tl = new Timeline(10, [{ id: 'c', sourceStart: 0, sourceEnd: 10, speed: 1 }] as never);
    expect(remapTransitions(n.transitions, tl, tl)).toHaveLength(1);
    // Really too short still goes.
    expect(normalizePhone3D({ enabled: true, transitions: [{ id: 'b', start: 4.0, end: 4.09, to: {} }] })!.transitions).toEqual([]);
  });
});

describe('normalizeProject hook', () => {
  it('old projects gain no key', () => {
    const p = phoneProject();
    const n = normalizeProject(structuredClone(p));
    expect('phone3d' in n).toBe(false);
    expect(json(normalizeProject(JSON.parse(json(p))))).toBe(json(normalizeProject(JSON.parse(json(p)))));
  });

  it('a non-object phone3d is deleted; an object is normalized; N(N(x)) = N(x)', () => {
    const bad = normalizeProject({ ...phoneProject(), phone3d: 'nope' } as unknown as Project);
    expect('phone3d' in bad).toBe(false);
    const p = normalizeProject({ ...phoneProject(), phone3d: { pose: { turn: 1e6 } } } as unknown as Project);
    expect(p.phone3d!.pose.turn).toBe(720);
    expect(json(normalizeProject(JSON.parse(json(p))))).toBe(json(p));
  });

  it('defaultProject does not carry phone3d (so a reset drops 3D)', () => {
    expect('phone3d' in defaultProject(phoneProject().recording)).toBe(false);
  });
});

describe('phone3dProblems', () => {
  const base = (): Phone3D => ({ ...defaultPhone3D(), transitions: [move('a', 1, 2, { turn: 90 })] });
  const errs = (mut: (p: Phone3D & Record<string, unknown>) => void) => {
    const p = base() as Phone3D & Record<string, unknown>;
    mut(p);
    return phone3dProblems({ phone3d: p });
  };

  it('accepts a valid setup and an absent key', () => {
    expect(phone3dProblems({ phone3d: base() })).toEqual([]);
    expect(phone3dProblems({})).toEqual([]);
  });

  it('reports pose channels out of range in the base pose, from and to', () => {
    expect(errs((p) => (p.pose.turn = 721))).toEqual(['phone3d.pose.turn must be -720..720']);
    expect(errs((p) => (p.transitions[0].to.tilt = 86))).toEqual(['phone3d.transitions[0].to.tilt must be -85..85']);
    expect(errs((p) => (p.transitions[0].from = { ...FRONT, focus: 3 }))).toEqual(['phone3d.transitions[0].from.focus must be 0..2']);
    expect(errs((p) => (p.pose.size = NaN))).toEqual(['phone3d.pose.size must be 0.2..3']);
  });

  it('reports settings out of range and unknown enums', () => {
    expect(errs((p) => (p.camera.fov = 61))).toEqual(['phone3d.camera.fov must be 8..60']);
    expect(errs((p) => (p.motionBlur.samples = 12.5))).toEqual(['phone3d.motionBlur.samples must be an integer 2..32']);
    expect(errs((p) => (p.motionBlur.samples = 33))).toEqual(['phone3d.motionBlur.samples must be an integer 2..32']);
    expect(errs((p) => ((p as Record<string, unknown>).supersample = 4))).toEqual(['phone3d.supersample must be 1, 2 or 3']);
    expect(errs((p) => ((p.light as Record<string, unknown>).preset = 'disco'))).toEqual(['phone3d.light.preset must be studio|soft|contrast|warm|night']);
    expect(errs((p) => ((p as Record<string, unknown>).back = 'x'))).toEqual(['phone3d.back must be auto|glossy|frosted']);
    expect(errs((p) => ((p.shadow as Record<string, unknown>).kind = 'x'))).toEqual(['phone3d.shadow.kind must be wall|floor']);
    expect(errs((p) => ((p as Record<string, unknown>).enabled = 1))).toEqual(['phone3d.enabled must be true or false']);
    expect(errs((p) => ((p as Record<string, unknown>).glass = -0.1))).toEqual(['phone3d.glass must be 0..1']);
  });

  it('reports transition structure: start < 0, too short, ids, spring and bezier ranges', () => {
    expect(errs((p) => (p.transitions[0].start = -0.1))).toEqual(['phone3d.transitions[0].start must be >= 0']);
    expect(errs((p) => (p.transitions[0].end = 1.05))).toEqual(['phone3d.transitions[0]: end must be at least 0.1 s after start']);
    expect(errs((p) => (p.transitions[0].id = ''))).toEqual(['phone3d.transitions[0].id must be a non-empty string']);
    expect(errs((p) => p.transitions.push(move('a', 3, 4, {})))).toEqual(['phone3d.transitions[1].id "a" is also used by phone3d.transitions[0]']);
    expect(errs((p) => (p.transitions[0].easing = { kind: 'spring', stiffness: 1001, damping: 18 }))).toEqual(['phone3d.transitions[0].easing.stiffness must be 1..1000']);
    expect(errs((p) => (p.transitions[0].easing = { kind: 'bezier', x1: 1.2, y1: 0, x2: 0.5, y2: 2.5 }))).toEqual([
      'phone3d.transitions[0].easing.x1 must be 0..1',
      'phone3d.transitions[0].easing.y2 must be -1..2',
    ]);
  });

  it('does NOT report warnings: overlap and past-the-end are fine', () => {
    expect(errs((p) => p.transitions.push(move('b', 1.5, 300, {})))).toEqual([]);
  });
});

describe('phone3dActive', () => {
  it('is active for an enabled iPhone take with a frame on a framed canvas', () => {
    expect(phone3dActive(with3d(phoneProject()))).toEqual({ active: true });
    expect(phone3dActive(with3d(phoneProject({ presetId: 'none' })))).toEqual({ active: true });
  });

  it('gives the reason it is not', () => {
    expect(phone3dActive(phoneProject())).toEqual({ active: false, reason: 'disabled' });
    expect(phone3dActive(with3d(phoneProject(), { enabled: false }))).toMatchObject({ reason: 'disabled' });
    const off = with3d(phoneProject());
    off.device.frame = false;
    expect(phone3dActive(off)).toMatchObject({ reason: 'frame-off' });
    expect(phone3dActive(with3d(phoneProject({ presetId: 'appstore' })))).toMatchObject({ reason: 'app-store' });
    const mac = with3d(defaultProject({ screenVideoFile: 's.webm', sourceKind: 'display', sourceSize: { width: 1920, height: 1080 }, duration: 5 }));
    expect(phone3dActive(mac)).toMatchObject({ reason: 'not-iphone' });
    const macPhone = with3d(defaultProject({ screenVideoFile: 's.webm', sourceKind: 'display', sourceSize: { width: 1920, height: 1080 }, duration: 5, phoneVideoFile: 'phone.mov', phoneSize: { width: 1206, height: 2622 } }));
    expect(phone3dActive(macPhone)).toMatchObject({ reason: 'mac-iphone' });
  });
});
