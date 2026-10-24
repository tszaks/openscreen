// Headless runs: `OpenScreen --export <bundle> --out <file> [--gif]
// [--preset id,id] [--timeout s]` renders an export, and
// `OpenScreen --export <bundle> --frames <t,t,…> --out <folder> [--scale s]
// [--sheet] [--draft] [--timeout s]` renders still PNGs at output times (the
// agent CLI's `frames`). Pure argv parsing and path rules, so they are
// unit-tested; main owns the window and the process exit.

import type { TextBox } from './textBoxes';

export interface HeadlessJob {
  bundleDir: string;
  /** A .mp4/.gif file, or a folder when `presets` or `frames` is set. */
  out: string;
  gif: boolean;
  /** Multi-format export (exportPresets ids) into the `out` folder. */
  presets?: string[];
  /** Frames mode: render a PNG at each of these OUTPUT seconds into the `out` folder. */
  frames?: number[];
  /** Frames mode: scale of each PNG against the canvas, 0 < scale ≤ 1 (default 1). */
  scale?: number;
  /** Frames mode: also write sheet.png, a labelled grid of every frame. */
  sheet?: boolean;
  /** Frames mode: preview quality (one 3D sample, no supersampling). */
  draft?: boolean;
  /** Give up (and exit 1) after this many seconds. */
  timeoutSec: number;
}

/** One rendered still in frames mode. */
export interface HeadlessFrame {
  /** The output seconds asked for. */
  t: number;
  /** The export frame drawn (snapToExportFrame): index and its output time (frame / fps). */
  frame?: number;
  at?: number;
  /** The PNG, when it was written. */
  path?: string;
  /** Why there is no PNG (e.g. "past the end"). */
  error?: string;
  /** The text boxes drawn in this still (captions, keycaps, text overlays, title), PNG px, in drawing order. */
  textBoxes?: TextBox[];
}

export interface HeadlessResult {
  ok: boolean;
  out?: string;
  files?: string[];
  frames?: number;
  /** Output video length in seconds. */
  seconds?: number;
  error?: string;
  /** Frames mode: each requested time, in order. */
  stills?: HeadlessFrame[];
  /** Frames mode: the PNG size (the canvas × scale). */
  size?: { w: number; h: number };
  /** Frames mode with --sheet: the contact sheet. */
  sheet?: string;
  /** The GPU the renderer drew 3D frames on (WEBGL_debug_renderer_info), when known. */
  gpu?: string | null;
}

export const DEFAULT_HEADLESS_TIMEOUT_SEC = 1800;
/** The most stills one frames run renders. */
export const MAX_FRAMES = 200;

/** Value of `--name value` or `--name=value`, else undefined. */
function flag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) return argv[i + 1];
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}
const has = (argv: string[], name: string) => argv.some((a) => a === name || a.startsWith(`${name}=`));

/**
 * The headless job in `argv`, null when this is a normal GUI launch, or an
 * error string when `--export` was given but the job is malformed.
 */
export function parseHeadlessArgs(argv: string[]): HeadlessJob | { error: string } | null {
  if (!argv.some((a) => a === '--export' || a.startsWith('--export='))) return null;
  const bundleDir = flag(argv, '--export');
  if (!bundleDir || bundleDir.startsWith('--')) return { error: '--export needs a bundle directory' };
  const out = flag(argv, '--out');
  if (!out || out.startsWith('--')) return { error: '--out needs an output path' };
  const t = Number(flag(argv, '--timeout') ?? DEFAULT_HEADLESS_TIMEOUT_SEC);
  if (!(t > 0)) return { error: '--timeout must be a positive number of seconds' };
  const presetRaw = flag(argv, '--preset');
  const presets = presetRaw ? presetRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

  if (has(argv, '--frames')) {
    const raw = flag(argv, '--frames');
    if (!raw || raw.startsWith('--')) return { error: '--frames needs a comma-separated list of output seconds' };
    const frames = raw.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
    if (!frames.length || frames.some((x) => !Number.isFinite(x) || x < 0)) return { error: `--frames must be output seconds ≥ 0, got "${raw}"` };
    if (frames.length > MAX_FRAMES) return { error: `--frames takes at most ${MAX_FRAMES} times (got ${frames.length})` };
    if (argv.includes('--gif')) return { error: '--frames writes PNGs; it cannot be combined with --gif' };
    if (presets?.length) return { error: '--frames writes PNGs; it cannot be combined with --preset' };
    const scaleRaw = flag(argv, '--scale');
    const scale = scaleRaw === undefined ? 1 : Number(scaleRaw);
    if (!(scale > 0 && scale <= 1)) return { error: '--scale must be a number in (0, 1]' };
    return {
      bundleDir,
      out,
      gif: false,
      frames,
      scale,
      sheet: argv.includes('--sheet'),
      draft: argv.includes('--draft'),
      timeoutSec: t,
    };
  }
  for (const f of ['--scale', '--sheet', '--draft']) if (has(argv, f)) return { error: `${f} needs --frames` };

  const gif = argv.includes('--gif') || /\.gif$/i.test(out);
  if (gif && presets?.length) return { error: '--gif and --preset cannot be combined' };
  if (!presets?.length && !/\.(mp4|gif)$/i.test(out)) return { error: '--out must end in .mp4 or .gif (or pass --preset with a folder)' };
  return { bundleDir, out, gif, ...(presets?.length ? { presets } : {}), timeoutSec: t };
}

/**
 * How many frames an export of `outputDuration` output seconds at `fps`
 * writes: frame i is drawn at output time i / fps for i = 0 … count − 1
 * (the Editor's renderFrames: `Math.floor(duration * fps)` frames).
 */
export const exportFrameCount = (outputDuration: number, fps: number) => Math.floor(outputDuration * fps);

/**
 * The export frame a still at output time `t` shows: index round(t · fps)
 * (the last frame for a time between it and the end) and its exact output
 * time `frame / fps`, the double renderFrames draws with. Null when `t` is at
 * or past the output end, or the export has no frames. A still drawn at `at`
 * is the export's frame, pixel for pixel; a time between frames would show a
 * picture no export contains (moving zooms and 3D moves).
 */
export function snapToExportFrame(t: number, fps: number, outputDuration: number): { frame: number; at: number } | null {
  const count = exportFrameCount(outputDuration, fps);
  if (!(fps > 0) || count < 1 || !(t >= 0) || !(t < outputDuration)) return null;
  const frame = Math.min(Math.round(t * fps), count - 1);
  return { frame, at: frame / fps };
}

/** The file name of the still at output time `t`: `f-0002.000.png` (sorts by time). */
export function frameFileName(t: number): string {
  return `f-${t.toFixed(3).padStart(8, '0')}.png`;
}

/**
 * Where a frames run may write `name`: `outDir/name`, or null when `name` is
 * not a plain PNG file name (letters, digits, `.`, `_`, `-`; not starting
 * with a dot), so it can never leave `outDir` (`../x.png`, `/etc/x.png`,
 * `a/x.png`, `.png`, `x.txt` are refused). main checks every
 * `headless:writePng` with this. Pure string rules: the renderer imports this
 * module too, so no node:path.
 */
export function framesOutputPath(outDir: string, name: unknown): string | null {
  if (typeof name !== 'string' || name.length > 128 || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.png$/.test(name)) return null;
  return `${outDir.replace(/\/+$/, '')}/${name}`;
}

/** Contact sheet geometry: tiles, gaps and where tile `i` goes. */
export interface SheetLayout {
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
  width: number;
  height: number;
  /** Top-left corner of tile `i` (left to right, top to bottom). */
  cell(i: number): { x: number; y: number };
}

const SHEET_GAP = 4;
/** Keep the sheet well inside the browser's canvas limits. */
const SHEET_MAX_SIDE = 16000;

/**
 * The frames run's sheet.png: 6 columns of 420 px tiles for a portrait
 * canvas, 4 of 240 px for a landscape or square one (the same grid `review`
 * uses), fewer columns when there are fewer frames, and smaller tiles when
 * that many rows would make the sheet taller than 16000 px.
 */
export function sheetLayout(count: number, frameW: number, frameH: number): SheetLayout {
  const portrait = frameH > frameW;
  const cols = Math.max(1, Math.min(count, portrait ? 6 : 4));
  const rows = Math.max(1, Math.ceil(count / cols));
  const fit = Math.floor((SHEET_MAX_SIDE - SHEET_GAP) / rows - SHEET_GAP);
  const tileH = Math.max(16, Math.min(portrait ? 420 : 240, fit));
  const tileW = Math.max(1, Math.round((tileH * frameW) / frameH));
  return {
    cols,
    rows,
    tileW,
    tileH,
    width: SHEET_GAP + cols * (tileW + SHEET_GAP),
    height: SHEET_GAP + rows * (tileH + SHEET_GAP),
    cell: (i) => ({ x: SHEET_GAP + (i % cols) * (tileW + SHEET_GAP), y: SHEET_GAP + Math.floor(i / cols) * (tileH + SHEET_GAP) }),
  };
}

/** A still's label on the sheet: its output time. */
export const sheetLabel = (t: number) => `${t.toFixed(2)} s`;
