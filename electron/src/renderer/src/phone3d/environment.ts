// Procedural studio lighting (D13, spec §3.1): ONE light rig, in two parts
// that never light the same thing twice.
//
// - The hero softboxes (lighting.ts boxes: the key, the rim strips, the
//   overhead strip, the lens catchlight) are RectAreaLights at a finite
//   distance round the phone (LIGHT_DISTANCE body long sides, or the box's
//   own nearer distance). A light at a
//   finite distance is what models a FLAT face: each point of the 17 Pro's
//   back sees the box from its own angle, so a broad soft highlight sweeps
//   across the back and the band as the phone turns. Round 2 painted the
//   boxes into the infinitely far environment instead, and a flat metal face
//   mirrors one direction of an infinite environment at every point: the
//   backs and the turn-90 side read as one flat tone (look judges round 2).
// - The set (the overhead gradient, the front fill, the white bounce card
//   below, the dark side flags) is the PMREM environment (512): the room the
//   phone stands in. Since look round 4 it is dark round the camera axis
//   (metal reads by bright and dark zones; round 3's bright even set made
//   every coloured finish one flat tone), with enough overhead gradient and
//   floor card that no face goes black between the boxes.
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
  PMREMGenerator,
  RectAreaLight,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { DEFAULT_KEY_AZIMUTH, FLAGS, LIGHT_DISTANCE, LIGHT_PRESETS, type SoftBox } from '../../../shared/phone3d/lighting';
import type { LightPreset } from '../../../shared/phone3d/model';
import { HDRI, hdriTexture } from './hdri';

/** How much the bounce card takes on the background's mean colour (the rest is white). */
const FLOOR_TINT = 0.06;
/** The floor card blends in over this many degrees below the horizon. */
const FLOOR_BLEND_DEG = 15;
const DOME_RADIUS = 10;
/** Dome tessellation: 0.7° per segment, so the painted strips (half-width 4-5°) keep their soft edges. */
const DOME_SEG = { w: 512, h: 256 };
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
    if (box.inEnv) return; // painted into the set (studioRadiance)
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
/** How much of a painted box's half-size its soft edge takes. */
export const ENV_BOX_FEATHER = 0.3;
/** A painted box's profile across one axis: 1 inside, a cos² fall over the outer ENV_BOX_FEATHER, 0 at |t| ≥ 1. */
const softBox = (t: number) => {
  const a = Math.abs(t);
  if (a >= 1) return 0;
  const inner = 1 - ENV_BOX_FEATHER;
  return a <= inner ? 1 : Math.cos((Math.PI / 2) * ((a - inner) / ENV_BOX_FEATHER)) ** 2;
};
/** Signed angle a − b, wrapped into (−180, 180]. */
const angleDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

/** How each preset takes the HDRI (owner decision 15): a gain (scene-linear) and a tint (sRGB). The studio
 *  panorama is the room every preset stands in; the presets differ by how bright and what colour it is, and by
 *  their softboxes (lighting.ts). */
export const HDRI_LOOK: Record<LightPreset, { gain: number; tint: string }> = {
  studio: { gain: 0.35, tint: '#f3f6ff' },
  soft: { gain: 0.6, tint: '#ffffff' },
  contrast: { gain: 0.25, tint: '#ffffff' },
  warm: { gain: 0.4, tint: '#ffd9b8' },
  night: { gain: 0.1, tint: '#b8c8ff' },
};

/**
 * What the studio adds to the HDRI in an environment-frame direction (unit
 * vector): `keep` multiplies the panorama (the preset's flags cut it toward
 * black at the sides; the floor takes FLOOR_TINT of the background's mean
 * colour, as a bounce off the coloured backdrop), `add` is scene-linear
 * radiance on top (the boxes painted into the set, inEnv, with soft edges).
 * Before phone3d.light.intensity. Pure; studioScene bakes it into the dome.
 */
export function studioSet(preset: LightPreset, bgMean: Rgb, dir: readonly [number, number, number]): { keep: [number, number, number]; add: [number, number, number] } {
  const rig = LIGHT_PRESETS[preset];
  const [x, y, z] = dir;
  const az = (Math.atan2(x, z) * 180) / Math.PI;
  const el = (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI;
  // As seen from the camera at the default key azimuth (the frame the set is placed in).
  const camAz = az + DEFAULT_KEY_AZIMUTH;
  let flag = 0;
  for (const side of [-1, 1]) flag = Math.max(flag, cos2Window(angleDiff(camAz, side * FLAGS.azimuth) / FLAGS.halfW) * cos2Window((el - FLAGS.elevation) / FLAGS.halfH));
  const k = 1 - rig.set.flags * flag;
  const f = smoothstep(0, FLOOR_BLEND_DEG, -el);
  const [br, bgc, bb] = quantizeBg(bgMean);
  const floor = (c: number) => 1 - f * FLOOR_TINT + f * FLOOR_TINT * c * 2;
  const keep: [number, number, number] = [k * floor(br), k * floor(bgc), k * floor(bb)];
  const add: [number, number, number] = [0, 0, 0];
  // In the environment's own frame a box's azimuth is its offset from the key (the set turns with the rig).
  for (const box of rig.boxes) {
    if (!box.inEnv) continue;
    const w = softBox(angleDiff(az, box.azimuth) / box.halfW) * softBox((el - box.elevation) / box.halfH);
    if (w <= 0) continue;
    const c = new Color().setStyle(box.color);
    add[0] += box.radiance * w * c.r;
    add[1] += box.radiance * w * c.g;
    add[2] += box.radiance * w * c.b;
  }
  return { keep, add };
}

const DOME_VERT = /* glsl */ `
attribute vec3 keep;
attribute vec3 add;
varying vec3 vDir;
varying vec3 vKeep;
varying vec3 vAdd;
void main() {
  vDir = position;
  vKeep = keep;
  vAdd = add;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

// The panorama in the dome's direction: three's equirectUv after a turn of yaw about +y, × gain × tint × keep, + add.
const DOME_FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec3 gainTint;
uniform float yaw;
varying vec3 vDir;
varying vec3 vKeep;
varying vec3 vAdd;
void main() {
  vec3 d = normalize( vDir );
  float c = cos( yaw );
  float s = sin( yaw );
  d = vec3( c * d.x + s * d.z, d.y, -s * d.x + c * d.z );
  vec2 uv = vec2( atan( d.z, d.x ) * 0.15915494309189535 + 0.5, asin( clamp( d.y, -1.0, 1.0 ) ) * 0.3183098861837907 + 0.5 );
  vec3 hdr = texture2D( map, uv ).rgb;
  gl_FragColor = vec4( hdr * gainTint * vKeep + vAdd, 1.0 );
}`;

/** The scene that goes through PMREM: the dome, the HDRI (HDRI_LOOK) under studioSet's flags, floor tint and painted
 *  boxes. `map` is the panorama texture (hdri.ts); the caller disposes it. */
export function studioScene(preset: LightPreset, bgMean: Rgb, map: Texture): Scene {
  const scene = new Scene();
  const dome = new SphereGeometry(DOME_RADIUS, DOME_SEG.w, DOME_SEG.h);
  const pos = dome.getAttribute('position');
  const keep = new Float32Array(pos.count * 3);
  const add = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = studioSet(preset, bgMean, [pos.getX(i) / DOME_RADIUS, pos.getY(i) / DOME_RADIUS, pos.getZ(i) / DOME_RADIUS]);
    keep.set(v.keep, i * 3);
    add.set(v.add, i * 3);
  }
  dome.setAttribute('keep', new BufferAttribute(keep, 3));
  dome.setAttribute('add', new BufferAttribute(add, 3));
  const look = HDRI_LOOK[preset];
  const tint = new Color().setStyle(look.tint).multiplyScalar(look.gain);
  const mat = new ShaderMaterial({
    uniforms: { map: { value: map }, gainTint: { value: new Vector3(tint.r, tint.g, tint.b) }, yaw: { value: HDRI.yawDeg * deg } },
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: BackSide,
    depthWrite: false,
    toneMapped: false,
  });
  const domeMesh = new Mesh(dome, mat);
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
  const map = hdriTexture();
  const scene = studioScene(preset, bgMean, map);
  const pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0, 0.1, DOME_RADIUS * 4, { size: PMREM_SIZE });
  pmrem.dispose();
  disposeScene(scene);
  map.dispose();
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
      (o.material as ShaderMaterial).dispose();
    }
  });
}
