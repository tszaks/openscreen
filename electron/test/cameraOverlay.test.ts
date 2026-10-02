import { describe, expect, it } from 'vitest';
import {
  OVERLAY_SIZES,
  clampOverlaySize,
  cornerCentre,
  macContentRect,
  overlayDiameter,
  overlayRect,
  overlaySizeName,
  positionForScreenPoint,
  withFreePosition,
} from '../src/shared/cameraOverlay';
import { snapBox, snapLines as layerSnapLines } from '../src/shared/canvasLayers';
import { defaultCameraOverlay, defaultProject, type CameraOverlay, type Project, type Size } from '../src/shared/types';
import { projectCanvasSize } from '../src/shared/mobileProject';

const canvas169: Size = { width: 1920, height: 1080 };
const visible = { x: 160, y: 90, w: 1600, h: 900 };

const overlay = (o: Partial<CameraOverlay> = {}): CameraOverlay => ({ ...defaultCameraOverlay(), enabled: true, ...o });

const macProject = (sourceSize: Size, presetId?: string): Project => {
  const p = defaultProject({ screenVideoFile: 'screen.webm', sourceKind: 'display', sourceSize, duration: 10 });
  if (presetId) p.layout = { ...p.layout, presetId: presetId as Project['layout']['presetId'] };
  return p;
};

describe('camera overlay defaults', () => {
  it('is Small, round, bottom-right', () => {
    const o = defaultCameraOverlay();
    expect(o.sizeFraction).toBe(OVERLAY_SIZES.small);
    expect(o.circular).toBe(true);
    expect(o.corner).toBe('bottomRight');
    expect(o.position).toBeUndefined();
  });

  it('names sizes and clamps the fine slider', () => {
    expect(overlaySizeName(OVERLAY_SIZES.small)).toBe('small');
    expect(overlaySizeName(OVERLAY_SIZES.large)).toBe('large');
    // The midpoint between Small (0.325) and Large (0.465) is 0.395.
    expect(overlaySizeName(0.36)).toBe('small');
    expect(overlaySizeName(0.42)).toBe('large');
    // Projects saved with the old Small (0.22) still read as Small.
    expect(overlaySizeName(0.22)).toBe('small');
    expect(OVERLAY_SIZES).toEqual({ small: 0.325, large: 0.465 });
    expect(clampOverlaySize(0.01)).toBe(0.1);
    expect(clampOverlaySize(2)).toBe(0.5);
    expect(clampOverlaySize(NaN)).toBe(OVERLAY_SIZES.small);
  });
});

describe('corner → free position (older projects)', () => {
  for (const corner of ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const) {
    it(`${corner} draws in the same place before and after`, () => {
      const old = overlay({ corner, sizeFraction: 0.3 });
      const before = overlayRect(old, visible, canvas169);
      const migrated = withFreePosition(old, visible, canvas169);
      expect(migrated.position).toBeDefined();
      const after = overlayRect(migrated, visible, canvas169);
      for (const k of ['x', 'y', 'w', 'h'] as const) expect(after[k]).toBeCloseTo(before[k], 6);
    });
  }

  it('keeps the old inset: 4% of the visible recording', () => {
    const d = overlayDiameter(overlay(), visible);
    const c = cornerCentre('bottomRight', d, visible);
    expect(visible.x + visible.w - (c.x + d / 2)).toBeCloseTo(900 * 0.04);
    expect(visible.y + visible.h - (c.y + d / 2)).toBeCloseTo(900 * 0.04);
  });

  it('leaves a free position alone', () => {
    const o = overlay({ position: { x: 0.3, y: 0.6 } });
    expect(withFreePosition(o, visible, canvas169)).toBe(o);
  });
});

describe('free position', () => {
  it('centres the bubble on the position', () => {
    const r = overlayRect(overlay({ position: { x: 0.25, y: 0.5 } }), visible, canvas169);
    expect(r.x + r.w / 2).toBeCloseTo(480);
    expect(r.y + r.h / 2).toBeCloseTo(540);
    expect(r.w).toBeCloseTo(900 * OVERLAY_SIZES.small);
  });

  it('keeps the whole bubble on the canvas', () => {
    const r = overlayRect(overlay({ position: { x: 1, y: 0 } }), visible, canvas169);
    expect(r.x + r.w).toBeCloseTo(1920);
    expect(r.y).toBeCloseTo(0);
  });
});

describe('screen position → canvas position', () => {
  // The display shown at full size in its content rect: a point maps onto
  // the same spot of the recording, whatever the canvas.
  const cases: [string, Size, string | undefined, number][] = [
    ['16:10 display, classic padded canvas', { width: 2880, height: 1800 }, undefined, 16 / 10],
    ['16:9 display on Wide 16:9', { width: 1920, height: 1080 }, 'landscape-16x9', 16 / 9],
    ['16:10 display on Vertical 9:16', { width: 2880, height: 1800 }, 'social-9x16', 9 / 16],
    ['ultrawide on Square 1:1', { width: 3440, height: 1440 }, 'square', 1],
  ];
  for (const [name, source, preset, canvasAspect] of cases) {
    it(name, () => {
      const p = macProject(source, preset);
      const c = projectCanvasSize(p);
      expect(c.width / c.height).toBeCloseTo(canvasAspect, 2);
      const content = macContentRect(p, c);
      // The content rect has the recording's shape.
      expect(content.w / content.h).toBeCloseTo(source.width / source.height, 3);
      for (const [u, v] of [
        [0.5, 0.5],
        [0.9, 0.85],
        [0.1, 0.2],
      ]) {
        const pos = positionForScreenPoint(u, v, content, c);
        expect(pos.x * c.width).toBeCloseTo(content.x + u * content.w, 6);
        expect(pos.y * c.height).toBeCloseTo(content.y + v * content.h, 6);
      }
      // The display's centre is the recording's centre.
      const mid = positionForScreenPoint(0.5, 0.5, content, c);
      expect(mid.x * c.width).toBeCloseTo(content.x + content.w / 2, 6);
    });
  }

  it('clamps a bubble that hung off the display', () => {
    const p = macProject({ width: 1920, height: 1080 }, 'landscape-16x9');
    const c = projectCanvasSize(p);
    const content = macContentRect(p, c);
    const pos = positionForScreenPoint(1.2, -0.1, content, c);
    expect(pos.x * c.width).toBeCloseTo(content.x + content.w);
    expect(pos.y * c.height).toBeCloseTo(content.y);
  });
});

// The bubble snaps like every canvas layer (shared/canvasLayers), here against the recording alone.
const snapBubble = (c: { x: number; y: number }, d: number, canvas: Size, content: { x: number; y: number; w: number; h: number }, t: number) =>
  snapBox(c, d, d, canvas, [content], t);
const snapLines = (canvas: Size, content: { x: number; y: number; w: number; h: number }) => layerSnapLines(canvas, [content]);

describe('snapping', () => {
  const content = { x: 200, y: 100, w: 1520, h: 880 };
  const d = 200;

  it('lists centre lines, safe-inset edges and the content edges', () => {
    const l = snapLines(canvas169, content);
    expect(l.x).toEqual(expect.arrayContaining([960, 1080 * 0.04, 1920 - 1080 * 0.04, 200, 1720]));
    expect(l.y).toEqual(expect.arrayContaining([540, 1080 * 0.04, 1080 - 1080 * 0.04, 100, 980]));
  });

  it('snaps the centre to the canvas centre lines', () => {
    const s = snapBubble({ x: 965, y: 536 }, d, canvas169, content, 8);
    expect(s.centre).toEqual({ x: 960, y: 540 });
    expect(s.guides).toEqual([
      { axis: 'x', at: 960 },
      { axis: 'y', at: 540 },
    ]);
  });

  it('snaps an edge to the content edge', () => {
    // Right edge at 1715 → 1720.
    const s = snapBubble({ x: 1615, y: 300 }, d, canvas169, content, 8);
    expect(s.centre.x).toBe(1620);
    expect(s.guides).toEqual([{ axis: 'x', at: 1720 }]);
  });

  it('snaps a bottom edge to the safe inset', () => {
    const inset = 1080 - 1080 * 0.04;
    const s = snapBubble({ x: 400, y: inset - d / 2 + 5 }, d, canvas169, content, 8);
    expect(s.centre.y).toBeCloseTo(inset - d / 2);
    expect(s.guides).toEqual([{ axis: 'y', at: inset }]);
  });

  it('picks the nearest line when two are in reach', () => {
    // Centre 3 px from the canvas centre line; right edge 6 px from the content's right edge.
    const narrow = { x: 200, y: 100, w: 869, h: 880 };
    const s = snapBubble({ x: 963, y: 300 }, d, canvas169, narrow, 8);
    expect(s.centre.x).toBe(960);
    expect(s.guides).toEqual([{ axis: 'x', at: 960 }]);
    // Moved 4 px right, the content edge (now 2 px off) wins.
    const t = snapBubble({ x: 967, y: 300 }, d, canvas169, narrow, 8);
    expect(t.centre.x).toBe(969);
  });

  it('leaves a bubble alone out of reach, and with a zero threshold (Option)', () => {
    const free = snapBubble({ x: 700, y: 300 }, d, canvas169, content, 8);
    expect(free.centre).toEqual({ x: 700, y: 300 });
    expect(free.guides).toEqual([]);
    expect(snapBubble({ x: 963, y: 300 }, d, canvas169, content, 0).centre.x).toBe(963);
  });
});
