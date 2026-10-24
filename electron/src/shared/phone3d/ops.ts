// The 3D phone's edit ops (SPEC §4.1): phone3d, setPose, addTransition,
// editTransition, removeTransition, clearTransitions and shot. agentOps.ts
// dispatches to applyPhone3dOp and adds `direct` (which needs the planner).
//
// They live here, not in agentOps.ts, so the planner (direct.ts) and the
// warnings (warnings.ts) can apply them to check a plan or a fix without an
// import cycle back into agentOps.
//
// Pure: no clock, no randomness (ids come from the caller). Every op:
// - refuses a project that is not an iPhone/iPad take
// - refuses bad input with a clear message instead of clamping it, so an op
//   the CLI refuses is refused in the editor too
// - stores full poses (partial input fills from the pose at the move's start)
// - leaves phone3d.transitions sorted with compareTransitions and ids unique

import { springSettleTime } from './easing3d';
import {
  BACK_FINISHES,
  BEZIER_RANGE,
  compareTransitions,
  defaultPhone3D,
  EASING_NAMES,
  LIGHT_PRESET_NAMES,
  MIN_TRANSITION,
  tooShort,
  PHONE3D_NUMBERS,
  POSE_KEYS,
  POSE_RANGE,
  SHADOW_KINDS,
  SHOT_RECIPES,
  SPRING_DEFAULT,
  SPRING_RANGE,
  type Easing,
  type EasingName,
  type Phone3D,
  type Pose,
  type PoseKey,
  type PoseTransition,
  type ShotRecipe,
} from './model';
import { poseAt, poseDelta, poseTargetAt, resolveStarts } from './pose';
import { defaultShotDuration, expandShot, INTENSITY_RANGE, shotBase, shotKeys, SHOTS, type ShotReturn } from './shots';
import { isPhoneProject } from '../mobileProject';
import type { Project } from '../types';
import type { EditOp } from '../agentOps';

/** A refused 3D op. agentOps turns it into an OpError. */
export class Phone3dOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Phone3dOpError';
  }
}

/** The ops applyPhone3dOp handles (agentOps adds `direct`). */
export const PHONE3D_OP_NAMES = ['phone3d', 'setPose', 'addTransition', 'editTransition', 'removeTransition', 'clearTransitions', 'shot'] as const;
export type Phone3dOpName = (typeof PHONE3D_OP_NAMES)[number];
export const isPhone3dOp = (name: string): name is Phone3dOpName => (PHONE3D_OP_NAMES as readonly string[]).includes(name);

/**
 * Every field each 3D op accepts (anything else is refused, so a typo never
 * silently does nothing). `direct` is in agentOps.ts but listed here too, so
 * one table documents every 3D op; the parity test (test/opsParity.test.ts)
 * reads it.
 */
export const PHONE3D_OP_FIELDS = {
  phone3d: ['enabled', 'clear', 'pose', 'camera', 'light', 'glass', 'back', 'shadow', 'dof', 'float', 'motionBlur', 'supersample'],
  setPose: ['at', 'target', 'id', 'index', 'end', ...POSE_KEYS],
  addTransition: ['start', 'end', 'from', 'to', 'easing', 'stiffness', 'damping', 'bezier', 'fitDuration'],
  editTransition: ['id', 'index', 'start', 'end', 'by', 'from', 'to', 'easing', 'stiffness', 'damping', 'bezier', 'fitDuration', 'swap', 'resetEnd'],
  removeTransition: ['id', 'index'],
  clearTransitions: [],
  shot: ['recipe', 'at', 'duration', 'intensity', 'direction', 'return'],
  direct: ['style', 'replace', 'scenes'],
} as const satisfies Record<Phone3dOpName | 'direct', readonly string[]>;

export const NOT_IPHONE = '3D phone needs an iPhone recording';
/** addTransition's length when neither `end` nor `fitDuration` is given (the lane's Option-click). */
export const DEFAULT_MOVE_LENGTH = 1.2;

const fail = (msg: string): never => {
  throw new Phone3dOpError(msg);
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const fmt = (s: number) => s.toFixed(2);

// ---------------------------------------------------------------------------
// Argument readers

/** Refuses fields an op does not know (a typo would otherwise do nothing). */
export function allowOnly(o: EditOp, keys: readonly string[] = PHONE3D_OP_FIELDS[o.op as keyof typeof PHONE3D_OP_FIELDS] ?? []) {
  for (const k of Object.keys(o)) {
    if (k !== 'op' && !keys.includes(k)) fail(`${o.op}: unknown field "${k}" (known: ${keys.join(', ')})`);
  }
}
const num = (o: EditOp, k: string): number => (isNum(o[k]) ? (o[k] as number) : fail(`${o.op}: "${k}" must be a number`));
const optNum = (o: EditOp, k: string): number | undefined => (o[k] === undefined ? undefined : num(o, k));
const optBool = (o: EditOp, k: string): boolean | undefined => {
  const v = o[k];
  if (v === undefined) return undefined;
  return typeof v === 'boolean' ? v : fail(`${o.op}: "${k}" must be true or false`);
};

const rangeText = (r: readonly [number, number]) => `${r[0]}..${r[1]}`;

/** Pose channels from an object: each one a finite number inside POSE_RANGE; unknown channels refused. */
export function posePatch(raw: unknown, what: string): Partial<Pose> {
  if (!isObj(raw)) return fail(`${what} must be a pose object ({turn, tilt, rotate, size, x, y, light, focus}, any subset)`);
  const out: Partial<Pose> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(POSE_KEYS as readonly string[]).includes(k)) fail(`${what}: unknown pose channel "${k}" (${POSE_KEYS.join(', ')})`);
    const key = k as PoseKey;
    const r = POSE_RANGE[key];
    if (!isNum(v) || v < r[0] || v > r[1]) fail(`${what}.${key} must be ${rangeText(r)}`);
    out[key] = v as number;
  }
  return out;
}

/** The pose channels given as top-level fields of `o` (setPose). */
function topLevelPose(o: EditOp): Partial<Pose> {
  const raw: Record<string, unknown> = {};
  for (const k of POSE_KEYS) if (o[k] !== undefined) raw[k] = o[k];
  return posePatch(raw, o.op);
}

const fullFrom = (base: Readonly<Pose>, patch: Partial<Pose>): Pose => {
  const out = {} as Pose;
  for (const k of POSE_KEYS) out[k] = patch[k] ?? base[k];
  return out;
};

function checkSpring(op: string, stiffness: number, damping: number): Easing {
  if (!(stiffness >= SPRING_RANGE.stiffness[0] && stiffness <= SPRING_RANGE.stiffness[1])) fail(`${op}: stiffness must be ${rangeText(SPRING_RANGE.stiffness)}`);
  if (!(damping >= SPRING_RANGE.damping[0] && damping <= SPRING_RANGE.damping[1])) fail(`${op}: damping must be ${rangeText(SPRING_RANGE.damping)}`);
  return { kind: 'spring', stiffness, damping };
}

function checkBezier(op: string, v: unknown): Easing {
  if (!Array.isArray(v) || v.length !== 4 || !v.every(isNum)) return fail(`${op}: bezier must be [x1, y1, x2, y2] (numbers)`);
  const [x1, y1, x2, y2] = v as number[];
  const inX = (x: number) => x >= BEZIER_RANGE.x[0] && x <= BEZIER_RANGE.x[1];
  const inY = (y: number) => y >= BEZIER_RANGE.y[0] && y <= BEZIER_RANGE.y[1];
  if (!inX(x1) || !inX(x2)) fail(`${op}: bezier x1 and x2 must be 0..1`);
  if (!inY(y1) || !inY(y2)) fail(`${op}: bezier y1 and y2 must be -1..2`);
  return { kind: 'bezier', x1, y1, x2, y2 };
}

/**
 * The easing an op asks for, or undefined when it names none. Accepts
 * `easing: name` (with top-level `stiffness`/`damping` for a spring),
 * `easing: {kind, …}` (a full object), or `bezier: [x1, y1, x2, y2]`. A
 * spring's missing numbers come from `cur` (when it is a spring), else
 * SPRING_DEFAULT. Out-of-range values are refused, never clamped.
 */
export function readEasing(o: EditOp, cur?: Easing): Easing | undefined {
  const raw = o.easing;
  if (raw === undefined && o.bezier === undefined && o.stiffness === undefined && o.damping === undefined) return undefined;
  if (isObj(raw)) {
    if (o.bezier !== undefined || o.stiffness !== undefined || o.damping !== undefined) fail(`${o.op}: give the easing either as an object or as fields, not both`);
    const kind = raw.kind as EasingName;
    if (!EASING_NAMES.includes(kind)) fail(`${o.op}: easing.kind must be ${EASING_NAMES.join('|')}`);
    if (kind === 'spring') return checkSpring(o.op, isNum(raw.stiffness) ? raw.stiffness : SPRING_DEFAULT.stiffness, isNum(raw.damping) ? raw.damping : SPRING_DEFAULT.damping);
    if (kind === 'bezier') return checkBezier(o.op, [raw.x1, raw.y1, raw.x2, raw.y2]);
    return { kind } as Easing;
  }
  let kind: EasingName | undefined;
  if (raw !== undefined) {
    if (typeof raw !== 'string' || !EASING_NAMES.includes(raw as EasingName)) return fail(`${o.op}: easing must be ${EASING_NAMES.join('|')} or an {kind, …} object`);
    kind = raw as EasingName;
  } else if (o.bezier !== undefined) kind = 'bezier';
  else if (cur?.kind === 'spring') kind = 'spring';
  else return fail(`${o.op}: stiffness and damping need "easing": "spring"`);

  if (o.bezier !== undefined && kind !== 'bezier') fail(`${o.op}: "bezier" needs "easing": "bezier" (or leave easing out)`);
  if ((o.stiffness !== undefined || o.damping !== undefined) && kind !== 'spring') fail(`${o.op}: stiffness and damping need "easing": "spring"`);
  if (kind === 'spring') {
    const was = cur?.kind === 'spring' ? cur : SPRING_DEFAULT;
    return checkSpring(o.op, optNum(o, 'stiffness') ?? was.stiffness, optNum(o, 'damping') ?? was.damping);
  }
  if (kind === 'bezier') {
    if (o.bezier !== undefined) return checkBezier(o.op, o.bezier);
    if (cur?.kind === 'bezier') return { ...cur };
    return fail(`${o.op}: easing "bezier" needs "bezier": [x1, y1, x2, y2]`);
  }
  return { kind } as Easing;
}

const easingLabel = (e: Easing) => (e.kind === 'spring' ? `spring ${e.stiffness}/${e.damping}` : e.kind);

// ---------------------------------------------------------------------------
// Helpers on the project

function requirePhone(p: Project, op: string) {
  if (!isPhoneProject(p)) fail(`${op}: ${NOT_IPHONE}`);
}

/** The project's phone3d, or the defaults when it has none yet (the first 3D edit seeds them). */
const current = (p: Project): Phone3D => p.phone3d ?? defaultPhone3D();

const withP3 = (p: Project, p3: Phone3D): Project => ({ ...p, phone3d: p3 });

const sorted = (list: PoseTransition[]) => [...list].sort(compareTransitions);

/** A transition with its keys in the normalizer's order (id, start, end, from?, to, easing, recipe?). */
function tidy(tr: PoseTransition): PoseTransition {
  const out = { id: tr.id, start: tr.start, end: tr.end } as PoseTransition;
  if (tr.from) out.from = { ...tr.from };
  out.to = { ...tr.to };
  out.easing = { ...tr.easing };
  if (tr.recipe) out.recipe = tr.recipe;
  return out;
}

/** Ids from newId that are not in use yet (a replayed id list stays deterministic). */
function freshIds(list: readonly PoseTransition[], newId: () => string): () => string {
  const taken = new Set(list.map((t) => t.id));
  return () => {
    for (let i = 0; i < 64; i++) {
      const id = newId();
      if (typeof id === 'string' && id && !taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
    return fail('could not make a new 3D move id');
  };
}

function locateMove(o: EditOp, list: readonly PoseTransition[]): number {
  if (typeof o.id === 'string') {
    const i = list.findIndex((t) => t.id === o.id);
    return i >= 0 ? i : fail(`${o.op}: no 3D move with id ${o.id}`);
  }
  if (typeof o.index === 'number') {
    if (!Number.isInteger(o.index) || o.index < 0 || o.index >= list.length) {
      return fail(`${o.op}: 3D move index ${o.index} out of range${list.length ? ` (0..${list.length - 1})` : ' (there are no moves)'}`);
    }
    return o.index;
  }
  return fail(`${o.op}: pass "id" or "index" to pick the 3D move`);
}

function checkTimes(op: string, start: number, end: number) {
  if (!(start >= 0)) fail(`${op}: start must be >= 0`);
  if (tooShort(start, end)) fail(`${op}: a move must last at least ${MIN_TRANSITION} s (end − start)`);
}

const samePose = (a: Readonly<Pose>, b: Readonly<Pose>, eps = 1e-9) => POSE_KEYS.every((k) => Math.abs(a[k] - b[k]) <= eps);
/** a and b differ only by whole turns of turn/rotate (the same picture). */
const sameModTurns = (a: Readonly<Pose>, b: Readonly<Pose>) => {
  const d = poseDelta(a, b);
  return POSE_KEYS.every((k) => Math.abs(d[k]) <= 1e-9);
};

// ---------------------------------------------------------------------------
// Settings (the `phone3d` op)

type Group = 'camera' | 'light' | 'shadow' | 'dof' | 'float' | 'motionBlur';
const GROUP_FIELDS: Record<Group, readonly string[]> = {
  camera: ['fov', 'elevation'],
  light: ['preset', 'azimuth', 'intensity'],
  shadow: ['on', 'kind', 'opacity', 'softness'],
  dof: ['on', 'amount', 'background'],
  float: ['on', 'amount', 'period'],
  motionBlur: ['on', 'shutter', 'samples'],
};
const ENUMS: Record<string, readonly string[]> = { 'light.preset': LIGHT_PRESET_NAMES, 'shadow.kind': SHADOW_KINDS };

function numberSetting(op: string, group: string | null, key: string, v: unknown): number {
  const spec = PHONE3D_NUMBERS.find((n) => n.group === group && n.key === key)!;
  const path = group ? `${group}.${key}` : key;
  const int = 'int' in spec && spec.int;
  if (!isNum(v) || v < spec.range[0] || v > spec.range[1] || (int && !Number.isInteger(v))) {
    fail(`${op}: ${path} must be ${int ? 'an integer ' : ''}${rangeText(spec.range)}`);
  }
  return v as number;
}

/** A settings group merged with the op's sub-object (each field checked). */
function mergeGroup<G extends Group>(op: string, group: G, cur: Phone3D[G], raw: unknown): Phone3D[G] {
  if (!isObj(raw)) return fail(`${op}: ${group} must be an object`);
  const next = { ...cur } as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw)) {
    if (!GROUP_FIELDS[group].includes(k)) fail(`${op}: unknown field ${group}.${k} (known: ${GROUP_FIELDS[group].join(', ')})`);
    const enumList = ENUMS[`${group}.${k}`];
    if (k === 'on') next[k] = typeof v === 'boolean' ? v : fail(`${op}: ${group}.on must be true or false`);
    else if (enumList) next[k] = enumList.includes(v as string) ? v : fail(`${op}: ${group}.${k} must be ${enumList.join('|')}`);
    else next[k] = numberSetting(op, group, k, v);
  }
  return next as Phone3D[G];
}

function phone3dOp(p: Project, o: EditOp) {
  allowOnly(o);
  if (o.clear !== undefined) {
    if (o.clear !== true) fail('phone3d: clear must be true');
    if (Object.keys(o).some((k) => k !== 'op' && k !== 'clear')) fail('phone3d: clear:true takes no other fields');
    if (!p.phone3d) return { project: p, note: 'no 3D phone to remove' };
    const { phone3d: _gone, ...rest } = p;
    return { project: rest as Project, note: '3D phone removed (flat again)' };
  }
  if (Object.keys(o).length === 1) fail('phone3d: pass enabled, clear:true, or a setting (pose, camera, light, glass, back, shadow, dof, float, motionBlur, supersample)');
  const seeded = !p.phone3d;
  const p3 = { ...current(p) };
  const enabled = optBool(o, 'enabled');
  if (enabled !== undefined) p3.enabled = enabled;
  if (o.pose !== undefined) p3.pose = fullFrom(p3.pose, posePatch(o.pose, 'phone3d: pose'));
  for (const g of Object.keys(GROUP_FIELDS) as Group[]) {
    if (o[g] !== undefined) (p3 as Record<Group, unknown>)[g] = mergeGroup('phone3d', g, p3[g], o[g]);
  }
  if (o.glass !== undefined) p3.glass = numberSetting('phone3d', null, 'glass', o.glass);
  if (o.back !== undefined) p3.back = BACK_FINISHES.includes(o.back as never) ? (o.back as Phone3D['back']) : fail(`phone3d: back must be ${BACK_FINISHES.join('|')}`);
  if (o.supersample !== undefined) p3.supersample = o.supersample === 1 || o.supersample === 2 || o.supersample === 3 ? o.supersample : fail('phone3d: supersample must be 1, 2 or 3');
  const { op: _op, ...fields } = o;
  const what = JSON.stringify(fields);
  return { project: withP3(p, p3), note: seeded ? `3D phone ${p3.enabled ? 'on' : 'set up (off)'}, defaults + ${what}` : `3D phone ${what}` };
}

// ---------------------------------------------------------------------------
// Keyframes

function setPoseOp(p: Project, o: EditOp) {
  allowOnly(o);
  const patch = topLevelPose(o);
  if (!Object.keys(patch).length) fail(`setPose: pass at least one pose channel (${POSE_KEYS.join(', ')})`);
  const p3 = { ...current(p) };
  const list = p3.transitions;
  if (o.target !== undefined && o.target !== 'base' && o.target !== 'auto') fail('setPose: target must be "base" (or "auto")');
  let kind: 'base' | 'from' | 'to';
  let index = -1;
  if (o.target === 'base') kind = 'base';
  else if (o.id !== undefined || o.index !== undefined) {
    index = locateMove(o, list);
    if (o.end !== 'from' && o.end !== 'to') fail('setPose: with id/index, pass end: "from" (Start) or "to" (End)');
    kind = o.end as 'from' | 'to';
  } else {
    const at = num(o, 'at');
    const t = poseTargetAt(p3, at);
    kind = t.kind;
    if (t.kind !== 'base') index = t.index;
  }
  if (kind === 'base') {
    p3.pose = fullFrom(p3.pose, patch);
    return { project: withP3(p, p3), note: 'setPose edited the base pose' };
  }
  const tr = { ...list[index] };
  let note: string;
  if (kind === 'from') {
    const linked = !tr.from;
    tr.from = fullFrom(tr.from ?? resolveStarts(p3)[index], patch);
    note = `setPose edited Start of ${tr.id}${linked ? ' (now explicit, no longer linked)' : ''}`;
  } else {
    tr.to = fullFrom(tr.to, patch);
    note = `setPose edited End of ${tr.id}`;
  }
  p3.transitions = list.map((x, i) => (i === index ? tidy(tr) : x));
  return { project: withP3(p, p3), note };
}

function addTransitionOp(p: Project, o: EditOp, newId: () => string) {
  allowOnly(o);
  const p3 = { ...current(p) };
  const start = num(o, 'start');
  const easing = readEasing(o) ?? { kind: 'smooth' };
  const fit = optBool(o, 'fitDuration');
  if (fit && o.end !== undefined) fail('addTransition: pass end or fitDuration:true, not both');
  if (fit && easing.kind !== 'spring') fail('addTransition: fitDuration needs "easing": "spring"');
  const end = fit && easing.kind === 'spring' ? start + springSettleTime(easing.stiffness, easing.damping) : (optNum(o, 'end') ?? start + DEFAULT_MOVE_LENGTH);
  checkTimes('addTransition', start, end);
  if (o.to === undefined) fail('addTransition: "to" (the End pose) is required');
  const at = poseAt(p3, start);
  const tr: PoseTransition = { id: freshIds(p3.transitions, newId)(), start, end, to: fullFrom(at, posePatch(o.to, 'addTransition: to')), easing };
  if (o.from !== undefined && o.from !== null) tr.from = fullFrom(at, posePatch(o.from, 'addTransition: from'));
  p3.transitions = sorted([...p3.transitions, tidy(tr)]);
  return { project: withP3(p, p3), note: `added 3D move ${tr.id} ${fmt(start)}–${fmt(end)} s (${easingLabel(easing)})` };
}

function editTransitionOp(p: Project, o: EditOp) {
  allowOnly(o);
  const p3 = { ...current(p) };
  const list = p3.transitions;
  const i = locateMove(o, list);
  const tr: PoseTransition = { ...list[i] };
  const starts = resolveStarts(p3);
  const did: string[] = [];
  // swap / resetEnd run first, then the other fields.
  if (optBool(o, 'swap')) {
    const from = tr.from ?? starts[i];
    tr.from = { ...tr.to };
    tr.to = { ...from };
    did.push('swapped Start/End');
  }
  if (optBool(o, 'resetEnd')) {
    tr.to = { ...(tr.from ?? starts[i]) };
    did.push('End reset to Start');
  }
  if (o.from === null) {
    delete tr.from;
    did.push('Start linked');
  } else if (o.from !== undefined) {
    tr.from = fullFrom(tr.from ?? starts[i], posePatch(o.from, 'editTransition: from'));
    did.push('Start');
  }
  if (o.to !== undefined) {
    tr.to = fullFrom(tr.to, posePatch(o.to, 'editTransition: to'));
    did.push('End');
  }
  const by = optNum(o, 'by');
  if (by !== undefined) {
    if (o.start !== undefined || o.end !== undefined) fail('editTransition: pass by, or start/end, not both');
    tr.start += by;
    tr.end += by;
    did.push(`shifted ${by >= 0 ? '+' : ''}${fmt(by)} s`);
  } else {
    const start = optNum(o, 'start');
    const end = optNum(o, 'end');
    if (start !== undefined) tr.start = start;
    if (end !== undefined) tr.end = end;
    if (start !== undefined || end !== undefined) did.push(`${fmt(tr.start)}–${fmt(tr.end)} s`);
  }
  const easing = readEasing(o, tr.easing);
  if (easing) {
    tr.easing = easing;
    did.push(easingLabel(easing));
  }
  if (optBool(o, 'fitDuration')) {
    if (o.end !== undefined || by !== undefined) fail('editTransition: fitDuration sets the end; do not also pass end or by');
    const e = tr.easing;
    if (e.kind !== 'spring') return fail('editTransition: fitDuration needs a spring easing');
    tr.end = tr.start + springSettleTime(e.stiffness, e.damping);
    did.push(`fitted to ${fmt(tr.end - tr.start)} s`);
  }
  if (!did.length) fail('editTransition: nothing to change (start, end, by, from, to, easing, fitDuration, swap, resetEnd)');
  checkTimes('editTransition', tr.start, tr.end);
  p3.transitions = sorted(list.map((x, j) => (j === i ? tidy(tr) : x)));
  return { project: withP3(p, p3), note: `edited 3D move ${tr.id}: ${did.join(', ')}` };
}

function removeTransitionOp(p: Project, o: EditOp) {
  allowOnly(o);
  const p3 = { ...current(p) };
  const i = locateMove(o, p3.transitions);
  const id = p3.transitions[i].id;
  p3.transitions = p3.transitions.filter((_, j) => j !== i);
  return { project: withP3(p, p3), note: `removed 3D move ${id}` };
}

function clearTransitionsOp(p: Project, o: EditOp) {
  allowOnly(o);
  if (!p.phone3d?.transitions.length) return { project: p, note: 'no 3D moves to clear' };
  const n = p.phone3d.transitions.length;
  return { project: withP3(p, { ...p.phone3d, transitions: [] }), note: `cleared ${n} 3D move${n === 1 ? '' : 's'}` };
}

// ---------------------------------------------------------------------------
// Shots

function shotOp(p: Project, o: EditOp, newId: () => string) {
  allowOnly(o);
  const recipe = o.recipe as ShotRecipe;
  if (!SHOT_RECIPES.includes(recipe)) fail(`shot: recipe must be ${SHOT_RECIPES.join('|')}`);
  const p3 = { ...current(p) };
  if (recipe === 'float') {
    p3.float = { ...p3.float, on: true };
    return { project: withP3(p, p3), note: 'shot float: idle float on' };
  }
  const at = num(o, 'at');
  if (at < 0) fail('shot: at must be >= 0');
  const ret = (o.return ?? 'front') as ShotReturn;
  if (ret !== 'front' && ret !== 'stay') fail('shot: return must be "front" or "stay"');
  const intensity = optNum(o, 'intensity') ?? 1;
  if (intensity < INTENSITY_RANGE[0] || intensity > INTENSITY_RANGE[1]) fail(`shot: intensity must be ${rangeText(INTENSITY_RANGE)}`);
  const direction = o.direction ?? 1;
  if (direction !== 1 && direction !== -1) fail('shot: direction must be 1 or -1');
  const { keys } = shotKeys(recipe, ret);
  const duration = optNum(o, 'duration') ?? defaultShotDuration(recipe, ret);
  const shortest = Math.min(...keys.map((k) => k.frac[1] - k.frac[0]));
  if (!(duration * shortest >= MIN_TRANSITION - 1e-9)) fail(`shot: duration must be at least ${fmt(MIN_TRANSITION / shortest)} s for ${recipe}`);
  const end = at + duration;

  // Moves that overlap the shot are replaced.
  const kept = p3.transitions.filter((tr) => !(tr.start < end - 1e-9 && tr.end > at + 1e-9));
  const replaced = p3.transitions.length - kept.length;
  const p3k = { ...p3, transitions: kept };
  const before = poseAt(p3k, at);
  const made = expandShot(recipe, { start: at, duration, intensity, direction: direction as 1 | -1, ret }, before, freshIds(p3.transitions, newId)).transitions;
  let list = sorted([...kept, ...made]);

  // The shot's first move must start where expandShot planned it (the rebased
  // `before`). A linked first move resolves from whatever precedes it, which
  // can differ (e.g. it became the first move and resolves from the base
  // pose); then its Start is written out.
  const planned = made[0].from ?? shotBase(before);
  const firstAt = list.findIndex((t) => t.id === made[0].id);
  if (!list[firstAt].from && !samePose(resolveStarts({ pose: p3.pose, transitions: list })[firstAt], planned)) {
    list[firstAt] = tidy({ ...list[firstAt], from: { ...planned } });
  }

  // The move after the shot, when linked, keeps its old Start if the shot
  // only changed it by whole turns (a round trip that ends at +360): it would
  // otherwise unwind a full turn on its way to its own End.
  const lastAt = list.findIndex((t) => t.id === made[made.length - 1].id);
  const next = list[lastAt + 1];
  if (next && !next.from) {
    const oldStart = resolveStarts(p3k)[kept.findIndex((t) => t.id === next.id)];
    const newStart = resolveStarts({ pose: p3.pose, transitions: list })[lastAt + 1];
    if (!samePose(oldStart, newStart) && sameModTurns(oldStart, newStart)) list[lastAt + 1] = tidy({ ...next, from: { ...oldStart } });
  }
  list = sorted(list);
  p3.transitions = list;
  const extra = [
    intensity !== 1 ? `intensity ${intensity}` : '',
    direction === -1 ? 'mirrored' : '',
    ret === 'stay' && SHOTS[recipe].keys.some((k) => k.ret) ? 'one-way' : '',
    replaced ? `replaced ${replaced} move${replaced === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return {
    project: withP3(p, p3),
    note: `shot ${recipe} ${fmt(at)}–${fmt(end)} s: ${made.map((t) => t.id).join(', ')}${extra.length ? ` (${extra.join(', ')})` : ''}`,
  };
}

// ---------------------------------------------------------------------------

/** Applies one 3D op (not `direct`). Throws Phone3dOpError on bad input. */
export function applyPhone3dOp(p: Project, o: EditOp, newId: () => string): { project: Project; note: string } {
  requirePhone(p, o.op);
  switch (o.op as Phone3dOpName) {
    case 'phone3d':
      return phone3dOp(p, o);
    case 'setPose':
      return setPoseOp(p, o);
    case 'addTransition':
      return addTransitionOp(p, o, newId);
    case 'editTransition':
      return editTransitionOp(p, o);
    case 'removeTransition':
      return removeTransitionOp(p, o);
    case 'clearTransitions':
      return clearTransitionsOp(p, o);
    case 'shot':
      return shotOp(p, o, newId);
    default:
      return fail(`not a 3D op: ${o.op}`);
  }
}

/** The moves as `info` prints them: resolved Start, End, timing, easing. */
export function describeTransitions(p3: Pick<Phone3D, 'pose' | 'transitions'>) {
  const starts = resolveStarts(p3);
  return p3.transitions.map((tr, index) => ({
    index,
    id: tr.id,
    start: tr.start,
    end: tr.end,
    duration: tr.end - tr.start,
    linked: !tr.from,
    from: starts[index],
    to: { ...tr.to },
    easing: { ...tr.easing },
    ...(tr.recipe ? { recipe: tr.recipe } : {}),
  }));
}
