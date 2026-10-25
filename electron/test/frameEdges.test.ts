// The flat device frame's edges (shared/frameEdges.ts, owner decision 14):
// the 4K-downscale check leaves a 1.5 px band along the outer body edge and
// the screen-hole edge out of its picture gate and checks the body and
// screen rects instead, so those must be exactly what the compositor drew.
// Every golden fixture is drawn through the harness: frameEdges reports a
// frame exactly when drawDeviceFrame ran, at the transform it drew with, and
// its two outlines start where drawDeviceFrame's body and hole paths start.
import { describe, expect, it } from 'vitest';
import { createHarness, goldenFixtureNames, loadGoldenFixture } from './helpers/compositorHarness';
import { drawsFlatFrame, frameEdges, scaleFrameEdges, SCREEN_HOLE_INSET_PX } from '../src/shared/frameEdges';
import { deviceBodyRect, frameGeometry } from '../src/shared/deviceGeometry';
import { projectCanvasSize, resolveDevice } from '../src/shared/mobileProject';
import { continuousRectCommands, type Pt2 } from '../src/shared/phone3d/outline';
import { phoneProject, with3d } from './helpers/phone3dFixtures';

/** The first point (moveTo) of the continuous rect path drawDeviceFrame draws at x, y, w, h, r. */
const startOf = (x: number, y: number, w: number, h: number, r: number): Pt2 => {
  const c = continuousRectCommands(x, y, w, h, r)![0];
  if (c.op !== 'M') throw new Error('path does not start with M');
  return c.p;
};

const bbox = (pts: Pt2[]) => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

const expectRectClose = (a: { x: number; y: number; w: number; h: number }, b: typeof a, digits = 6) => {
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(a[k]).toBeCloseTo(b[k], digits);
};

describe('frameEdges against what the compositor drew (every golden fixture)', () => {
  // The fixtures with a flat frame on the canvas: framed social / web presets and the classic padded frame (portrait and landscape).
  const FRAMED = ['ios-16x9', 'ios-landscape', 'ios-social'];
  const PHONE_LAYER = 'mac-iphone';

  it('covers framed and frameless fixtures', () => {
    expect(goldenFixtureNames()).toEqual(expect.arrayContaining([...FRAMED, 'ios-appstore', 'display']));
  });

  for (const name of goldenFixtureNames()) {
    it(`${name}: a frame exactly when drawDeviceFrame ran, at its transform, with its body and hole outlines`, async () => {
      const { project } = loadGoldenFixture(name);
      const h = await createHarness();
      try {
        const comp = h.compositor(project, projectCanvasSize(project));
        const rec = project.recording;
        const from = h.log.length;
        h.render(comp, 1, { frame: h.video('screen', rec.sourceSize.width, rec.sourceSize.height), cursor: null, ripples: [] });
        const log = h.log.slice(from);
        const f = h.format;
        const edges = frameEdges(project, { contentRect: comp.contentRect, screen: comp.screenMap?.screen ?? null, drew3d: comp.drew3d });
        // drawDeviceFrame fills its bezel with this glass colour. mac-iphone draws one too, for the phone
        // layer beside the Mac screen, which is not the recording's frame (see shared/frameEdges.ts).
        const glass = log.includes('canvas#0.fillStyle = "#060607"');
        expect(glass).toBe(FRAMED.includes(name) || name === PHONE_LAYER);
        expect(edges !== null).toBe(FRAMED.includes(name));
        if (!edges) return;
        const { device, orientation } = resolveDevice(project);
        const g = frameGeometry(comp.contentRect!, device, { orientation });
        // The transform drawDeviceFrame drew in, then the body path and the hole path where they start.
        const at = log.indexOf(`canvas#0.translate(${f(g.cx)},${f(g.cy)})`);
        expect(at).toBeGreaterThan(-1);
        if (g.rotation) expect(log.slice(at, at + 3)).toContain(`canvas#0.rotate(${f(g.rotation)})`);
        const body = startOf(-g.bodyW / 2, -g.bodyH / 2, g.bodyW, g.bodyH, g.bodyRadius);
        const i = SCREEN_HOLE_INSET_PX;
        const hole = startOf(-g.screenW / 2 + i, -g.screenH / 2 + i, g.screenW - 2 * i, g.screenH - 2 * i, Math.max(0, g.screenRadius - i));
        expect(log).toContain(`canvas#0.moveTo(${f(body[0])},${f(body[1])})`);
        expect(log).toContain(`canvas#0.moveTo(${f(hole[0])},${f(hole[1])})`);
        // The outlines start at those points, carried to the canvas by the same transform.
        const place = ([x, y]: Pt2): Pt2 => [g.cx + x * Math.cos(g.rotation) - y * Math.sin(g.rotation), g.cy + x * Math.sin(g.rotation) + y * Math.cos(g.rotation)];
        edges.edges.forEach((e, k) => {
          const want = place(k === 0 ? body : hole);
          expect(e[0][0]).toBeCloseTo(want[0], 9);
          expect(e[0][1]).toBeCloseTo(want[1], 9);
        });
        // The body outline spans the drawn body rect; the hole outline the screen less the inset (rotation included).
        expect(edges.body).toEqual(deviceBodyRect(comp.contentRect!, device, { orientation }));
        expectRectClose(bbox(edges.edges[0]), edges.body);
        expect(edges.screen).toEqual(comp.screenMap!.screen);
        expectRectClose(bbox(edges.edges[1]), { x: edges.screen.x + i, y: edges.screen.y + i, w: edges.screen.w - 2 * i, h: edges.screen.h - 2 * i });
        if (name === 'ios-landscape') expect(edges.body.w).toBeGreaterThan(edges.body.h);
      } finally {
        h.dispose();
      }
    });
  }
});

describe('drawsFlatFrame', () => {
  it('a phone recording with the frame on, without a preset or with a framed one, unless the phone drew in 3D', () => {
    const framed = phoneProject({ presetId: 'social-9x16' });
    framed.device.frame = true;
    expect(drawsFlatFrame(framed, false)).toBe(true);
    expect(drawsFlatFrame(framed, true)).toBe(false);
    // A 3D project whose engine has not drawn (drew3d false) still drew the flat frame.
    expect(drawsFlatFrame(with3d(framed), false)).toBe(true);
    const classic = phoneProject({ presetId: 'none' });
    classic.device.frame = true;
    expect(drawsFlatFrame(classic, false)).toBe(true);
    const off = phoneProject({ presetId: 'social-9x16' });
    off.device.frame = false;
    expect(drawsFlatFrame(off, false)).toBe(false);
    const appStore = phoneProject({ presetId: 'appstore' });
    appStore.device.frame = true;
    expect(drawsFlatFrame(appStore, false)).toBe(false);
    expect(drawsFlatFrame(loadGoldenFixture('display').project, false)).toBe(false);
  });

  it('frameEdges is null without a content box or a screen', () => {
    const p = phoneProject({ presetId: 'social-9x16' });
    p.device.frame = true;
    const r = { x: 0, y: 0, w: 100, h: 200 };
    expect(frameEdges(p, { contentRect: null, screen: r, drew3d: false })).toBeNull();
    expect(frameEdges(p, { contentRect: r, screen: null, drew3d: false })).toBeNull();
    expect(frameEdges(p, { contentRect: r, screen: r, drew3d: false })).not.toBeNull();
  });
});

describe('scaleFrameEdges', () => {
  it('scales the rects and every outline point', () => {
    const f = { body: { x: 1, y: 2, w: 3, h: 4 }, screen: { x: 5, y: 6, w: 7, h: 8 }, edges: [[[1, 2], [3, 4]] as Pt2[]] };
    expect(scaleFrameEdges(f, 0.5)).toEqual({ body: { x: 0.5, y: 1, w: 1.5, h: 2 }, screen: { x: 2.5, y: 3, w: 3.5, h: 4 }, edges: [[[0.5, 1], [1.5, 2]]] });
    expect(f.body.x).toBe(1);
  });
});
