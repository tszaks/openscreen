import { cornerAt, cornerCursor, type Corner } from './contentTransform';
import { hitLayer, type LayerBox, type LayerId } from './canvasLayers';

// What a press on the editor's preview does, in one place so the order is
// tested. Highest first:
//
//   1. Crop mode: the press starts a crop.
//   2. A tap selected on the taps lane (phone takes): the press places it.
//   3. A corner handle of the selected layer: resize it.
//   4. A 3D phone (phone3dActive) that is the topmost layer under the pointer,
//      pressed inside its drawn hull, without ⌘: orbit it (turn and tilt).
//      A camera bubble, text, title or caption drawn over the phone wins, as
//      in 5; ⌘-drag moves the phone like any layer.
//   5. The topmost layer under the pointer (shared/canvasLayers): select and move it.
//   6. Empty canvas: deselect.
//
// A double-click on a layer resets its position and size; crop mode and tap
// placement keep double-clicks to themselves.

export type PreviewTarget =
  | { kind: 'crop' }
  | { kind: 'placeTap' }
  | { kind: 'resize'; layer: LayerBox; corner: Corner }
  | { kind: 'orbit'; layer: LayerBox }
  | { kind: 'move'; layer: LayerBox }
  | { kind: 'none' };

export interface PreviewState {
  cropMode: boolean;
  placingTap: boolean;
  /** Every layer drawn at the last render, bottom to top. */
  layers: readonly LayerBox[];
  selected: LayerId | null;
  /** How near a corner counts as its handle, in canvas px. */
  handleRadius: number;
  /** The recording is drawn as a 3D phone (phone3dActive): a press on it orbits. */
  phone3d?: boolean;
}

/** Keys held with the press: ⌘ turns an orbit back into a move. */
export interface PreviewMods {
  meta?: boolean;
}

export function previewTarget(p: { x: number; y: number }, s: PreviewState, mods: PreviewMods = {}): PreviewTarget {
  if (s.cropMode) return { kind: 'crop' };
  if (s.placingTap) return { kind: 'placeTap' };
  const selected = s.selected ? s.layers.find((l) => l.id === s.selected) : undefined;
  if (selected) {
    const corner = cornerAt(selected.rect, p, s.handleRadius);
    if (corner) return { kind: 'resize', layer: selected, corner };
  }
  const hit = hitLayer(s.layers, p);
  // hitLayer tests the drawn hull when a box has one, so a press inside the
  // home rect but outside the turned phone misses it.
  if (hit && s.phone3d && !mods.meta && hit.id === 'content' && hit.hull && hit.hull.length >= 3) return { kind: 'orbit', layer: hit };
  return hit ? { kind: 'move', layer: hit } : { kind: 'none' };
}

/** The pointer's cursor over a target (`dragging`: the press is held). */
export function previewCursor(t: PreviewTarget, dragging = false): string | undefined {
  switch (t.kind) {
    case 'crop':
    case 'placeTap':
      return 'crosshair';
    case 'resize':
      return cornerCursor(t.corner);
    case 'orbit':
      return dragging ? 'grabbing' : 'grab';
    case 'move':
      if (t.layer.id === 'camera') return dragging ? 'grabbing' : 'grab';
      return 'move';
    case 'none':
      return undefined;
  }
}
