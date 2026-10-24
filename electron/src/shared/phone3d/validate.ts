// Hard validation of project.phone3d: structural problems only (D6). Overlap,
// past-the-end, steep angles, off-canvas and an inactive gate are warnings
// (warnings.ts), never errors, so a trim can never lock applyOps.
//
// validateProject (agentOps.ts) calls this when the key is present:
//   if (p.phone3d !== undefined) errs.push(...phone3dProblems(p))

import {
  BACK_FINISHES,
  BEZIER_RANGE,
  EASING_NAMES,
  LIGHT_PRESET_NAMES,
  MIN_TRANSITION,
  PHONE3D_NUMBERS,
  POSE_KEYS,
  POSE_RANGE,
  SHADOW_KINDS,
  SHOT_RECIPES,
  SPRING_RANGE,
} from './model';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, r: readonly [number, number]) => isNum(v) && v >= r[0] && v <= r[1];

function poseProblems(raw: unknown, path: string, errs: string[]) {
  if (!isObj(raw)) {
    errs.push(`${path} must be a pose object`);
    return;
  }
  for (const k of POSE_KEYS) {
    const r = POSE_RANGE[k];
    if (!inRange(raw[k], r)) errs.push(`${path}.${k} must be ${r[0]}..${r[1]}`);
  }
}

function easingProblems(raw: unknown, path: string, errs: string[]) {
  if (!isObj(raw) || !EASING_NAMES.includes(raw.kind as never)) {
    errs.push(`${path}.kind must be ${EASING_NAMES.join('|')}`);
    return;
  }
  if (raw.kind === 'spring') {
    for (const k of ['stiffness', 'damping'] as const) {
      const r = SPRING_RANGE[k];
      if (!inRange(raw[k], r)) errs.push(`${path}.${k} must be ${r[0]}..${r[1]}`);
    }
  } else if (raw.kind === 'bezier') {
    for (const k of ['x1', 'x2'] as const) if (!inRange(raw[k], BEZIER_RANGE.x)) errs.push(`${path}.${k} must be 0..1`);
    for (const k of ['y1', 'y2'] as const) if (!inRange(raw[k], BEZIER_RANGE.y)) errs.push(`${path}.${k} must be -1..2`);
  }
}

/** Every structural problem in `p.phone3d`, as validateProject messages. */
export function phone3dProblems(p: { phone3d?: unknown }): string[] {
  const errs: string[] = [];
  const raw = p.phone3d;
  if (raw === undefined) return errs;
  if (!isObj(raw)) return ['phone3d must be an object'];

  if (typeof raw.enabled !== 'boolean') errs.push('phone3d.enabled must be true or false');
  poseProblems(raw.pose, 'phone3d.pose', errs);

  for (const n of PHONE3D_NUMBERS) {
    const src = n.group === null ? raw : raw[n.group];
    const path = n.group === null ? `phone3d.${n.key}` : `phone3d.${n.group}.${n.key}`;
    if (n.group !== null && !isObj(src)) continue; // reported once below
    const v = (src as Record<string, unknown>)[n.key];
    if ('int' in n && n.int) {
      if (!(Number.isInteger(v) && inRange(v, n.range))) errs.push(`${path} must be an integer ${n.range[0]}..${n.range[1]}`);
    } else if (!inRange(v, n.range)) errs.push(`${path} must be ${n.range[0]}..${n.range[1]}`);
  }
  for (const g of ['camera', 'light', 'shadow', 'dof', 'float', 'motionBlur'] as const) {
    if (!isObj(raw[g])) errs.push(`phone3d.${g} must be an object`);
  }
  for (const g of ['shadow', 'dof', 'float', 'motionBlur'] as const) {
    const o = raw[g];
    if (isObj(o) && typeof o.on !== 'boolean') errs.push(`phone3d.${g}.on must be true or false`);
  }
  const light = raw.light;
  if (isObj(light) && !LIGHT_PRESET_NAMES.includes(light.preset as never)) errs.push(`phone3d.light.preset must be ${LIGHT_PRESET_NAMES.join('|')}`);
  if (!BACK_FINISHES.includes(raw.back as never)) errs.push(`phone3d.back must be ${BACK_FINISHES.join('|')}`);
  const shadow = raw.shadow;
  if (isObj(shadow) && !SHADOW_KINDS.includes(shadow.kind as never)) errs.push(`phone3d.shadow.kind must be ${SHADOW_KINDS.join('|')}`);
  if (![1, 2, 3].includes(raw.supersample as number)) errs.push('phone3d.supersample must be 1, 2 or 3');

  if (!Array.isArray(raw.transitions)) {
    errs.push('phone3d.transitions must be an array');
    return errs;
  }
  const seen = new Map<string, number>();
  raw.transitions.forEach((tr: unknown, i: number) => {
    const path = `phone3d.transitions[${i}]`;
    if (!isObj(tr)) {
      errs.push(`${path} must be an object`);
      return;
    }
    if (typeof tr.id !== 'string' || !tr.id) errs.push(`${path}.id must be a non-empty string`);
    else if (seen.has(tr.id)) errs.push(`${path}.id "${tr.id}" is also used by phone3d.transitions[${seen.get(tr.id)}]`);
    else seen.set(tr.id, i);
    if (!isNum(tr.start) || !isNum(tr.end)) errs.push(`${path}: start and end must be numbers`);
    else {
      if (tr.start < 0) errs.push(`${path}.start must be >= 0`);
      if (tr.end - tr.start < MIN_TRANSITION - 1e-9) errs.push(`${path}: end must be at least ${MIN_TRANSITION} s after start`);
    }
    if (tr.from !== undefined) poseProblems(tr.from, `${path}.from`, errs);
    poseProblems(tr.to, `${path}.to`, errs);
    easingProblems(tr.easing, `${path}.easing`, errs);
    if (tr.recipe !== undefined && !SHOT_RECIPES.includes(tr.recipe as never)) errs.push(`${path}.recipe must be ${SHOT_RECIPES.join('|')}`);
  });
  return errs;
}
