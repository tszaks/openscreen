import { describe, expect, it } from 'vitest';
import { continuousRectPath, drawCutouts, drawDeviceFrame } from '../src/renderer/src/mobile/deviceFrame';
import { DEVICES } from '../src/shared/devices';
import { CONTINUOUS_CORNER, CORNER_EXTENT, continuousRectCommands, continuousRectPoints, pointInPolygon } from '../src/shared/phone3d/outline';
import { mockCanvas } from './helpers/mockCanvas';

// continuousRectPath exactly as it was before the corner table moved to
// shared/phone3d/outline.ts (main 3dea11b, deviceFrame.ts:178-228).
const OLD_CORNER: Array<['M' | 'L' | 'C', ...number[]]> = [
  ['L', 1.52866483, 0],
  ['C', 1.08849323, 0, 0.86840689, 0, 0.66993427, 0.065496],
  ['L', 0.63149399, 0.074911],
  ['C', 0.37282392, 0.16905899, 0.16905899, 0.37282392, 0.074911, 0.63149399],
  ['L', 0.065496, 0.66993427],
  ['C', 0, 0.86840689, 0, 1.08849323, 0, 1.52866483],
];
function oldContinuousRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2 / 1.52866483));
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  const corners: Array<[number, number, number, number, number, number]> = [
    [x + w, y, -1, 0, 0, 1],
    [x + w, y + h, 0, -1, -1, 0],
    [x, y + h, 1, 0, 0, -1],
    [x, y, 0, 1, 1, 0],
  ];
  const pt = (c: (typeof corners)[number], a: number, b: number): [number, number] => [c[0] + (c[2] * a + c[4] * b) * r, c[1] + (c[3] * a + c[5] * b) * r];
  const start = pt(corners[3], 0, 1.52866483);
  ctx.moveTo(start[0], start[1]);
  for (const c of corners) {
    for (const [op, ...n] of OLD_CORNER) {
      if (op === 'C') {
        const p1 = pt(c, n[0], n[1]);
        const p2 = pt(c, n[2], n[3]);
        const p3 = pt(c, n[4], n[5]);
        ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
      } else {
        const p = pt(c, n[0], n[1]);
        ctx.lineTo(p[0], p[1]);
      }
    }
  }
  ctx.closePath();
}

const RECTS: [number, number, number, number, number][] = [
  [0, 0, 100, 200, 20],
  [12.5, -3.25, 71.5, 149.6, 9.7],
  [5, 5, 40, 40, 100], // radius clamped
  [0, 0, 10, 30, 0], // plain rect
  [-50, 20, 300, 120, 60],
];

describe('the continuous-corner table (shared/phone3d/outline.ts)', () => {
  it('is the table deviceFrame drew with', () => {
    expect(CONTINUOUS_CORNER.map((c) => [...c])).toEqual(OLD_CORNER);
    expect(CORNER_EXTENT).toBe(1.52866483);
  });

  it('continuousRectPath issues exactly the same path commands as before the move', () => {
    for (const r of RECTS) {
      const a = mockCanvas();
      const b = mockCanvas();
      oldContinuousRectPath(a.ctx, ...r);
      continuousRectPath(b.ctx, ...r);
      expect(b.calls).toEqual(a.calls);
    }
  });

  it('continuousRectPoints lie on the same curve, run counter-clockwise with y up, and are inside/outside correctly', () => {
    const w = 71.5;
    const h = 149.6;
    const r = 9.7;
    const pts = continuousRectPoints(w, h, r, 24);
    // 4 corners × (3 lines + 3 spans × 8 samples), less the merged duplicates.
    expect(pts.length).toBeGreaterThan(4 * 24);
    // Every sampled point is on the outline: an end point or a bezier sample of the commands.
    const cmds = continuousRectCommands(-w / 2, -h / 2, w, h, r)!;
    const ends = cmds.flatMap((c) => (c.op === 'Z' ? [] : [c.p]));
    for (const e of ends) expect(pts.some((p) => Math.hypot(p[0] - e[0], p[1] - e[1]) < 1e-9)).toBe(true);
    // Signed area > 0 with y up = counter-clockwise.
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      area += x1 * y2 - x2 * y1;
    }
    expect(area).toBeGreaterThan(0);
    expect(Math.abs(area / 2)).toBeLessThan(w * h);
    expect(Math.abs(area / 2)).toBeGreaterThan(w * h - 4 * r * r);
    expect(pointInPolygon(pts, [0, 0])).toBe(true);
    expect(pointInPolygon(pts, [w / 2 - 0.2, h / 2 - 0.2])).toBe(false); // the cut corner
    expect(pointInPolygon(pts, [w / 2 - 0.2, 0])).toBe(true);
    expect(continuousRectPoints(10, 20, 0, 24)).toHaveLength(4);
  });
});

describe('drawCutouts', () => {
  it('draws exactly the front hardware drawDeviceFrame draws last, for every device', () => {
    for (const d of DEVICES) {
      const rect = { x: 10, y: 20, w: 300, h: 640 };
      const full = mockCanvas();
      drawDeviceFrame(full.ctx, rect, d, undefined, { orientation: 'portrait' });
      const cut = mockCanvas();
      drawCutouts(cut.ctx, rect, d, { orientation: 'portrait' });
      // drawCutouts = save, translate (+rotate), the hardware, restore: the hardware calls are the
      // tail of drawDeviceFrame's log before its final restore.
      const inner = cut.calls.slice(2, -1);
      if (!inner.length) continue;
      const tail = full.calls.slice(full.calls.length - 1 - inner.length, -1);
      // (JSON: the mock's gradient stubs are per-canvas objects.)
      expect(JSON.stringify(inner), d.id).toBe(JSON.stringify(tail));
      expect(cut.depth()).toBe(0);
    }
  });
});
