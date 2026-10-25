// The studio light presets, as pure data (D13: procedural, no HDRI). The
// renderer (renderer/src/phone3d/environment.ts) makes ONE rig of each:
// - the softboxes (the key, rim strips, an overhead strip, the lens
//   catchlight) are RectAreaLights LIGHT_DISTANCE body long sides from the
//   phone, so a flat face (the 17 Pro's back, the band at turn 90) sees each
//   one from a different angle at every point and takes a gradient and a
//   moving highlight;
// - the set round the phone (an overhead gradient, a front fill, a white
//   bounce card below and dark flags at the sides) is ONE PMREM environment,
//   so a face that points between the boxes still sees the room.
//
// Frames of reference:
// - A softbox's azimuth is an OFFSET from the key azimuth (phone3d.light.
//   azimuth + pose.light), so the `light` channel turns the whole rig.
// - The set (front fill, flags) is placed as seen from the camera at the
//   DEFAULT key azimuth (`DEFAULT_KEY_AZIMUTH`); it turns with the light
//   channel too, because the environment and the boxes turn as one piece.
// Azimuth 0 is the camera's side of the phone, + toward the canvas right;
// elevation 0 is level with the phone, + up.

import type { LightPreset } from './model';

/**
 * Elevation of the key light, degrees: the key softbox and the shadow's light
 * (projection.ts keyLightDir) both use it, so it is a one-line look decision
 * (owner decision 7). 32 was picked by looking at 20, 32 and 44 in round 1;
 * since round 2 the drop shadow's offset is capped (projection.ts
 * SHADOW_OFFSET, 0.08 of the body since look round 4), so it mostly moves the
 * key's reflection: 32 lights the back's upper half in a turn to the back
 * without mirroring the key on the plateau top. Round 4 looked again with the
 * darker set and kept it.
 */
export const KEY_ELEVATION = 32;

/** The key azimuth phone3d starts with (model.ts defaultPhone3D): the frame the set is placed in. */
export const DEFAULT_KEY_AZIMUTH = -35;

/**
 * How far the softboxes stand from the phone's centre, in body long sides. Near enough that a flat face sees a
 * box from clearly different angles across its length (about 22° from the top of the back to its bottom), so the
 * highlight has a gradient and moves across the face as the phone turns; far enough that the box still reads as
 * a studio light, not a lamp beside the phone.
 */
export const LIGHT_DISTANCE = 2.6;

export interface SoftBox {
  /** Degrees, offset from the key azimuth. */
  azimuth: number;
  /** Degrees above the phone. */
  elevation: number;
  /** Half the box's angular width and height, degrees (as seen from the phone's centre). */
  halfW: number;
  halfH: number;
  /** The box's radiance, scene-linear (1 is a white that tone maps to about 80%); × phone3d.light.intensity. */
  radiance: number;
  /** sRGB hex. */
  color: string;
  /** How far it stands from the phone's centre, body long sides (default LIGHT_DISTANCE). A nearer box is seen from
   *  more different angles across a flat face, so its highlight falls off across the face instead of filling it. */
  distance?: number;
}

export interface StudioSet {
  /** The dome: radiance straight up (the overhead gradient) and at the horizon. */
  top: number;
  horizon: number;
  /** A broad soft fill on the camera's side, added to the dome (keeps metal facing the camera mid-tone). */
  front: number;
  /** The white bounce card below the phone (every face pointing down sees it). */
  floor: number;
  /** How much the two side flags darken the dome where they stand, 0 (none) .. 1 (black). */
  flags: number;
}

export interface LightRig {
  /** The softboxes, key first (RectAreaLights). */
  boxes: SoftBox[];
  set: StudioSet;
  /** The key: its elevation (the shadow's light) and relative strength. */
  key: { elevation: number; intensity: number };
}

/**
 * Where the flags stand, as seen from the camera at the default key azimuth:
 * either side of the phone, a little behind it, so a band's edge runs from
 * a softbox into a dark flag (the crisp light-dark line that reads as metal).
 */
export const FLAGS = { azimuth: 128, halfW: 16, elevation: 12, halfH: 40 } as const;

export const LIGHT_PRESETS: Record<LightPreset, LightRig> = {
  // Clean product light: a big soft key, a rim strip behind each side, a long overhead strip.
  studio: {
    boxes: [
      { azimuth: 0, elevation: KEY_ELEVATION, halfW: 30, halfH: 22, radiance: 1.2, color: '#ffffff' },
      // A tall strip low on the key side: the streak that runs down the band in a three-quarter view.
      { azimuth: -65, elevation: 6, halfW: 5, halfH: 42, radiance: 2.0, color: '#ffffff' },
      { azimuth: 185, elevation: 14, halfW: 5, halfH: 34, radiance: 2.0, color: '#ffffff' },
      { azimuth: -115, elevation: 14, halfW: 4, halfH: 34, radiance: 1.5, color: '#ffffff' },
      { azimuth: 40, elevation: 64, halfW: 70, halfH: 16, radiance: 1.1, color: '#f4f6ff' },
      // A low wide box under the key: the broad soft highlight that slides across a back turned three-quarters
      // toward the key (the turn-to-back's end pose), well off the camera axis so FRONT stays clean.
      { azimuth: -5, elevation: 0, halfW: 10, halfH: 12, radiance: 0.9, color: '#ffffff' },
      // A small soft lamp just above and right of the camera: the round catchlight in the lens elements.
      { azimuth: 50, elevation: 18, halfW: 5, halfH: 5, radiance: 2.5, color: '#ffffff' },
      // A tall strip right of the camera (60° from it): its reflection crosses the screen glass as the phone turns
      // toward it, and sweeps over the back in the three-quarter back view.
      { azimuth: 95, elevation: 12, halfW: 6, halfH: 36, radiance: 1.4, color: '#ffffff' },
      // A wide box above the camera axis: a back facing the viewer mirrors its lower edge (bright top, falling off down the back).
      { azimuth: 35, elevation: 24, halfW: 26, halfH: 9, radiance: 2.2, color: '#ffffff' },
      // A tall strip 60° left of the camera: a back turned three-quarters (turn 130-170) mirrors it as a soft
      // vertical highlight that slides across the back and the panel as the phone turns.
      { azimuth: -25, elevation: 8, halfW: 9, halfH: 40, radiance: 1.6, color: '#ffffff', distance: 1.2 },
      // A broad soft box behind on the key side, near the phone: a back turned well past three-quarters (the
      // turn-to-back outro from a layback) mirrors it as a falling gradient instead of one flat tone.
      { azimuth: -100, elevation: 18, halfW: 16, halfH: 32, radiance: 0.9, color: '#ffffff', distance: 1.6 },
      // A white bounce card low in front: the downward faces (the plateau step's rounded edge, the band's lower
      // chamfers) catch a thin line of it.
      { azimuth: 35, elevation: -32, halfW: 30, halfH: 10, radiance: 1.2, color: '#ffffff' },
    ],
    set: { top: 0.3, horizon: 0.04, front: 0.02, floor: 0.15, flags: 1 },
    key: { elevation: KEY_ELEVATION, intensity: 1 },
  },
  // Large, low-contrast sources: gentle gradients, quiet reflections.
  soft: {
    boxes: [
      { azimuth: 0, elevation: KEY_ELEVATION, halfW: 38, halfH: 26, radiance: 1.1, color: '#ffffff' },
      { azimuth: 120, elevation: 24, halfW: 26, halfH: 26, radiance: 0.7, color: '#ffffff' },
    ],
    set: { top: 0.6, horizon: 0.2, front: 0.38, floor: 0.4, flags: 0.4 },
    key: { elevation: KEY_ELEVATION, intensity: 0.8 },
  },
  // One tighter key and a strong rim: deeper shades, bright edge lines.
  contrast: {
    boxes: [
      { azimuth: 0, elevation: KEY_ELEVATION, halfW: 16, halfH: 11, radiance: 2.2, color: '#ffffff' },
      { azimuth: 165, elevation: 10, halfW: 3.5, halfH: 38, radiance: 2.8, color: '#ffffff' },
    ],
    set: { top: 0.3, horizon: 0.05, front: 0.16, floor: 0.2, flags: 1 },
    key: { elevation: KEY_ELEVATION, intensity: 1.3 },
  },
  // Golden-hour key against a cool rim.
  warm: {
    boxes: [
      { azimuth: 0, elevation: KEY_ELEVATION, halfW: 26, halfH: 17, radiance: 1.5, color: '#ffd9b0' },
      { azimuth: 150, elevation: 18, halfW: 5, halfH: 32, radiance: 1.8, color: '#cfe0ff' },
      { azimuth: 70, elevation: 70, halfW: 60, halfH: 10, radiance: 0.55, color: '#ffe9d2' },
    ],
    set: { top: 0.45, horizon: 0.11, front: 0.3, floor: 0.3, flags: 0.85 },
    key: { elevation: KEY_ELEVATION, intensity: 1 },
  },
  // Dim, cool and edge-lit: the phone reads by its rims.
  night: {
    boxes: [
      { azimuth: 0, elevation: KEY_ELEVATION, halfW: 20, halfH: 13, radiance: 0.6, color: '#c8d6ff' },
      { azimuth: 155, elevation: 14, halfW: 4, halfH: 38, radiance: 2.4, color: '#9fb8ff' },
      { azimuth: -155, elevation: 14, halfW: 4, halfH: 38, radiance: 1.5, color: '#b9a6ff' },
    ],
    set: { top: 0.12, horizon: 0.03, front: 0.08, floor: 0.08, flags: 1 },
    key: { elevation: KEY_ELEVATION, intensity: 0.45 },
  },
};
