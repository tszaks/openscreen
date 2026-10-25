// The 3D phone's GPU passes (SPEC §3.5, §3.7, D3, D19, D22): the
// 2-attachment HDR MSAA target the scene renders into, the accumulation of
// motion-blur and anti-aliasing sub-samples, the depth-of-field gather, and
// the output pass (tone map, unpremultiply, sRGB, dither, premultiply) that
// writes the finished pixels into the engine canvas. Also the pure planning
// the passes run from (sub-sample times and jitter, tiles), kept free of the
// GPU so tests can pin it.
//
// Attachment 0 holds every lit surface (scene-linear HDR, premultiplied,
// alpha = coverage); attachment 1 holds only the screen (linear premultiplied
// colour, alpha = screen coverage). Both are averaged in HDR; only the output
// pass tone maps, and only attachment 0, so the recording on the screen goes
// sRGB → linear → sRGB untouched.
//
// Every pass reads its inputs with texelFetch at integer coordinates, so no
// pass filters or resamples: the FRONT screen stays texel exact.
import * as THREE from 'three';
import type { ShutterWindow } from '../../../shared/phone3d/pose';

// ---------------------------------------------------------------------------
// Sample plan (pure)

/** Radical inverse of `i` in `base` (the Halton sequence), i ≥ 1. */
export function halton(i: number, base: number): number {
  let f = 1;
  let r = 0;
  let n = i;
  while (n > 0) {
    f /= base;
    r += f * (n % base);
    n = Math.floor(n / base);
  }
  return r;
}

/** Most sub-samples a frame takes (the adaptive motion count's cap). */
export const MAX_SAMPLES = 64;
/** Anti-aliasing sub-samples in export and full-quality frames (D19). */
export const AA_SAMPLES = 8;
/**
 * Adjacent motion-blur copies are on average at most this far apart, in output px at the 1080 reference
 * (MOTION_REF_PX on the canvas's short side; a 4K canvas counts its travel at half). Round 1's 1.5 render px left
 * every crisp edge (side buttons, UI text) as a stack of copies 1.5-3 px apart that read as ghosts; at 1 px with
 * each copy at a random time inside its slot (planSamples), the copies blend into a smear.
 */
export const MOTION_STEP_PX = 1;
/** The canvas short side the motion step is measured at. */
export const MOTION_REF_PX = 1080;
/** Below this hull travel over the shutter (output px at the reference) the phone counts as still. */
export const STILL_TRAVEL_PX = 0.5;

/** Fixed sub-pixel jitter per sample, render px: sample 0 is unjittered, then Halton(2, 3) − 0.5 (D19). */
export const JITTER: readonly (readonly [number, number])[] = Array.from({ length: MAX_SAMPLES }, (_, k) =>
  k === 0 ? ([0, 0] as const) : ([halton(k, 2) - 0.5, halton(k, 3) - 0.5] as const),
);

/**
 * A fixed hash of (frame time, sample) to [0, 1): where inside its time slot a motion sample sits. Keyed on the
 * time in whole microseconds, so the same frame always renders the same way (frames, export and a re-render agree).
 */
export function slotOffset(t: number, k: number): number {
  let h = (Math.round(t * 1e6) | 0) ^ Math.imul(k + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export interface SamplePlan {
  /** Sub-samples rendered for this frame. */
  n: number;
  /** The motion-blur part of n (1 = the phone is still over the shutter). */
  nMotion: number;
  /** Output time of each sample. */
  times: number[];
  /** Sub-pixel camera offset of each sample, render px. */
  jitter: (readonly [number, number])[];
  /** Each sample's share of the frame (the tent shutter's weight; 1/N when still), summing to 1. */
  weights: number[];
}

export interface SampleInputs {
  /** Output time of the frame. */
  t: number;
  /** Longest projected hull path over the shutter, output px at the 1080 reference (travelRefPx); 0 with motion blur off. */
  travelPx: number;
  /** Motion blur: the user's minimum sample count and the shutter in seconds; null = off. */
  motion: { samples: number; shutterSec: number } | null;
  /** Export / full-quality frames (8 jittered samples, adaptive motion); false = one sample (live preview, --draft). */
  full: boolean;
  /**
   * The shutter cut at a pose break (shutterWindow), or null/absent for the
   * whole shutter. A cut frame samples only inside it, so a frame on an
   * unlinked Start shows one pose, not both. `travelPx` must be measured over
   * the same window (hullTravelPx's `win`).
   */
  win?: ShutterWindow | null;
}

/** Hull travel in output px of a canvas whose short side is `shortSide`, as px at the 1080 reference. */
export function travelRefPx(travelOutputPx: number, shortSide: number): number {
  return travelOutputPx * Math.min(1, MOTION_REF_PX / Math.max(1, shortSide));
}

/**
 * The shutter's response at u (0..1 across the shutter): a tent, 1 in the
 * middle, 0 at both ends. A box shutter (every sample weighed the same)
 * prints every thin stroke as two hard-edged copies at the ends of its smear
 * (look round 2: "TD Bank" read as doubled text); a tent fades the smear out
 * at both ends, and its spread (σ) is 0.71× a box's of the same width. The
 * samples stay evenly spread in time (1 px apart), so no gap opens at the
 * ends; only their weights follow the tent.
 */
export function tentShutter(u: number): number {
  return Math.max(0, 1 - Math.abs(2 * Math.min(1, Math.max(0, u)) - 1));
}

/**
 * The sub-samples of one frame (§3.7 step 4), from pose and fixed tables only,
 * so a frame always renders the same way. Nmotion = 1 when the hull moves less
 * than STILL_TRAVEL_PX over the shutter, else ceil(travel / MOTION_STEP_PX)
 * clamped to [max(2, samples), 64]; N = max(Nmotion, 8) at full quality, 1
 * otherwise. A moving frame's shutter is cut into N equal slots and each
 * sample sits at a fixed-random place in its own slot (stratified): even
 * spacing printed the copies of an edge as a regular stack (ghosts); jittered,
 * the leftover steps are fine noise inside the smear. Each sample is weighed
 * by the tent shutter at its place (`weights`, summing to 1); a still frame's
 * samples weigh 1/N each.
 */
export function planSamples({ t, travelPx, motion, full, win }: SampleInputs): SamplePlan {
  if (!full) return { n: 1, nMotion: 1, times: [t], jitter: [JITTER[0]], weights: [1] };
  const span = win ? win.hi - win.lo : (motion?.shutterSec ?? 0);
  const moving = motion !== null && motion.shutterSec > 0 && span > 0 && travelPx >= STILL_TRAVEL_PX;
  const nMotion = moving
    ? Math.min(MAX_SAMPLES, Math.max(Math.max(2, Math.round(motion.samples)), Math.ceil(travelPx / MOTION_STEP_PX)))
    : 1;
  const n = Math.max(nMotion, AA_SAMPLES);
  const u = Array.from({ length: n }, (_, k) => (k + slotOffset(t, k)) / n);
  // A shutter cut at a pose break (win) spreads the samples over the cut window; each keeps the tent weight of its
  // place in the full shutter (the cut tent), so the exposure profile is the same, only truncated. With no break the
  // arithmetic is exactly the uncut one.
  const times = u.map((x) => (nMotion > 1 ? (win ? win.lo + x * span : t + (x - 0.5) * motion!.shutterSec) : t));
  const raw = times.map((tt, k) => (nMotion > 1 ? tentShutter(win ? (tt - t) / motion!.shutterSec + 0.5 : u[k]) : 1));
  const sum = raw.reduce((a, b) => a + b, 0);
  return { n, nMotion, times, jitter: JITTER.slice(0, n), weights: raw.map((w) => w / sum) };
}

/** The screen content holds still (no motion blur) when the screen faces the camera this squarely or more (cosine);
 *  it blurs fully below SCREEN_STEADY_FACING[0]. */
export const SCREEN_STEADY_FACING = [0.8, 0.9] as const;
/** ...and within this many seconds of a tap (fully steady inside the first, blurring again by the second). */
export const SCREEN_STEADY_TAP = [0.15, 0.3] as const;
/** ...and never less than this: even turned away at full speed the content smears half as far as the body moves, so
 *  the UI stays readable through a spin (look round 4: the full smear at the spin-in's peak hid the app). */
export const SCREEN_STEADY_FLOOR = 0.5;

const smoothstep = (a: number, b: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/**
 * How still the screen CONTENT is held under motion blur, 0..1 (§3.7 step 4,
 * look round 3): 1 when the screen faces the viewer (facing ≥ 0.9) or a tap
 * is within 0.15 s, so the UI is crisp when it is the point of the frame and
 * a tap always lands on legible text; the floor (half the blur) when the
 * phone is turned away and no tap is near. In between it eases. The body, the screen's
 * edge and the glass still blur as the phone moves; only what the screen shows
 * is read where the frame's centre pose put it. Never below
 * SCREEN_STEADY_FLOOR (half the content smear). `tapGap` = seconds from the
 * frame to the nearest tap (Infinity when none). Pure.
 */
export function screenSteadiness(facing: number, tapGap: number): number {
  const byFacing = smoothstep(SCREEN_STEADY_FACING[0], SCREEN_STEADY_FACING[1], facing);
  const byTap = 1 - smoothstep(SCREEN_STEADY_TAP[0], SCREEN_STEADY_TAP[1], tapGap);
  return Math.max(SCREEN_STEADY_FLOOR, byFacing, byTap);
}

// ---------------------------------------------------------------------------
// Tiles (pure)

/**
 * GPU bytes per render pixel that decide the tiling (§3.7 step 8). Full
 * quality (export, frames, the paused preview) renders every sample without
 * MSAA (the jitter anti-aliases): the plain target (2 × 8 B colour + 4 B
 * depth), the accumulation and the DoF output (2 × 8 B each). A
 * single-sample frame (live preview, --draft) renders with 4× MSAA: the spec's
 * 4 × (2 × 8 B + 4 B) of MSAA storage (its resolve is counted in bytes()).
 */
export const TILE_BYTES_PER_PX = { full: 20 + 16 + 16, msaa: 4 * 20 } as const;

/** Above this many bytes, the ROI renders in tiles (§3.7 step 8). */
export const TILE_THRESHOLD_BYTES = 120e6;
/** Largest tile side, render px. */
export const TILE_MAX_SIDE = 2048;
/** Largest tile area, render px: as many pixels as TILE_THRESHOLD_BYTES of targets hold at `bytesPerPx`. */
export function tileMaxPx(bytesPerPx: number): number {
  return Math.floor(TILE_THRESHOLD_BYTES / bytesPerPx);
}

/** One tile: its core (written to the canvas) and the padded window rendered for it, render px, top-down. */
export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The rendered window: the core plus `overlap` on every side that has a neighbour (clipped to the area). */
  px: number;
  py: number;
  pw: number;
  ph: number;
}

/**
 * Splits a w × h render area into tiles when its targets would pass
 * TILE_THRESHOLD_BYTES at `bytesPerPx`: each padded tile is at most
 * tileMaxPx(bytesPerPx) with a long side
 * ≤ TILE_MAX_SIDE, its size a multiple of `ss` (so a tile never splits an
 * output pixel), and is padded by `overlap` px (the DoF reach) that is
 * rendered and discarded. One tile (the whole area) otherwise.
 */
export function planTiles(w: number, h: number, ss: number, overlap: number, bytesPerPx: number = TILE_BYTES_PER_PX.full): Tile[] {
  if (w <= 0 || h <= 0) return [];
  if (w * h * bytesPerPx <= TILE_THRESHOLD_BYTES) return [{ x: 0, y: 0, w, h, px: 0, py: 0, pw: w, ph: h }];
  const ov = Math.max(0, Math.ceil(overlap));
  const maxPx = tileMaxPx(bytesPerPx);
  // The fewest columns and rows whose padded tiles fit the limits.
  let cols = Math.max(1, Math.ceil(w / TILE_MAX_SIDE));
  let rows = Math.max(1, Math.ceil(h / TILE_MAX_SIDE));
  const fits = () => {
    const tw = Math.ceil(w / cols / ss) * ss + 2 * ov;
    const th = Math.ceil(h / rows / ss) * ss + 2 * ov;
    return tw <= TILE_MAX_SIDE && th <= TILE_MAX_SIDE && tw * th <= maxPx;
  };
  for (let guard = 0; !fits() && guard < 256; guard++) {
    // Split the longer tile side.
    if (w / cols >= h / rows) cols++;
    else rows++;
  }
  const tw = Math.ceil(w / cols / ss) * ss;
  const th = Math.ceil(h / rows / ss) * ss;
  const tiles: Tile[] = [];
  for (let y = 0; y < h; y += th) {
    for (let x = 0; x < w; x += tw) {
      const cw = Math.min(tw, w - x);
      const ch = Math.min(th, h - y);
      const px = Math.max(0, x - ov);
      const py = Math.max(0, y - ov);
      tiles.push({ x, y, w: cw, h: ch, px, py, pw: Math.min(w, x + cw + ov) - px, ph: Math.min(h, y + ch + ov) - py });
    }
  }
  return tiles;
}

// ---------------------------------------------------------------------------
// Material patches (§3.5, §3.6)

export type MrtRole = 'lit' | 'screen' | 'glare';

/** A named shader edit; a material's patches run in the order they were added, once each. */
interface ShaderPatch {
  key: string;
  apply: (shader: THREE.WebGLProgramParametersWithUniforms) => void;
}

/**
 * Adds a patch to a material's onBeforeCompile (the one place every phone3d
 * shader patch goes through): idempotent per key, composes with any patch
 * added before it and with an onBeforeCompile the material already had, and
 * keys three's program cache by the patch list.
 */
function addPatch(mat: THREE.Material, patch: ShaderPatch): void {
  const data = mat.userData as { phone3dPatches?: ShaderPatch[] };
  let list = data.phone3dPatches;
  if (!list) {
    list = data.phone3dPatches = [];
    const prev = mat.onBeforeCompile.bind(mat);
    // Three's default key is the onBeforeCompile source, which this replaces: only a material's own key is kept.
    const ownKey = mat.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey;
    const prevKey = ownKey ? mat.customProgramCacheKey.bind(mat) : () => '';
    const patches = list;
    mat.onBeforeCompile = (shader, renderer) => {
      prev(shader, renderer);
      for (const p of patches) p.apply(shader);
    };
    mat.customProgramCacheKey = () => {
      const base = prevKey();
      const own = patches.map((p) => p.key).join('|');
      return base ? `${base}|${own}` : own;
    };
  }
  if (list.some((p) => p.key === patch.key)) return;
  list.push(patch);
  mat.needsUpdate = true;
}

/** The location-1 output (three's program prefix declares pc_fragColor at location 0, WebGLProgram.js:819). */
export const MRT_DECL = 'layout(location = 1) out highp vec4 pc_fragScreen;';

/**
 * Makes a material write both attachments of the MRT target (§3.5):
 * - 'lit': attachment 0 stays as three computed it (HDR, premultiplied,
 *   alpha = coverage); attachment 1 = 0.
 * - 'screen': attachment 1 = the screen colour, linear premultiplied, alpha =
 *   coverage; attachment 0 = (0, 0, 0, a), so the lit layer knows it is covered.
 * - 'glare': the cover glass's sheen over the screen (an additive layer, its
 *   alpha kept by its blending): its colour, × the material's glare weight
 *   (planGlare), goes to attachment 1 with the screen; attachment 0 gets
 *   nothing. The sheen is drawn on only some samples (planGlare), each
 *   weighted by how many samples it stands for.
 * Every material drawn into the target must have one, so no attachment is ever
 * left undefined. Idempotent.
 */
export function mrtOutput<M extends THREE.Material>(mat: M, role: MrtRole): M {
  addPatch(mat, {
    key: `mrt-${role}`,
    apply: (shader) => {
      const tail =
        role === 'lit'
          ? '\tpc_fragScreen = vec4( 0.0 );'
          : role === 'glare'
            ? '\tpc_fragScreen = vec4( gl_FragColor.rgb * uGlareWeight, 0.0 );\n\tgl_FragColor = vec4( 0.0 );'
            : '\tpc_fragScreen = vec4( gl_FragColor.rgb * gl_FragColor.a, gl_FragColor.a );\n\tgl_FragColor = vec4( 0.0, 0.0, 0.0, gl_FragColor.a );';
      if (role === 'glare') {
        shader.uniforms.uGlareWeight = glareWeight(mat);
        shader.fragmentShader = `uniform float uGlareWeight;\n${shader.fragmentShader}`;
      }
      shader.fragmentShader = closeMain(`${MRT_DECL}\n${shader.fragmentShader}`, tail);
    },
  });
  return mat;
}

/** three r186's RectAreaLight diffuse integral (lights_physical_pars_fragment, RE_Direct_RectArea_Physical). */
export const RECT_DIFFUSE_LINE =
  'reflectedLight.directDiffuse += lightColor * material.diffuseContribution * LTC_Evaluate( normal, viewDir, position, mat3( 1.0 ), rectCoords );';

/**
 * Leaves out each RectAreaLight's diffuse integral, for a surface with no
 * diffuse term: a metal (metalness 1, so three's diffuseContribution is
 * exactly 0) or the black glare layer. three evaluates it anyway, and it is
 * one of the two or three LTC polygon integrals a rect light costs per pixel
 * (look round 4 fix round 1: the rig had tripled the moving-frame cost).
 * Exact: the term it drops is 0. Throws if three's chunk changes, so an
 * upgrade cannot silently keep the cost.
 */
export function rectSpecularOnly<M extends THREE.Material>(mat: M): M {
  addPatch(mat, {
    key: 'rect-nodiffuse',
    apply: (shader) => {
      const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
      if (!chunk.includes(RECT_DIFFUSE_LINE)) throw new Error('phone3d: three changed RE_Direct_RectArea_Physical');
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', chunk.replace(RECT_DIFFUSE_LINE, ''));
    },
  });
  return mat;
}

/**
 * Fades a material's specular by how far the surface turns from the camera's
 * axis: 0 while the sine of that angle (the view-space normal's x, y length)
 * is under `sinClear`, full from `sinFull`, smoothstep between. For the front
 * cover glass (materials.ts FRONT_GLASS_FLAG): the studio's black flag round
 * the lens, so a screen parallel to the canvas mirrors black and stays exact.
 * The geometric normal (nonPerturbedNormal), so a flat sheet fades as one.
 */
export function flagFade<M extends THREE.Material>(mat: M, sinClear: number, sinFull: number): M {
  addPatch(mat, {
    key: `flag-${sinClear.toFixed(4)}-${sinFull.toFixed(4)}`,
    apply: (shader) => {
      const at = '#include <lights_fragment_end>';
      if (!shader.fragmentShader.includes(at)) throw new Error('phone3d: flagFade needs a lit material');
      shader.fragmentShader = shader.fragmentShader.replace(
        at,
        `${at}\n\t{\n\t\tfloat flag = smoothstep( ${sinClear.toFixed(6)}, ${sinFull.toFixed(6)}, length( nonPerturbedNormal.xy ) );\n\t\treflectedLight.directSpecular *= flag;\n\t\treflectedLight.indirectSpecular *= flag;\n\t}`,
      );
    },
  });
  return mat;
}

/** The glare material's weight uniform (how many samples this draw stands for). */
function glareWeight(mat: THREE.Material): { value: number } {
  const data = mat.userData as { glareWeight?: { value: number } };
  return (data.glareWeight ??= { value: 1 });
}

/** Sets the glare's weight for the next draw (planGlare). */
export function setGlareWeight(mat: THREE.Material, w: number): void {
  glareWeight(mat).value = w;
}

/** Most samples a moving frame draws the glass sheen on: every one (MAX_SAMPLES). */
export const GLARE_SAMPLES = MAX_SAMPLES;

/**
 * Which samples draw the screen's glass sheen, and with what weight (§3.7
 * step 5). The sheen is one sheet with the border round the screen
 * (materials.ts FRONT_GLASS_ROUGHNESS), so:
 * - a still phone draws it on sample 0 only, × N: the screen layer of a
 *   still export frame is then the --draft frame's exactly, sheen included
 *   (the sheen does not move with the sub-pixel jitter);
 * - a moving one on every sample, like the border it continues: round 1
 *   drew it on 8 samples at most, and with a sharper sheen and finer motion
 *   steps those 8 copies would strobe across the screen. With all the light
 *   in one environment it is cheap enough (look round 2 bench).
 * `weight[k]` is 0 for a sample that skips it. Pure.
 */
export function planGlare(plan: Pick<SamplePlan, 'n' | 'nMotion'>): number[] {
  const N = plan.n;
  const step = plan.nMotion > 1 ? Math.ceil(N / GLARE_SAMPLES) : N;
  return Array.from({ length: N }, (_, k) => (k % step === 0 ? Math.min(step, N - k) : 0));
}

/** Inserts `code` just before the closing brace of main(). */
function closeMain(src: string, code: string): string {
  const i = src.lastIndexOf('}');
  if (i < 0) throw new Error('phone3d: shader has no main()');
  return src.slice(0, i) + code + '\n' + src.slice(i);
}

/** The screen's LOD bias (§3.6): an oblique screen minified by up to the texture's hysteresis slack (8%) still reads mip 0. */
export const LOD_BIAS = -0.5;
export const LOD_MAP_FRAGMENT = `#ifdef USE_MAP
\tvec4 sampledDiffuseColor = texture( map, vMapUv, ${LOD_BIAS.toFixed(1)} );
\tdiffuseColor *= sampledDiffuseColor;
#endif`;

/** Samples the colour map with LOD_BIAS (§3.6). */
export function lodBias<M extends THREE.Material>(mat: M): M {
  addPatch(mat, {
    key: 'lodbias',
    apply: (shader) => {
      if (!shader.fragmentShader.includes('#include <map_fragment>')) throw new Error('phone3d: no map_fragment to bias');
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', LOD_MAP_FRAGMENT);
    },
  });
  return mat;
}

/** Per-draw inputs of the screen's texture lookup (screenLookup). */
interface ScreenLookupUniforms {
  uScreenJitter: { value: THREE.Vector2 };
  uSteady: { value: number };
  uSteadyH: { value: THREE.Matrix3 };
  uSteadyMap: { value: THREE.Matrix3 };
  uTileOrigin: { value: THREE.Vector2 };
  uTileH: { value: number };
  uSs: { value: number };
}

function lookupUniforms(mat: THREE.Material): ScreenLookupUniforms {
  const data = mat.userData as { screenLookup?: ScreenLookupUniforms };
  return (data.screenLookup ??= {
    uScreenJitter: { value: new THREE.Vector2() },
    uSteady: { value: 0 },
    uSteadyH: { value: new THREE.Matrix3() },
    uSteadyMap: { value: new THREE.Matrix3() },
    uTileOrigin: { value: new THREE.Vector2() },
    uTileH: { value: 1 },
    uSs: { value: 1 },
  });
}

/**
 * The screen texture lookup (§3.6, §3.7 step 4, D19). Two corrections, so
 * the screen's inside stays exact while its edge anti-aliases and blurs:
 * - Jitter: a jittered sample sees the scene moved by `j` render px, so the
 *   fragment at a pixel reads the texel the UNjittered render read there:
 *   uv − dFdx(uv)·jx + dFdy(uv)·jy (render px are y down, gl_FragCoord y up).
 * - Steadiness (screenSteadiness): under motion blur each sample's screen is
 *   at its own pose, and the UI text smears with it. With uSteady = 1 the
 *   fragment instead reads the texel the frame's CENTRE pose put at this
 *   output pixel: its canvas position (the tile's place in the full view, no
 *   jitter, / ss) through uSteadyH (canvas → mesh uv at the centre pose,
 *   projection.ts screenUvMap) and the texture's own transform (uSteadyMap).
 *   Every sample then reads the same picture, so the content is crisp while
 *   the screen's edge still moves with the phone; uSteady between 0 and 1
 *   mixes the two (a shorter smear).
 * Apply after lodBias.
 */
export function screenLookup<M extends THREE.Material>(mat: M): M {
  const u = lookupUniforms(mat);
  addPatch(mat, {
    key: 'screen-lookup',
    apply: (shader) => {
      const call = 'texture( map, vMapUv,';
      if (!shader.fragmentShader.includes(call)) throw new Error('phone3d: screenLookup needs lodBias first');
      Object.assign(shader.uniforms, u);
      // After three's declarations (vMapUv is declared by uv_pars_fragment), just before main().
      const main = 'void main() {';
      if (!shader.fragmentShader.includes(main)) throw new Error('phone3d: screen shader has no main()');
      const lookup =
        `uniform vec2 uScreenJitter;
uniform float uSteady;
uniform mat3 uSteadyH;
uniform mat3 uSteadyMap;
uniform vec2 uTileOrigin;
uniform float uTileH;
uniform float uSs;
vec2 screenUv() {
	vec2 own = vMapUv - dFdx( vMapUv ) * uScreenJitter.x + dFdy( vMapUv ) * uScreenJitter.y;
	if ( uSteady <= 0.0 ) return own;
	vec2 canvasPx = ( uTileOrigin + vec2( gl_FragCoord.x, uTileH - gl_FragCoord.y ) ) / uSs;
	vec3 q = uSteadyH * vec3( canvasPx, 1.0 );
	vec2 meshUv = clamp( q.xy / q.z, 0.0, 1.0 );
	vec2 held = ( uSteadyMap * vec3( meshUv, 1.0 ) ).xy;
	return mix( own, held, uSteady );
}
`;
      shader.fragmentShader = shader.fragmentShader.replace(main, lookup + main).replace(call, 'texture( map, screenUv(),');
    },
  });
  return mat;
}

/** Sets the jitter (render px) the screen's texture lookup undoes for the next draw. */
export function setScreenJitter(mat: THREE.Material, x: number, y: number): void {
  lookupUniforms(mat).uScreenJitter.value.set(x, y);
}

/**
 * Sets the frame's screen steadiness (screenSteadiness) and the centre pose's canvas → mesh uv map (row-major,
 * projection.ts Homography) with the texture's uv transform; 0 turns the steady lookup off.
 */
export function setScreenSteady(mat: THREE.Material, steady: number, canvasToUv: readonly number[] | null, mapMatrix: THREE.Matrix3 | null): void {
  const u = lookupUniforms(mat);
  u.uSteady.value = canvasToUv && mapMatrix ? Math.min(1, Math.max(0, steady)) : 0;
  if (canvasToUv && mapMatrix) {
    const m = canvasToUv;
    u.uSteadyH.value.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    u.uSteadyMap.value.copy(mapMatrix);
  }
}

/** Sets where the tile being drawn sits in the full W·ss × H·ss view (render px, top-down, no jitter), its height and ss. */
export function setScreenTile(mat: THREE.Material, x: number, y: number, h: number, ss: number): void {
  const u = lookupUniforms(mat);
  u.uTileOrigin.value.set(x, y);
  u.uTileH.value = h;
  u.uSs.value = ss;
}

// ---------------------------------------------------------------------------
// Fullscreen passes

const FULLSCREEN_VERT = /* glsl */ `
void main() {
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

/** Accumulates one resolved sample into the accumulation target with per-attachment weights (blend ONE, ONE). */
const ACCUM_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D uSrc0;
uniform highp sampler2D uSrc1;
uniform float uW0;
uniform float uW1;
layout(location = 0) out highp vec4 o0;
layout(location = 1) out highp vec4 o1;
void main() {
  ivec2 p = ivec2( gl_FragCoord.xy );
  o0 = texelFetch( uSrc0, p, 0 ) * uW0;
  o1 = texelFetch( uSrc1, p, 0 ) * uW1;
}`;

/**
 * Depth-of-field gather on both attachments (§3.7 step 6): scatter-as-gather
 * over a fixed Vogel disc. A tap counts by how much of its own circle of
 * confusion reaches the centre; a tap behind the centre can blur onto it no
 * further than the centre's own CoC, so a sharp phone never takes on the blur
 * of what is behind it. Premultiplied, so edges fade into transparency.
 */
const DOF_FRAG = /* glsl */ `
precision highp float;
#include <packing>
uniform highp sampler2D uSrc0;
uniform highp sampler2D uSrc1;
uniform highp sampler2D uDepth;
uniform float uNear;
uniform float uFar;
uniform float uFocusZ;
uniform float uCocScale;
uniform float uMaxCoc;
uniform int uTaps;
uniform ivec2 uSize;
layout(location = 0) out highp vec4 o0;
layout(location = 1) out highp vec4 o1;
float viewZ( ivec2 p ) {
  float d = texelFetch( uDepth, p, 0 ).x;
  return -perspectiveDepthToViewZ( d, uNear, uFar );
}
float coc( float z ) {
  return min( uMaxCoc, uCocScale * abs( 1.0 - uFocusZ / max( z, 1e-3 ) ) );
}
void main() {
  ivec2 p = ivec2( gl_FragCoord.xy );
  float zc = viewZ( p );
  float rc = coc( zc );
  vec4 s0 = texelFetch( uSrc0, p, 0 );
  vec4 s1 = texelFetch( uSrc1, p, 0 );
  float wsum = 1.0;
  const float GOLDEN = 2.39996323;
  for ( int i = 0; i < 64; i++ ) {
    if ( i >= uTaps ) break;
    float r = uMaxCoc * sqrt( ( float( i ) + 0.5 ) / float( uTaps ) );
    float a = float( i ) * GOLDEN;
    ivec2 q = clamp( p + ivec2( round( vec2( cos( a ), sin( a ) ) * r ) ), ivec2( 0 ), uSize - 1 );
    float d = length( vec2( q - p ) );
    float zi = viewZ( q );
    float ri = coc( zi );
    float reach = zi > zc ? min( ri, rc ) : ri;
    float w = clamp( reach - d + 0.5, 0.0, 1.0 );
    s0 += texelFetch( uSrc0, q, 0 ) * w;
    s1 += texelFetch( uSrc1, q, 0 ) * w;
    wsum += w;
  }
  o0 = s0 / wsum;
  o1 = s1 / wsum;
}`;

/**
 * The output pass (§3.5, D3, D22), per canvas pixel: the ss × ss box
 * downsample of both attachments (linear premultiplied), the lit layer tone
 * mapped with three's NeutralToneMapping on its unpremultiplied colour, the
 * screen added untouched, then unpremultiply → sRGB → a fixed ±0.5 LSB dither
 * on the lit part only (colour, and alpha where it is a soft gradient: the
 * shadow is black, so its banding would be in alpha) → premultiply again into
 * the premultipliedAlpha canvas.
 * Tone mapping the unpremultiplied colour (not the premultiplied one the spec
 * first wrote) keeps a half-covered edge at half the surface's value.
 * The dither is three's dithering() (same hash, same ±0.5 LSB shifts) keyed
 * on the pixel's place on the OUTPUT canvas (uOrigin + its place in the
 * core), not gl_FragCoord: the engine canvas is resized with hysteresis, so
 * gl_FragCoord of the same output pixel changed with what was rendered
 * before, and a frame came out ±2 levels different after a seek.
 */
const OUTPUT_FRAG = /* glsl */ `
precision highp float;
#include <common>
#include <tonemapping_pars_fragment>
uniform highp sampler2D uSrc0;
uniform highp sampler2D uSrc1;
uniform int uSs;
uniform int uCanvasH;
uniform ivec4 uWindow; // the tile's rendered window in render px (top-down): x, y, w, h
uniform bool uDither;
uniform ivec2 uOrigin; // the core's top-left on the output canvas, px
layout(location = 0) out highp vec4 o0;
vec3 ditherAt( vec2 p ) {
  float grid_position = rand( p );
  vec3 dither_shift_RGB = vec3( 0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0 );
  return mix( 2.0 * dither_shift_RGB, -2.0 * dither_shift_RGB, grid_position );
}
void main() {
  int X = int( gl_FragCoord.x );
  int Y = uCanvasH - 1 - int( gl_FragCoord.y );
  vec4 a0 = vec4( 0.0 );
  vec4 a1 = vec4( 0.0 );
  for ( int b = 0; b < 3; b++ ) {
    if ( b >= uSs ) break;
    for ( int a = 0; a < 3; a++ ) {
      if ( a >= uSs ) break;
      ivec2 q = ivec2( X * uSs + a - uWindow.x, uWindow.y + uWindow.w - 1 - ( Y * uSs + b ) );
      a0 += texelFetch( uSrc0, q, 0 );
      a1 += texelFetch( uSrc1, q, 0 );
    }
  }
  float k = 1.0 / float( uSs * uSs );
  a0 *= k;
  a1 *= k;
  float alpha = clamp( a0.a, 0.0, 1.0 );
  vec3 lit = alpha > 0.0 ? NeutralToneMapping( a0.rgb / alpha ) * alpha : vec3( 0.0 );
  vec3 c = lit + a1.rgb;
  vec3 u = alpha > 0.0 ? c / alpha : vec3( 0.0 );
  u = sRGBTransferOETF( vec4( clamp( u, 0.0, 1.0 ), 1.0 ) ).rgb;
  #ifdef DITHERING
  if ( uDither ) {
    // The lit part only: never the screen. A soft shadow is premultiplied black, so its gradient lives in alpha;
    // alpha is dithered too (inside (1/255, 1), so the ROI border stays exactly transparent).
    float lit = 1.0 - clamp( a1.a, 0.0, 1.0 );
    // Output canvas px, y down, at the pixel centre.
    vec3 d = ditherAt( vec2( uOrigin + ivec2( X, Y ) ) + 0.5 );
    u += d * lit;
    if ( alpha > 1.0 / 255.0 && alpha < 1.0 ) alpha = clamp( alpha + d.g * lit, 1.0 / 255.0, 1.0 );
  }
  #endif
  u = clamp( u, 0.0, 1.0 );
  o0 = vec4( u * alpha, alpha );
}`;

/** A 2-attachment HalfFloat target. */
function mrtTarget(w: number, h: number, samples: number, depth: boolean): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(w, h, {
    count: 2,
    samples,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: depth,
    stencilBuffer: false,
    colorSpace: THREE.NoColorSpace,
  });
  if (depth) {
    t.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    t.depthTexture.minFilter = THREE.NearestFilter;
    t.depthTexture.magFilter = THREE.NearestFilter;
  }
  return t;
}

/**
 * Whether render targets must be re-created for a w × h need: when it grows
 * past them, or falls below half of them in both axes (a turning phone's ROI
 * shrinks and grows every frame; re-creating ~200 MB of targets each time is
 * the slowest thing a frame could do). Rendering uses only the top-left
 * w × h viewport, so the extra size never changes a pixel.
 */
export function needsRealloc(cur: { w: number; h: number } | null, w: number, h: number): boolean {
  if (!cur) return true;
  return w > cur.w || h > cur.h || (w < cur.w * 0.5 && h < cur.h * 0.5);
}

/**
 * The size to give a resource that must hold w × h, now `cur`: unchanged
 * while needsRealloc says no; else the need, kept up to twice as large as
 * the need where the current size already was (so a shrink-grow cycle
 * does not re-create it every frame).
 */
export function grownSize(cur: { w: number; h: number } | null, w: number, h: number): { w: number; h: number } {
  if (cur && cur.w && !needsRealloc(cur, w, h)) return cur;
  const c = cur ?? { w: 0, h: 0 };
  return { w: Math.max(w, Math.min(c.w, w * 2)), h: Math.max(h, Math.min(c.h, h * 2)) };
}

export interface DofParams {
  near: number;
  far: number;
  /** View depth of the screen centre, px. */
  focusZ: number;
  /** CoC = cocScale · |1 − focusZ / z|, render px. */
  cocScale: number;
  /** Largest CoC (the gather radius), render px. */
  maxCoc: number;
  taps: number;
}

/** The targets and fullscreen passes, one set per engine. */
export class Passes {
  /**
   * Where a single-sample frame renders (the live preview, --draft): 2
   * attachments, 4× MSAA, HalfFloat, with a resolved depth texture for DoF.
   * Made only for those frames, and dropped when a tiled full-quality frame
   * comes: it is the biggest target (100 B per pixel), and at 4K it alone was
   * most of the memory budget.
   */
  msaa: THREE.WebGLRenderTarget | null = null;
  /**
   * Where every sample of a full-quality frame renders: the same, without
   * MSAA. The jitter itself anti-aliases (8 or more Halton offsets), the
   * screen's edge included; the screen's texels stay exact because the screen
   * shader undoes the jitter in its texture lookup (screenJitter).
   */
  plain: THREE.WebGLRenderTarget | null = null;
  /** The sum of the sub-samples (full quality). */
  accum: THREE.WebGLRenderTarget | null = null;
  /** The DoF result. */
  dofOut: THREE.WebGLRenderTarget | null = null;
  private size: { w: number; h: number } | null = null;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly accumMat: THREE.ShaderMaterial;
  private readonly dofMat: THREE.ShaderMaterial;
  readonly outputMat: THREE.ShaderMaterial;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(tri);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    const pass = (frag: string, uniforms: Record<string, THREE.IUniform>, extra: Partial<THREE.ShaderMaterialParameters> = {}) =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: frag,
        uniforms,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        ...extra,
      });
    this.accumMat = pass(
      ACCUM_FRAG,
      { uSrc0: { value: null }, uSrc1: { value: null }, uW0: { value: 1 }, uW1: { value: 1 } },
      {
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneFactor,
        transparent: true,
      },
    );
    this.dofMat = pass(DOF_FRAG, {
      uSrc0: { value: null },
      uSrc1: { value: null },
      uDepth: { value: null },
      uNear: { value: 1 },
      uFar: { value: 2 },
      uFocusZ: { value: 1 },
      uCocScale: { value: 0 },
      uMaxCoc: { value: 0 },
      uTaps: { value: 16 },
      uSize: { value: new THREE.Vector2(1, 1) },
    });
    this.outputMat = pass(
      OUTPUT_FRAG,
      {
        uSrc0: { value: null },
        uSrc1: { value: null },
        uSs: { value: 1 },
        uCanvasH: { value: 1 },
        uWindow: { value: new THREE.Vector4() },
        uDither: { value: true },
        uOrigin: { value: new THREE.Vector2() },
      },
      { dithering: true, blending: THREE.NoBlending },
    );
  }

  /**
   * Makes the targets a frame needs at least w × h (needsRealloc): `msaa` for a
   * single-sample frame, else the plain and accumulation targets; the DoF
   * output either way. A target the frame does not need is kept while it is
   * small (a 1080 preview going between live and paused frames), and dropped
   * when it would hold more than one tile's budget (a 4K export).
   */
  ensure(w: number, h: number, msaa: boolean): void {
    if (needsRealloc(this.size, w, h)) {
      this.disposeTargets();
      this.size = { w, h };
    }
    const { w: W, h: H } = this.size!;
    const px = W * H;
    if (msaa) {
      this.msaa ??= mrtTarget(W, H, 4, true);
      if (this.plain && px > tileMaxPx(TILE_BYTES_PER_PX.full)) this.dropFull();
    } else {
      this.plain ??= mrtTarget(W, H, 0, true);
      this.accum ??= mrtTarget(W, H, 0, false);
      if (this.msaa && px > tileMaxPx(TILE_BYTES_PER_PX.msaa)) this.dropMsaa();
    }
    // dofOut is made by the first frame that blurs (dof()): with DoF off it never holds its 2 × 8 B per px (a third
    // of the tile targets; 4K ss 2: about 36 MB).
  }

  /** Bytes the targets hold on the GPU (MSAA renderbuffers + resolve textures + depth), for the memory budget. */
  bytes(): number {
    if (!this.size) return 0;
    const px = this.size.w * this.size.h;
    // msaa: 4 samples × (2 × 8 B colour + 4 B depth) plus its resolve (2 × 8 B + 4 B depth); plain: 2 × 8 B + 4 B
    // depth; accum and dof: 2 × 8 B each.
    return px * ((this.msaa ? TILE_BYTES_PER_PX.msaa + 20 : 0) + (this.plain ? 20 : 0) + (this.accum ? 16 : 0) + (this.dofOut ? 16 : 0));
  }

  private dropMsaa(): void {
    this.msaa?.depthTexture?.dispose();
    this.msaa?.dispose();
    this.msaa = null;
  }

  private dropFull(): void {
    for (const t of [this.plain, this.accum]) {
      t?.depthTexture?.dispose();
      t?.dispose();
    }
    this.plain = this.accum = null;
  }

  /** Points the target's viewport at its top-left w × h (it may be larger: hysteresis). */
  static view(target: THREE.WebGLRenderTarget, w: number, h: number): void {
    target.viewport.set(0, 0, w, h);
    target.scissor.set(0, 0, w, h);
    target.scissorTest = true;
  }

  private draw(mat: THREE.Material): void {
    this.quad.material = mat;
    this.renderer.render(this.quadScene, this.quadCam);
  }

  /** Clears the accumulation target's w × h area to 0. */
  clearAccum(w: number, h: number): void {
    const r = this.renderer;
    Passes.view(this.accum!, w, h);
    r.setRenderTarget(this.accum);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
  }

  /** accum += src (a resolved sample: msaa or plain) × (w0, w1). */
  accumulate(src: THREE.WebGLRenderTarget, w: number, h: number, w0: number, w1: number): void {
    const m = this.accumMat.uniforms;
    m.uSrc0.value = src.textures[0];
    m.uSrc1.value = src.textures[1];
    m.uW0.value = w0;
    m.uW1.value = w1;
    Passes.view(this.accum!, w, h);
    this.renderer.setRenderTarget(this.accum);
    this.draw(this.accumMat);
  }

  /** DoF from `src` (the accumulation or a resolved sample) with `depth` (the last sample's) into dofOut. */
  dof(src: THREE.WebGLRenderTarget, depth: THREE.Texture, w: number, h: number, p: DofParams): THREE.WebGLRenderTarget {
    const u = this.dofMat.uniforms;
    u.uSrc0.value = src.textures[0];
    u.uSrc1.value = src.textures[1];
    u.uDepth.value = depth;
    u.uNear.value = p.near;
    u.uFar.value = p.far;
    u.uFocusZ.value = p.focusZ;
    u.uCocScale.value = p.cocScale;
    u.uMaxCoc.value = p.maxCoc;
    u.uTaps.value = Math.max(1, Math.min(64, Math.round(p.taps)));
    (u.uSize.value as THREE.Vector2).set(w, h);
    const out = (this.dofOut ??= mrtTarget(this.size!.w, this.size!.h, 0, false));
    Passes.view(out, w, h);
    this.renderer.setRenderTarget(out);
    this.draw(this.dofMat);
    return out;
  }

  /**
   * Writes one tile's core into the engine canvas (the default framebuffer).
   * `core` is the tile core in OUTPUT (canvas) px inside the ROI, `window` the
   * rendered window in render px; the canvas is canvasW × canvasH and the ROI
   * is drawn into its top-left. `origin` is where the core lands on the
   * output canvas (px): the dither pattern is keyed on it.
   */
  output(
    src: THREE.WebGLRenderTarget,
    core: { x: number; y: number; w: number; h: number },
    window: { x: number; y: number; w: number; h: number },
    ss: number,
    canvasH: number,
    origin: { x: number; y: number },
    dither = true,
  ): void {
    const r = this.renderer;
    const u = this.outputMat.uniforms;
    u.uSrc0.value = src.textures[0];
    u.uSrc1.value = src.textures[1];
    u.uSs.value = ss;
    u.uCanvasH.value = canvasH;
    (u.uWindow.value as THREE.Vector4).set(window.x, window.y, window.w, window.h);
    u.uDither.value = dither;
    (u.uOrigin.value as THREE.Vector2).set(origin.x, origin.y);
    r.setRenderTarget(null);
    const gy = canvasH - (core.y + core.h);
    r.setViewport(core.x, gy, core.w, core.h);
    r.setScissor(core.x, gy, core.w, core.h);
    r.setScissorTest(true);
    this.draw(this.outputMat);
    r.setScissorTest(false);
  }

  private disposeTargets(): void {
    for (const t of [this.msaa, this.plain, this.accum, this.dofOut]) {
      t?.depthTexture?.dispose();
      t?.dispose();
    }
    this.msaa = this.plain = this.accum = this.dofOut = null;
    this.size = null;
  }

  dispose(): void {
    this.disposeTargets();
    this.accumMat.dispose();
    this.dofMat.dispose();
    this.outputMat.dispose();
    this.quad.geometry.dispose();
  }
}
