// The 3D planning API the agent CLI calls: the `direct` planner, the
// project warnings, the shot recipe table and `needsScenes` (SPEC §2.5-2.7,
// §4.1), all from WP2's shared modules. This module is the CLI's one seam to
// them, so agentCli.ts and framesCmd.ts import 3D planning from one place.

import type { ApplyContext } from '../shared/agentOps';

export { needsScenes } from '../shared/agentOps';
export { DIRECT_STYLES, planDirect, type DirectOptions, type DirectPlan, type DirectStyle, type PlannedShot as DirectShot } from '../shared/phone3d/direct';
export { projectWarnings, type Warning as Phone3DWarning } from '../shared/phone3d/warnings';
export { shotRecipeList as shotRecipes } from '../shared/phone3d/shots';

/** ApplyContext carries cursor.json samples and scene changes (D5, §4.1). */
export type ApplyContext3d = ApplyContext;

/** The planner is in this build. */
export const PLANNER_READY = true;
