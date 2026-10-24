// The one builder of a 3D phone's render settings (FrameInputs.render3d) for
// exports, `frames` and the paused preview's full-quality redraw. Exports and
// frames used to build them in two places (compositor.exportRender3d and
// headlessFrames.render3dFor) with small differences; this is the single
// definition both call.

import type { Project } from '../../shared/types';
import type { Render3DSettings } from './compositor';

export interface Render3DOptions {
  /** The frame rate the frames are drawn at (motion blur's shutter is in frames). */
  fps: number;
  /** One sample at 1× and no motion blur (`frames --draft`). Default false: export quality. */
  draft?: boolean;
  /** Abort on a missing engine or a lost GPU instead of drawing flat (export, frames). Default true. */
  strict?: boolean;
}

/**
 * Export-quality settings from the project's `phone3d.supersample` and
 * `motionBlur`, or undefined when the project has no 3D settings at all.
 *
 * It does not ask whether 3D is active (phone3dActive) on purpose: a batch
 * export draws copies of the project with another layout preset
 * (projectForPreset), and a copy can draw in 3D when the editor's own preset
 * does not (an App Store project exported as social 9:16). The compositor
 * reads `render3d` only when it draws the phone in 3D, so the settings are
 * inert for a flat compositor.
 */
export function render3dSettings(project: Project, opts: Render3DOptions): Render3DSettings | undefined {
  const p3 = project.phone3d;
  if (!p3) return undefined;
  const draft = opts.draft ?? false;
  return {
    ss: draft ? 1 : p3.supersample,
    quality: draft ? 'draft' : 'full',
    motionBlur: !draft && p3.motionBlur.on ? { samples: p3.motionBlur.samples, shutter: p3.motionBlur.shutter } : null,
    fps: opts.fps,
    strict: opts.strict ?? true,
  };
}
