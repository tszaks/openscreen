// The studio light presets, as pure data (D13). The renderer
// (renderer/src/phone3d/environment.ts) turns `boxes` into RectAreaLights
// and `ambient` into the PMREM fill's strength; `info` prints them.
//
// Frame of reference: azimuth 0 is the camera's side of the phone, + toward
// the canvas right; elevation 0 is level with the phone, + up. Every box
// azimuth is an OFFSET from the key azimuth (phone3d.light.azimuth +
// pose.light), so the `light` channel rotates the whole rig, and the
// environment with it.

import type { LightPreset } from './model';

/** Elevation of the key light, degrees. The shadow (projection.ts shadowHull, the renderer's shadow camera) uses it. */
export const KEY_ELEVATION = 55;

export interface SoftBox {
  /** Degrees, offset from the key azimuth. */
  azimuth: number;
  /** Degrees above the phone. */
  elevation: number;
  /** Size in units of the phone body's long side (a box 1 wide is as wide as the phone is tall). */
  w: number;
  h: number;
  /** Relative radiance; multiplied by phone3d.light.intensity. */
  intensity: number;
  /** sRGB hex. */
  color: string;
}

export interface LightRig {
  /** The hero softboxes, key first (RectAreaLights; LTC gives sharp edges). */
  boxes: SoftBox[];
  /** Strength of the PMREM fill (the dim dome, floor bounce and the sheen strip), 0..1. */
  ambient: number;
  /** The key: its elevation (the shadow's light) and relative strength. */
  key: { elevation: number; intensity: number };
}

/** How far the softboxes sit from the phone's centre, in body long sides. */
export const LIGHT_DISTANCE = 3;

export const LIGHT_PRESETS: Record<LightPreset, LightRig> = {
  // Clean product light: a big key, a thin rim strip opposite, a soft top fill.
  studio: {
    boxes: [
      { azimuth: 0, elevation: 35, w: 1.2, h: 0.8, intensity: 1, color: '#ffffff' },
      { azimuth: 150, elevation: 15, w: 0.22, h: 1.6, intensity: 0.75, color: '#ffffff' },
      { azimuth: 60, elevation: 70, w: 1.6, h: 0.5, intensity: 0.3, color: '#f4f6ff' },
    ],
    ambient: 0.05,
    key: { elevation: KEY_ELEVATION, intensity: 1 },
  },
  // Large, low-contrast sources: gentle gradients, quiet reflections.
  soft: {
    boxes: [
      { azimuth: 0, elevation: 30, w: 2, h: 1.4, intensity: 0.8, color: '#ffffff' },
      { azimuth: 120, elevation: 25, w: 1.4, h: 1.4, intensity: 0.45, color: '#ffffff' },
    ],
    ambient: 0.06,
    key: { elevation: KEY_ELEVATION, intensity: 0.8 },
  },
  // One hard key and a strong rim: deep shadows, bright edge lines.
  contrast: {
    boxes: [
      { azimuth: 0, elevation: 40, w: 0.7, h: 0.5, intensity: 1.3, color: '#ffffff' },
      { azimuth: 165, elevation: 10, w: 0.15, h: 1.8, intensity: 1.1, color: '#ffffff' },
    ],
    ambient: 0.02,
    key: { elevation: KEY_ELEVATION, intensity: 1.3 },
  },
  // Golden-hour key against a cool rim.
  warm: {
    boxes: [
      { azimuth: 0, elevation: 25, w: 1.3, h: 0.8, intensity: 1, color: '#ffd9b0' },
      { azimuth: 150, elevation: 20, w: 0.25, h: 1.5, intensity: 0.6, color: '#cfe0ff' },
      { azimuth: 70, elevation: 65, w: 1.4, h: 0.5, intensity: 0.25, color: '#ffe9d2' },
    ],
    ambient: 0.05,
    key: { elevation: KEY_ELEVATION, intensity: 1 },
  },
  // Dim, cool and edge-lit: the phone reads by its rims.
  night: {
    boxes: [
      { azimuth: 0, elevation: 30, w: 0.9, h: 0.6, intensity: 0.45, color: '#c8d6ff' },
      { azimuth: 155, elevation: 15, w: 0.2, h: 1.8, intensity: 0.9, color: '#9fb8ff' },
      { azimuth: -155, elevation: 15, w: 0.2, h: 1.8, intensity: 0.5, color: '#b9a6ff' },
    ],
    ambient: 0.02,
    key: { elevation: KEY_ELEVATION, intensity: 0.45 },
  },
};
