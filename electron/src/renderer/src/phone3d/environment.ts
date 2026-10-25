// Procedural studio lighting (D13, spec §3.1): ONE light rig, in two parts
// that never light the same thing twice.
//
// - The hero softboxes (lighting.ts boxes: the key, the rim strips, the
//   overhead strip, the lens catchlight) are RectAreaLights at a finite
//   distance round the phone (LIGHT_DISTANCE body long sides). A light at a
//   finite distance is what models a FLAT face: each point of the 17 Pro's
//   back sees the box from its own angle, so a broad soft highlight sweeps
//   across the back and the band as the phone turns. Round 2 painted the
//   boxes into the infinitely far environment instead, and a flat metal face
//   mirrors one direction of an infinite environment at every point: the
//   backs and the turn-90 side read as one flat tone (look judges round 2).
// - The set (the overhead gradient, the front fill, the white bounce card
//   below, the dark side flags) is the PMREM environment (512): the room the
//   phone stands in, so no face ever falls into a black gap between boxes
//   (round 1's 2-6% fill turned Silver black at turn 150).
//
// The light channel turns both together: the rig's group and
// scene.environmentRotation (placeStudio, aimStudio), by the key azimuth
// (light.azimuth + pose.light). The shadow's light is the key's direction
// (KEY_ELEVATION).
//
// Frame (lighting.ts): azimuth 0 is the camera's side (+z), + toward the
// canvas right (+x); elevation + up. In the rig's own frame the key sits at
// azimuth 0.

import {
  BackSide,
  BufferAttribute,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  RectAreaLight,
  Scene,
  SphereGeometry,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { DEFAULT_KEY_AZIMUTH, FLAGS, LIGHT_DISTANCE, LIGHT_PRESETS, type SoftBox } from '../../../shared/phone3d/lighting';
import type { LightPreset } from '../../../shared/phone3d/model';

/** How much the bounce card takes on the background's mean colour (the rest is white). */
const FLOOR_TINT = 0.15;
/** The front fill's reach: half-width in azimuth and height in elevation, degrees. */
const FRONT_LOBE = { halfAz: 150, halfEl: 50 };
/** The overhead gradient rises from this elevation to full at TOP_TO_DEG: steepest near the horizon, so a flat
 *  metal back (it mirrors directions within about ±15° of level) falls off softly from top to bottom. */
const TOP_FROM_DEG = -10;
const TOP_TO_DEG = 70;
/** The floor card blends in over this many degrees below the horizon. */
const FLOOR_BLEND_DEG = 15;
const DOME_RADIUS = 10;
/** Dome tessellation: about 2.8° per segment (the set is smooth gradients and broad flags). */
const DOME_SEG = { w: 128, h: 64 };
export const PMREM_SIZE = 512;

const deg = Math.PI / 180;
/** Unit direction for (azimuth, elevation) in this file's frame. */
export function lightDir(azimuthDeg: number, elevationDeg: number): [number, number, number] {
  const a = azimuthDeg * deg;
  const e = elevationDeg * deg;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

/** Turn the environment to the key azimuth (light.azimuth + pose.light), degrees. */
export function aimStudio(scene: Scene, azimuthDeg: number) {
  scene.environmentRotation.set(0, azimuthDeg * deg, 0);
}

let areaLightsReady = false;
/** RectAreaLights need three's LTC tables in its uniform library, once per process. */
function initAreaLights() {
  if (areaLightsReady) return;
  RectAreaLightUniformsLib.init();
  areaLightsReady = true;
}

/** A softbox's size at the rig distance, in body long sides: its angular half-size seen from the phone. */
export function boxSize(box: SoftBox): { w: number; h: number } {
  const d = box.distance ?? LIGHT_DISTANCE;
  return { w: 2 * d * Math.tan(box.halfW * deg), h: 2 * d * Math.tan(box.halfH * deg) };
}

/**
 * The preset's hero softboxes as RectAreaLights in a group, in the rig's own
 * frame (key at azimuth 0), each its distance (LIGHT_DISTANCE unless the box
 * sets one) in body long sides from the group's origin and facing it. placeStudio sizes, centres and turns them.
 */
export function studioLights(preset: LightPreset): Group {
  initAreaLights();
  const g = new Group();
  g.name = `studio:${preset}`;
  LIGHT_PRESETS[preset].boxes.forEach((box, i) => {
    const light = new RectAreaLight(new Color().setStyle(box.color), box.radiance, 1, 1);
    light.name = i === 0 ? 'key' : `box${i}`;
    light.userData.box = { dir: lightDir(box.azimuth, box.elevation), ...boxSize(box), radiance: box.radiance, distance: box.distance ?? LIGHT_DISTANCE };
    g.add(light);
  });
  return g;
}

/**
 * Puts a light group round the phone for one sample: centred on `center`
 * (world), sized for a body long side of `unit` world units (a
 * RectAreaLight's width and height ignore its parent's scale, so each box is
 * re-sized here), turned to the key azimuth (degrees), each box's radiance ×
 * `intensity` (phone3d.light.intensity).
 */
export function placeStudio(lights: Group, center: readonly [number, number, number], unit: number, azimuthDeg: number, intensity: number) {
  lights.position.set(center[0], center[1], center[2]);
  lights.rotation.set(0, azimuthDeg * deg, 0);
  for (const l of lights.children) {
    const box = l.userData.box as { dir: [number, number, number]; w: number; h: number; radiance: number; distance: number } | undefined;
    if (!(l instanceof RectAreaLight) || !box) continue;
    const d = box.distance * unit;
    l.position.set(box.dir[0] * d, box.dir[1] * d, box.dir[2] * d);
    l.lookAt(center[0], center[1], center[2]);
    l.width = box.w * unit;
    l.height = box.h * unit;
    l.intensity = box.radiance * intensity;
  }
  lights.updateMatrixWorld(true);
}

export type Rgb = readonly [number, number, number];

/** 16 levels per channel, so a slowly changing background reuses the cached environment. */
export const quantizeBg = (bg: Rgb): [number, number, number] => bg.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 15) / 15) as [number, number, number];

/** cos² window: 1 at 0, 0 at |t| ≥ 1. */
const cos2Window = (t: number) => (Math.abs(t) >= 1 ? 0 : Math.cos((Math.PI / 2) * t) ** 2);
const smoothstep = (a: number, b: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};
/** Signed angle a − b, wrapped into (−180, 180]. */
const angleDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

/**
 * Radiance of the studio environment (the set) in an environment-frame
 * direction (unit vector), scene-linear RGB, before phone3d.light.intensity:
 * the dome (overhead gradient, front fill, bounce card tinted FLOOR_TINT by
 * the background), darkened by the flags. The softboxes are lights
 * (studioLights), not part of it. Pure; studioScene paints the dome with it.
 */
export function studioRadiance(preset: LightPreset, bgMean: Rgb, dir: readonly [number, number, number]): [number, number, number] {
  const rig = LIGHT_PRESETS[preset];
  const set = rig.set;
  const [x, y, z] = dir;
  const az = (Math.atan2(x, z) * 180) / Math.PI;
  const el = (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI;
  // As seen from the camera at the default key azimuth (the frame the set is placed in).
  const camAz = az + DEFAULT_KEY_AZIMUTH;
  const front = set.front * cos2Window(camAz / FRONT_LOBE.halfAz) * cos2Window(el / FRONT_LOBE.halfEl);
  const sky = set.horizon + (set.top - set.horizon) * (smoothstep(TOP_FROM_DEG, TOP_TO_DEG, el) - smoothstep(TOP_FROM_DEG, TOP_TO_DEG, 0));
  const [br, bgc, bb] = quantizeBg(bgMean);
  const tint = (c: number) => set.floor * (1 - FLOOR_TINT + FLOOR_TINT * c);
  const f = smoothstep(0, FLOOR_BLEND_DEG, -el);
  const dome = (floorC: number) => sky * (1 - f) + tint(floorC) * f + front;
  let r = dome(br);
  let g = dome(bgc);
  let b = dome(bb);
  // Flags either side: they cut the dome (not the softboxes) down toward black.
  let flag = 0;
  for (const side of [-1, 1]) flag = Math.max(flag, cos2Window(angleDiff(camAz, side * FLAGS.azimuth) / FLAGS.halfW) * cos2Window((el - FLAGS.elevation) / FLAGS.halfH));
  const keep = 1 - set.flags * flag;
  r *= keep;
  g *= keep;
  b *= keep;
  return [r, g, b];
}

/** The scene that goes through PMREM: the dome, studioRadiance as vertex colours. */
export function studioScene(preset: LightPreset, bgMean: Rgb): Scene {
  const scene = new Scene();
  const dome = new SphereGeometry(DOME_RADIUS, DOME_SEG.w, DOME_SEG.h);
  const pos = dome.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = studioRadiance(preset, bgMean, [pos.getX(i) / DOME_RADIUS, pos.getY(i) / DOME_RADIUS, pos.getZ(i) / DOME_RADIUS]);
    colors[i * 3] = v[0];
    colors[i * 3 + 1] = v[1];
    colors[i * 3 + 2] = v[2];
  }
  dome.setAttribute('color', new BufferAttribute(colors, 3));
  const domeMesh = new Mesh(dome, new MeshBasicMaterial({ vertexColors: true, side: BackSide, toneMapped: false }));
  domeMesh.name = 'studio:dome';
  scene.add(domeMesh);

  return scene;
}

interface EnvEntry {
  target: WebGLRenderTarget;
}
const envCaches = new WeakMap<WebGLRenderer, Map<string, EnvEntry>>();
const ENV_CACHE_SIZE = 4;

/**
 * The studio environment for a preset and background mean (linear RGB), via
 * `fromScene(studio, 0, near, far, { size: 512 })` (about 25 MB HalfFloat).
 * Cached per renderer, per (preset, bgMean quantized to 16 levels), LRU 4;
 * evicted targets are disposed. Set it as `scene.environment`. (Tools; the
 * engine owns its own, createStudioEnv.)
 */
export function studioEnv(renderer: WebGLRenderer, preset: LightPreset, bgMean: Rgb): Texture {
  let cache = envCaches.get(renderer);
  if (!cache) envCaches.set(renderer, (cache = new Map()));
  const key = `${preset}|${quantizeBg(bgMean).join(',')}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.target.texture;
  }
  const target = createStudioEnv(renderer, preset, bgMean);
  cache.set(key, { target });
  while (cache.size > ENV_CACHE_SIZE) {
    const oldest = cache.keys().next().value as string;
    cache.get(oldest)!.target.dispose();
    cache.delete(oldest);
  }
  return target.texture;
}

/**
 * The studio environment, not cached: the caller owns the target and
 * disposes it (the engine keeps one, LRU 1, for the §3.9 budget).
 */
export function createStudioEnv(renderer: WebGLRenderer, preset: LightPreset, bgMean: Rgb): WebGLRenderTarget {
  const scene = studioScene(preset, bgMean);
  const pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0, 0.1, DOME_RADIUS * 4, { size: PMREM_SIZE });
  pmrem.dispose();
  disposeScene(scene);
  return target;
}

/** Drop a renderer's cached environments (context loss, unload). */
export function clearEnvCache(renderer: WebGLRenderer) {
  const cache = envCaches.get(renderer);
  if (!cache) return;
  for (const e of cache.values()) e.target.dispose();
  cache.clear();
}

function disposeScene(scene: Scene) {
  scene.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      (o.material as MeshBasicMaterial).dispose();
    }
  });
}
