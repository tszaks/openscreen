// Procedural studio lighting (D13, spec §3.1): ONE PMREM environment holds
// every light the phone sees.
//
// Round 1 lit the phone with three RectAreaLight softboxes over a dim (2-6%)
// fill. Metal only reflects what it faces, so a face that pointed between
// the boxes went black: Silver read as Space Black at turn 150 and clipped
// to white at 180, and the plateau top turned peach under the key. Real
// product sets are a room of light: a big soft source overhead, a white card
// under the phone, black flags at the sides for the edge lines. So now:
// - the dome: an overhead gradient (horizon → top), a broad front fill on
//   the camera's side, and a white bounce card below the horizon (tinted a
//   little by the background), with two dark flags either side of the phone;
// - the softboxes (key, rims, an overhead strip) painted into the same dome
//   with soft edges (no hard rectangle in a lens or a glass edge).
// Nothing bright sits near the camera axis: round 1's sheen strip there (for
// a diagonal sheen on the glass at FRONT) was also what a metal back facing
// the camera mirrored, so Silver clipped to white at turn 180 and fell to
// grey at 150. Around the camera the studio is even (within about 15%), so a
// finish keeps its colour as the phone turns.
// One source of light for every surface: rough metal sees the soft sources
// blurred, glossy glass sees them sharp, and nothing is double counted.
// The light channel turns it all together (scene.environmentRotation), and
// the shadow's light is the key's direction (KEY_ELEVATION).
//
// Frame (lighting.ts): azimuth 0 is the camera's side (+z), + toward the
// canvas right (+x); elevation + up. The environment is turned by the key
// azimuth (light.azimuth + pose.light), so in its own frame the key sits at
// azimuth 0.

import {
  BackSide,
  BufferAttribute,
  Color,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { DEFAULT_KEY_AZIMUTH, FLAGS, LIGHT_PRESETS, type SoftBox } from '../../../shared/phone3d/lighting';
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
/** A softbox's edge: radiance is flat to this fraction of its half-size, then falls off as cos² to 0 at the edge. */
const BOX_CORE = 0.45;
const DOME_RADIUS = 10;
/** Dome tessellation: about 1.4° per segment, fine enough for the 3.5°-wide rim strips. */
const DOME_SEG = { w: 256, h: 128 };
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

export type Rgb = readonly [number, number, number];

/** 16 levels per channel, so a slowly changing background reuses the cached environment. */
export const quantizeBg = (bg: Rgb): [number, number, number] => bg.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 15) / 15) as [number, number, number];

/** cos² window: 1 at 0, 0 at |t| ≥ 1. */
const cos2Window = (t: number) => (Math.abs(t) >= 1 ? 0 : Math.cos((Math.PI / 2) * t) ** 2);
/** Flat core to BOX_CORE, then cos² down to 0 at |t| = 1. */
const boxWindow = (t: number) => {
  const a = Math.abs(t);
  return a <= BOX_CORE ? 1 : cos2Window((a - BOX_CORE) / (1 - BOX_CORE));
};
const smoothstep = (a: number, b: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};
/** Signed angle a − b, wrapped into (−180, 180]. */
const angleDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

const boxColors = new Map<string, [number, number, number]>();
function linearOf(hex: string): [number, number, number] {
  let c = boxColors.get(hex);
  if (!c) {
    const k = new Color().setStyle(hex);
    boxColors.set(hex, (c = [k.r, k.g, k.b]));
  }
  return c;
}

/** One softbox's radiance toward (az, el) (environment frame, degrees). */
function boxRadiance(b: SoftBox, az: number, el: number): number {
  const du = angleDiff(az, b.azimuth) * Math.cos(b.elevation * deg);
  const dv = el - b.elevation;
  return b.radiance * boxWindow(du / b.halfW) * boxWindow(dv / b.halfH);
}

/**
 * Radiance of the studio environment in an environment-frame direction (unit
 * vector), scene-linear RGB, before phone3d.light.intensity: the dome
 * (overhead gradient, front fill, bounce card tinted FLOOR_TINT by the
 * background), darkened by the flags, plus every softbox. Pure; studioScene
 * paints the dome with it.
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
  for (const box of rig.boxes) {
    const k = boxRadiance(box, az, el);
    if (k <= 0) continue;
    const c = linearOf(box.color);
    r += k * c[0];
    g += k * c[1];
    b += k * c[2];
  }
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
