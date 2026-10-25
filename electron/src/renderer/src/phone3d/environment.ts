// Studio lighting (spec §3.1; owner decision 15): ONE light rig, in two parts.
//
// - The hero softboxes (lighting.ts boxes: the key, the rim strips, the
//   lens catchlight) are RectAreaLights at a finite distance round the phone
//   (LIGHT_DISTANCE body long sides, or the box's own nearer distance): they
//   draw the crisp highlights that sweep over the back and the band.
// - The room is ONE CC0 studio HDRI (hdri.ts, assets/SOURCE.md) through PMREM:
//   a dome that samples the panorama (turned by HDRI.yawDeg), × the preset's
//   gain and tint (HDRI_LOOK), under the preset's side flags and a little of
//   the backdrop's colour on the floor, plus the boxes painted into the set
//   (inEnv). The materials read it as a room of finite size (passes.ts
//   roomEnv), so flat faces show its structure. Look rounds 1-4 painted a
//   procedural set instead; judges read the metal as painted plastic and the
//   glass as a grey veil (decision 15).
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
  Color,
  Group,
  Mesh,
  PMREMGenerator,
  RectAreaLight,
  Scene,
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { DEFAULT_KEY_AZIMUTH, FLAGS, LIGHT_DISTANCE, LIGHT_PRESETS, type SoftBox } from '../../../shared/phone3d/lighting';
import type { LightPreset } from '../../../shared/phone3d/model';
import { HDRI, hdriTexture } from './hdri';

/** How much the floor takes on the background's mean colour (a bounce off the coloured backdrop). */
const FLOOR_TINT = 0.06;
/** The floor card blends in over this many degrees below the horizon. */
const FLOOR_BLEND_DEG = 15;
const DOME_RADIUS = 10;
/**
 * The studio floor falls off from the horizon toward the nadir: × 1 down to `fromDeg` below the horizon, × `deep`
 * from `toDeg` (smoothstep between). The panorama's floor is one bright white sweep, and a back seen from the
 * camera's height (22° above) mirrors the floor 10-35° down: unfalloffed, every back read as one flat tone and
 * the plateau step's down-facing wall mirrored the white and read lighter than the top face (look v2 round 1).
 * With the fall, a back's top (which mirrors nearer the horizon) is lighter than its bottom, the gradient a
 * product shot's sweep gives, and the step's wall (which mirrors further down) is darker than the top face.
 */
export const FLOOR_FALL = { fromDeg: 0, toDeg: 18, deep: 0.3 } as const;
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
    light.userData.box = { dir: lightDir(box.azimuth, box.elevation), ...boxSize(box), radiance: box.radiance * HDRI_LOOK[preset].boxes, distance: box.distance ?? LIGHT_DISTANCE };
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
export const HDRI_LOOK: Record<LightPreset, { gain: number; tint: string; boxes: number }> = {
  studio: { gain: 0.5, tint: '#f3f6ff', boxes: 0.5 },
  soft: { gain: 0.6, tint: '#ffffff', boxes: 1 },
  contrast: { gain: 0.25, tint: '#ffffff', boxes: 1 },
  warm: { gain: 0.4, tint: '#ffd9b8', boxes: 1 },
  night: { gain: 0.1, tint: '#b8c8ff', boxes: 1 },
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
  const k2 = k * (1 - (1 - FLOOR_FALL.deep) * smoothstep(FLOOR_FALL.fromDeg, FLOOR_FALL.toDeg, -el));
  const keep: [number, number, number] = [k2 * floor(br), k2 * floor(bgc), k2 * floor(bb)];
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

/** The set's resolution (studioSetTextures): 0.7° a texel, so the painted strips (half-width 4-5°) keep their soft
 *  edges. */
export const SET_TEX = { w: 512, h: 256 } as const;

/** The unit direction at equirect (u, v) (three's equirectUv inverted: u round from +x toward +z, v up). */
export function equirectDir(u: number, v: number): [number, number, number] {
  const phi = (u - 0.5) * 2 * Math.PI;
  const theta = (v - 0.5) * Math.PI;
  return [Math.cos(phi) * Math.cos(theta), Math.sin(theta), Math.sin(phi) * Math.cos(theta)];
}

/**
 * studioSet baked into two small equirect textures (SET_TEX, half float,
 * linear, row 0 = the bottom): keep (rgb) and add (rgb). The dome reads them
 * per pixel, so the dome itself can be a coarse mesh: the dense 512 × 256
 * dome of look round 4 was about 10 MB of vertex buffers while the PMREM was
 * made, and the 4K memory budget (owner decision 16) counts that peak.
 */
export function studioSetTextures(preset: LightPreset, bgMean: Rgb): { keep: DataTexture; add: DataTexture } {
  const { w, h } = SET_TEX;
  const keep = new Uint16Array(w * h * 4);
  const add = new Uint16Array(w * h * 4);
  const one = DataUtils.toHalfFloat(1);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = studioSet(preset, bgMean, equirectDir((i + 0.5) / w, (j + 0.5) / h));
      const o = (j * w + i) * 4;
      for (let c = 0; c < 3; c++) {
        keep[o + c] = DataUtils.toHalfFloat(v.keep[c]);
        add[o + c] = DataUtils.toHalfFloat(v.add[c]);
      }
      keep[o + 3] = one;
      add[o + 3] = one;
    }
  }
  const tex = (data: Uint16Array) => {
    const t = new DataTexture(data, w, h, RGBAFormat, HalfFloatType);
    t.colorSpace = NoColorSpace;
    t.wrapS = RepeatWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.minFilter = LinearFilter;
    t.magFilter = LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  return { keep: tex(keep), add: tex(add) };
}

/** Dome tessellation: the panorama and the set are read per pixel, so the sphere only has to be round. */
const DOME_SEG = { w: 64, h: 32 };

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

// The panorama (8-bit RGBE, decoded and interpolated here: RGBE does not filter) in the dome's direction turned by
// yaw about +y, × gain × tint × the set's keep, + the set's add.
const DOME_FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec2 mapSize;
uniform sampler2D setKeep;
uniform sampler2D setAdd;
uniform vec3 gainTint;
uniform float yaw;
varying vec3 vDir;
vec2 equirect( vec3 d ) {
  return vec2( atan( d.z, d.x ) * 0.15915494309189535 + 0.5, asin( clamp( d.y, -1.0, 1.0 ) ) * 0.3183098861837907 + 0.5 );
}
vec3 rgbe( int x, int y ) {
  vec4 c = floor( texelFetch( map, ivec2( x, y ), 0 ) * 255.0 + 0.5 );
  return c.a < 0.5 ? vec3( 0.0 ) : c.rgb * ( exp2( c.a - 128.0 ) / 255.0 );
}
void main() {
  vec3 d = normalize( vDir );
  vec2 uvSet = equirect( d );
  float c = cos( yaw );
  float s = sin( yaw );
  vec2 t = equirect( vec3( c * d.x + s * d.z, d.y, -s * d.x + c * d.z ) ) * mapSize - 0.5;
  vec2 f = fract( t );
  ivec2 i0 = ivec2( floor( t ) );
  int W = int( mapSize.x );
  int H = int( mapSize.y );
  int x0 = ( ( i0.x % W ) + W ) % W;
  int x1 = ( x0 + 1 ) % W;
  int y0 = clamp( i0.y, 0, H - 1 );
  int y1 = clamp( i0.y + 1, 0, H - 1 );
  vec3 hdr = mix( mix( rgbe( x0, y0 ), rgbe( x1, y0 ), f.x ), mix( rgbe( x0, y1 ), rgbe( x1, y1 ), f.x ), f.y );
  gl_FragColor = vec4( hdr * gainTint * texture2D( setKeep, uvSet ).rgb + texture2D( setAdd, uvSet ).rgb, 1.0 );
}`;

/** The scene that goes through PMREM: a dome reading the HDRI (HDRI_LOOK) under the set (studioSetTextures). `map` is
 *  the panorama texture (hdri.ts), owned by the caller; the set textures go with the scene (disposeScene). */
export function studioScene(preset: LightPreset, bgMean: Rgb, map: Texture & { image: { width: number; height: number } }): Scene {
  const scene = new Scene();
  const dome = new SphereGeometry(DOME_RADIUS, DOME_SEG.w, DOME_SEG.h);
  const set = studioSetTextures(preset, bgMean);
  const look = HDRI_LOOK[preset];
  const tint = new Color().setStyle(look.tint).multiplyScalar(look.gain);
  const mat = new ShaderMaterial({
    uniforms: {
      map: { value: map },
      mapSize: { value: new Vector2(map.image.width, map.image.height) },
      setKeep: { value: set.keep },
      setAdd: { value: set.add },
      gainTint: { value: new Vector3(tint.r, tint.g, tint.b) },
      yaw: { value: HDRI.yawDeg * deg },
    },
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: BackSide,
    depthWrite: false,
    toneMapped: false,
  });
  const domeMesh = new Mesh(dome, mat);
  domeMesh.name = 'studio:dome';
  domeMesh.userData.textures = [set.keep, set.add];
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
      for (const t of (o.userData.textures as Texture[] | undefined) ?? []) t.dispose();
    }
  });
}
