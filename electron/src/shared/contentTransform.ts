import type { Rect } from './phoneLayer';
import type { ContentTransform, Size } from './types';

// The recording moved and resized by hand on the preview, kept pure so it is
// tested. The layout still decides where the recording fits (padding, crop,
// device frame, canvas preset, the phone layer); `style.contentTransform`
// then moves that fitted rect's centre and scales it about its centre, aspect
// kept. Absent means the fitted rect exactly, so older projects draw as they
// always did. Everything that rides on the recording (its frame, shadow,
// zoom, touch indicators, keystrokes) follows the placed rect.

export const MIN_CONTENT_SCALE = 0.1;
export const MAX_CONTENT_SCALE = 4;
/** At least this much of the recording's width and height stays on the canvas. */
export const MIN_VISIBLE = 0.1;

export const clampContentScale = (s: number) =>
  Math.min(MAX_CONTENT_SCALE, Math.max(MIN_CONTENT_SCALE, Number.isFinite(s) ? s : 1));

/** The scale a transform asks for (1 when there is none). */
export const contentScale = (t: ContentTransform | null | undefined) => (t ? clampContentScale(t.scale) : 1);

/** A centre on one axis, clamped so `MIN_VISIBLE` of a box `size` long stays on [0, extent]. */
function clampAxis(c: number, size: number, extent: number) {
  const keep = Math.min(size * MIN_VISIBLE, extent);
  return Math.min(Math.max(c, keep - size / 2), extent - keep + size / 2);
}

/** `rect` moved (not resized) so at least MIN_VISIBLE of it is on the canvas. */
export function keepOnCanvas(rect: Rect, canvas: Size): Rect {
  const cx = clampAxis(rect.x + rect.w / 2, rect.w, canvas.width);
  const cy = clampAxis(rect.y + rect.h / 2, rect.h, canvas.height);
  return { x: cx - rect.w / 2, y: cy - rect.h / 2, w: rect.w, h: rect.h };
}

/**
 * Where the recording goes: the layout's fitted rect `base`, scaled about its
 * centre and moved to the transform's centre, kept on the canvas. No
 * transform returns `base` itself.
 */
export function placeContent(base: Rect, t: ContentTransform | null | undefined, canvas: Size): Rect {
  if (!t) return base;
  const s = clampContentScale(t.scale);
  const w = base.w * s;
  const h = base.h * s;
  const cx = Number.isFinite(t.x) ? t.x! * canvas.width : base.x + base.w / 2;
  const cy = Number.isFinite(t.y) ? t.y! * canvas.height : base.y + base.h / 2;
  return keepOnCanvas({ x: cx - w / 2, y: cy - h / 2, w, h }, canvas);
}

/** `r` carried along when `from` becomes `to` (the same move and uniform scale):
 *  the screen inside a device frame, or a phone over the recording's corner. */
export function mapRect(r: Rect, from: Rect, to: Rect): Rect {
  const k = from.w > 0 ? to.w / from.w : 1;
  return { x: to.x + (r.x - from.x) * k, y: to.y + (r.y - from.y) * k, w: r.w * k, h: r.h * k };
}

/** The transform that places `base` at `placed` (same aspect). */
export function transformFor(base: Rect, placed: Rect, canvas: Size): ContentTransform {
  return {
    x: (placed.x + placed.w / 2) / canvas.width,
    y: (placed.y + placed.h / 2) / canvas.height,
    scale: base.w > 0 ? placed.w / base.w : 1,
  };
}

// ---------------------------------------------------------------------------
// Corner handles: aspect-locked resize, shared by the recording and the
// camera bubble.

export type Corner = 'nw' | 'ne' | 'sw' | 'se';
export const CORNERS: readonly Corner[] = ['nw', 'ne', 'sw', 'se'];

/** A corner's point on `r`. */
export function cornerPoint(r: Rect, c: Corner) {
  return { x: c === 'ne' || c === 'se' ? r.x + r.w : r.x, y: c === 'sw' || c === 'se' ? r.y + r.h : r.y };
}

const opposite: Record<Corner, Corner> = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' };

/** The corner handle within `radius` of `p`, nearest first. */
export function cornerAt(r: Rect, p: { x: number; y: number }, radius: number): Corner | null {
  let best: { c: Corner; d: number } | null = null;
  for (const c of CORNERS) {
    const q = cornerPoint(r, c);
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d <= radius && (!best || d < best.d)) best = { c, d };
  }
  return best?.c ?? null;
}

/** The resize cursor for a corner. */
export const cornerCursor = (c: Corner) => (c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize');

export interface ResizeOptions {
  /** Resize about the centre (Option held) instead of the opposite corner. */
  fromCentre?: boolean;
  /** Width limits, in canvas px. */
  minW: number;
  maxW: number;
  /** Snap the width to `snapW.at` when within `snapW.threshold` px of it (100% scale). */
  snapW?: { at: number; threshold: number };
}

/**
 * `start` resized by dragging corner `c` to `pointer`, aspect locked. The
 * opposite corner stays put (or, with `fromCentre`, the centre does). The new
 * width follows whichever of the pointer's two distances asks for more, so
 * dragging straight across or straight down both work; a pointer dragged past
 * the anchor bottoms out at `minW` rather than flipping.
 */
export function resizeFromCorner(start: Rect, c: Corner, pointer: { x: number; y: number }, o: ResizeOptions): Rect {
  const aspect = start.w / Math.max(1e-9, start.h);
  const sx = c === 'ne' || c === 'se' ? 1 : -1;
  const sy = c === 'sw' || c === 'se' ? 1 : -1;
  const anchor = o.fromCentre ? { x: start.x + start.w / 2, y: start.y + start.h / 2 } : cornerPoint(start, opposite[c]);
  const k = o.fromCentre ? 2 : 1;
  const dx = (pointer.x - anchor.x) * sx * k;
  const dy = (pointer.y - anchor.y) * sy * k;
  let w = Math.max(dx, dy * aspect);
  if (o.snapW && Math.abs(w - o.snapW.at) <= o.snapW.threshold) w = o.snapW.at;
  w = Math.min(o.maxW, Math.max(o.minW, w));
  const h = w / aspect;
  if (o.fromCentre) return { x: anchor.x - w / 2, y: anchor.y - h / 2, w, h };
  return { x: sx > 0 ? anchor.x : anchor.x - w, y: sy > 0 ? anchor.y : anchor.y - h, w, h };
}
