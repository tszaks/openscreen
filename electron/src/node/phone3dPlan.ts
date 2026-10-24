// The 3D planning API the agent CLI calls: the `direct` planner, the
// project warnings, the shot recipe table and `needsScenes` (SPEC §2.5-2.7,
// §4.1). They belong to WP2 (shared/phone3d/{direct,warnings,shots}.ts and
// agentOps.ts), which integrates before WP3. This module is the CLI's one
// seam to them, so the CLI code (direct, frames, info, validate, apply,
// polish, export) is final and typed against the spec's signatures.
//
// Until WP2 is in the build: planDirect refuses clearly, projectWarnings
// and shotRecipes are empty, and needsScenes is the spec's rule. At
// integration this file becomes re-exports of WP2's functions (the exact
// replacement is in the WP3 hand-off, /tmp/openscreen-3d/wf/wp3/requests.md).

import type { ApplyContext, EditOp } from '../shared/agentOps';
import type { ShotRecipe } from '../shared/phone3d/model';
import type { CursorSample, Project } from '../shared/types';

/** `direct` style: the Auto 3D Style control and `--style`. */
export type DirectStyle = 'subtle' | 'hero' | 'bold';
export const DIRECT_STYLES: readonly DirectStyle[] = ['subtle', 'hero', 'bold'];

/** planDirect's options (SPEC §2.6). `scenes` are SOURCE seconds; absent = scene changes are not used. */
export interface DirectOptions {
  style: DirectStyle;
  scenes?: number[];
  replace: boolean;
  cursor?: CursorSample[];
}

export interface DirectShot {
  recipe: ShotRecipe;
  start: number;
  end: number;
  reason: string;
}

export interface DirectPlan {
  ops: EditOp[];
  shots: DirectShot[];
}

/** A 3D warning (SPEC §2.7): never blocks applyOps; `fix` ops clear it. */
export interface Phone3DWarning {
  code: string;
  message: string;
  at?: number;
  end?: number;
  transitionId?: string;
  fix?: EditOp[];
}

/** A shot recipe as `info.shotRecipes` lists it. */
export interface ShotRecipeInfo {
  name: ShotRecipe;
  duration: number;
  summary: string;
  use: string;
}

/** ApplyContext with the 3D fields WP2 adds (D5, §4.1): cursor.json samples and scene changes (source s). */
export type ApplyContext3d = ApplyContext & { cursor?: CursorSample[]; scenes?: number[] };

/** Whether the planner is in this build (false until WP2 integrates). */
export const PLANNER_READY = false;

/** The `direct` plan for `p`: ops in the spec's fixed order plus the shots with their reasons. */
export function planDirect(_p: Project, _opts: DirectOptions): DirectPlan {
  throw new Error('the 3D shot planner is not in this build yet (it ships with the 3D ops)');
}

/** Every 3D warning on `p`, computed with the bundle's cursor samples (D5). */
export function projectWarnings(_p: Project, _opts?: { cursor?: CursorSample[] }): Phone3DWarning[] {
  return [];
}

/** The shot recipes, for `info`. */
export function shotRecipes(): ShotRecipeInfo[] {
  return [];
}

/** True when the ops need scene changes: a `direct` op without `scenes:false` (SPEC §4.1). */
export function needsScenes(ops: EditOp[]): boolean {
  return ops.some((o) => o.op === 'direct' && o.scenes !== false);
}
