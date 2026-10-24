// The 3D phone's screen texture (SPEC §3.6): an offscreen 2D canvas the
// compositor draws the recording into (video crop and zoom, touch
// indicators, cursor, ripples, the island or notch), uploaded as a
// CanvasTexture the screen mesh samples.
//
// Size: one texel per render pixel. The texture covers the projected screen
// at render resolution (× supersample), so a FRONT phone is a 1:1 copy and an
// oblique one is minified at most by the hysteresis slack (the −0.5 LOD bias
// keeps that on mip 0). At an axis-aligned pose the content starts at the
// integer render pixel under the screen's top-left and keeps the flat rect's
// sub-pixel phase, so the 2D draw onto the texture is the same resample as
// the flat draw onto the canvas, and every render pixel then reads exactly
// one texel: the screen at FRONT is the flat screen.
//
// Hysteresis: the canvas size is the needed size rounded UP to a fixed
// geometric ladder with 8% steps (textureSide), so it is re-created only when
// the need crosses a rung; the content is drawn into its top-left and the
// texture matrix maps the mesh's 0..1 UVs onto that area. A ladder (not
// "keep the last size unless it is 8% off") makes the size a pure function of
// the frame: the mip chain, and so every oblique frame, is then identical
// whatever was rendered before (seek order never changes a pixel). The whole
// canvas is cleared each frame for the same reason (stale texels would reach
// the coarse mips).
import * as THREE from 'three';
import type { Rect } from '../../../shared/deviceGeometry';
import type { Quad } from '../../../shared/phone3d/projection';

/** Largest texture side used, whatever the GPU allows. */
export const MAX_SCREEN_TEXTURE = 8192;

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
 * How big the texture is and where the content goes, from the projected
 * screen quad (canvas px, corners in the flat rect's TL, TR, BR, BL order),
 * the flat screen rect, the supersample factor and the texture size limit.
 */
export function planScreenTexture(quad: Quad, flat: Rect, ss: number, maxSize = MAX_SCREEN_TEXTURE): ScreenLayout {
  const [q0, q1, q2, q3] = quad;
  const across = Math.max(dist(q0, q1), dist(q3, q2)) / flat.w;
  const down = Math.max(dist(q0, q3), dist(q1, q2)) / flat.h;
  let scale = ss * Math.max(across, down);
  // A FRONT phone at size 1 projects onto the flat rect up to float noise: use exactly ss.
  if (Math.abs(scale / ss - 1) < 1e-6) scale = ss;
  const limit = Math.max(16, Math.floor(maxSize)) - 2;
  scale = Math.min(scale, limit / flat.w, limit / flat.h);
  const eps = 1e-6;
  const aligned =
    Math.abs(q0.y - q1.y) < eps && Math.abs(q3.y - q2.y) < eps && Math.abs(q0.x - q3.x) < eps && Math.abs(q1.x - q2.x) < eps;
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
 * pose, every keyframe, float) × 1.12 (perspective: a near edge projects
 * larger). Frames that need more still get it (their own rung).
 */
export function screenRoom(flat: Rect, ss: number, sizes: readonly number[]): { w: number; h: number } {
  const k = ss * Math.max(1, ...sizes) * 1.12;
  return { w: Math.ceil(flat.w * k), h: Math.ceil(flat.h * k) };
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

/** The offscreen canvas and its texture. One per engine. */
export class ScreenTexture {
  canvas: HTMLCanvasElement | null = null;
  ctx: CanvasRenderingContext2D | null = null;
  texture: THREE.CanvasTexture | null = null;
  private size: { w: number; h: number } | null = null;
  /** Re-creations so far (stats; the hysteresis keeps this low while a phone turns). */
  reallocs = 0;

  constructor(private readonly anisotropy: number) {}

  /**
   * Makes the canvas textureSide(w) × textureSide(h) (re-created only when
   * that changes), clears it to black, and returns the 2D context to draw
   * into, with an identity transform (screenCanvasSize: never above `cap`).
   * `room` is a size the canvas should hold
   * anyway (screenRoom: the project's largest screen), so a turning phone
   * does not re-create the canvas as its projected size crosses rungs; it is a
   * pure function of the project, so the size stays a pure function of the
   * frame.
   */
  begin(needW: number, needH: number, cap = MAX_SCREEN_TEXTURE, room?: { w: number; h: number }): CanvasRenderingContext2D {
    const { w, h } = screenCanvasSize(needW, needH, cap, room);
    if (!this.size || this.size.w !== w || this.size.h !== h || !this.canvas || !this.ctx) {
      this.texture?.dispose();
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('phone3d: no 2d context for the screen texture');
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = this.anisotropy;
      tex.matrixAutoUpdate = false;
      this.canvas = canvas;
      this.ctx = ctx;
      this.texture = tex;
      this.size = { w, h };
      this.reallocs++;
    }
    const ctx = this.ctx!;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    return ctx;
  }

  /** Points the texture matrix at `layout` and marks the texture for upload (once per output frame). */
  commit(layout: ScreenLayout, landscape: number): THREE.CanvasTexture {
    const tex = this.texture!;
    tex.matrix.copy(screenUvMatrix(layout.dst, this.canvas!.width, this.canvas!.height, landscape));
    tex.needsUpdate = true;
    return tex;
  }

  /** Bytes on the GPU (with mips, about 4/3 of the base level). */
  bytes(): number {
    return this.size ? Math.round(this.size.w * this.size.h * 4 * (4 / 3)) : 0;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
    this.canvas = null;
    this.ctx = null;
    this.size = null;
  }
}
