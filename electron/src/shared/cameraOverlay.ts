import { fitAspect, phoneAspect, phoneLayerOn, phoneLayerRects, type Rect } from './phoneLayer';
import type { CameraOverlay, Project, Size } from './types';

// Where the camera overlay (the face bubble) sits on the canvas. It is free:
// `position` is the bubble's centre as a fraction of the canvas, so it can go
// anywhere, padding included. Its diameter is `sizeFraction` × the shorter
// side of the visible recording. Projects from before free placement have
// only `corner`; they draw exactly where they always did (cornerCentre) until
// the bubble is first moved.

/** Small and Large, the two sizes the recording monitor and the inspector offer.
 *  Tyler's call (2026-10-01): on a 1-5 scale where 0.22 was 1 and 0.36 was 5,
 *  Small should sit near 4 and Large near 8 (3.5 points of height per step). */
export const OVERLAY_SIZES = { small: 0.325, large: 0.465 } as const;
export type OverlaySizeName = keyof typeof OVERLAY_SIZES;
/** The inspector's fine size slider. */
export const MIN_OVERLAY_SIZE = 0.1;
export const MAX_OVERLAY_SIZE = 0.5;

export const clampOverlaySize = (f: number) =>
  Math.min(MAX_OVERLAY_SIZE, Math.max(MIN_OVERLAY_SIZE, Number.isFinite(f) ? f : OVERLAY_SIZES.small));

/** The named size nearest a fraction (for the Small/Large switch). */
export const overlaySizeName = (f: number): OverlaySizeName =>
  Math.abs(f - OVERLAY_SIZES.small) <= Math.abs(f - OVERLAY_SIZES.large) ? 'small' : 'large';

/** The bubble's diameter in canvas pixels. */
export const overlayDiameter = (overlay: Pick<CameraOverlay, 'sizeFraction'>, visible: Rect) =>
  Math.min(visible.w, visible.h) * clampOverlaySize(overlay.sizeFraction);

/** Where a corner-placed bubble's centre is: inside that corner of the
 *  visible recording, inset 4% of its shorter side (the old placement). */
export function cornerCentre(corner: CameraOverlay['corner'], d: number, visible: Rect) {
  const margin = Math.min(visible.w, visible.h) * 0.04;
  const x = /Right/.test(corner) ? visible.x + visible.w - d - margin : visible.x + margin;
  const y = /bottom/i.test(corner) ? visible.y + visible.h - d - margin : visible.y + margin;
  return { x: x + d / 2, y: y + d / 2 };
}

/**
 * The bubble's square on the canvas. A free position is clamped so the whole
 * bubble stays on the canvas; a corner-only (older) project uses the corner.
 */
export function overlayRect(overlay: CameraOverlay, visible: Rect, canvas: Size): Rect {
  const d = overlayDiameter(overlay, visible);
  const c = overlay.position
    ? { x: overlay.position.x * canvas.width, y: overlay.position.y * canvas.height }
    : cornerCentre(overlay.corner, d, visible);
  const half = d / 2;
  const cx = Math.min(Math.max(c.x, half), Math.max(half, canvas.width - half));
  const cy = Math.min(Math.max(c.y, half), Math.max(half, canvas.height - half));
  return { x: cx - half, y: cy - half, w: d, h: d };
}

/** The overlay with its corner turned into the free position it draws at. */
export function withFreePosition(overlay: CameraOverlay, visible: Rect, canvas: Size): CameraOverlay {
  if (overlay.position) return overlay;
  const r = overlayRect(overlay, visible, canvas);
  return { ...overlay, position: { x: (r.x + r.w / 2) / canvas.width, y: (r.y + r.h / 2) / canvas.height } };
}

/**
 * The visible recording's rect on the canvas for a Mac take (display,
 * window or camera): the padded content rect, fitted to the recording (or
 * its crop), sharing room with a phone layer when there is one. The
 * compositor draws the recording here, unzoomed.
 */
export function macContentRect(project: Project, canvas: Size): Rect {
  const { width: W, height: H } = canvas;
  const pad = Math.min(W, H) * project.style.paddingFraction;
  const content = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 };
  const full = project.recording.sourceSize;
  const crop = project.style.cropRect;
  const macAspect = crop ? (crop.w * full.width) / (crop.h * full.height) : full.width / full.height;
  const phoneSize = project.recording.phoneSize;
  if (phoneLayerOn(project) && phoneSize) {
    return phoneLayerRects(content, macAspect, phoneAspect(phoneSize, project.phoneOverlay), project.phoneOverlay).mac;
  }
  return fitAspect(content, macAspect);
}

/**
 * The free position for a point on the recorded display: `u`,`v` are where
 * the bubble's centre was as a fraction of the display, and the recording
 * shows that display (uncropped) in `content`. The bubble lands over the
 * same spot of the recording it covered on screen.
 */
export function positionForScreenPoint(u: number, v: number, content: Rect, canvas: Size) {
  const x = content.x + Math.min(1, Math.max(0, u)) * content.w;
  const y = content.y + Math.min(1, Math.max(0, v)) * content.h;
  return { x: x / canvas.width, y: y / canvas.height };
}

// ---------------------------------------------------------------------------
// Snapping while the bubble is dragged in the editor

/** A guide line: vertical (`x`) or horizontal (`y`), in canvas pixels. */
export type Guide = { axis: 'x'; at: number } | { axis: 'y'; at: number };

/** The edge inset that counts as "safe": 4% of the canvas's shorter side. */
export const SAFE_INSET = 0.04;

/** Lines the bubble's edges and centre snap to: the canvas centre lines,
 *  the canvas edges inset by SAFE_INSET, and the recording's edges. */
export function snapLines(canvas: Size, content: Rect): { x: number[]; y: number[] } {
  const inset = Math.min(canvas.width, canvas.height) * SAFE_INSET;
  return {
    x: [canvas.width / 2, inset, canvas.width - inset, content.x, content.x + content.w],
    y: [canvas.height / 2, inset, canvas.height - inset, content.y, content.y + content.h],
  };
}

/**
 * Snap a dragged bubble (`centre`, diameter `d`): on each axis, the nearest
 * line within `threshold` px of its left/centre/right (top/middle/bottom)
 * wins and pulls the bubble onto it. Returns the snapped centre and the
 * guides to draw.
 */
export function snapBubble(
  centre: { x: number; y: number },
  d: number,
  canvas: Size,
  content: Rect,
  threshold: number,
): { centre: { x: number; y: number }; guides: Guide[] } {
  const lines = snapLines(canvas, content);
  const guides: Guide[] = [];
  const axis = (c: number, list: number[]) => {
    let best: { delta: number; at: number } | null = null;
    for (const at of list) {
      for (const off of [-d / 2, 0, d / 2]) {
        const delta = at - (c + off);
        if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, at };
      }
    }
    return best;
  };
  const sx = axis(centre.x, lines.x);
  const sy = axis(centre.y, lines.y);
  if (sx) guides.push({ axis: 'x', at: sx.at });
  if (sy) guides.push({ axis: 'y', at: sy.at });
  return { centre: { x: centre.x + (sx?.delta ?? 0), y: centre.y + (sy?.delta ?? 0) }, guides };
}
