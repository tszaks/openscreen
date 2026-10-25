// Headless frames (SPEC §4.2): the `--frames` argv, the PNG names and the
// write rule main enforces, the contact sheet grid, and the renderer loop
// (runFrames) driven with a fake compositor.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportFrameCount, frameFileName, framesOutputPath, MAX_FRAMES, parseHeadlessArgs, sheetLayout, snapToExportFrame } from '../src/shared/headless';
import { EXPORT_SOFTWARE_FROM, holdPreview, runFrames, type FramesCompositor, type FramesRun } from '../src/renderer/src/headlessFrames';
import type { TextBox } from '../src/shared/textBoxes';
import { frameEdges, scaleFrameEdges } from '../src/shared/frameEdges';
import { titleLineBoxes } from '../src/renderer/src/titleLineBoxes';
import type { Rect } from '../src/shared/deviceGeometry';
import { mockCanvas } from './helpers/mockCanvas';
import { phoneProject, with3d } from './helpers/phone3dFixtures';

describe('parseHeadlessArgs --frames', () => {
  const base = ['electron', '.', '--export', '/b'];

  it('parses a frames job: times, folder out, scale, sheet, draft, timeout', () => {
    expect(parseHeadlessArgs([...base, '--frames', '0.5,2,4.25', '--out', '/tmp/f', '--scale', '0.5', '--sheet', '--draft', '--timeout', '60'])).toEqual({
      bundleDir: '/b',
      out: '/tmp/f',
      gif: false,
      frames: [0.5, 2, 4.25],
      scale: 0.5,
      sheet: true,
      draft: true,
      timeoutSec: 60,
    });
    expect(parseHeadlessArgs([...base, '--frames=1', '--out=/tmp/f'])).toMatchObject({ frames: [1], scale: 1, sheet: false, draft: false });
  });

  it('takes any folder for --out (no .mp4 needed)', () => {
    expect(parseHeadlessArgs([...base, '--frames', '1', '--out', '/tmp/no-extension'])).toMatchObject({ out: '/tmp/no-extension' });
  });

  it('refuses --gif and --preset with --frames', () => {
    expect(parseHeadlessArgs([...base, '--frames', '1', '--out', '/tmp/f', '--gif'])).toEqual({ error: '--frames writes PNGs; it cannot be combined with --gif' });
    expect(parseHeadlessArgs([...base, '--frames', '1', '--out', '/tmp/f', '--preset', 'square'])).toEqual({ error: '--frames writes PNGs; it cannot be combined with --preset' });
  });

  it('refuses bad times, too many times, and a bad scale', () => {
    expect(parseHeadlessArgs([...base, '--frames', '--out', '/tmp/f'])).toHaveProperty('error');
    expect(parseHeadlessArgs([...base, '--frames', '1,x', '--out', '/tmp/f'])).toHaveProperty('error');
    expect(parseHeadlessArgs([...base, '--frames', '-1', '--out', '/tmp/f'])).toHaveProperty('error');
    const many = Array.from({ length: MAX_FRAMES + 1 }, (_, i) => i / 10).join(',');
    expect(parseHeadlessArgs([...base, '--frames', many, '--out', '/tmp/f'])).toEqual({ error: `--frames takes at most ${MAX_FRAMES} times (got ${MAX_FRAMES + 1})` });
    const max = Array.from({ length: MAX_FRAMES }, (_, i) => i / 10).join(',');
    expect(parseHeadlessArgs([...base, '--frames', max, '--out', '/tmp/f'])).toMatchObject({ frames: expect.any(Array) });
    for (const s of ['0', '1.5', '-0.5', 'abc']) {
      expect(parseHeadlessArgs([...base, '--frames', '1', '--out', '/tmp/f', '--scale', s])).toEqual({ error: '--scale must be a number in (0, 1]' });
    }
  });

  it('refuses frames-only flags without --frames, and keeps the export cases as they were', () => {
    expect(parseHeadlessArgs([...base, '--out', '/o.mp4', '--sheet'])).toEqual({ error: '--sheet needs --frames' });
    expect(parseHeadlessArgs([...base, '--out', '/o.mp4', '--scale', '0.5'])).toEqual({ error: '--scale needs --frames' });
    expect(parseHeadlessArgs([...base, '--out', '/o.mp4'])).toEqual({ bundleDir: '/b', out: '/o.mp4', gif: false, timeoutSec: 1800 });
    expect(parseHeadlessArgs([...base, '--out', '/dir'])).toEqual({ error: '--out must end in .mp4 or .gif (or pass --preset with a folder)' });
  });
});

describe('frame files', () => {
  it('names stills by output time so they sort in time order', () => {
    expect(frameFileName(2)).toBe('f-0002.000.png');
    expect(frameFileName(0.5)).toBe('f-0000.500.png');
    expect(frameFileName(125.25)).toBe('f-0125.250.png');
    const names = [10, 2, 0.25, 100].map(frameFileName);
    expect([...names].sort()).toEqual([0.25, 2, 10, 100].map(frameFileName));
  });

  it('writes only plain PNG names inside the out folder', () => {
    expect(framesOutputPath('/tmp/out/', 'f-0002.000.png')).toBe('/tmp/out/f-0002.000.png');
    expect(framesOutputPath('/tmp/out', 'sheet.png')).toBe('/tmp/out/sheet.png');
    for (const bad of ['../x.png', '/etc/x.png', 'a/x.png', 'a\\x.png', '..png', '.png', '.hidden.png', 'x.txt', 'x.png/..', 'x.PNG.exe', '', 'x\0.png', 'a'.repeat(200) + '.png', 42, null, undefined]) {
      expect(framesOutputPath('/tmp/out', bad), String(bad)).toBeNull();
    }
  });
});

describe('sheetLayout', () => {
  it('uses the review grid: 6 × 420 px portrait, 4 × 240 px landscape', () => {
    const p = sheetLayout(12, 1080, 1920);
    expect([p.cols, p.rows, p.tileH, p.tileW]).toEqual([6, 2, 420, 236]);
    expect(p.width).toBe(4 + 6 * (236 + 4));
    expect(p.height).toBe(4 + 2 * (420 + 4));
    const l = sheetLayout(9, 1920, 1080);
    expect([l.cols, l.rows, l.tileH, l.tileW]).toEqual([4, 3, 240, 427]);
  });

  it('places tiles left to right, top to bottom, inside the sheet', () => {
    const s = sheetLayout(7, 1080, 1920);
    expect(s.cell(0)).toEqual({ x: 4, y: 4 });
    expect(s.cell(1)).toEqual({ x: 4 + s.tileW + 4, y: 4 });
    expect(s.cell(6)).toEqual({ x: 4, y: 4 + s.tileH + 4 });
    for (let i = 0; i < 7; i++) {
      const c = s.cell(i);
      expect(c.x + s.tileW).toBeLessThanOrEqual(s.width);
      expect(c.y + s.tileH).toBeLessThanOrEqual(s.height);
    }
  });

  it('uses fewer columns for fewer frames and shrinks tiles to stay under 16000 px', () => {
    expect(sheetLayout(2, 1080, 1920).cols).toBe(2);
    // The most a frames run makes still fits at full tile size…
    const max = sheetLayout(MAX_FRAMES, 1080, 1920);
    expect([max.tileH, max.height <= 16000]).toEqual([420, true]);
    // …and a longer list shrinks its tiles instead of growing past the limit.
    const big = sheetLayout(400, 1080, 1920);
    expect(big.height).toBeLessThanOrEqual(16000);
    expect(big.tileH).toBeLessThan(420);
  });
});

// A fake 2D world for runFrames: canvases whose toBlob returns a PNG-like
// payload naming the canvas, so the test can see what was written.
const stubs: Array<() => void> = [];
afterEach(() => stubs.splice(0).forEach((f) => f()));

function stubDocument() {
  const g = globalThis as Record<string, unknown>;
  const had = 'document' in g;
  const prev = g.document;
  let n = 0;
  const made: { id: number; width: number; height: number; draws: unknown[][] }[] = [];
  g.document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(tag);
      const m = mockCanvas();
      const rec = { id: ++n, width: 0, height: 0, draws: [] as unknown[][] };
      made.push(rec);
      const ctx = m.ctx as unknown as Record<string, unknown>;
      const draw = ctx.drawImage as (...a: unknown[]) => void;
      ctx.drawImage = (...a: unknown[]) => {
        rec.draws.push(a);
        draw(...a);
      };
      ctx.measureText = (s: string) => ({ width: s.length * 10 });
      return {
        get width() {
          return rec.width;
        },
        set width(v: number) {
          rec.width = v;
        },
        get height() {
          return rec.height;
        },
        set height(v: number) {
          rec.height = v;
        },
        getContext: () => m.ctx,
        toBlob: (cb: (b: Blob) => void) => cb(new Blob([`canvas#${rec.id}`])),
      };
    },
  };
  stubs.push(() => (had ? (g.document = prev) : delete g.document));
  return made;
}

/** The text boxes the fake compositor reports after drawing output time `t`, canvas px. */
const boxesAt = (t: number): TextBox[] => [
  { kind: 'caption', rect: { x: 100 + t, y: 1500, w: 400, h: 80 } },
  { kind: 'title', rect: { x: 40, y: 60, w: 1000, h: 200 } },
];

function fakeComp(W = 1080, H = 1920, over: { contentRect?: Rect; screen?: Rect; drew3d?: boolean; boxes?: (t: number) => TextBox[] } = {}) {
  const renders: { t: number; input: unknown }[] = [];
  /** For each full-canvas readback (the export's getImageData), how many renders came before it. */
  const readbacks: number[] = [];
  const ctx = {
    getImageData: (x: number, y: number, w: number, h: number) => {
      expect([x, y, w, h]).toEqual([0, 0, W, H]);
      readbacks.push(renders.length);
    },
  };
  const comp: FramesCompositor = {
    contentRect: over.contentRect ?? null,
    screenMap: over.screen ? { screen: over.screen } : null,
    drew3d: over.drew3d ?? false,
    canvas: { toBlob: (cb: (b: Blob) => void) => cb(new Blob([`frame@${renders.at(-1)?.t}`])), getContext: () => ctx } as unknown as HTMLCanvasElement,
    canvasSize: { width: W, height: H },
    render: (t, input) => renders.push({ t, input }),
    get textBoxes() {
      const last = renders.at(-1);
      return last ? (over.boxes ?? boxesAt)(last.t) : [];
    },
  };
  return { comp, renders, readbacks };
}

function fakeRun(over: Partial<FramesRun> = {}) {
  const written: { name: string; text: string }[] = [];
  const seeks: number[] = [];
  const run: FramesRun = {
    project: phoneProject(),
    times: [0, 2, 9],
    fps: 30,
    outputDuration: 8,
    scale: 1,
    sheet: false,
    outDir: '/out',
    sourceTime: (t) => (t < 8 ? t + 1 : null),
    seek: async (s) => void seeks.push(s),
    inputsAt: (outT, srcT) => ({ frame: {} as CanvasImageSource, cursor: null, ripples: [], keystrokes: [`${outT}/${srcT}`] }),
    writePng: async (name, bytes) => {
      written.push({ name, text: new TextDecoder().decode(bytes) });
      return `/out/${name}`;
    },
    ...over,
  };
  return { run, written, seeks };
}

describe('snapToExportFrame (the export frame grid)', () => {
  it('is frame round(t·fps) at frame / fps, the double the export draws with', () => {
    expect(snapToExportFrame(4.25, 30, 8)).toEqual({ frame: 128, at: 128 / 30 });
    expect(snapToExportFrame(4.733, 30, 8)).toEqual({ frame: 142, at: 142 / 30 });
    expect(snapToExportFrame(4.7, 30, 8)).toEqual({ frame: 141, at: 141 / 30 });
    expect(snapToExportFrame(0, 60, 8)).toEqual({ frame: 0, at: 0 });
  });

  it('is idempotent on frame times, so the app re-snapping what the CLI sent changes nothing', () => {
    for (const fps of [24, 30, 60]) {
      for (let i = 0; i < exportFrameCount(8, fps); i++) {
        const g = snapToExportFrame(Number(String(i / fps)), fps, 8);
        expect(g, `${fps}:${i}`).toEqual({ frame: i, at: i / fps });
      }
    }
  });

  it('matches the export frame count: the last frame for a time just before the end; null at or past the end', () => {
    expect(exportFrameCount(8, 30)).toBe(240);
    expect(exportFrameCount(7.5, 30)).toBe(225);
    expect(snapToExportFrame(7.99, 30, 8)).toEqual({ frame: 239, at: 239 / 30 });
    expect(snapToExportFrame(8, 30, 8)).toBeNull();
    expect(snapToExportFrame(99, 30, 8)).toBeNull();
    expect(snapToExportFrame(0, 30, 0)).toBeNull();
    expect(snapToExportFrame(-1, 30, 8)).toBeNull();
  });
});

describe('runFrames', () => {
  it('seeks, renders and writes each time in order; past the end is reported, not drawn', async () => {
    const { comp, renders } = fakeComp();
    const { run, written, seeks } = fakeRun();
    const progress: number[] = [];
    const r = await runFrames(comp, { ...run, progress: (d) => progress.push(d) });
    expect(seeks).toEqual([1, 3]);
    expect(renders.map((x) => x.t)).toEqual([0, 2]);
    expect(renders.map((x) => (x.input as { keystrokes: string[] }).keystrokes[0])).toEqual(['0/1', '2/3']);
    expect(written).toEqual([
      { name: 'f-0000.000.png', text: 'frame@0' },
      { name: 'f-0002.000.png', text: 'frame@2' },
    ]);
    expect(r).toEqual({
      ok: true,
      out: '/out',
      frames: 2,
      stills: [
        { t: 0, frame: 0, at: 0, path: '/out/f-0000.000.png', textBoxes: boxesAt(0), deviceFrame: null },
        { t: 2, frame: 60, at: 2, path: '/out/f-0002.000.png', textBoxes: boxesAt(2), deviceFrame: null },
        { t: 9, error: 'past the end' },
      ],
      size: { w: 1080, h: 1920 },
      gpu: null,
    });
    expect(progress).toEqual([1, 2]);
  });

  it('draws each time at its export frame (round(t·fps) / fps), once per frame, so a still is never a picture between frames', async () => {
    const { comp, renders: all, readbacks } = fakeComp();
    // 4.25 and 4.26 s are both frame 128 at 30 fps (4.2667 s); 7.99 s is the last frame, 239.
    const { run, written, seeks } = fakeRun({ times: [4.25, 4.26, 7.99, 8] });
    const r = await runFrames(comp, run);
    // Frame 128 is past EXPORT_SOFTWARE_FROM, so the export's draw-and-readback cycles run first (next test).
    expect(readbacks.length).toBe(EXPORT_SOFTWARE_FROM);
    const renders = all.slice(EXPORT_SOFTWARE_FROM);
    expect(renders.map((x) => x.t)).toEqual([128 / 30, 239 / 30]);
    expect(renders.map((x) => (x.input as { keystrokes: string[] }).keystrokes[0])).toEqual([`${128 / 30}/${128 / 30 + 1}`, `${239 / 30}/${239 / 30 + 1}`]);
    expect(seeks).toEqual([128 / 30 + 1, 239 / 30 + 1]);
    expect(written.map((w) => w.name)).toEqual(['f-0004.267.png', 'f-0007.967.png']);
    expect(r.frames).toBe(2);
    expect(r.stills).toEqual([
      // A time on an already drawn frame reports that frame's PNG and text boxes.
      { t: 4.25, frame: 128, at: 128 / 30, path: '/out/f-0004.267.png', textBoxes: boxesAt(128 / 30), deviceFrame: null },
      { t: 4.26, frame: 128, at: 128 / 30, path: '/out/f-0004.267.png', textBoxes: boxesAt(128 / 30), deviceFrame: null },
      { t: 7.99, frame: 239, at: 239 / 30, path: '/out/f-0007.967.png', textBoxes: boxesAt(239 / 30), deviceFrame: null },
      { t: 8, error: 'past the end' },
    ]);
  });

  it('R2: before its first still at or past export frame 101 the canvas gets the export\'s draw-and-readback cycles, once', async () => {
    // Export frame 100 is the last the export draws on an accelerated canvas: no cycles for stills up to it.
    const early = fakeComp();
    await runFrames(early.comp, fakeRun({ times: [0, 1, 100 / 30] }).run);
    expect(early.readbacks).toEqual([]);
    expect(early.renders).toHaveLength(3);
    // Stills at 2 s (frame 60), 101/30 (frame 101) and 5 s (frame 150): frame 60 is drawn first on the fresh canvas,
    // then 101 cycles (each a draw, then a full readback), then frames 101 and 150; no more cycles after that.
    const late = fakeComp();
    const p3 = { ss: 2 as const, quality: 'full' as const, motionBlur: { samples: 12, shutter: 0.5 }, fps: 30, strict: true };
    const { run } = fakeRun({ times: [2, 101 / 30, 5], inputsAt: (outT, srcT) => ({ frame: {} as CanvasImageSource, cursor: null, ripples: [], keystrokes: [`${outT}/${srcT}`], render3d: p3 }) });
    await runFrames(late.comp, run);
    expect(late.readbacks).toEqual(Array.from({ length: EXPORT_SOFTWARE_FROM }, (_, k) => k + 2));
    expect(late.renders).toHaveLength(EXPORT_SOFTWARE_FROM + 3);
    expect(late.renders.map((x) => x.t)).toEqual([2, ...Array(EXPORT_SOFTWARE_FROM).fill(101 / 30), 101 / 30, 5]);
    // The cycles draw the 3D pass at draft quality (only the draw matters, not its quality); the stills at full.
    const r3 = (i: number) => (late.renders[i].input as { render3d: typeof p3 }).render3d;
    expect(r3(1)).toEqual({ ...p3, quality: 'draft', ss: 1, motionBlur: null });
    expect(r3(EXPORT_SOFTWARE_FROM + 1)).toEqual(p3);
    expect(r3(EXPORT_SOFTWARE_FROM + 2)).toEqual(p3);
  });

  it('awaits ready() before frame 0 and reports the GPU', async () => {
    const { comp, renders } = fakeComp();
    const order: string[] = [];
    const { run } = fakeRun({ times: [1], ready: async () => void order.push(`ready, ${renders.length} renders`), gpu: () => 'Apple M1' });
    const r = await runFrames(comp, run);
    expect(order).toEqual(['ready, 0 renders']);
    expect(r.gpu).toBe('Apple M1');
  });

  it('stops on a render error (a lost GPU in strict mode) without writing that frame', async () => {
    const { comp } = fakeComp();
    const { run, written } = fakeRun({ times: [0, 1], renderError: () => '3D renderer lost the GPU' });
    await expect(runFrames(comp, run)).rejects.toThrow('3D renderer lost the GPU');
    expect(written).toEqual([]);
  });

  it('after a render error, a GPU that comes back draws the same frame once more and the run goes on', async () => {
    const { comp, renders } = fakeComp();
    let lost = true;
    const recovers: number[] = [];
    const { run, written } = fakeRun({
      times: [0],
      renderError: () => (lost && renders.length === 1 ? '3D renderer lost the GPU' : null),
      recover: async () => {
        recovers.push(renders.length);
        lost = false;
        return true;
      },
    });
    const r = await runFrames(comp, run);
    expect(recovers).toEqual([1]);
    expect(renders.map((x) => x.t)).toEqual([0, 0]);
    expect(written.map((w) => w.name)).toEqual(['f-0000.000.png']);
    expect(r.frames).toBe(1);
  });

  it('a GPU that does not come back stops the run without writing that frame', async () => {
    const { comp, renders } = fakeComp();
    const { run, written } = fakeRun({ times: [0, 1], renderError: () => '3D renderer lost the GPU', recover: async () => false });
    await expect(runFrames(comp, run)).rejects.toThrow('3D renderer lost the GPU');
    expect(renders).toHaveLength(1);
    expect(written).toEqual([]);
  });

  it('scales each PNG and builds a labelled sheet of the drawn frames', async () => {
    const made = stubDocument();
    const { comp } = fakeComp(1080, 1920);
    const { run, written } = fakeRun({ times: [0, 2, 9], scale: 0.5, sheet: true });
    const r = await runFrames(comp, run);
    expect(r.size).toEqual({ w: 540, h: 960 });
    const [scaled, sheet] = made;
    expect([scaled.width, scaled.height]).toEqual([540, 960]);
    // Each frame is drawn from the full canvas into the scaled one.
    expect(scaled.draws.map((d) => d.slice(1))).toEqual([
      [0, 0, 1080, 1920, 0, 0, 540, 960],
      [0, 0, 1080, 1920, 0, 0, 540, 960],
    ]);
    // Two drawable frames → a 2-column sheet; the past-the-end time has no tile.
    const layout = sheetLayout(2, 540, 960);
    expect([sheet.width, sheet.height]).toEqual([layout.width, layout.height]);
    expect(sheet.draws.map((d) => d.slice(5))).toEqual([
      [layout.cell(0).x, layout.cell(0).y, layout.tileW, layout.tileH],
      [layout.cell(1).x, layout.cell(1).y, layout.tileW, layout.tileH],
    ]);
    expect(written.map((w) => w.name)).toEqual(['f-0000.000.png', 'f-0002.000.png', 'sheet.png']);
    expect(written.map((w) => w.text)).toEqual([`canvas#${scaled.id}`, `canvas#${scaled.id}`, `canvas#${sheet.id}`]);
    expect(r.sheet).toBe('/out/sheet.png');
    // Text boxes are reported in the scaled PNG's pixels.
    expect(r.stills?.[1].textBoxes).toEqual([
      { kind: 'caption', rect: { x: 51, y: 750, w: 200, h: 40 } },
      { kind: 'title', rect: { x: 20, y: 30, w: 500, h: 100 } },
    ]);
  });

  it('reports a title card as its drawn lines, measured on its own canvas, in PNG px', async () => {
    const made = stubDocument();
    const card = { titlePx: 120, subtitlePx: 55, titleLines: ['Tap anywhere'], subtitleLines: ['to start', 'again'], blockHeight: 400, align: 'center' as const, valign: 'bottom' as const };
    const rect = { x: 40, y: 1200, w: 1000, h: 500 };
    const { comp } = fakeComp(1080, 1920, { boxes: () => [{ kind: 'caption', rect: { x: 1, y: 2, w: 3, h: 4 } }, { kind: 'title', rect, card }] });
    const r = await runFrames(comp, fakeRun({ times: [0], scale: 0.5 }).run);
    // The mock canvas measures each character at half the font size it was given, so the font set before measuring shows.
    const lines = titleLineBoxes(rect, card, (font, _l, t) => t.length * Number(/(\d+(?:\.\d+)?)px/.exec(font)![1]) * 0.5);
    expect(lines.map((l) => l.text)).toEqual(['Tap anywhere', 'to start', 'again']);
    expect(r.stills?.[0].textBoxes).toEqual([
      { kind: 'caption', rect: { x: 0.5, y: 1, w: 1.5, h: 2 } },
      ...lines.map((l) => {
        const half = (r: Rect) => ({ x: r.x / 2, y: r.y / 2, w: r.w / 2, h: r.h / 2 });
        return { kind: 'title', text: l.text, rect: half(l.rect), drawn: half(l.drawn!) };
      }),
    ]);
    // One canvas for the scaled PNG, one 1 × 1 canvas to measure on (never the compositor's).
    expect(made.map((m) => [m.width, m.height])).toEqual([[540, 960], [1, 1]]);
  });

  it("reports the flat device frame's body, screen and edges from the compositor's boxes, in PNG px; none when the phone drew in 3D", async () => {
    stubDocument();
    const project = phoneProject();
    project.device.frame = true;
    const contentRect = { x: 200, y: 160, w: 680, h: 1400 };
    const screen = { x: 230, y: 190, w: 620, h: 1340 };
    const r = await runFrames(fakeComp(1080, 1920, { contentRect, screen }).comp, fakeRun({ project, times: [0], scale: 0.5 }).run);
    const want = frameEdges(project, { contentRect, screen, drew3d: false });
    expect(want).not.toBeNull();
    expect(r.stills?.[0].deviceFrame).toEqual(scaleFrameEdges(want!, 0.5));
    const r3d = await runFrames(fakeComp(1080, 1920, { contentRect, screen, drew3d: true }).comp, fakeRun({ project, times: [0] }).run);
    expect(r3d.stills?.[0].deviceFrame).toBeNull();
  });
});

describe('holdPreview (no preview redraw during a 3D export, frames or headless run; flat exactly as today: §5.5, owner decision 9)', () => {
  const threeD = () => {
    const p = with3d(phoneProject({ presetId: 'social-9x16' }));
    p.device.frame = true;
    return p;
  };

  it('holds a 3D preview while exporting or headless, and never when idle', () => {
    expect(holdPreview({ headless: false, exporting: true, project: threeD() })).toBe(true);
    expect(holdPreview({ headless: true, exporting: false, project: threeD() })).toBe(true);
    expect(holdPreview({ headless: false, exporting: false, project: threeD() })).toBe(false);
  });

  it('never holds a flat project: its export keeps main redraw sequence, byte for byte (D11)', () => {
    const flat = phoneProject({ presetId: 'social-9x16' });
    const off = threeD();
    off.phone3d!.enabled = false;
    const appStore = with3d(phoneProject({ presetId: 'appstore' }));
    for (const project of [flat, off, appStore]) {
      for (const [headless, exporting] of [[true, true], [true, false], [false, true]]) {
        expect(holdPreview({ headless, exporting, project })).toBe(false);
      }
    }
  });

  it("is the editor's only preview guard: renderAt and the 'seeked' redraw return early on previewHeld() and nothing else that a flat project could hit", () => {
    const src = readFileSync(join(__dirname, '../src/renderer/src/Editor.tsx'), 'utf8');
    expect(src).toMatch(/const previewHeld = \(\) => holdPreview\(\{ headless: !!headless, exporting: exportingRef\.current, project: projRef\.current \}\);/);
    // renderAt up to its first draw: the hold, then exactly main's early returns (no recording, no canvas, no context).
    const renderAt = src.slice(src.indexOf('const renderAt = useCallback('), src.indexOf('compositor.render(outT, frameInputsAt('));
    // WP5 adds one guard: a hover preview (a shot tile or an easing, set only while the pointer is over one and
    // cleared by any edit or by playback) owns the preview canvas. It reads neither the export nor the headless
    // flag, and the export renders on its own compositor, so export pixels are unchanged (flat identity checks it).
    expect(renderAt.match(/if \([^)]*\)[^;]*return;/g)).toEqual([
      'if (previewHeld()) return;',
      'if (previewing3d.current) return;',
      'if (!video || !canvas || video.readyState < 2) return;',
      'if (!ctx) return;',
    ]);
    expect(src).toMatch(/const onSeeked = \(\) => \{\s*if \(previewHeld\(\)\) return;\s*renderAt\(playheadRef\.current\);\s*\};/);
    // No other guard reads the export flag or the headless flag to skip a preview draw.
    expect(src.match(/if \([^)]*exportingRef\.current[^)]*\)\s*return/g)).toBeNull();
    expect(src.match(/previewHeld\(\)/g)).toHaveLength(2);
  });
});
