// The studio light presets, as pure data (D13: procedural, no HDRI). The
// renderer (renderer/src/phone3d/environment.ts) paints all of it into ONE
// PMREM environment: the softboxes, the set around the phone (an overhead
// gradient, a front fill, a white bounce card below and dark flags at the
// sides) and the faint glass sheen. Every lit surface takes all its light
// from that one environment, so a metal face never falls into a black gap
// between lights, and rough surfaces see soft-edged sources.
//
// Frames of reference:
// - A softbox's azimuth is an OFFSET from the key azimuth (phone3d.light.
//   azimuth + pose.light), so the `light` channel turns the whole rig.
// - The set (front fill, flags) is placed as seen from the camera at the
//   DEFAULT key azimuth (`DEFAULT_KEY_AZIMUTH`); it turns with the light
//   channel too, because the environment turns as one piece.
// Azimuth 0 is the camera's side of the phone, + toward the canvas right;
// elevation 0 is level with the phone, + up.

import type { LightPreset } from './model';

/**
 * Elevation of the key light, degrees: the key softbox and the shadow's light
 * (projection.ts keyLightDir) both use it, so it is a one-line look decision
 * (owner decision 7). 32 was picked by looking at 20, 32 and 44 in round 1;
 * round 2 kept it after the shadow offset was capped (projection.ts
 * SHADOW_OFFSET), because then it only moves the key's reflection: 32 lights
 * the back's upper half in a turn to the back without mirroring the key on
 * the plateau top.
 */
export const KEY_ELEVATION = 32;

/** The key azimuth phone3d starts with (model.ts defaultPhone3D): the frame the set is placed in. */
export const DEFAULT_KEY_AZIMUTH = -35;

export interface SoftBox {
  /** Degrees, offset from the key azimuth. */
  azimuth: number;
  /** Degrees above the phone. */
  elevation: number;
  /** Half the box's angular width and height, degrees (as seen from the phone). */
  halfW: number;
  halfH: number;
  /** Radiance at the box's centre, scene-linear (1 is a white that tone maps to about 80%); × phone3d.light.intensity. */
  radiance: number;
  /** sRGB hex. */
  color: string;
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
  /** The softboxes, key first, painted into the environment with soft edges. */
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
      { azimuth: 40, elevation: 74, halfW: 70, halfH: 10, radiance: 0.5, color: '#f4f6ff' },
      // A small soft lamp just above and right of the camera: the round catchlight in the lens elements.
      { azimuth: 50, elevation: 18, halfW: 5, halfH: 5, radiance: 2.5, color: '#ffffff' },
    ],
    set: { top: 0.8, horizon: 0.45, front: 0.15, floor: 0.55, flags: 0.9 },
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
