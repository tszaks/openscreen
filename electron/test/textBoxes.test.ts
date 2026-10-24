// The compositor's text boxes (CanvasCompositor.textBoxes, shared/textBoxes):
// every caption pill, keycap, text overlay and title card the last render
// drew, in drawing order, in canvas px. The 4K-downscale check (SPEC §4.2,
// owner decision 8) masks them out of its picture comparison and compares
// them as layout, so they must be exactly where the text was drawn: each box
// is checked against the draw calls in the harness log, and the boxes of a
// 2160-wide canvas must be the 1080 boxes times 2.
import { describe, expect, it } from 'vitest';
import { createHarness, loadGoldenFixture, type Harness } from './helpers/compositorHarness';
import { projectCanvasSize } from '../src/shared/mobileProject';
import { scaleTextBoxes, type TextBox } from '../src/shared/textBoxes';
import type { CanvasCompositor } from '../src/renderer/src/compositor';
import type { Project, Size } from '../src/shared/types';

/** Renders `project` at `t` on a canvas of `size`; the boxes, the render's log lines and the layer boxes. */
async function drawAt(project: Project, size: Size, t: number, keystrokes?: string[]) {
  const h: Harness = await createHarness();
  try {
    const comp: CanvasCompositor = h.compositor(project, size);
    const rec = project.recording;
    const screen = h.video('screen', rec.sourceSize.width, rec.sourceSize.height);
    const from = h.log.length;
    h.render(comp, t, { frame: screen, cursor: null, ripples: [], keystrokes });
    return { boxes: comp.textBoxes, log: h.log.slice(from), layers: comp.layers, format: h.format };
  } finally {
    h.dispose();
  }
}

/** The arcTo the rounded pill at `r` starts with (compositor roundedPath: moveTo(x + r, y), arcTo(x + w, y, x + w, y + h, …)). */
const pillArc = (rect: TextBox['rect'], f: (v: unknown) => string) => `.arcTo(${f(rect.x + rect.w)},${f(rect.y)},${f(rect.x + rect.w)},${f(rect.y + rect.h)},`;

describe('CanvasCompositor.textBoxes', () => {
  it('reports the caption pill and the title card, in drawing order, where they were drawn (ios-social)', async () => {
    const { project } = loadGoldenFixture('ios-social');
    const size = projectCanvasSize(project);
    const { boxes, log, layers, format } = await drawAt(project, size, 2.5);
    expect(boxes.map((b) => b.kind)).toEqual(['caption', 'title']);
    const [caption, title] = boxes;
    // The pill's path and its centred text use the same rect.
    expect(log.some((l) => l.includes(pillArc(caption.rect, format)))).toBe(true);
    expect(log.some((l) => l.startsWith(`canvas#0.fillText("Tap, swipe, hold, type",${format(caption.rect.x + caption.rect.w / 2)},`))).toBe(true);
    // The title card's box is the title layer's box the editor selects.
    expect(title.rect).toEqual(layers.find((l) => l.id === 'title')?.rect);
    // Outside the caption's time only the title is drawn.
    expect((await drawAt(project, size, 1)).boxes.map((b) => b.kind)).toEqual(['title']);
  });

  it('reports a text overlay at its layer box (ios-16x9)', async () => {
    const { project } = loadGoldenFixture('ios-16x9');
    const { boxes, layers } = await drawAt(project, projectCanvasSize(project), 1);
    expect(boxes.map((b) => b.kind)).toEqual(['annotation', 'title']);
    expect(boxes[0].rect).toEqual(layers.find((l) => l.id === 'text:ann-1')?.rect);
    // Past the overlay's end it is gone.
    expect((await drawAt(project, projectCanvasSize(project), 3.5)).boxes.map((b) => b.kind)).toEqual(['title']);
  });

  it('reports one box per keycap, each the pill it drew (display)', async () => {
    const { project } = loadGoldenFixture('display');
    const { boxes, log, format } = await drawAt(project, projectCanvasSize(project), 1, ['Meta', 'K', 'Space']);
    const caps = boxes.filter((b) => b.kind === 'keycap');
    expect(caps).toHaveLength(3);
    for (const c of caps) expect(log.some((l) => l.includes(pillArc(c.rect, format)))).toBe(true);
    // Left to right, a gap apart, all on one row.
    expect(caps[1].rect.x).toBeGreaterThan(caps[0].rect.x + caps[0].rect.w);
    expect(new Set(caps.map((c) => c.rect.y)).size).toBe(1);
  });

  it('is empty for a frame with no text, and is reset by every render', async () => {
    const { project } = loadGoldenFixture('ios-social');
    project.layout.titleCard = undefined;
    expect((await drawAt(project, projectCanvasSize(project), 1)).boxes).toEqual([]);
  });

  // The title card's lines are not compared here: the card picks its font
  // size with whole-pixel steps, so its lines at 4K are not exactly twice the
  // 1080 ones (requests.md R4). scripts/golden/downscale4k.mjs compares them
  // line by line in the real app (test/titleLineBoxes.test.ts checks those
  // line boxes against the drawing).
  it("lays its boxes out independently of resolution: at 4K every box, and the title card's area, is the 1080 one times 2", async () => {
    for (const name of ['ios-social', 'ios-16x9']) {
      const { project } = loadGoldenFixture(name);
      // Set as the CLI sets it (apply exportSettings): the layout preset, and so the canvas, follow exportPreset (D18).
      const hdP: Project = { ...project, exportPreset: 'p1080' };
      const uhdP: Project = { ...project, exportPreset: 'uhd4k' };
      const hd = projectCanvasSize(hdP);
      const uhd = projectCanvasSize(uhdP);
      const k = uhd.height / hd.height;
      expect([k, uhd.width / hd.width]).toEqual([2, 2]);
      for (const t of [1, 2.5]) {
        const a = (await drawAt(hdP, hd, t)).boxes;
        const b = scaleTextBoxes((await drawAt(uhdP, uhd, t)).boxes, 1 / k);
        expect(a.length).toBeGreaterThan(0);
        expect(b.map((x) => x.kind)).toEqual(a.map((x) => x.kind));
        b.forEach((x, i) => {
          for (const key of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(x.rect[key] - a[i].rect[key])).toBeLessThan(1e-6);
        });
      }
    }
  });
});

describe('scaleTextBoxes', () => {
  it('scales x and widths by kx, y and heights by ky (ky defaults to kx), keeping kinds and order', () => {
    const boxes: TextBox[] = [
      { kind: 'keycap', rect: { x: 10, y: 20, w: 30, h: 40 } },
      { kind: 'caption', rect: { x: 1, y: 2, w: 3, h: 4 } },
    ];
    expect(scaleTextBoxes(boxes, 0.5)).toEqual([
      { kind: 'keycap', rect: { x: 5, y: 10, w: 15, h: 20 } },
      { kind: 'caption', rect: { x: 0.5, y: 1, w: 1.5, h: 2 } },
    ]);
    expect(scaleTextBoxes(boxes, 2, 3)[0].rect).toEqual({ x: 20, y: 60, w: 60, h: 120 });
    // The input is not changed.
    expect(boxes[0].rect).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });
});
