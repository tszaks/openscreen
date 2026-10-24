// Procedural studio lighting (D13, spec §3.1).
//
// Two parts, never double counted:
// 1. The hero softboxes are RectAreaLights. LTC gives analytically sharp
//    softbox edges at any resolution and (r186) covers clearcoat too, so the
//    band highlight and the glossy back's reflection are crisp streaks.
// 2. A PMREM environment holds only the fill: a dim vertical gradient dome
//    (2–6%), a floor bounce tinted by the project's mean background colour,
//    and a faint wide strip behind and above the camera, so the front glass
//    shows a diagonal sheen at FRONT. The hero boxes are NOT in it.
//
// Frame (lighting.ts): azimuth 0 is the camera's side (+z), + toward the
// canvas right (+x); elevation + up. `aimStudio` turns the light group and
// scene.environmentRotation together by (light.azimuth + pose.light).

import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PMREMGenerator,
  RectAreaLight,
  Scene,
  SphereGeometry,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { LIGHT_DISTANCE, LIGHT_PRESETS, type SoftBox } from '../../../shared/phone3d/lighting';
import { defaultPhone3D, type LightPreset } from '../../../shared/phone3d/model';

/**
 * Luminance (nits) of a softbox of relative intensity 1. A box seen in a
 * steel band (F0 ≈ 0.56) then reflects ≈ 20 in HDR, which survives a
 * 2-of-12-sample motion-blur average and tone maps to a bright streak (D3);
 * the diffuse back under the key sits around 0.1–0.3.
 */
export const BOX_RADIANCE = 22;

/** Fill dome levels, as multiples of the preset's `ambient` (0.02–0.06): top and horizon. */
const DOME_TOP = 1.0;
const DOME_HORIZON = 0.4;
/** Floor bounce: the background's mean linear colour × ambient × this. */
const FLOOR_BOUNCE = 1.5;
/** The sheen strip's radiance (it shows in the glass at specularIntensity × F0 ≈ 1%). */
export const SHEEN_RADIANCE = 2.5;
/**
 * The sheen strip: size (in dome-placement units), roll, and where it sits as
 * seen from the phone at the DEFAULT key azimuth: just above and right of
 * the camera, so a flat glass at FRONT reflects it (reflections of a flat
 * glass at FRONT only span about ±9° around the camera axis). The strip
 * turns with the light channel like the rest of the environment (D13), so
 * it lives at environment azimuth (camera az − default key az).
 */
const SHEEN = { w: 1.8, h: 0.4, azimuth: 3, elevation: 5, rollDeg: -32 };
const DEFAULT_KEY_AZIMUTH = defaultPhone3D().light.azimuth;
const DOME_RADIUS = 10;
export const PMREM_SIZE = 512;

let ltcReady = false;
/** RectAreaLightUniformsLib.init() once per process (it fills the LTC uniforms). */
export function initAreaLights() {
  if (!ltcReady) {
    RectAreaLightUniformsLib.init();
    ltcReady = true;
  }
}

const deg = Math.PI / 180;
/** Unit direction for (azimuth, elevation) in this file's frame. */
export function lightDir(azimuthDeg: number, elevationDeg: number): [number, number, number] {
  const a = azimuthDeg * deg;
  const e = elevationDeg * deg;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

/**
 * The hero softboxes of a preset as RectAreaLights, aimed at the origin.
 * `unit` is the phone body's long side in world units (boxes are sized and
 * placed in long sides; RectAreaLight ignores a parent's scale for its
 * size, so the unit is applied here). `intensity` = phone3d.light.intensity.
 */
export function studioLights(preset: LightPreset, unit = 1, intensity = 1): Group {
  initAreaLights();
  const g = new Group();
  g.name = `studio:${preset}`;
  for (const [i, box] of LIGHT_PRESETS[preset].boxes.entries()) g.add(softbox(box, unit, intensity, i));
  return g;
}

function softbox(box: SoftBox, unit: number, intensity: number, i: number): RectAreaLight {
  const light = new RectAreaLight(new Color().setStyle(box.color), box.intensity * BOX_RADIANCE * intensity, box.w * unit, box.h * unit);
  const [x, y, z] = lightDir(box.azimuth, box.elevation);
  const d = LIGHT_DISTANCE * unit;
  light.position.set(x * d, y * d, z * d);
  light.lookAt(0, 0, 0);
  light.name = i === 0 ? 'key' : `box${i}`;
  light.userData.baseIntensity = box.intensity * BOX_RADIANCE;
  return light;
}

/** Rescale a light group to a new phone3d.light.intensity without rebuilding it. */
export function setLightIntensity(lights: Group, intensity: number) {
  for (const l of lights.children) if (l instanceof RectAreaLight) l.intensity = (l.userData.baseIntensity as number) * intensity;
}

/** Turn the softboxes and the fill environment together (key azimuth = light.azimuth + pose.light). */
export function aimStudio(lights: Group, scene: Scene, azimuthDeg: number) {
  lights.rotation.set(0, azimuthDeg * deg, 0);
  scene.environmentRotation.set(0, azimuthDeg * deg, 0);
}

export type Rgb = readonly [number, number, number];

/** 16 levels per channel, so a slowly changing background reuses the cached environment. */
export const quantizeBg = (bg: Rgb): [number, number, number] => bg.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 15) / 15) as [number, number, number];

/**
 * The fill scene that goes through PMREM: the gradient dome (with the floor
 * bounce in its lower half) and the sheen strip. No RectAreaLight and no
 * softbox mesh: the hero boxes are lights only.
 */
export function fillScene(preset: LightPreset, bgMean: Rgb): Scene {
  const rig = LIGHT_PRESETS[preset];
  const amb = rig.ambient;
  const scene = new Scene();
  const dome = new SphereGeometry(DOME_RADIUS, 64, 32);
  const pos = dome.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const [br, bgc, bb] = quantizeBg(bgMean);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / DOME_RADIUS;
    let r: number, g: number, b: number;
    if (y >= 0) {
      // Horizon → top: a smooth rise (smoothstep), neutral.
      const s = y * y * (3 - 2 * y);
      const v = amb * (DOME_HORIZON + (DOME_TOP - DOME_HORIZON) * s);
      r = g = b = v;
    } else {
      // Below the horizon: the floor bounce, tinted by the background.
      const s = Math.min(1, -y * 3);
      const h = amb * DOME_HORIZON;
      r = h + (br * amb * FLOOR_BOUNCE - h) * s;
      g = h + (bgc * amb * FLOOR_BOUNCE - h) * s;
      b = h + (bb * amb * FLOOR_BOUNCE - h) * s;
    }
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  dome.setAttribute('color', new BufferAttribute(colors, 3));
  const domeMesh = new Mesh(dome, new MeshBasicMaterial({ vertexColors: true, side: BackSide, toneMapped: false }));
  domeMesh.name = 'fill:dome';
  scene.add(domeMesh);

  const d = DOME_RADIUS * 0.6;
  // Soft-edged: radiance falls off as cos² across the strip and toward its
  // ends, added over the dome. A hard-edged quad showed the cube map's
  // texels as stair steps in the glass.
  const sg = new PlaneGeometry(SHEEN.w * d, SHEEN.h * d, 24, 12);
  const sp = sg.getAttribute('position');
  const sc = new Float32Array(sp.count * 3);
  for (let i = 0; i < sp.count; i++) {
    const u = sp.getX(i) / ((SHEEN.w * d) / 2);
    const v = sp.getY(i) / ((SHEEN.h * d) / 2);
    const bump = (x: number) => Math.max(0, Math.cos((Math.PI / 2) * Math.min(1, Math.abs(x))));
    const k = SHEEN_RADIANCE * bump(v) ** 2 * Math.sqrt(bump(u));
    sc[i * 3] = sc[i * 3 + 1] = sc[i * 3 + 2] = k;
  }
  sg.setAttribute('color', new BufferAttribute(sc, 3));
  const strip = new Mesh(
    sg,
    new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, toneMapped: false, blending: AdditiveBlending, transparent: true, depthWrite: false }),
  );
  const [sx, sy, sz] = lightDir(SHEEN.azimuth - DEFAULT_KEY_AZIMUTH, SHEEN.elevation);
  strip.position.set(sx * d, sy * d, sz * d);
  strip.lookAt(0, 0, 0);
  strip.rotateZ(SHEEN.rollDeg * deg);
  strip.name = 'fill:sheen';
  scene.add(strip);
  return scene;
}

interface EnvEntry {
  target: WebGLRenderTarget;
}
const envCaches = new WeakMap<WebGLRenderer, Map<string, EnvEntry>>();
const ENV_CACHE_SIZE = 4;

/**
 * The PMREM fill environment for a preset and background mean (linear RGB),
 * via `fromScene(fill, 0, near, far, { size: 512 })` (about 25 MB HalfFloat).
 * Cached per renderer, per (preset, bgMean quantized to 16 levels), LRU 4;
 * evicted targets are disposed. Set it as `scene.environment`.
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
  const scene = fillScene(preset, bgMean);
  const pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0, 0.1, DOME_RADIUS * 4, { size: PMREM_SIZE });
  pmrem.dispose();
  disposeScene(scene);
  cache.set(key, { target });
  while (cache.size > ENV_CACHE_SIZE) {
    const oldest = cache.keys().next().value as string;
    cache.get(oldest)!.target.dispose();
    cache.delete(oldest);
  }
  return target.texture;
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
