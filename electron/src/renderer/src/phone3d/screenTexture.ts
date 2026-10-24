// The 3D phone's screen texture (SPEC §3.6): an offscreen 2D canvas the
// compositor draws the recording into (video crop and zoom, touch
// indicators, cursor, ripples, the island or notch), uploaded into the
// texture the screen mesh samples.
//
// Size: one texel per render pixel. The texture covers the projected screen
// at render resolution (× supersample), so a FRONT phone is a 1:1 copy and an
// oblique one is minified at most by the hysteresis slack (the −0.5 LOD bias
// keeps that on mip 0); from ss 2 an oblique screen stops at the FRONT
// density (obliqueScaleCap). At an axis-aligned pose the content starts at the
// integer render pixel under the screen's top-left and keeps the flat rect's
// sub-pixel phase, so the 2D draw onto the texture is the same resample as
// the flat draw onto the canvas, and every render pixel then reads exactly
// one texel: the screen at FRONT is the flat screen.
//
// Hysteresis: the texture size is the needed size rounded UP to a fixed
// geometric ladder with 8% steps (textureSide), so it is re-created only when
// the need crosses a rung; the content is drawn into its top-left and the
// texture matrix maps the mesh's 0..1 UVs onto that area. A ladder (not
// "keep the last size unless it is 8% off") makes the size a pure function of
// the frame: the mip chain, and so every oblique frame, is then identical
// whatever was rendered before (seek order never changes a pixel). The whole
// texture is redrawn each frame for the same reason (stale texels would reach
// the coarse mips).
//
// Bands (memory, §3.9): the GL texture is the full ladder size with mips, but
// the 2D canvas the content is drawn into is at most SCREEN_BAND_PX: a
// bigger screen is drawn and uploaded in horizontal bands, each the whole
// content shifted up by a whole number of rows, then the mips are made once.
// (Chromium's 2D canvas may round a few pixels one level apart under such a
// shift, as the one big canvas already differs from the flat draw: the GPU
// harness bounds it at 2 levels with no seam.) At 1080 the screen
// is one band, exactly as before; at 4K a full-size 2D canvas would be one
// more copy of the screen (26 MB at ss 1, 106 MB at ss 2), which would put 4K
// over its memory budget.
import * as THREE from 'three';
import type { Rect } from '../../../shared/deviceGeometry';
import type { Quad } from '../../../shared/phone3d/projection';

/** Largest texture side used, whatever the GPU allows. */
export const MAX_SCREEN_TEXTURE = 8192;

/** Largest 2D canvas the screen content is drawn into, px (2²¹: 8.4 MB); a bigger texture fills in bands. */
export const SCREEN_BAND_PX = 2 ** 21;

/**
 * The horizontal bands that fill a w × h texture from a 2D canvas of at most
 * `maxPx` (but never less than one row): n bands of the same height, top
 * rows first. The last band ends on the texture's last row, so it may overlap
 * the one before it (those rows are drawn twice, the same content at a
 * whole-row shift, and the last upload wins): no band needs a partial upload.
 */
export function planBands(w: number, h: number, maxPx = SCREEN_BAND_PX): { height: number; y: number[] } {
  if (w <= 0 || h <= 0) return { height: 0, y: [] };
  const rows = Math.max(1, Math.min(h, Math.floor(maxPx / w)));
  const n = Math.ceil(h / rows);
  const height = Math.ceil(h / n);
  return { height, y: Array.from({ length: n }, (_, i) => Math.min(i * height, h - height)) };
}

/** Texture canvas sides: 64·1.08^k rounded up (an 8% ladder), capped at MAX_SCREEN_TEXTURE. */
const LADDER: number[] = (() => {
  const out: number[] = [];
  for (let v = 64; v < MAX_SCREEN_TEXTURE; v *= 1.08) out.push(Math.ceil(v));
  out.push(MAX_SCREEN_TEXTURE);
  return out;
})();

/** The canvas side that holds `n` texels: the smallest ladder rung ≥ n, never above `cap` (the GPU's limit) unless n is
 *  (callers keep n ≤ cap: planScreenTexture limits the need, screenCanvasSize the room). */
export function textureSide(n: number, cap = MAX_SCREEN_TEXTURE): number {
  const need = Math.ceil(n);
  for (const v of LADDER) if (v >= need) return Math.max(need, Math.min(v, cap));
  return need;
}

export interface ScreenLayout {
  /** The area of the texture canvas used this frame, texels (from its top-left). */
  w: number;
  h: number;
  /** Where the flat screen rect lands in the texture, texels, top-down. */
  dst: Rect;
  /** Texels per canvas px (the compositor's pxScale for overlay sizes). */
  scale: number;
  /** The quad is an axis-aligned rect (FRONT-like): the texture is phase-locked to the render pixels. */
  aligned: boolean;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The most texels per canvas px an oblique screen gets (planScreenTexture's
 * `obliqueCap`): unlimited at ss 1; from ss 2 the FRONT density of the
 * project's largest pose, ss × max size. A turning phone's near edge
 * projects up to about 12% larger than FRONT; at ss 1 its texture grows with
 * it (so a held three-quarter view is not soft at the near edge), but at
 * ss ≥ 2 that edge still gets ≥ ss / 1.12 ≈ 1.8 texels per output pixel after
 * the supersample downsample, so growing the texture there buys nothing
 * visible and costs about 25% more screen memory (§3.9: 4K ss 2 ≤ 440 MB).
 */
export function obliqueScaleCap(ss: number, sizes: readonly number[]): number {
  return ss >= 2 ? ss * Math.max(1, ...sizes) : Infinity;
}

/**
 * How big the texture is and where the content goes, from the projected
 * screen quad (canvas px, corners in the flat rect's TL, TR, BR, BL order),
 * the flat screen rect, the supersample factor, the texture size limit and
 * the oblique cap (obliqueScaleCap; an axis-aligned screen is never capped,
 * so FRONT stays 1:1 at every ss).
 */
export function planScreenTexture(quad: Quad, flat: Rect, ss: number, maxSize = MAX_SCREEN_TEXTURE, obliqueCap = Infinity): ScreenLayout {
  const [q0, q1, q2, q3] = quad;
  const eps = 1e-6;
  const aligned =
    Math.abs(q0.y - q1.y) < eps && Math.abs(q3.y - q2.y) < eps && Math.abs(q0.x - q3.x) < eps && Math.abs(q1.x - q2.x) < eps;
  const across = Math.max(dist(q0, q1), dist(q3, q2)) / flat.w;
  const down = Math.max(dist(q0, q3), dist(q1, q2)) / flat.h;
  let scale = ss * Math.max(across, down);
  // A FRONT phone at size 1 projects onto the flat rect up to float noise: use exactly ss.
  if (Math.abs(scale / ss - 1) < 1e-6) scale = ss;
  if (!aligned) scale = Math.min(scale, obliqueCap);
  const limit = Math.max(16, Math.floor(maxSize)) - 2;
  scale = Math.min(scale, limit / flat.w, limit / flat.h);
  const minX = Math.min(q0.x, q1.x, q2.x, q3.x);
  const minY = Math.min(q0.y, q1.y, q2.y, q3.y);
  const frac = (v: number) => v - Math.floor(v);
  const dst = {
    x: aligned ? frac(minX * ss) : 0,
    y: aligned ? frac(minY * ss) : 0,
    w: flat.w * scale,
    h: flat.h * scale,
  };
  return { w: Math.ceil(dst.x + dst.w), h: Math.ceil(dst.y + dst.h), dst, scale, aligned };
}

/**
 * The texture matrix that maps the screen mesh's UVs (model space: u along
 * the portrait model's +x, v up its +y, 0..1 over the screen) onto `dst` in a
 * texW × texH canvas texture (flipY), with the landscape turn `landscape`
 * (radians, the model's Rz) applied so the canvas-oriented content lands
 * upright.
 */
export function screenUvMatrix(dst: Rect, texW: number, texH: number, landscape: number): THREE.Matrix3 {
  const c = Math.round(Math.cos(landscape) * 1e12) / 1e12;
  const s = Math.round(Math.sin(landscape) * 1e12) / 1e12;
  // Canvas-local screen coords: [U − .5, V − .5] = Rz(landscape)·[u − .5, v − .5] (V up).
  const rot = new THREE.Matrix3().set(c, -s, 0.5 - 0.5 * c + 0.5 * s, s, c, 0.5 - 0.5 * s - 0.5 * c, 0, 0, 1);
  // Texture coords: s = (dst.x + U·dst.w) / texW; t = 1 − (dst.y + dst.h) / texH + V·dst.h / texH.
  const place = new THREE.Matrix3().set(dst.w / texW, 0, dst.x / texW, 0, dst.h / texH, 1 - (dst.y + dst.h) / texH, 0, 0, 1);
  return place.multiply(rot);
}

/**
 * The texture size a project's screen needs at most, in normal use: the flat
 * screen × supersample × the largest pose size anywhere in the project (base
 * pose, every keyframe, float), × 1.12 at ss 1 (perspective: a near edge
 * projects larger). Frames that need more still get it (their own rung). At
 * ss ≥ 2 no frame needs more than the FRONT size (obliqueScaleCap), so the
 * room is exactly that, plus one texel for a FRONT screen's sub-pixel phase.
 */
export function screenRoom(flat: Rect, ss: number, sizes: readonly number[]): { w: number; h: number } {
  const front = ss * Math.max(1, ...sizes);
  if (ss >= 2) return { w: Math.ceil(flat.w * front) + 1, h: Math.ceil(flat.h * front) + 1 };
  return { w: Math.ceil(flat.w * front * 1.12), h: Math.ceil(flat.h * front * 1.12) };
}

/**
 * The texture canvas size for a frame: the ladder rung that holds both the
 * frame's need and the project's room, never above `cap` on either side. The
 * need is already within the cap (planScreenTexture); the room is clamped to
 * it here, so a big pose size or supersample can never make a canvas the GPU
 * would scale down on upload (which would end the FRONT screen's 1:1 texels)
 * or that blows the memory budget.
 */
export function screenCanvasSize(needW: number, needH: number, cap = MAX_SCREEN_TEXTURE, room?: { w: number; h: number }): { w: number; h: number } {
  const c = Math.min(MAX_SCREEN_TEXTURE, Math.floor(cap));
  const fit = (need: number, r: number | undefined) => textureSide(Math.max(need, Math.min(r ?? 0, c)), c);
  return { w: fit(needW, room?.w), h: fit(needH, room?.h) };
}

/** The 2D canvas the content is drawn into (one band) and the texture it fills. One per engine. */
export class ScreenTexture {
  /** The band canvas: the texture's width, one band's height (the whole texture when it fits SCREEN_BAND_PX). */
  canvas: HTMLCanvasElement | null = null;
  ctx: CanvasRenderingContext2D | null = null;
  texture: THREE.Texture | null = null;
  /** The texture's size (the ladder rung), texels. */
  size: { w: number; h: number } | null = null;
  /** Bands the last frame was drawn in (1 when the texture fits one 2D canvas). */
  bands = 0;
  /** Re-creations so far (stats; the hysteresis keeps this low while a phone turns). */
  reallocs = 0;
  /** SCREEN_BAND_PX; the GPU harness lowers it to prove that bands change no texel. */
  bandPx = SCREEN_BAND_PX;
  private source: THREE.Texture | null = null;
  private readonly at = new THREE.Vector2();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly anisotropy: number,
  ) {}

  /**
   * Fills the texture for one output frame and returns it. The texture is
   * textureSide(need) × textureSide(need) or the room's rung
   * (screenCanvasSize: never above `cap`), re-created only when that changes.
   * `room` is a size the texture should hold anyway (screenRoom: the
   * project's largest screen), so a turning phone does not re-create it as
   * its projected size crosses rungs; it is a pure function of the project,
   * so the size stays a pure function of the frame.
   *
   * `paint` draws the content in texture coordinates (texels from the
   * top-left; identity transform) and runs once per band, on a canvas cleared
   * to black, shifted so its rows land on that band. Each band uploads at
   * once; the mips are made after the last one. The texture matrix then points
   * at `layout` (the area used, inside the top-left).
   */
  update(layout: ScreenLayout, landscape: number, paint: (ctx: CanvasRenderingContext2D) => void, cap = MAX_SCREEN_TEXTURE, room?: { w: number; h: number }): THREE.Texture {
    const { w, h } = screenCanvasSize(layout.w, layout.h, cap, room);
    const bands = planBands(w, h, this.bandPx);
    if (!this.size || this.size.w !== w || this.size.h !== h || !this.texture) {
      this.texture?.dispose();
      const tex = new THREE.DataTexture(null, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.colorSpace = THREE.SRGBColorSpace;
      // Canvas rows are top-down: flipped on upload, as a CanvasTexture would be (screenUvMatrix assumes it).
      tex.flipY = true;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = this.anisotropy;
      tex.matrixAutoUpdate = false;
      // Storage only (all mip levels): the bands fill level 0.
      tex.source.dataReady = false;
      tex.needsUpdate = true;
      this.renderer.initTexture(tex);
      this.texture = tex;
      this.size = { w, h };
      this.reallocs++;
    }
    if (!this.canvas || !this.ctx || this.canvas.width !== w || this.canvas.height !== bands.height) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = bands.height;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('phone3d: no 2d context for the screen texture');
      this.canvas = canvas;
      this.ctx = ctx;
      this.source = new THREE.Texture(canvas);
    }
    const ctx = this.ctx;
    const tex = this.texture;
    for (let i = 0; i < bands.y.length; i++) {
      const y = bands.y[i];
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, bands.height);
      ctx.setTransform(1, 0, 0, 1, 0, -y);
      paint(ctx);
      ctx.restore();
      // flipY: the band's top row lands on GL row h − 1 − y. copyTextureToTexture makes the mips when the
      // destination asks for them: only after the last band, once.
      tex.generateMipmaps = i === bands.y.length - 1;
      this.renderer.copyTextureToTexture(this.source!, tex, null, this.at.set(0, h - y - bands.height));
    }
    tex.generateMipmaps = true;
    this.bands = bands.y.length;
    tex.matrix.copy(screenUvMatrix(layout.dst, w, h, landscape));
    return tex;
  }

  /** Bytes on the GPU (with mips, about 4/3 of the base level). */
  bytes(): number {
    return this.size ? Math.round(this.size.w * this.size.h * 4 * (4 / 3)) : 0;
  }

  /** Bytes of the 2D band canvas the content is drawn into (a GPU surface when the 2D canvas is accelerated). */
  canvasBytes(): number {
    return this.canvas ? this.canvas.width * this.canvas.height * 4 : 0;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
    this.source = null;
    this.canvas = null;
    this.ctx = null;
    this.size = null;
  }
}
