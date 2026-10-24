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
/** Adjacent motion-blur copies are at most this far apart, render px (§3.7 step 4). */
export const MOTION_STEP_PX = 1.5;
/** Below this hull travel over the shutter the phone counts as still, render px. */
export const STILL_TRAVEL_PX = 0.5;

/** Fixed sub-pixel jitter per sample, render px: sample 0 is unjittered, then Halton(2, 3) − 0.5 (D19). */
export const JITTER: readonly (readonly [number, number])[] = Array.from({ length: MAX_SAMPLES }, (_, k) =>
  k === 0 ? ([0, 0] as const) : ([halton(k, 2) - 0.5, halton(k, 3) - 0.5] as const),
);

export interface SamplePlan {
  /** Sub-samples rendered for this frame. */
  n: number;
  /** The motion-blur part of n (1 = the phone is still over the shutter). */
  nMotion: number;
  /** Output time of each sample. */
  times: number[];
  /** Sub-pixel camera offset of each sample, render px. */
  jitter: (readonly [number, number])[];
  /** The screen attachment comes from sample 0 alone (the phone is still and jittered AA would soften the UI). */
  screenFromFirst: boolean;
}

export interface SampleInputs {
  /** Output time of the frame. */
  t: number;
  /** Longest projected hull path over the shutter, render px (hullTravelPx); 0 with motion blur off. */
  travelPx: number;
  /** Motion blur: the user's minimum sample count and the shutter in seconds; null = off. */
  motion: { samples: number; shutterSec: number } | null;
  /** Export / full-quality frames (8 jittered samples, adaptive motion); false = one sample (live preview, --draft). */
  full: boolean;
}

/**
 * The sub-samples of one frame (§3.7 step 4), from pose and fixed tables only,
 * so a frame always renders the same way. Nmotion = 1 when the hull moves less
 * than STILL_TRAVEL_PX over the shutter, else ceil(travel / 1.5) clamped to
 * [max(2, samples), 64]; N = max(Nmotion, 8) at full quality, 1 otherwise.
 */
export function planSamples({ t, travelPx, motion, full }: SampleInputs): SamplePlan {
  if (!full) return { n: 1, nMotion: 1, times: [t], jitter: [JITTER[0]], screenFromFirst: false };
  const moving = motion !== null && motion.shutterSec > 0 && travelPx >= STILL_TRAVEL_PX;
  const nMotion = moving
    ? Math.min(MAX_SAMPLES, Math.max(Math.max(2, Math.round(motion.samples)), Math.ceil(travelPx / MOTION_STEP_PX)))
    : 1;
  const n = Math.max(nMotion, AA_SAMPLES);
  const times = Array.from({ length: n }, (_, k) => (nMotion > 1 ? t + ((k + 0.5) / n - 0.5) * motion!.shutterSec : t));
  return { n, nMotion, times, jitter: JITTER.slice(0, n), screenFromFirst: nMotion === 1 };
}

// ---------------------------------------------------------------------------
// Tiles (pure)

/** GPU bytes per render pixel of one tile: 4 MSAA samples × (2 attachments × 8 B + 4 B depth). */
export const TILE_BYTES_PER_PX = 80;
/** Above this many bytes, the ROI renders in tiles (§3.7 step 8). */
export const TILE_THRESHOLD_BYTES = 120e6;
/** Largest tile: area and long side, render px. */
export const TILE_MAX_PX = 1.5e6;
export const TILE_MAX_SIDE = 2048;

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
 * Splits a w × h render area into tiles when one target would pass
 * TILE_THRESHOLD_BYTES: each core is at most TILE_MAX_PX with a long side
 * ≤ TILE_MAX_SIDE, its size a multiple of `ss` (so a tile never splits an
 * output pixel), and is padded by `overlap` px (the DoF reach) that is
 * rendered and discarded. One tile (the whole area) otherwise.
 */
export function planTiles(w: number, h: number, ss: number, overlap: number): Tile[] {
  if (w <= 0 || h <= 0) return [];
  if (w * h * TILE_BYTES_PER_PX <= TILE_THRESHOLD_BYTES) return [{ x: 0, y: 0, w, h, px: 0, py: 0, pw: w, ph: h }];
  const ov = Math.max(0, Math.ceil(overlap));
  // The fewest columns and rows whose padded tiles fit the limits.
  let cols = Math.max(1, Math.ceil(w / TILE_MAX_SIDE));
  let rows = Math.max(1, Math.ceil(h / TILE_MAX_SIDE));
  const fits = () => {
    const tw = Math.ceil(w / cols / ss) * ss + 2 * ov;
    const th = Math.ceil(h / rows / ss) * ss + 2 * ov;
    return tw <= TILE_MAX_SIDE && th <= TILE_MAX_SIDE && tw * th <= TILE_MAX_PX;
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

export type MrtRole = 'lit' | 'screen';

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
          : '\tpc_fragScreen = vec4( gl_FragColor.rgb * gl_FragColor.a, gl_FragColor.a );\n\tgl_FragColor = vec4( 0.0, 0.0, 0.0, gl_FragColor.a );';
      shader.fragmentShader = closeMain(`${MRT_DECL}\n${shader.fragmentShader}`, tail);
    },
  });
  return mat;
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
 */
const OUTPUT_FRAG = /* glsl */ `
precision highp float;
#include <common>
#include <tonemapping_pars_fragment>
#include <dithering_pars_fragment>
uniform highp sampler2D uSrc0;
uniform highp sampler2D uSrc1;
uniform int uSs;
uniform int uCanvasH;
uniform ivec4 uWindow; // the tile's rendered window in render px (top-down): x, y, w, h
uniform bool uDither;
layout(location = 0) out highp vec4 o0;
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
    vec3 d = dithering( vec3( 0.0 ) );
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
  /** Where the unjittered sample renders: 2 attachments, 4× MSAA, HalfFloat, with a resolved depth texture for DoF. */
  msaa: THREE.WebGLRenderTarget | null = null;
  /**
   * Where the jittered sub-samples render: the same, without MSAA. The jitter
   * itself anti-aliases them (8 or more Halton offsets), so storing and
   * resolving 4 MSAA samples of two HalfFloat attachments per sub-sample (the
   * bulk of the frame's memory traffic) buys nothing. Sample 0 keeps MSAA: it is
   * the whole frame in the live preview, and it alone carries the screen of a
   * still phone (the screen exactness rule), whose edge MSAA anti-aliases.
   */
  plain: THREE.WebGLRenderTarget | null = null;
  /** The sum of the sub-samples. */
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
      },
      { dithering: true, blending: THREE.NoBlending },
    );
  }

  /** Makes the targets at least w × h (needsRealloc); returns true when they were re-created. */
  ensure(w: number, h: number): boolean {
    if (!needsRealloc(this.size, w, h) && this.msaa && this.plain && this.accum && this.dofOut) return false;
    this.disposeTargets();
    this.size = { w, h };
    this.msaa = mrtTarget(w, h, 4, true);
    this.plain = mrtTarget(w, h, 0, true);
    this.accum = mrtTarget(w, h, 0, false);
    this.dofOut = mrtTarget(w, h, 0, false);
    return true;
  }

  /** Bytes the targets hold on the GPU (MSAA renderbuffers + resolve textures + depth), for the memory budget. */
  bytes(): number {
    if (!this.size) return 0;
    const px = this.size.w * this.size.h;
    // msaa: 4 samples × (2 × 8 B colour + 4 B depth); its resolve and the plain target: 2 × 8 B + 4 B depth each;
    // accum and dof: 2 × 8 B each.
    return px * (4 * (16 + 4) + 20 + 20 + 16 + 16);
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
    Passes.view(this.dofOut!, w, h);
    this.renderer.setRenderTarget(this.dofOut);
    this.draw(this.dofMat);
    return this.dofOut!;
  }

  /**
   * Writes one tile's core into the engine canvas (the default framebuffer).
   * `core` is the tile core in OUTPUT (canvas) px inside the ROI, `window` the
   * rendered window in render px; the canvas is canvasW × canvasH and the ROI
   * is drawn into its top-left.
   */
  output(
    src: THREE.WebGLRenderTarget,
    core: { x: number; y: number; w: number; h: number },
    window: { x: number; y: number; w: number; h: number },
    ss: number,
    canvasH: number,
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
