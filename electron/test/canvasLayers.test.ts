import { describe, expect, it } from 'vitest';
import {
  canHide,
  defaultLayerOrder,
  hideLayer,
  hitLayer,
  layerOrder,
  layerTransform,
  nudgeLayer,
  placeLayer,
  resetLayer,
  resizeLimits,
  restack,
  snapBox,
  snapLines,
  textLayer,
  withLayerOrder,
  type LayerBox,
} from '../src/shared/canvasLayers';
import { cornerPoint, resizeFromCorner, type Corner } from '../src/shared/contentTransform';
import { OVERLAY_SIZES, overlayRect } from '../src/shared/cameraOverlay';
import { previewCursor, previewTarget, type PreviewState } from '../src/shared/previewPointer';
import { applyOp, applyOps, validateProject, OP_NAMES } from '../src/shared/agentOps';
import { defaultCameraOverlay, defaultProject, type Annotation, type Project, type Size } from '../src/shared/types';

const canvas: Size = { width: 1920, height: 1080 };

const annotation = (id: string, o: Partial<Annotation> = {}): Annotation => ({ id, start: 0, end: 3, text: id, band: 1, hex: '#ffffff', ...o });

const project = (o: Partial<Project> = {}): Project => {
  const p = defaultProject({ screenVideoFile: 'screen.webm', cameraVideoFile: 'cam.webm', sourceKind: 'display', sourceSize: { width: 1920, height: 1080 }, duration: 10 });
  p.recording.phoneVideoFile = 'phone.mov';
  p.recording.phoneSize = { width: 1206, height: 2622 };
  p.annotations = [annotation('a1'), annotation('a2')];
  p.layout = { ...p.layout, titleCard: { title: 'Hello', subtitle: '' } };
  return { ...p, ...o };
};

const content: LayerBox = { id: 'content', rect: { x: 160, y: 90, w: 1600, h: 900 }, base: { x: 160, y: 90, w: 1600, h: 900 } };
const camera: LayerBox = { id: 'camera', rect: { x: 1500, y: 700, w: 300, h: 300 }, round: true, basis: { x: 160, y: 90, w: 1600, h: 900 } };
const phone: LayerBox = { id: 'phone', rect: { x: 1300, y: 200, w: 300, h: 620 }, base: { x: 1300, y: 200, w: 300, h: 620 } };
const text: LayerBox = { id: textLayer('a1'), rect: { x: 700, y: 480, w: 520, h: 72 }, base: { x: 700, y: 480, w: 520, h: 72 } };
// Bottom to top, as the compositor reports them.
const stack = [content, camera, phone, text];

describe('hit-testing: the topmost layer wins', () => {
  it('picks the top of overlapping layers', () => {
    // Inside content, phone and (its corner square) the camera; the phone is drawn above both.
    expect(hitLayer(stack, { x: 1550, y: 750 })?.id).toBe('phone');
    // Only content and the camera's circle: the camera.
    expect(hitLayer(stack, { x: 1650, y: 900 })?.id).toBe('camera');
    expect(hitLayer(stack, { x: 900, y: 500 })?.id).toBe(textLayer('a1'));
    expect(hitLayer(stack, { x: 400, y: 300 })?.id).toBe('content');
    expect(hitLayer(stack, { x: 20, y: 20 })).toBeNull();
  });

  it('reorders with the stack', () => {
    const phoneAtBack = [phone, content, camera, text];
    expect(hitLayer(phoneAtBack, { x: 1400, y: 400 })?.id).toBe('content');
  });

  it("a round bubble's square corner is not the bubble", () => {
    expect(hitLayer([content, camera], { x: 1510, y: 710 })?.id).toBe('content');
  });
});

describe('what a press on the preview does', () => {
  const state = (o: Partial<PreviewState> = {}): PreviewState => ({ cropMode: false, placingTap: false, layers: stack, selected: null, handleRadius: 12, ...o });

  it('crop mode wins over everything, then placing a selected tap', () => {
    expect(previewTarget({ x: 1650, y: 850 }, state({ cropMode: true, placingTap: true }))).toEqual({ kind: 'crop' });
    expect(previewTarget({ x: 1650, y: 850 }, state({ placingTap: true, selected: 'camera' }))).toEqual({ kind: 'placeTap' });
  });

  it("then the selected layer's corner handles, even under a layer above it", () => {
    expect(previewTarget({ x: 162, y: 92 }, state({ selected: 'content' }))).toEqual({ kind: 'resize', layer: content, corner: 'nw' });
    expect(previewTarget({ x: 1800, y: 1000 }, state({ selected: 'camera' }))).toEqual({ kind: 'resize', layer: camera, corner: 'se' });
    // The content's corner hidden under the camera: still the content's handle when it is selected.
    const under = { ...content, rect: { x: 160, y: 90, w: 1500, h: 843.75 } };
    const square = { ...camera, round: false, rect: { x: 1500, y: 780, w: 300, h: 300 } };
    expect(previewTarget({ x: 1660, y: 933 }, state({ layers: [under, square], selected: 'content' }))).toEqual({ kind: 'resize', layer: under, corner: 'se' });
    // Unselected, a corner is just the body.
    expect(previewTarget({ x: 162, y: 92 }, state())).toEqual({ kind: 'move', layer: content });
  });

  it('then the topmost layer, then nothing', () => {
    expect(previewTarget({ x: 1550, y: 750 }, state())).toEqual({ kind: 'move', layer: phone });
    expect(previewTarget({ x: 40, y: 40 }, state())).toEqual({ kind: 'none' });
    // An App Store preview reports no content layer: the press deselects.
    expect(previewTarget({ x: 400, y: 300 }, state({ layers: [] }))).toEqual({ kind: 'none' });
  });

  it('cursors', () => {
    expect(previewCursor({ kind: 'resize', layer: content, corner: 'nw' })).toBe('nwse-resize');
    expect(previewCursor({ kind: 'resize', layer: camera, corner: 'ne' })).toBe('nesw-resize');
    expect(previewCursor({ kind: 'move', layer: phone })).toBe('move');
    expect(previewCursor({ kind: 'move', layer: camera })).toBe('grab');
    expect(previewCursor({ kind: 'move', layer: camera }, true)).toBe('grabbing');
    expect(previewCursor({ kind: 'crop' })).toBe('crosshair');
    expect(previewCursor({ kind: 'none' })).toBeUndefined();
  });
});

describe('snapping across layers', () => {
  it("lists the canvas centre lines, safe insets and every other layer's edges and centre", () => {
    const l = snapLines(canvas, [camera.rect, phone.rect]);
    expect(l.x).toEqual(expect.arrayContaining([960, 1080 * 0.04, 1920 - 1080 * 0.04, 1500, 1650, 1800, 1300, 1450, 1600]));
    expect(l.y).toEqual(expect.arrayContaining([540, 1080 * 0.04, 1080 - 1080 * 0.04, 700, 850, 1000, 200, 510, 820]));
  });

  it('snaps to the canvas centre lines', () => {
    const s = snapBox({ x: 955, y: 545 }, 800, 450, canvas, [], 8);
    expect(s.centre).toEqual({ x: 960, y: 540 });
    expect(s.guides).toEqual([{ axis: 'x', at: 960 }, { axis: 'y', at: 540 }]);
  });

  it("snaps an edge to another layer's edge", () => {
    // A text box whose right edge is 4 px short of the phone's left edge.
    const s = snapBox({ x: 1300 - 4 - 260, y: 120 }, 520, 72, canvas, [phone.rect], 8);
    expect(s.centre.x + 260).toBeCloseTo(1300, 9);
    expect(s.guides).toContainEqual({ axis: 'x', at: 1300 });
  });

  it("snaps a centre to another layer's centre", () => {
    // The camera's centre 5 px off the phone's centre line.
    const s = snapBox({ x: 1455, y: 150 }, 100, 100, canvas, [phone.rect], 8);
    expect(s.centre.x).toBe(1450);
  });

  it("snaps to the camera bubble's edges, and Option (0) never snaps", () => {
    const s = snapBox({ x: 1500 - 4 - 300, y: 300 }, 600, 338, canvas, [camera.rect], 8);
    expect(s.centre.x + 300).toBeCloseTo(1500, 9);
    const free = snapBox({ x: 955, y: 545 }, 800, 450, canvas, [camera.rect], 0);
    expect(free.centre).toEqual({ x: 955, y: 545 });
    expect(free.guides).toEqual([]);
  });

  it('safe-inset edges', () => {
    const inset = 1080 * 0.04;
    const s = snapBox({ x: 400 + inset + 5, y: 540 }, 800, 450, canvas, [], 8);
    expect(s.centre.x - 400).toBeCloseTo(inset, 9);
  });
});

describe('stacking', () => {
  it('defaults to the order layers have always drawn in', () => {
    expect(defaultLayerOrder(project())).toEqual(['content', 'camera', 'phone', 'text:a1', 'text:a2', 'title']);
    expect(layerOrder(project())).toEqual(defaultLayerOrder(project()));
  });

  it('brings to front, sends to back, steps forward and backward', () => {
    const p = project();
    expect(layerOrder(restack(p, 'camera', 'front'))).toEqual(['content', 'phone', 'text:a1', 'text:a2', 'title', 'camera']);
    expect(layerOrder(restack(p, 'phone', 'back'))).toEqual(['phone', 'content', 'camera', 'text:a1', 'text:a2', 'title']);
    expect(layerOrder(restack(p, 'camera', 'forward'))).toEqual(['content', 'phone', 'camera', 'text:a1', 'text:a2', 'title']);
    expect(layerOrder(restack(p, 'content', 'backward'))).toEqual(defaultLayerOrder(p));
    expect(restack(p, 'title', 'front')).toBe(p);
  });

  it('stores nothing once back in the default order, so it draws as it always did', () => {
    const p = project();
    const moved = restack(p, 'camera', 'front');
    expect(moved.layerOrder).toBeDefined();
    const back = restack(restack(moved, 'camera', 'back'), 'camera', 'forward');
    expect(layerOrder(back)).toEqual(defaultLayerOrder(p));
    expect('layerOrder' in back).toBe(false);
    expect('layerOrder' in withLayerOrder(p, defaultLayerOrder(p))).toBe(false);
  });

  it('slots a text added after reordering in where the default would put it, and drops ones that are gone', () => {
    const p = restack(project(), 'camera', 'front');
    const added = { ...p, annotations: [...p.annotations, annotation('a3')] };
    expect(layerOrder(added)).toEqual(['content', 'phone', 'text:a1', 'text:a2', 'text:a3', 'title', 'camera']);
    const removed = { ...p, annotations: [annotation('a2')] };
    expect(layerOrder(removed)).toEqual(['content', 'phone', 'text:a2', 'title', 'camera']);
  });
});

describe('moving, resizing, nudging, reset and hide', () => {
  it('moves and resizes every transform layer through one call', () => {
    for (const box of [content, phone, text]) {
      const placed = { x: box.rect.x - 100, y: box.rect.y + 50, w: box.rect.w * 0.5, h: box.rect.h * 0.5 };
      const t = layerTransform(placeLayer(project(), box, placed, canvas), box.id)!;
      expect(t.scale).toBeCloseTo(0.5, 9);
      expect(t.x! * 1920).toBeCloseTo(placed.x + placed.w / 2, 9);
      expect(t.y! * 1080).toBeCloseTo(placed.y + placed.h / 2, 9);
    }
    const title: LayerBox = { id: 'title', rect: { x: 100, y: 100, w: 400, h: 200 }, base: { x: 100, y: 100, w: 400, h: 200 } };
    expect(placeLayer(project(), title, { x: 200, y: 100, w: 800, h: 400 }, canvas).layout.titleCard?.transform?.scale).toBe(2);
  });

  it('keeps at least 10% of a moved layer on the canvas', () => {
    const p = placeLayer(project(), phone, { ...phone.rect, x: 5000, y: -5000 }, canvas);
    const t = p.phoneOverlay.transform!;
    const cx = t.x! * 1920;
    const cy = t.y! * 1080;
    expect(1920 - (cx - 150)).toBeCloseTo(30, 6); // 10% of 300 px wide
    expect(cy + 310).toBeCloseTo(62, 6); // 10% of 620 px tall
  });

  it('the camera is a free centre and a size, within its limits', () => {
    const p = placeLayer(project(), camera, { x: 100, y: 100, w: 450, h: 450 }, canvas);
    expect(p.cameraOverlay.position).toEqual({ x: 325 / 1920, y: 325 / 1080 });
    expect(p.cameraOverlay.sizeFraction).toBeCloseTo(0.5, 9);
    expect(placeLayer(project(), camera, { x: 100, y: 100, w: 2000, h: 2000 }, canvas).cameraOverlay.sizeFraction).toBe(0.5);
  });

  for (const c of ['nw', 'ne', 'sw', 'se'] as Corner[]) {
    it(`camera ${c} corner resize: uniform, opposite corner fixed`, () => {
      const basis = camera.basis!;
      const overlay = { ...defaultCameraOverlay(), enabled: true, position: { x: 0.5, y: 0.5 }, sizeFraction: 0.22 };
      const rect = overlayRect(overlay, basis, canvas);
      const box: LayerBox = { ...camera, rect };
      const grab = cornerPoint(rect, c);
      const dir = { x: c.endsWith('e') ? 1 : -1, y: c.startsWith('s') ? 1 : -1 };
      const next = resizeFromCorner(rect, c, { x: grab.x + dir.x * 45, y: grab.y + dir.y * 10 }, resizeLimits(box, 8));
      const p = placeLayer({ ...project(), cameraOverlay: overlay }, box, next, canvas);
      expect(p.cameraOverlay.sizeFraction).toBeCloseTo((rect.w + 45) / 900, 9);
      const after = overlayRect(p.cameraOverlay, basis, canvas);
      const opp = ({ nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' } as const)[c];
      expect(cornerPoint(after, opp).x).toBeCloseTo(cornerPoint(rect, opp).x, 6);
      expect(cornerPoint(after, opp).y).toBeCloseTo(cornerPoint(rect, opp).y, 6);
    });
  }

  it('camera resize limits are its fine-size range; the rest 10%..400% snapping at 100%', () => {
    expect(resizeLimits(camera, 8)).toEqual({ minW: 90, maxW: 450 });
    expect(resizeLimits(phone, 8)).toEqual({ minW: 30, maxW: 1200, snapW: { at: 300, threshold: 8 } });
  });

  it('is sized against the fitted recording, so moving the recording leaves the bubble alone', () => {
    const overlay = { ...defaultCameraOverlay(), enabled: true, position: { x: 0.5, y: 0.5 }, sizeFraction: 0.22 };
    const moved = { x: 900, y: 500, w: 800, h: 450 };
    expect(overlayRect(overlay, moved, canvas, camera.basis).w).toBeCloseTo(overlayRect(overlay, camera.basis!, canvas).w, 9);
  });

  it('nudges by canvas px from the project, repeat after repeat', () => {
    let p = project();
    for (let i = 0; i < 10; i++) p = nudgeLayer(p, text, 1, 0, canvas); // the box is never re-read
    const t = layerTransform(p, text.id)!;
    expect(t.x! * 1920).toBeCloseTo(700 + 260 + 10, 6);
    expect(t.y! * 1080).toBeCloseTo(480 + 36, 6);
    expect(t.scale).toBe(1);
    const c = nudgeLayer({ ...project(), cameraOverlay: { ...project().cameraOverlay, position: { x: 0.5, y: 0.5 } } }, camera, 0, -10, canvas);
    expect(c.cameraOverlay.position!.y * 1080).toBeCloseTo(530, 9);
  });

  it('reset puts a layer back where its layout puts it', () => {
    const moved = placeLayer(project(), phone, { ...phone.rect, x: 10 }, canvas);
    expect(resetLayer(moved, 'phone').phoneOverlay.transform).toBeUndefined();
    const cam = resetLayer({ ...project(), cameraOverlay: { ...project().cameraOverlay, position: { x: 0.2, y: 0.2 }, sizeFraction: 0.4 } }, 'camera');
    expect(cam.cameraOverlay.position).toBeUndefined();
    expect(cam.cameraOverlay.sizeFraction).toBe(OVERLAY_SIZES.small);
  });

  it('hides everything but the recording', () => {
    const p = project();
    expect(canHide('content')).toBe(false);
    expect(hideLayer(p, 'camera').cameraOverlay.enabled).toBe(false);
    expect(hideLayer({ ...p, phoneOverlay: { ...p.phoneOverlay, enabled: true } }, 'phone').phoneOverlay.enabled).toBe(false);
    expect(hideLayer(p, textLayer('a2')).annotations.map((a) => a.hidden)).toEqual([undefined, true]);
    expect(hideLayer(p, 'title').layout.titleCard?.hidden).toBe(true);
  });
});

describe('the layer ops', () => {
  it('are listed', () => {
    expect(OP_NAMES).toContain('layer');
  });

  it('restack, reset and hide any layer; validate passes', () => {
    const p = project();
    const r = applyOps(p, [
      { op: 'layer', id: 'camera', restack: 'back' },
      { op: 'layer', id: 'text:1', hide: true },
      { op: 'phone', x: 0.2, y: 0.5, scale: 0.8 },
      { op: 'editAnnotation', index: 0, x: 0.5, y: 0.2, scale: 1.5 },
      { op: 'titleCard', title: 'Hi', x: 0.7, scale: 0.9 },
    ]).project;
    expect(layerOrder(r)[0]).toBe('camera');
    expect(r.annotations[1].hidden).toBe(true);
    expect(r.phoneOverlay.transform).toEqual({ scale: 0.8, x: 0.2, y: 0.5 });
    expect(r.annotations[0].transform).toEqual({ scale: 1.5, x: 0.5, y: 0.2 });
    expect(r.layout.titleCard).toMatchObject({ title: 'Hi', transform: { scale: 0.9, x: 0.7 } });
    expect(validateProject({ ...r, phoneOverlay: { ...r.phoneOverlay, enabled: true } })).toEqual([]);
  });

  it('a phone layout or a text band is a quick placement that clears the hand move', () => {
    const moved = applyOps(project(), [
      { op: 'phone', x: 0.2, scale: 0.8 },
      { op: 'editAnnotation', index: 0, x: 0.5 },
    ]).project;
    expect(applyOp(moved, { op: 'phone', layout: 'corner' }).project.phoneOverlay.transform).toBeUndefined();
    expect(applyOp(moved, { op: 'editAnnotation', index: 0, band: 2 }).project.annotations[0].transform).toBeUndefined();
  });

  it('refuses what makes no sense', () => {
    const p = project();
    expect(() => applyOp(p, { op: 'layer', id: 'content', hide: true })).toThrow(/can't be hidden/);
    expect(() => applyOp(p, { op: 'layer', id: 'text:nope', reset: true })).toThrow(/no text overlay/);
    expect(() => applyOp(p, { op: 'layer', id: 'camera', restack: 'up' })).toThrow(/restack/);
    expect(() => applyOp(p, { op: 'layer', id: 'camera' })).toThrow(/pass restack/);
    expect(() => applyOp(p, { op: 'phone', scale: 9 })).toThrow(/scale/);
    expect(validateProject({ ...p, layerOrder: ['content', 'bogus'] }).join()).toMatch(/layerOrder/);
    expect(validateProject({ ...p, annotations: [annotation('a1', { transform: { scale: 0 } })] }).join()).toMatch(/annotations\[0\]\.transform/);
  });
});
