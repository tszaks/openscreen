import { describe, expect, it } from 'vitest';
import type { LayerBox } from '../src/shared/canvasLayers';
import { previewCursor, previewTarget, type PreviewState } from '../src/shared/previewPointer';

// A 3D phone turned to the right: its home rect is 300..700 × 200..1000, its
// drawn hull a narrower quad inside it (the far edge is pulled in).
const hull = [
  { x: 360, y: 230 },
  { x: 640, y: 260 },
  { x: 640, y: 940 },
  { x: 360, y: 970 },
];
const content: LayerBox = { id: 'content', rect: { x: 300, y: 200, w: 400, h: 800 }, base: { x: 300, y: 200, w: 400, h: 800 }, hull };
const flatContent: LayerBox = { id: 'content', rect: content.rect, base: content.base };
const text: LayerBox = { id: 'text:a', rect: { x: 420, y: 500, w: 160, h: 60 } };
const camera: LayerBox = { id: 'camera', rect: { x: 600, y: 850, w: 150, h: 150 }, round: true };

const state = (over: Partial<PreviewState> = {}): PreviewState => ({
  cropMode: false,
  placingTap: false,
  layers: [content, text, camera],
  selected: null,
  handleRadius: 12,
  phone3d: true,
  ...over,
});

describe('drag-to-orbit on the preview (SPEC §5.4)', () => {
  it('orbits when the 3D phone is the topmost layer under the press', () => {
    expect(previewTarget({ x: 500, y: 350 }, state())).toEqual({ kind: 'orbit', layer: content });
    expect(previewCursor({ kind: 'orbit', layer: content })).toBe('grab');
    expect(previewCursor({ kind: 'orbit', layer: content }, true)).toBe('grabbing');
  });

  it('lets a text layer drawn over the phone move, as today', () => {
    expect(previewTarget({ x: 500, y: 530 }, state())).toEqual({ kind: 'move', layer: text });
  });

  it('lets a camera bubble drawn over the phone move', () => {
    expect(previewTarget({ x: 630, y: 900 }, state())).toEqual({ kind: 'move', layer: camera });
  });

  it('keeps ⌘-drag on the phone as a move', () => {
    expect(previewTarget({ x: 500, y: 350 }, state(), { meta: true })).toEqual({ kind: 'move', layer: content });
  });

  it('does not orbit a press inside the home rect but outside the turned hull', () => {
    // (320, 210) is inside rect 300..700 × 200..1000 and outside the hull.
    expect(previewTarget({ x: 320, y: 210 }, state())).toEqual({ kind: 'none' });
  });

  it('keeps the selected phone\'s corner handles for resizing', () => {
    expect(previewTarget({ x: 302, y: 203 }, state({ selected: 'content' }))).toEqual({ kind: 'resize', layer: content, corner: 'nw' });
  });

  it('lets crop mode and tap placing win', () => {
    expect(previewTarget({ x: 500, y: 350 }, state({ cropMode: true }))).toEqual({ kind: 'crop' });
    expect(previewTarget({ x: 500, y: 350 }, state({ placingTap: true }))).toEqual({ kind: 'placeTap' });
  });

  it('changes nothing with 3D off', () => {
    const off = state({ phone3d: false, layers: [flatContent, text, camera] });
    expect(previewTarget({ x: 500, y: 350 }, off)).toEqual({ kind: 'move', layer: flatContent });
    expect(previewTarget({ x: 320, y: 210 }, off)).toEqual({ kind: 'move', layer: flatContent });
    // A stale hull without the 3D flag does not orbit either.
    expect(previewTarget({ x: 500, y: 350 }, state({ phone3d: false }))).toEqual({ kind: 'move', layer: content });
  });
});
