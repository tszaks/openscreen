// The 3D phone's data model: the one optional `project.phone3d` key, its
// defaults, and the normalizer that makes any saved or hand-written JSON
// safe. Pure: imports nothing at runtime (types.ts imports this file, so a
// runtime import back into the project modules would make a cycle; the
// "is 3D active" gate, which needs the project modules, is placement.ts
// phone3dActive).
//
// Angles are degrees. Euler order 'ZXY': R = Rz(rotate)·Rx(tilt)·Ry(turn), in
// the phone's frame with y up and the screen facing +z (the camera). Signs
// (pinned by test/pose3d.test.ts):
//   turn   + turns the screen toward the viewer's right (the right edge goes away)
//   tilt   + leans the TOP AWAY from the camera (layback)
//   rotate + is clockwise in the picture plane

/** Degrees / fractions. Euler 'ZXY': R = Rz(rotate)·Rx(tilt)·Ry(turn).
 *  turn: spin about the phone's long axis, unwrapped (0→360 = one full spin), -720..720
 *  tilt: + leans the TOP AWAY from camera (layback), -85..85
 *  rotate: roll in the picture plane, + = clockwise, -180..180
 *  size: × the flat layout's body height, 0.2..3
 *  x, y: offset of the phone centre from its home, fraction of canvas W / H (+y = down), -1..1
 *  light: key-light azimuth OFFSET added to phone3d.light.azimuth, -180..180
 *  focus: depth-of-field strength, a multiplier on phone3d.dof.amount, 0..2 (0 = sharp, 1 = the setting).
 *         Animating it gives a focus pull. It does nothing while dof.on is false. */
export interface Pose {
  turn: number;
  tilt: number;
  rotate: number;
  size: number;
  x: number;
  y: number;
  light: number;
  focus: number;
}
export const FRONT: Readonly<Pose> = Object.freeze({ turn: 0, tilt: 0, rotate: 0, size: 1, x: 0, y: 0, light: 0, focus: 1 });
export const POSE_KEYS = ['turn', 'tilt', 'rotate', 'size', 'x', 'y', 'light', 'focus'] as const;
export type PoseKey = (typeof POSE_KEYS)[number];
export const POSE_RANGE = {
  turn: [-720, 720],
  tilt: [-85, 85],
  rotate: [-180, 180],
  size: [0.2, 3],
  x: [-1, 1],
  y: [-1, 1],
  light: [-180, 180],
  focus: [0, 2],
} as const satisfies Record<PoseKey, readonly [number, number]>;
/** Channels compared modulo 360 (pose-jump, rebasing). */
export const ANGLE_KEYS = ['turn', 'rotate'] as const;

export type EasingName = 'smooth' | 'linear' | 'easeIn' | 'easeOut' | 'cinematic' | 'spring' | 'bezier';
export const EASING_NAMES: readonly EasingName[] = ['smooth', 'linear', 'easeIn', 'easeOut', 'cinematic', 'spring', 'bezier'];
export type Easing =
  | { kind: 'smooth' | 'linear' | 'easeIn' | 'easeOut' | 'cinematic' }
  | { kind: 'spring'; stiffness: number; damping: number } // mass 1
  | { kind: 'bezier'; x1: number; y1: number; x2: number; y2: number };
export const SPRING_RANGE = { stiffness: [1, 1000], damping: [0.1, 200] } as const;
export const SPRING_DEFAULT = { stiffness: 180, damping: 18 }; // ζ≈0.67, one soft overshoot
/** Bezier handle limits: x in 0..1 (time must move forward), y in -1..2. */
export const BEZIER_RANGE = { x: [0, 1], y: [-1, 2] } as const;
export const MIN_TRANSITION = 0.1;

/** The shot recipes (shots.ts holds their keys). Stored on a move for display only. */
export type ShotRecipe = 'spin-in' | 'turn-to-back' | 'hero-layback' | 'float' | 'settle';
export const SHOT_RECIPES: readonly ShotRecipe[] = ['spin-in', 'turn-to-back', 'hero-layback', 'float', 'settle'];

export interface PoseTransition {
  id: string;
  start: number; // OUTPUT seconds
  end: number; // OUTPUT seconds, end - start >= MIN_TRANSITION
  from?: Pose; // Start keyframe; absent = linked (continues from the pose at `start`)
  to: Pose; // End keyframe, always a full pose (ops fill partial input)
  easing: Easing;
  recipe?: ShotRecipe; // display only (lane label, info)
}

export type LightPreset = 'studio' | 'soft' | 'contrast' | 'warm' | 'night';
export const LIGHT_PRESET_NAMES: readonly LightPreset[] = ['studio', 'soft', 'contrast', 'warm', 'night'];
export type BackFinish = 'auto' | 'glossy' | 'frosted';
export const BACK_FINISHES: readonly BackFinish[] = ['auto', 'glossy', 'frosted'];
export type ShadowKind = 'wall' | 'floor';
export const SHADOW_KINDS: readonly ShadowKind[] = ['wall', 'floor'];

export interface Phone3D {
  enabled: boolean; // false = render flat, keep settings
  pose: Pose; // base pose (held before / without moves)
  camera: { fov: number /*8..60, 22*/; elevation: number /*0..30, 0*/ };
  light: { preset: LightPreset; azimuth: number /*-180..180, -35*/; intensity: number /*0..2, 1*/ };
  glass: number; // front-glass sheen 0..1, 0.25
  back: BackFinish; // auto: frosted on Pro models
  shadow: { on: boolean; kind: ShadowKind; opacity: number /*0..1,.4*/; softness: number /*0..1,.5*/ };
  dof: { on: boolean; amount: number /*0..1,.35*/; background: number /*0..1, 0*/ };
  float: { on: boolean; amount: number /*0..1,.4*/; period: number /*2..20 s, 6*/ };
  motionBlur: { on: boolean; shutter: number /*0..1 of a frame, .5*/; samples: number /*int 2..32, 12*/ };
  supersample: 1 | 2 | 3; // export and frames only; preview 1; default 1 (D19: AA comes from jitter)
  transitions: PoseTransition[]; // sorted by start, then id
}

/**
 * Every numeric setting with its range, in declared key order. One table
 * drives the defaults, the normalizer's clamps and validate.ts's errors, so
 * they can never disagree.
 */
export const PHONE3D_NUMBERS = [
  { group: 'camera', key: 'fov', range: [8, 60], def: 22 },
  { group: 'camera', key: 'elevation', range: [0, 30], def: 0 },
  { group: 'light', key: 'azimuth', range: [-180, 180], def: -35 },
  { group: 'light', key: 'intensity', range: [0, 2], def: 1 },
  { group: null, key: 'glass', range: [0, 1], def: 0.25 },
  { group: 'shadow', key: 'opacity', range: [0, 1], def: 0.4 },
  { group: 'shadow', key: 'softness', range: [0, 1], def: 0.5 },
  { group: 'dof', key: 'amount', range: [0, 1], def: 0.35 },
  { group: 'dof', key: 'background', range: [0, 1], def: 0 },
  { group: 'float', key: 'amount', range: [0, 1], def: 0.4 },
  { group: 'float', key: 'period', range: [2, 20], def: 6 },
  { group: 'motionBlur', key: 'shutter', range: [0, 1], def: 0.5 },
  { group: 'motionBlur', key: 'samples', range: [2, 32], def: 12, int: true },
] as const satisfies readonly { group: string | null; key: string; range: readonly [number, number]; def: number; int?: boolean }[];

/** The defaults. Spec §3.9 budgets "the default settings (ss 1, motion blur
 *  on, DoF on)", so both start on; the shadow starts on like the 2D frame's;
 *  float starts off (Auto 3D's subtle style turns it on). */
export function defaultPhone3D(): Phone3D {
  return {
    enabled: true,
    pose: { ...FRONT },
    camera: { fov: 22, elevation: 0 },
    light: { preset: 'studio', azimuth: -35, intensity: 1 },
    glass: 0.25,
    back: 'auto',
    shadow: { on: true, kind: 'wall', opacity: 0.4, softness: 0.5 },
    dof: { on: true, amount: 0.35, background: 0 },
    float: { on: false, amount: 0.4, period: 6 },
    motionBlur: { on: true, shutter: 0.5, samples: 12 },
    supersample: 1,
    transitions: [],
  };
}

// ---------------------------------------------------------------------------
// Normalize

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/** A full pose: each channel of `raw` that is a finite number, clamped to
 *  POSE_RANGE, else the channel of `base` (FRONT by default). Key order is
 *  POSE_KEYS. */
export function fullPose(raw: unknown, base: Readonly<Pose> = FRONT): Pose {
  const o = isObj(raw) ? raw : {};
  const out = {} as Pose;
  for (const k of POSE_KEYS) out[k] = clamp(finite(o[k], base[k]), POSE_RANGE[k][0], POSE_RANGE[k][1]);
  return out;
}

/** `pose` with every channel clamped to POSE_RANGE (non-finite → FRONT). */
export const clampPose = (pose: Readonly<Pose>): Pose => fullPose(pose, FRONT);

/** Easing params are kept only for their own kind. A spring with missing
 *  numbers gets SPRING_DEFAULT's; a bezier with a missing or non-finite
 *  handle becomes `cinematic`. In-range clamps keep the result valid. */
export function normalizeEasing(raw: unknown): Easing {
  const o = isObj(raw) ? raw : {};
  const kind = oneOf(o.kind, EASING_NAMES, 'smooth');
  if (kind === 'spring') {
    return {
      kind,
      stiffness: clamp(finite(o.stiffness, SPRING_DEFAULT.stiffness), SPRING_RANGE.stiffness[0], SPRING_RANGE.stiffness[1]),
      damping: clamp(finite(o.damping, SPRING_DEFAULT.damping), SPRING_RANGE.damping[0], SPRING_RANGE.damping[1]),
    };
  }
  if (kind === 'bezier') {
    const ok = (['x1', 'y1', 'x2', 'y2'] as const).every((k) => typeof o[k] === 'number' && Number.isFinite(o[k]));
    if (!ok) return { kind: 'cinematic' };
    return {
      kind,
      x1: clamp(o.x1 as number, BEZIER_RANGE.x[0], BEZIER_RANGE.x[1]),
      y1: clamp(o.y1 as number, BEZIER_RANGE.y[0], BEZIER_RANGE.y[1]),
      x2: clamp(o.x2 as number, BEZIER_RANGE.x[0], BEZIER_RANGE.x[1]),
      y2: clamp(o.y2 as number, BEZIER_RANGE.y[0], BEZIER_RANGE.y[1]),
    };
  }
  return { kind };
}

/** Transitions in timeline order: by start, then id (code-point order, so
 *  the result never depends on the machine's locale). */
export function compareTransitions(a: Pick<PoseTransition, 'start' | 'id'>, b: Pick<PoseTransition, 'start' | 'id'>): number {
  return a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function normalizeTransition(raw: unknown, index: number): PoseTransition | null {
  if (!isObj(raw)) return null;
  if (typeof raw.start !== 'number' || !Number.isFinite(raw.start)) return null;
  if (typeof raw.end !== 'number' || !Number.isFinite(raw.end)) return null;
  // A move that starts before 0 keeps its end (the moment it lands on).
  const start = Math.max(0, raw.start);
  const end = raw.end;
  if (end - start < MIN_TRANSITION) return null;
  const tr: PoseTransition = {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : `t${index}`,
    start,
    end,
  } as PoseTransition;
  if (isObj(raw.from)) tr.from = fullPose(raw.from);
  tr.to = fullPose(raw.to);
  tr.easing = normalizeEasing(raw.easing);
  if (SHOT_RECIPES.includes(raw.recipe as ShotRecipe)) tr.recipe = raw.recipe as ShotRecipe;
  return tr;
}

/**
 * Any saved value → a valid Phone3D, or undefined (the key is then deleted:
 * a non-object is not a 3D setup). The object is rebuilt in declared key
 * order from defaultPhone3D(): numbers are made finite and clamped, bad enums
 * become their default, `samples` is rounded. Transitions with a non-finite
 * start/end or shorter than MIN_TRANSITION are dropped, a missing id becomes
 * `t${index}`, partial poses are merged over FRONT (a pose saved before
 * `focus` existed gets focus 1: no visual change), and the list is sorted.
 * Idempotent: normalizePhone3D(normalizePhone3D(x)) is JSON-equal to
 * normalizePhone3D(x).
 */
export function normalizePhone3D(raw: unknown): Phone3D | undefined {
  if (!isObj(raw)) return undefined;
  const d = defaultPhone3D();
  const group = (k: string) => (isObj(raw[k]) ? (raw[k] as Record<string, unknown>) : {});
  const cam = group('camera');
  const light = group('light');
  const shadow = group('shadow');
  const dof = group('dof');
  const float = group('float');
  const mb = group('motionBlur');
  const numIn = (g: Record<string, unknown>, groupName: string | null, key: string) => {
    const spec = PHONE3D_NUMBERS.find((n) => n.group === groupName && n.key === key)!;
    const v = clamp(finite(g[key], spec.def), spec.range[0], spec.range[1]);
    return 'int' in spec && spec.int ? Math.round(v) : v;
  };
  const transitions = (Array.isArray(raw.transitions) ? raw.transitions : [])
    .map((t, i) => normalizeTransition(t, i))
    .filter((t): t is PoseTransition => t !== null)
    .sort(compareTransitions);
  return {
    enabled: bool(raw.enabled, d.enabled),
    pose: fullPose(raw.pose),
    camera: { fov: numIn(cam, 'camera', 'fov'), elevation: numIn(cam, 'camera', 'elevation') },
    light: {
      preset: oneOf(light.preset, LIGHT_PRESET_NAMES, d.light.preset),
      azimuth: numIn(light, 'light', 'azimuth'),
      intensity: numIn(light, 'light', 'intensity'),
    },
    glass: numIn(raw, null, 'glass'),
    back: oneOf(raw.back, BACK_FINISHES, d.back),
    shadow: {
      on: bool(shadow.on, d.shadow.on),
      kind: oneOf(shadow.kind, SHADOW_KINDS, d.shadow.kind),
      opacity: numIn(shadow, 'shadow', 'opacity'),
      softness: numIn(shadow, 'shadow', 'softness'),
    },
    dof: { on: bool(dof.on, d.dof.on), amount: numIn(dof, 'dof', 'amount'), background: numIn(dof, 'dof', 'background') },
    float: { on: bool(float.on, d.float.on), amount: numIn(float, 'float', 'amount'), period: numIn(float, 'float', 'period') },
    motionBlur: { on: bool(mb.on, d.motionBlur.on), shutter: numIn(mb, 'motionBlur', 'shutter'), samples: numIn(mb, 'motionBlur', 'samples') },
    supersample: raw.supersample === 1 || raw.supersample === 2 || raw.supersample === 3 ? raw.supersample : d.supersample,
    transitions,
  };
}
