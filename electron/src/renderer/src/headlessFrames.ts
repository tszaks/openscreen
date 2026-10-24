// The renderer half of `frames` (the agent CLI's still PNGs, SPEC §4.2):
// for each output time, seek the recording, draw the frame through the
// export's compositor with the export's inputs, scale it, encode a PNG and
// hand it to main. No ffmpeg, no audio, no project writes. Optionally a
// labelled contact sheet of every frame.

import { frameFileName, sheetLabel, sheetLayout, snapToExportFrame, type HeadlessFrame, type HeadlessResult } from '../../shared/headless';
import { phone3dActive } from '../../shared/phone3d/placement';
import type { Project } from '../../shared/types';
import type { FrameInputs } from './compositor';

/**
 * How the 3D pass renders a frame (SPEC §3.8 `FrameInputs.render3d`):
 * export quality (`full`: 8 jittered samples, adaptive motion blur, the
 * project's supersampling) or one sample (`draft`); `strict` aborts on a
 * lost GPU instead of drawing a flat frame.
 */
export interface Render3dInputs {
  ss: 1 | 2 | 3;
  quality: 'full' | 'draft';
  motionBlur: { samples: number; shutter: number } | null;
  fps: number;
  strict: boolean;
}

/** The frame inputs plus the 3D quality (read by the compositor's 3D pass; flat frames ignore it). */
export type FrameInputs3d = FrameInputs & { render3d?: Render3dInputs };

/** Export-path 3D settings for `p`, or undefined when the phone draws flat. `draft` = one sample at 1×. */
export function render3dFor(p: Project, opts: { draft: boolean; fps: number; strict: boolean }): Render3dInputs | undefined {
  const p3 = p.phone3d;
  if (!p3 || !phone3dActive(p).active) return undefined;
  return {
    ss: opts.draft ? 1 : p3.supersample,
    quality: opts.draft ? 'draft' : 'full',
    motionBlur: !opts.draft && p3.motionBlur.on ? { samples: p3.motionBlur.samples, shutter: p3.motionBlur.shutter } : null,
    fps: opts.fps,
    strict: opts.strict,
  };
}

/** What a frames run draws with; the Editor supplies it from its own export plumbing. */
export interface FramesRun {
  /** Output seconds, ascending. Each is drawn at its export frame (snapToExportFrame). */
  times: number[];
  /** The export's frame rate and output length: the frame grid the stills snap to. */
  fps: number;
  outputDuration: number;
  /** PNG scale against the canvas, 0 < scale ≤ 1. */
  scale: number;
  sheet: boolean;
  /** Folder the PNGs go to (reported back as `out`). */
  outDir: string;
  /** Source time for an output time; null past the end. */
  sourceTime(outT: number): number | null;
  /** Put the recording (and camera / phone videos) on source time `srcT`. */
  seek(srcT: number): Promise<void>;
  /** The export's frame inputs at this moment (Editor.frameInputsAt). */
  inputsAt(outT: number, srcT: number): FrameInputs3d;
  /** Write a PNG into outDir; resolves its path. */
  writePng(name: string, bytes: ArrayBuffer): Promise<string>;
  progress?(done: number, total: number): void;
  /** Awaited before frame 0 (D9: the 3D engine loads first). */
  ready?(): Promise<void>;
  /** After each frame: a reason to stop (a lost GPU in strict mode), or null. */
  renderError?(): string | null;
  /** The GPU 3D frames render on, when known. */
  gpu?(): string | null;
}

/** The compositor surface a frames run needs. */
export interface FramesCompositor {
  readonly canvas: HTMLCanvasElement;
  readonly canvasSize: { width: number; height: number };
  render(t: number, input: FrameInputs): void;
}

const pngBytes = (canvas: HTMLCanvasElement) =>
  new Promise<ArrayBuffer>((resolve, reject) =>
    canvas.toBlob((b) => (b ? b.arrayBuffer().then(resolve, reject) : reject(new Error('the frame could not be encoded as PNG'))), 'image/png'),
  );

function canvas2d(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

/**
 * Render every time in `run.times` through `comp` and write
 * `f-<time>.png` (plus `sheet.png` with `run.sheet`). Each time is drawn at
 * its export frame (index round(t · fps), output time frame / fps), so a
 * still is exactly the export's frame; times on the same frame share one PNG.
 * A time past the end is reported as `{ t, error: "past the end" }`. Throws
 * on a failed encode, write or render error; main turns that into
 * `{ ok: false }`.
 */
export async function runFrames(comp: FramesCompositor, run: FramesRun): Promise<HeadlessResult> {
  await run.ready?.();
  const { width: W, height: H } = comp.canvasSize;
  const w = Math.max(1, Math.round(W * run.scale));
  const h = Math.max(1, Math.round(H * run.scale));
  const scaled = run.scale === 1 ? null : canvas2d(w, h);
  // Each requested time → its export frame, or null past the end.
  const snaps = run.times.map((t) => {
    const g = snapToExportFrame(t, run.fps, run.outputDuration);
    const srcT = g ? run.sourceTime(g.at) : null;
    return g && srcT !== null ? { ...g, srcT } : null;
  });
  const drawable = new Set(snaps.flatMap((g) => (g ? [g.frame] : []))).size;
  const layout = run.sheet && drawable ? sheetLayout(drawable, w, h) : null;
  const sheet = layout ? canvas2d(layout.width, layout.height) : null;
  if (sheet && layout) {
    sheet.ctx.fillStyle = '#202020';
    sheet.ctx.fillRect(0, 0, layout.width, layout.height);
  }
  const stills: HeadlessFrame[] = [];
  const written = new Map<number, string>();
  let tile = 0;
  for (let i = 0; i < run.times.length; i++) {
    const t = run.times[i];
    const g = snaps[i];
    if (!g) {
      stills.push({ t, error: 'past the end' });
      continue;
    }
    const { frame: index, at, srcT } = g;
    const done = written.get(index);
    if (done) {
      stills.push({ t, frame: index, at, path: done });
      run.progress?.(i + 1, run.times.length);
      continue;
    }
    await run.seek(srcT);
    // The export draws frame i at output time i / fps (Editor.renderFrames).
    comp.render(at, run.inputsAt(at, srcT));
    const failed = run.renderError?.();
    if (failed) throw new Error(failed);
    let frame = comp.canvas;
    if (scaled) {
      scaled.ctx.clearRect(0, 0, w, h);
      scaled.ctx.drawImage(comp.canvas, 0, 0, W, H, 0, 0, w, h);
      frame = scaled.canvas;
    }
    const path = await run.writePng(frameFileName(at), await pngBytes(frame));
    written.set(index, path);
    stills.push({ t, frame: index, at, path });
    if (sheet && layout) {
      const { x, y } = layout.cell(tile++);
      sheet.ctx.drawImage(frame, 0, 0, w, h, x, y, layout.tileW, layout.tileH);
      const size = Math.max(10, Math.round(layout.tileH / 14));
      sheet.ctx.font = `600 ${size}px -apple-system, system-ui, sans-serif`;
      sheet.ctx.textBaseline = 'top';
      const label = sheetLabel(at);
      const pad = Math.round(size * 0.3);
      const tw = sheet.ctx.measureText(label).width;
      sheet.ctx.fillStyle = 'rgba(0,0,0,0.65)';
      sheet.ctx.fillRect(x + 6, y + 6, tw + pad * 2, size + pad * 2);
      sheet.ctx.fillStyle = '#ffffff';
      sheet.ctx.fillText(label, x + 6 + pad, y + 6 + pad);
    }
    run.progress?.(i + 1, run.times.length);
  }
  const sheetPath = sheet ? await run.writePng('sheet.png', await pngBytes(sheet.canvas)) : undefined;
  return {
    ok: true,
    out: run.outDir,
    frames: written.size,
    stills,
    size: { w, h },
    ...(sheetPath ? { sheet: sheetPath } : {}),
    gpu: run.gpu?.() ?? null,
  };
}
