import { describe, expect, it } from 'vitest';
import {
  MAX_CONTENT_SCALE,
  MIN_CONTENT_SCALE,
  MIN_VISIBLE,
  contentScale,
  cornerAt,
  cornerPoint,
  keepOnCanvas,
  mapRect,
  placeContent,
  resizeFromCorner,
  transformFor,
  type Corner,
} from '../src/shared/contentTransform';
import { macContentRect, macFittedRect } from '../src/shared/cameraOverlay';
import { fitAspect, type Rect } from '../src/shared/phoneLayer';
import { applyOp, validateProject, OP_NAMES } from '../src/shared/agentOps';
import { defaultProject, normalizeProject, resetProject, type Project, type Size } from '../src/shared/types';
import { projectCanvasSize } from '../src/shared/mobileProject';

const CANVASES: Record<string, Size> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
};

const close = (a: Rect, b: Rect, digits = 6) => {
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(a[k]).toBeCloseTo(b[k], digits);
};
const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

const macProject = (sourceSize: Size, presetId?: string): Project => {
  const p = defaultProject({ screenVideoFile: 'screen.webm', sourceKind: 'display', sourceSize, duration: 10 });
  if (presetId) p.layout = { ...p.layout, presetId: presetId as Project['layout']['presetId'] };
  return p;
};

describe('placing the recording (centre and scale → rect)', () => {
  const canvas = CANVASES['16:9'];
  const base = { x: 154, y: 86, w: 1612, h: 906.75 };

  it('no transform is the fitted rect itself', () => {
    expect(placeContent(base, undefined, canvas)).toBe(base);
    expect(placeContent(base, null, canvas)).toBe(base);
  });

  it('scale 1 at the fitted centre is the fitted rect', () => {
    close(placeContent(base, { x: centre(base).x / 1920, y: centre(base).y / 1080, scale: 1 }, canvas), base);
    close(placeContent(base, { scale: 1 }, canvas), base);
  });

  it('scales about the centre, aspect kept, and moves the centre', () => {
    const r = placeContent(base, { x: 0.25, y: 0.5, scale: 0.5 }, canvas);
    expect(r.w).toBeCloseTo(base.w / 2, 9);
    expect(r.h).toBeCloseTo(base.h / 2, 9);
    expect(r.w / r.h).toBeCloseTo(base.w / base.h, 9);
    expect(centre(r).x).toBeCloseTo(480, 9);
    expect(centre(r).y).toBeCloseTo(540, 9);
  });

  it('a missing x or y keeps the fitted centre on that axis', () => {
    const r = placeContent(base, { y: 0.3, scale: 0.5 }, canvas);
    expect(centre(r).x).toBeCloseTo(centre(base).x, 9);
    expect(centre(r).y).toBeCloseTo(324, 9);
  });

  it('clamps the scale', () => {
    expect(placeContent(base, { scale: 0.001 }, canvas).w).toBeCloseTo(base.w * MIN_CONTENT_SCALE, 6);
    expect(placeContent(base, { scale: 99 }, canvas).w).toBeCloseTo(base.w * MAX_CONTENT_SCALE, 6);
    expect(contentScale({ scale: NaN })).toBe(1);
    expect(contentScale(undefined)).toBe(1);
  });

  const visibleFraction = (r: Rect, c: Size) => ({
    x: (Math.min(r.x + r.w, c.width) - Math.max(r.x, 0)) / r.w,
    y: (Math.min(r.y + r.h, c.height) - Math.max(r.y, 0)) / r.h,
  });

  for (const [x, y] of [[-5, -5], [5, 5], [-5, 0.5], [0.5, 9], [1.2, -0.3]]) {
    it(`never loses the recording off the canvas (centre ${x}, ${y})`, () => {
      for (const scale of [0.2, 1, 3]) {
        const r = placeContent(base, { x, y, scale }, canvas);
        const v = visibleFraction(r, canvas);
        // At least 10% of each side stays on the canvas (or the whole canvas, when 10% is bigger).
        expect(v.x).toBeGreaterThanOrEqual(Math.min(MIN_VISIBLE, canvas.width / r.w) - 1e-9);
        expect(v.y).toBeGreaterThanOrEqual(Math.min(MIN_VISIBLE, canvas.height / r.h) - 1e-9);
        expect(r.w).toBeCloseTo(base.w * scale, 6); // moved, never squashed
      }
    });
  }

  it('keepOnCanvas leaves a rect that is on the canvas alone', () => {
    const r = { x: 10, y: 20, w: 300, h: 200 };
    expect(keepOnCanvas(r, canvas)).toEqual(r);
  });

  it('transformFor inverts placeContent', () => {
    const t = { x: 0.31, y: 0.62, scale: 0.7 };
    const placed = placeContent(base, t, canvas);
    const back = transformFor(base, placed, canvas);
    expect(back.x).toBeCloseTo(t.x, 9);
    expect(back.y).toBeCloseTo(t.y, 9);
    expect(back.scale).toBeCloseTo(t.scale, 9);
  });

  it('mapRect carries an inner rect (the screen in its frame) along', () => {
    const body = { x: 100, y: 100, w: 400, h: 800 };
    const screen = { x: 120, y: 130, w: 360, h: 740 };
    const placed = { x: 600, y: 50, w: 200, h: 400 };
    close(mapRect(screen, body, placed), { x: 610, y: 65, w: 180, h: 370 });
    close(mapRect(screen, body, body), screen);
  });
});

describe('older projects are unchanged', () => {
  const projects: [string, Project][] = [
    ['16:9 display', macProject({ width: 1920, height: 1080 })],
    ['ultrawide on a square preset', macProject({ width: 3440, height: 1440 }, 'square')],
    ['portrait window on 9:16', macProject({ width: 900, height: 1600 }, 'social-9x16')],
  ];
  for (const [name, p] of projects) {
    it(`${name}: no transform → the same rect as before`, () => {
      const canvas = projectCanvasSize(p);
      const pad = Math.min(canvas.width, canvas.height) * p.style.paddingFraction;
      const before = fitAspect(
        { x: pad, y: pad, w: canvas.width - pad * 2, h: canvas.height - pad * 2 },
        p.recording.sourceSize.width / p.recording.sourceSize.height,
      );
      expect(p.style.contentTransform).toBeUndefined();
      expect(macContentRect(p, canvas)).toEqual(before);
      expect(macFittedRect(p, canvas)).toEqual(before);
      // Loading an old project.json adds nothing.
      expect(normalizeProject(JSON.parse(JSON.stringify(p))).style.contentTransform).toBeUndefined();
    });
  }

  it('macContentRect applies the transform; reset clears it', () => {
    const p = macProject({ width: 1920, height: 1080 });
    const canvas = projectCanvasSize(p);
    p.style.contentTransform = { x: 0.3, y: 0.4, scale: 0.5 };
    const base = macFittedRect(p, canvas);
    const r = macContentRect(p, canvas);
    expect(r.w).toBeCloseTo(base.w / 2, 9);
    expect(centre(r).x).toBeCloseTo(0.3 * canvas.width, 9);
    expect(resetProject(p).style.contentTransform).toBeUndefined();
  });
});

describe('aspect-locked corner resize', () => {
  const opposite: Record<Corner, Corner> = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' };
  const out: Record<Corner, { x: number; y: number }> = { nw: { x: -1, y: -1 }, ne: { x: 1, y: -1 }, sw: { x: -1, y: 1 }, se: { x: 1, y: 1 } };
  // Landscape (a Mac screen), portrait (a phone in its frame), square.
  const contents: [string, number][] = [['16:9 content', 16 / 9], ['portrait phone content', 0.49], ['1:1 content', 1]];

  for (const [cname, canvas] of Object.entries(CANVASES)) {
    for (const [kind, aspect] of contents) {
      const base = fitAspect({ x: 80, y: 80, w: canvas.width - 160, h: canvas.height - 160 }, aspect);
      const opts = { minW: base.w * MIN_CONTENT_SCALE, maxW: base.w * MAX_CONTENT_SCALE };
      for (const c of ['nw', 'ne', 'sw', 'se'] as Corner[]) {
        it(`${cname} canvas, ${kind}: ${c} corner, opposite corner fixed`, () => {
          const grab = cornerPoint(base, c);
          // Drag outward 120 px on x and 40 on y: x asks for more, so it wins.
          const r = resizeFromCorner(base, c, { x: grab.x + out[c].x * 120, y: grab.y + out[c].y * 40 }, opts);
          expect(r.w / r.h).toBeCloseTo(aspect, 9);
          const fixed = cornerPoint(base, opposite[c]);
          const after = cornerPoint(r, opposite[c]);
          expect(after.x).toBeCloseTo(fixed.x, 9);
          expect(after.y).toBeCloseTo(fixed.y, 9);
          expect(r.w).toBeCloseTo(Math.max(base.w + 120, (base.h + 40) * aspect), 9);
          // The dragged corner is where the pointer asked (on its stronger axis).
          // Dragging inward shrinks it.
          const small = resizeFromCorner(base, c, { x: grab.x - out[c].x * base.w * 0.5, y: grab.y - out[c].y * base.h * 0.5 }, opts);
          expect(small.w).toBeCloseTo(base.w * 0.5, 6);
          expect(small.w / small.h).toBeCloseTo(aspect, 9);
        });
        it(`${cname} canvas, ${kind}: ${c} corner with Option resizes about the centre`, () => {
          const grab = cornerPoint(base, c);
          const r = resizeFromCorner(base, c, { x: grab.x + out[c].x * 50, y: grab.y + out[c].y * 10 }, { ...opts, fromCentre: true });
          expect(centre(r).x).toBeCloseTo(centre(base).x, 9);
          expect(centre(r).y).toBeCloseTo(centre(base).y, 9);
          expect(r.w / r.h).toBeCloseTo(aspect, 9);
          expect(r.w).toBeCloseTo(Math.max(base.w + 100, (base.h + 20) * aspect), 9);
        });
      }
    }
  }

  it('a pointer dragged past the anchor bottoms out at the minimum, never flips', () => {
    const base = { x: 100, y: 100, w: 400, h: 225 };
    const r = resizeFromCorner(base, 'se', { x: 0, y: 0 }, { minW: 40, maxW: 1600 });
    expect(r.w).toBe(40);
    expect(r.x).toBe(100);
    expect(r.y).toBe(100);
  });

  it('caps at the maximum', () => {
    const base = { x: 100, y: 100, w: 400, h: 225 };
    expect(resizeFromCorner(base, 'se', { x: 99999, y: 0 }, { minW: 40, maxW: 1600 }).w).toBe(1600);
  });

  it('snaps to 100% within the threshold, and not outside it', () => {
    const base = { x: 100, y: 100, w: 400, h: 225 };
    const start = { x: 100, y: 100, w: 300, h: 168.75 }; // at 75%
    const snapW = { at: base.w, threshold: 8 };
    const near = resizeFromCorner(start, 'se', { x: 100 + 395, y: 0 }, { minW: 40, maxW: 1600, snapW });
    expect(near.w).toBe(400);
    expect(near.h).toBeCloseTo(225, 9);
    const far = resizeFromCorner(start, 'se', { x: 100 + 380, y: 0 }, { minW: 40, maxW: 1600, snapW });
    expect(far.w).toBe(380);
  });

  it('cornerAt finds the nearest handle within its radius', () => {
    const r = { x: 100, y: 100, w: 400, h: 200 };
    expect(cornerAt(r, { x: 104, y: 97 }, 10)).toBe('nw');
    expect(cornerAt(r, { x: 495, y: 305 }, 10)).toBe('se');
    expect(cornerAt(r, { x: 500, y: 100 }, 10)).toBe('ne');
    expect(cornerAt(r, { x: 100, y: 300 }, 10)).toBe('sw');
    expect(cornerAt(r, { x: 300, y: 200 }, 10)).toBeNull();
    expect(cornerAt(r, { x: 115, y: 100 }, 10)).toBeNull();
  });
});

describe('the content op', () => {
  const p = macProject({ width: 1920, height: 1080 });

  it('is listed', () => expect(OP_NAMES).toContain('content'));

  it('sets, merges and resets', () => {
    const a = applyOp(p, { op: 'content', scale: 0.6 }).project;
    expect(a.style.contentTransform).toEqual({ scale: 0.6 });
    const b = applyOp(a, { op: 'content', x: 0.3, y: 0.7 }).project;
    expect(b.style.contentTransform).toEqual({ scale: 0.6, x: 0.3, y: 0.7 });
    expect(validateProject(b)).toEqual([]);
    const c = applyOp(b, { op: 'content', reset: true }).project;
    expect(c.style.contentTransform).toBeUndefined();
    expect('contentTransform' in c.style).toBe(false);
  });

  it('refuses bad values', () => {
    expect(() => applyOp(p, { op: 'content' })).toThrow(/pass x, y, scale/);
    expect(() => applyOp(p, { op: 'content', scale: 0 })).toThrow(/scale/);
    expect(() => applyOp(p, { op: 'content', scale: 9 })).toThrow(/scale/);
    expect(() => applyOp(p, { op: 'content', x: 'left' })).toThrow(/x/);
  });

  it('validate catches a broken transform set by hand', () => {
    expect(validateProject({ ...p, style: { ...p.style, contentTransform: { scale: 0 } } }).join()).toMatch(/contentTransform/);
    expect(validateProject({ ...p, style: { ...p.style, contentTransform: { scale: 1, x: Number.NaN } } }).join()).toMatch(/contentTransform/);
  });
});
