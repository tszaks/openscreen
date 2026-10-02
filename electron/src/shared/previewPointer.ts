import { cornerAt, cornerCursor, type Corner } from './contentTransform';
import type { Rect } from './phoneLayer';

// What a press on the editor's preview does, in one place so the order is
// tested. Highest first:
//
//   1. Crop mode: the press starts a crop.
//   2. A tap selected on the taps lane (phone takes): the press places it.
//   3. A corner handle of whatever is selected (camera or recording): resize.
//   4. The camera bubble: select and move it (it is drawn above the recording).
//   5. The recording: select and move it.
//   6. Empty canvas: deselect.
//
// A double-click on the recording (not the bubble) resets its move and size;
// crop mode and tap placement keep double-clicks to themselves.

export type PreviewTarget =
  | { kind: 'crop' }
  | { kind: 'placeTap' }
  | { kind: 'resize'; what: 'camera' | 'content'; corner: Corner }
  | { kind: 'move'; what: 'camera' | 'content' }
  | { kind: 'none' };

export interface PreviewState {
  cropMode: boolean;
  placingTap: boolean;
  /** The camera bubble's square, when it is showing. */
  camera: { rect: Rect; circular: boolean; selected: boolean } | null;
  /** The recording's box, when it can be moved. */
  content: { rect: Rect; selected: boolean } | null;
  /** How near a corner counts as its handle, in canvas px. */
  handleRadius: number;
}

const inRect = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** The camera bubble under `p` (its circle when round). */
export function overCamera(cam: NonNullable<PreviewState['camera']>, p: { x: number; y: number }) {
  const r = cam.rect;
  if (cam.circular) return Math.hypot(p.x - (r.x + r.w / 2), p.y - (r.y + r.h / 2)) <= r.w / 2;
  return inRect(r, p);
}

export function previewTarget(p: { x: number; y: number }, s: PreviewState): PreviewTarget {
  if (s.cropMode) return { kind: 'crop' };
  if (s.placingTap) return { kind: 'placeTap' };
  if (s.camera?.selected) {
    const corner = cornerAt(s.camera.rect, p, s.handleRadius);
    if (corner) return { kind: 'resize', what: 'camera', corner };
  }
  if (s.content?.selected) {
    const corner = cornerAt(s.content.rect, p, s.handleRadius);
    if (corner) return { kind: 'resize', what: 'content', corner };
  }
  if (s.camera && overCamera(s.camera, p)) return { kind: 'move', what: 'camera' };
  if (s.content && inRect(s.content.rect, p)) return { kind: 'move', what: 'content' };
  return { kind: 'none' };
}

/** The pointer's cursor over a target (`dragging`: the press is held). */
export function previewCursor(t: PreviewTarget, dragging = false): string | undefined {
  switch (t.kind) {
    case 'crop':
    case 'placeTap':
      return 'crosshair';
    case 'resize':
      return cornerCursor(t.corner);
    case 'move':
      if (t.what === 'camera') return dragging ? 'grabbing' : 'grab';
      return 'move';
    case 'none':
      return undefined;
  }
}
