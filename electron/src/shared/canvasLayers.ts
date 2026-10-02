import { clampOverlaySize, MAX_OVERLAY_SIZE, MIN_OVERLAY_SIZE, OVERLAY_SIZES } from './cameraOverlay';
import { keepOnCanvas, MAX_CONTENT_SCALE, MIN_CONTENT_SCALE, placeContent, transformFor, type ResizeOptions } from './contentTransform';
import type { Rect } from './phoneLayer';
import type { ContentTransform, Project, Size } from './types';

// Everything on the preview is a layer the same way: the screen recording,
// the camera bubble, the phone of a Mac + iPhone take, each text overlay and
// the title card. Each is selected, moved, resized from its corners (aspect
// locked), snapped and stacked the same way; this module is that shared
// part, kept pure so it is tested.
//
// Where a layer sits: its layout still decides a fitted rect (`base`), and an
// optional transform ({x, y, scale}, shared/contentTransform) places it from
// there. Absent, it draws exactly where it always did. The camera keeps its
// own model (a free centre and a size against the recording) and is written
// through the same calls.
//
// The compositor reports, every render, a LayerBox per layer it drew, bottom
// to top: the editor hit-tests, snaps and edits through those.

export type LayerId = 'content' | 'camera' | 'phone' | 'title' | `text:${string}`;

/** A layer as drawn at the last render. */
export interface LayerBox {
  id: LayerId;
  /** Its box on the canvas. */
  rect: Rect;
  /** Where its layout puts it, before any transform (not the camera). */
  base?: Rect;
  /** Hit-tested as the circle inside `rect` (a round camera bubble). */
  round?: boolean;
  /** The camera: what its size is measured against. */
  basis?: Rect;
}

export const textLayer = (annotationId: string): LayerId => `text:${annotationId}`;
const annotationIdOf = (id: LayerId) => (id.startsWith('text:') ? id.slice(5) : null);

/** A human name for a layer (menus, hints). */
export function layerLabel(p: Pick<Project, 'annotations'>, id: LayerId): string {
  if (id === 'content') return 'Recording';
  if (id === 'camera') return 'Camera';
  if (id === 'phone') return 'iPhone';
  if (id === 'title') return 'Title';
  const a = p.annotations.find((x) => x.id === annotationIdOf(id));
  return a ? `Text "${a.text}"` : 'Text';
}

// ---------------------------------------------------------------------------
// Stacking

/** The order layers have always drawn in, bottom to top. */
export function defaultLayerOrder(p: Pick<Project, 'annotations'>): LayerId[] {
  return ['content', 'camera', 'phone', ...(p.annotations ?? []).map((a) => textLayer(a.id)), 'title'];
}

/** The project's order, bottom to top: the stored one, with layers it doesn't
 *  know (text added later) slotted in where the default would put them. */
export function layerOrder(p: Pick<Project, 'annotations' | 'layerOrder'>): LayerId[] {
  const def = defaultLayerOrder(p);
  if (!p.layerOrder?.length) return def;
  const known = new Set<string>(def);
  const order = p.layerOrder.filter((id): id is LayerId => known.has(id));
  const unique = order.filter((id, i) => order.indexOf(id) === i);
  for (const id of def) {
    if (unique.includes(id)) continue;
    // After the nearest layer below it in the default order, else at the bottom.
    const below = def.slice(0, def.indexOf(id)).reverse().find((x) => unique.includes(x));
    unique.splice(below ? unique.indexOf(below) + 1 : 0, 0, id);
  }
  return unique;
}

/** The project with `order` stored; the default order is stored as nothing,
 *  so a project put back in order draws exactly as it always did. */
export function withLayerOrder<P extends Pick<Project, 'annotations' | 'layerOrder'>>(p: P, order: LayerId[]): P {
  const def = defaultLayerOrder(p);
  const { layerOrder: _, ...rest } = p;
  if (order.length === def.length && order.every((id, i) => id === def[i])) return rest as P;
  return { ...rest, layerOrder: [...order] } as P;
}

export type Restack = 'front' | 'back' | 'forward' | 'backward';

/** `id` moved to the top or bottom, or one step up or down. */
export function restack<P extends Pick<Project, 'annotations' | 'layerOrder'>>(p: P, id: LayerId, how: Restack): P {
  const order = layerOrder(p);
  const i = order.indexOf(id);
  if (i < 0) return p;
  const rest = order.filter((x) => x !== id);
  const at = how === 'front' ? rest.length : how === 'back' ? 0 : how === 'forward' ? Math.min(rest.length, i + 1) : Math.max(0, i - 1);
  rest.splice(at, 0, id);
  // Already there: the same project, so nothing is recorded as an edit.
  if (rest.every((x, j) => x === order[j])) return p;
  return withLayerOrder(p, rest);
}

// ---------------------------------------------------------------------------
// Transforms, reset, hide

/** A layer's transform (none for the camera, which has its own model). */
export function layerTransform(p: Project, id: LayerId): ContentTransform | undefined {
  if (id === 'content') return p.style.contentTransform;
  if (id === 'phone') return p.phoneOverlay?.transform;
  if (id === 'title') return p.layout.titleCard?.transform;
  const aid = annotationIdOf(id);
  return aid ? p.annotations.find((a) => a.id === aid)?.transform : undefined;
}

const without = <T extends object, K extends keyof T>(o: T, k: K): T => {
  const { [k]: _, ...rest } = o;
  return rest as T;
};

/** The project with a layer's transform set, or cleared with undefined. */
export function withLayerTransform(p: Project, id: LayerId, t: ContentTransform | undefined): Project {
  const put = <T extends { transform?: ContentTransform }>(o: T): T => (t ? { ...o, transform: t } : without(o, 'transform'));
  if (id === 'content') return { ...p, style: t ? { ...p.style, contentTransform: t } : without(p.style, 'contentTransform') };
  if (id === 'phone') return { ...p, phoneOverlay: put(p.phoneOverlay) };
  if (id === 'title') return p.layout.titleCard ? { ...p, layout: { ...p.layout, titleCard: put(p.layout.titleCard) } } : p;
  const aid = annotationIdOf(id);
  if (!aid) return p;
  return { ...p, annotations: p.annotations.map((a) => (a.id === aid ? put(a) : a)) };
}

/**
 * The one write path for moving and resizing: the project with layer `box`
 * drawn at `rect` (same aspect as its box). It stays at least 10% on the
 * canvas. The camera becomes a free centre and a size; everything else a
 * transform from its base.
 */
export function placeLayer(p: Project, box: LayerBox, rect: Rect, canvas: Size): Project {
  const r = keepOnCanvas(rect, canvas);
  if (box.id === 'camera') {
    const basis = box.basis ?? box.rect;
    const side = Math.min(basis.w, basis.h);
    const sizeFraction = side > 0 ? clampOverlaySize(r.w / side) : p.cameraOverlay.sizeFraction;
    const position = { x: (r.x + r.w / 2) / canvas.width, y: (r.y + r.h / 2) / canvas.height };
    return { ...p, cameraOverlay: { ...p.cameraOverlay, position, sizeFraction } };
  }
  if (!box.base) return p;
  return withLayerTransform(p, box.id, transformFor(box.base, r, canvas));
}

/** How far a corner drag may take a layer, as resizeFromCorner limits: the
 *  camera within its fine-size range; the rest 10%..400% of their fitted
 *  width, snapping at 100% within `threshold` px. */
export function resizeLimits(box: LayerBox, threshold: number): Omit<ResizeOptions, 'fromCentre'> {
  if (box.id === 'camera') {
    const basis = box.basis ?? box.rect;
    const side = Math.min(basis.w, basis.h);
    return { minW: side * MIN_OVERLAY_SIZE, maxW: side * MAX_OVERLAY_SIZE };
  }
  const w = (box.base ?? box.rect).w;
  return { minW: w * MIN_CONTENT_SCALE, maxW: w * MAX_CONTENT_SCALE, snapW: { at: w, threshold } };
}

/** Moved by (dx, dy) canvas px: the arrow keys. Works from the project's own
 *  numbers (not the last render), so held-down keys never drop a step. */
export function nudgeLayer(p: Project, box: LayerBox, dx: number, dy: number, canvas: Size): Project {
  if (box.id === 'camera') {
    const c = p.cameraOverlay.position ?? { x: (box.rect.x + box.rect.w / 2) / canvas.width, y: (box.rect.y + box.rect.h / 2) / canvas.height };
    const d = box.rect.w;
    // The bubble stays whole on the canvas, as everywhere else.
    const clamp = (v: number, ext: number) => Math.min(Math.max(v, d / 2 / ext), 1 - d / 2 / ext);
    return { ...p, cameraOverlay: { ...p.cameraOverlay, position: { x: clamp(c.x + dx / canvas.width, canvas.width), y: clamp(c.y + dy / canvas.height, canvas.height) } } };
  }
  if (!box.base) return p;
  const t = layerTransform(p, box.id) ?? { scale: 1 };
  const b = box.base;
  const x = (t.x ?? (b.x + b.w / 2) / canvas.width) + dx / canvas.width;
  const y = (t.y ?? (b.y + b.h / 2) / canvas.height) + dy / canvas.height;
  const placed = placeContent(b, { ...t, x, y }, canvas);
  return withLayerTransform(p, box.id, { ...transformFor(b, placed, canvas), scale: t.scale });
}

/** Back to where the layout puts it (the camera: Small, in its corner). */
export function resetLayer(p: Project, id: LayerId): Project {
  if (id === 'camera') return { ...p, cameraOverlay: { ...without(p.cameraOverlay, 'position'), sizeFraction: OVERLAY_SIZES.small } };
  return withLayerTransform(p, id, undefined);
}

/** Every layer but the recording itself can be hidden. */
export const canHide = (id: LayerId) => id !== 'content';

/** Hidden: the camera and phone switch off, a text or the title is kept but not drawn. */
export function hideLayer(p: Project, id: LayerId): Project {
  if (id === 'camera') return { ...p, cameraOverlay: { ...p.cameraOverlay, enabled: false } };
  if (id === 'phone') return { ...p, phoneOverlay: { ...p.phoneOverlay, enabled: false } };
  if (id === 'title') return p.layout.titleCard ? { ...p, layout: { ...p.layout, titleCard: { ...p.layout.titleCard, hidden: true } } } : p;
  const aid = annotationIdOf(id);
  if (!aid) return p;
  return { ...p, annotations: p.annotations.map((a) => (a.id === aid ? { ...a, hidden: true } : a)) };
}

// ---------------------------------------------------------------------------
// Hit-testing

const inRect = (r: Rect, q: { x: number; y: number }) => q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h;

/** `box` is under `q` (its circle, when round). */
export function overLayer(box: LayerBox, q: { x: number; y: number }) {
  const r = box.rect;
  if (box.round) return Math.hypot(q.x - (r.x + r.w / 2), q.y - (r.y + r.h / 2)) <= r.w / 2;
  return inRect(r, q);
}

/** The topmost layer under `q`; `boxes` run bottom to top, as drawn. */
export function hitLayer(boxes: readonly LayerBox[], q: { x: number; y: number }): LayerBox | null {
  for (let i = boxes.length - 1; i >= 0; i--) if (overLayer(boxes[i], q)) return boxes[i];
  return null;
}

// ---------------------------------------------------------------------------
// Snapping while a layer is dragged

/** A guide line: vertical (`x`) or horizontal (`y`), in canvas pixels. */
export type Guide = { axis: 'x'; at: number } | { axis: 'y'; at: number };

/** The edge inset that counts as "safe": 4% of the canvas's shorter side. */
export const SAFE_INSET = 0.04;

/** Lines a dragged layer's edges and centre snap to: the canvas centre lines,
 *  the canvas edges inset by SAFE_INSET, and every other layer's edges and centre. */
export function snapLines(canvas: Size, others: readonly Rect[]): { x: number[]; y: number[] } {
  const inset = Math.min(canvas.width, canvas.height) * SAFE_INSET;
  return {
    x: [canvas.width / 2, inset, canvas.width - inset, ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])],
    y: [canvas.height / 2, inset, canvas.height - inset, ...others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h])],
  };
}

/**
 * Snap a dragged box (`centre`, `w` × `h`): on each axis, the nearest line
 * within `threshold` px of its left/centre/right (top/middle/bottom) wins and
 * pulls the box onto it. Returns the snapped centre and the guides to draw.
 */
export function snapBox(
  centre: { x: number; y: number },
  w: number,
  h: number,
  canvas: Size,
  others: readonly Rect[],
  threshold: number,
): { centre: { x: number; y: number }; guides: Guide[] } {
  const lines = snapLines(canvas, others);
  const guides: Guide[] = [];
  const axis = (c: number, list: number[], d: number) => {
    let best: { delta: number; at: number } | null = null;
    for (const at of list) {
      for (const off of [-d / 2, 0, d / 2]) {
        const delta = at - (c + off);
        if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, at };
      }
    }
    return best;
  };
  const sx = axis(centre.x, lines.x, w);
  const sy = axis(centre.y, lines.y, h);
  if (sx) guides.push({ axis: 'x', at: sx.at });
  if (sy) guides.push({ axis: 'y', at: sy.at });
  return { centre: { x: centre.x + (sx?.delta ?? 0), y: centre.y + (sy?.delta ?? 0) }, guides };
}
