// Agent edit operations: every editing action the editor offers, as a JSON
// op applied to a Project. Pure (no fs, no ffmpeg): ops that need analysis
// (silences, taps, a transcript) receive it through `ApplyContext`, which the
// CLI fills in before calling. Clip edits go through `remapProject`, the same
// path the editor's editClips uses, so captions, overlays, chapters and
// manual zooms move with their footage.
//
// Time domains (same as the editor):
//  - SOURCE seconds (the recording): clips, cut/trim/speed ranges, taps, waits.
//  - OUTPUT seconds (the edited timeline): captions, chapters, annotations,
//    manual zooms, split points.

import type { FocusSegment } from './autofocus';
import { parseCaptions } from './captions';
import { suggestChapters } from './chapters';
import { isFillerWord, planSmartCuts, type TimeRange } from './editcuts';
import { PRESETS } from './exportPresets';
import { BACKDROPS } from './backdrops';
import { DEVICES } from './devices';
import { pendingWaits, speedUpRanges, waitCore, LAYOUT_CHOICES } from './mobileProject';
import { remapProject } from './remap';
import { addItem, fitToVideo, newAudioItem, segmentLength, trackProblems, withMusicTrack } from './audioTracks';
import { Timeline } from './timeline';
import type { TapSuggestion } from './taps';
import { MAX_CONTENT_SCALE, MIN_CONTENT_SCALE } from './contentTransform';
import type { Annotation, AudioItem, Background, CaptionCue, Chapter, Clip, ContentTransform, Project, TranscriptWord, WaitRange } from './types';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

/** Analysis results the CLI computes (ffmpeg/whisper) before applying ops. */
export interface ApplyContext {
  /** silencedetect ranges, source seconds (needed by cutSilences/smartCut). */
  silences?: TimeRange[];
  /** Fresh tap analysis (needed by analyzeTaps). */
  tapAnalysis?: { taps: TapSuggestion[]; deadTime: WaitRange[] };
  /** Transcript segments in SOURCE seconds (captionsFromTranscript). */
  transcript?: TranscriptSegment[];
  /** Contents of files referenced by importCaptions {file}. */
  files?: Record<string, string>;
  /** Sound files referenced by addAudio {file}: the copy the CLI makes in the
   *  bundle (bundle-relative), its display name and length in seconds. */
  audioFiles?: Record<string, { file: string; name: string; duration: number }>;
  /** Fixed id generator (tests). */
  newId?: () => string;
}

export type EditOp = { op: string } & Record<string, unknown>;

export class OpError extends Error {
  constructor(
    message: string,
    readonly index?: number,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Small argument readers with clear errors

const num = (o: EditOp, k: string, opt = false): number => {
  const v = o[k];
  if (v === undefined && opt) return NaN;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new OpError(`${o.op}: "${k}" must be a number`);
  return v;
};
const optNum = (o: EditOp, k: string): number | undefined => (o[k] === undefined ? undefined : num(o, k));
const str = (o: EditOp, k: string): string => {
  const v = o[k];
  if (typeof v !== 'string') throw new OpError(`${o.op}: "${k}" must be a string`);
  return v;
};
const optStr = (o: EditOp, k: string): string | undefined => (o[k] === undefined ? undefined : str(o, k));
const optBool = (o: EditOp, k: string): boolean | undefined => {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new OpError(`${o.op}: "${k}" must be true or false`);
  return v;
};
const ranges = (o: EditOp, k = 'ranges'): TimeRange[] => {
  const v = o[k];
  if (!Array.isArray(v)) throw new OpError(`${o.op}: "${k}" must be an array of {start,end}`);
  return v.map((r, i) => {
    if (!r || typeof r.start !== 'number' || typeof r.end !== 'number' || !(r.end > r.start)) {
      throw new OpError(`${o.op}: ${k}[${i}] needs numeric start < end`);
    }
    return { start: r.start, end: r.end };
  });
};
const pick = <T extends object>(o: EditOp, keys: (keyof T & string)[]): Partial<T> => {
  const out: Partial<T> = {};
  for (const k of keys) if (o[k] !== undefined) (out as Record<string, unknown>)[k] = o[k];
  return out;
};
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Find an item by `id` or by `index` (0-based) in a list. */
function locateItem<T extends { id?: string }>(o: EditOp, list: T[], what: string): number {
  if (typeof o.id === 'string') {
    const i = list.findIndex((x) => x.id === o.id);
    if (i < 0) throw new OpError(`${o.op}: no ${what} with id ${o.id}`);
    return i;
  }
  if (typeof o.index === 'number') {
    if (!Number.isInteger(o.index) || o.index < 0 || o.index >= list.length) {
      throw new OpError(`${o.op}: ${what} index ${o.index} out of range (0..${list.length - 1})`);
    }
    return o.index;
  }
  throw new OpError(`${o.op}: pass "id" or "index" to pick the ${what}`);
}

// ---------------------------------------------------------------------------
// Clip edits (the editor's editClips)

const tlOf = (p: Project) => new Timeline(p.recording.duration, p.clips.map((c) => ({ ...c })));

/** Replace the clip list; everything in output time moves with its footage. */
export function withClips(p: Project, clips: Clip[]): Project {
  if (!clips.length) throw new OpError('that edit would leave no footage');
  return remapProject(p, tlOf(p), new Timeline(p.recording.duration, clips));
}

/** Remove source ranges (Timeline.cutRanges). Returns the project and seconds removed. */
export function cutSource(p: Project, rs: TimeRange[]): { project: Project; removed: number } {
  const tl = tlOf(p);
  const removed = tl.cutRanges(rs);
  return { project: removed > 0 ? withClips(p, tl.clips) : p, removed };
}

/** Clips with the source range [start,end] at `speed` (split at the edges). */
export function setRangeSpeed(clips: Clip[], start: number, end: number, speed: number): Clip[] {
  const split = speedUpRanges(clips, [{ start, end }], Number.POSITIVE_INFINITY);
  return split.map((c) => {
    const inside = c.sourceStart >= start - EPS && c.sourceEnd <= end + EPS;
    if (!inside) return c.speed === Number.POSITIVE_INFINITY ? { ...c, speed: 1 } : c;
    return { ...c, speed };
  });
}

// ---------------------------------------------------------------------------
// Validation

const SPEED_MIN = 0.1;
const SPEED_MAX = 16;

/** Problems that would make the editor or the export misbehave. Empty = valid. */
export function validateProject(p: Project): string[] {
  const errs: string[] = [];
  const d = p.recording?.duration;
  if (!p.recording || typeof p.recording.screenVideoFile !== 'string') errs.push('recording.screenVideoFile missing');
  if (!(typeof d === 'number' && d > 0)) errs.push('recording.duration must be > 0');
  const ss = p.recording?.sourceSize;
  if (!ss || !(ss.width > 0) || !(ss.height > 0)) errs.push('recording.sourceSize must be positive');
  if (!Array.isArray(p.clips) || !p.clips.length) errs.push('clips must be a non-empty array');
  (p.clips ?? []).forEach((c, i) => {
    if (typeof c.id !== 'string') errs.push(`clips[${i}].id must be a string`);
    if (!(c.sourceEnd > c.sourceStart)) errs.push(`clips[${i}]: sourceEnd must be > sourceStart`);
    if (c.sourceStart < -EPS || (d && c.sourceEnd > d + 0.05)) errs.push(`clips[${i}] is outside the recording (0..${d})`);
    if (!(c.speed >= SPEED_MIN && c.speed <= SPEED_MAX)) errs.push(`clips[${i}].speed must be ${SPEED_MIN}..${SPEED_MAX}`);
  });
  const out = p.clips?.length ? new Timeline(d || 0, p.clips).outputDuration : 0;
  const timed = (list: { start: number; end: number }[] | undefined, name: string) =>
    (list ?? []).forEach((c, i) => {
      if (!(typeof c.start === 'number' && typeof c.end === 'number' && c.end > c.start)) errs.push(`${name}[${i}]: end must be > start`);
    });
  timed(p.captions, 'captions');
  timed(p.annotations, 'annotations');
  (p.captions ?? []).forEach((c, i) => typeof c.text !== 'string' && errs.push(`captions[${i}].text must be a string`));
  (p.annotations ?? []).forEach((a, i) => {
    if (![0, 1, 2].includes(a.band)) errs.push(`annotations[${i}].band must be 0, 1 or 2`);
    if (!/^#[0-9a-f]{6}$/i.test(a.hex)) errs.push(`annotations[${i}].hex must be #rrggbb`);
  });
  (p.chapters ?? []).forEach((c, i) => {
    if (!(c.start >= 0) || typeof c.title !== 'string') errs.push(`chapters[${i}] needs start >= 0 and a title`);
  });
  (p.manualZooms ?? []).forEach((z, i) => {
    if (!(z.inStart <= z.holdStart && z.holdStart <= z.holdEnd && z.holdEnd <= z.outEnd)) errs.push(`manualZooms[${i}]: needs inStart <= holdStart <= holdEnd <= outEnd`);
    if (!(z.scale >= 1 && z.scale <= 5)) errs.push(`manualZooms[${i}].scale must be 1..5`);
    if (!z.center || !(z.center.x >= 0 && z.center.x <= 1 && z.center.y >= 0 && z.center.y <= 1)) errs.push(`manualZooms[${i}].center must be normalized 0..1`);
  });
  (p.taps ?? []).forEach((t, i) => {
    if (typeof t.id !== 'string' || !(t.t >= 0) || !(t.x >= 0 && t.x <= 1 && t.y >= 0 && t.y <= 1)) errs.push(`taps[${i}] needs id, t >= 0, x/y in 0..1`);
    if (!['tap', 'swipe', 'longpress', 'typing'].includes(t.kind)) errs.push(`taps[${i}].kind must be tap|swipe|longpress|typing`);
  });
  const s = p.style;
  if (s) {
    if (!(s.paddingFraction >= 0 && s.paddingFraction <= 0.4)) errs.push('style.paddingFraction must be 0..0.4');
    if (!(s.cornerRadius >= 0 && s.cornerRadius <= 200)) errs.push('style.cornerRadius must be 0..200');
    if (!(s.shadowRadius >= 0 && s.shadowRadius <= 300)) errs.push('style.shadowRadius must be 0..300');
    if (!(s.shadowOpacity >= 0 && s.shadowOpacity <= 1)) errs.push('style.shadowOpacity must be 0..1');
    if (!(s.cursorSize > 0 && s.cursorSize <= 0.1)) errs.push('style.cursorSize must be 0..0.1 (fraction of frame height)');
    if (!/^#[0-9a-f]{6}$/i.test(s.cursorHex)) errs.push('style.cursorHex must be #rrggbb');
    if (s.cursorOpacity !== undefined && !(s.cursorOpacity >= 0 && s.cursorOpacity <= 1)) errs.push('style.cursorOpacity must be 0..1');
    if (!['none', 'phone'].includes(s.deviceFrame)) errs.push('style.deviceFrame must be none|phone');
    const b = s.background as Background | undefined;
    if (!b || !['solid', 'gradient', 'mesh', 'imageFile', 'wallpaper'].includes(b.kind)) errs.push('style.background.kind must be solid|gradient|mesh|imageFile|wallpaper');
    else if (b.kind === 'mesh' && !(/^#[0-9a-f]{6}$/i.test(b.baseHex) && Array.isArray(b.blobs) && b.blobs.every((o) => /^#[0-9a-f]{6}$/i.test(o.hex) && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.r) && o.r > 0) && (b.grain === undefined || Number.isFinite(b.grain)))) errs.push('style.background mesh needs baseHex #rrggbb, blobs [{x,y,r>0,hex}] with finite numbers, and a finite grain if set');
    if (s.contentTransform !== undefined) {
      const t = s.contentTransform;
      if (!t || typeof t !== 'object' || !(t.scale >= MIN_CONTENT_SCALE && t.scale <= MAX_CONTENT_SCALE)) errs.push(`style.contentTransform.scale must be ${MIN_CONTENT_SCALE}..${MAX_CONTENT_SCALE}`);
      else if ((t.x !== undefined && !Number.isFinite(t.x)) || (t.y !== undefined && !Number.isFinite(t.y))) errs.push('style.contentTransform x and y must be numbers (fractions of the canvas)');
    }
    if (s.cropRect) {
      const c = s.cropRect;
      if (!(c.x >= 0 && c.y >= 0 && c.w > 0 && c.h > 0 && c.x + c.w <= 1 + EPS && c.y + c.h <= 1 + EPS)) errs.push('style.cropRect must be normalized and inside the frame');
    }
  } else errs.push('style missing');
  if (p.exportPreset && !['original', 'p1080', 'uhd4k'].includes(p.exportPreset)) errs.push('exportPreset must be original|p1080|uhd4k');
  if (!(p.outputFPS >= 1 && p.outputFPS <= 120)) errs.push('outputFPS must be 1..120');
  if (p.layout && p.layout.presetId !== 'none' && p.layout.presetId !== 'appstore' && !PRESETS.some((x) => x.id === p.layout.presetId)) {
    errs.push(`layout.presetId "${p.layout.presetId}" is unknown`);
  }
  if (p.layout && !['style', 'blurred'].includes(p.layout.background)) errs.push('layout.background must be style|blurred');
  if (p.device?.modelId && !DEVICES.some((x) => x.id === p.device.modelId)) errs.push(`device.modelId "${p.device.modelId}" is unknown`);
  if (p.tapStyle) {
    if (!['ripple', 'pulse', 'ring'].includes(p.tapStyle.style)) errs.push('tapStyle.style must be ripple|pulse|ring');
    if (!['white', 'accent'].includes(p.tapStyle.color)) errs.push('tapStyle.color must be white|accent');
  }
  if (p.cameraOverlay && !['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].includes(p.cameraOverlay.corner)) errs.push('cameraOverlay.corner is invalid');
  if (p.phoneOverlay) {
    const ph = p.phoneOverlay;
    if (!['side-by-side-right', 'side-by-side-left', 'corner'].includes(ph.layout)) errs.push('phoneOverlay.layout must be side-by-side-right|side-by-side-left|corner');
    if (!['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].includes(ph.corner)) errs.push('phoneOverlay.corner must be topLeft|topRight|bottomLeft|bottomRight');
    if (!(ph.size >= 0.3 && ph.size <= 1)) errs.push('phoneOverlay.size must be 0.3..1');
    if (ph.modelId && !DEVICES.some((x) => x.id === ph.modelId)) errs.push(`phoneOverlay.modelId "${ph.modelId}" is unknown`);
    if (ph.enabled && !p.recording?.phoneVideoFile) errs.push('phoneOverlay is enabled but the recording has no phone video');
  }
  errs.push(...trackProblems(p.tracks ?? []));
  if (out <= 0) errs.push('the timeline has no footage');
  return errs;
}

// ---------------------------------------------------------------------------
// Generic `set` (JSON pointer)

/** RFC 6901 pointer → path segments. */
export function parsePointer(ptr: string): string[] {
  if (ptr === '' || ptr === '/') return [];
  if (!ptr.startsWith('/')) throw new OpError(`set: path must be a JSON pointer like /style/cornerRadius (got ${ptr})`);
  return ptr.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Set a value by pointer. The value's JSON type must match what is there (null/undefined targets accept anything). */
export function setPointer(p: Project, ptr: string, value: unknown): Project {
  const path = parsePointer(ptr);
  if (!path.length) throw new OpError('set: cannot replace the whole project');
  if (path[0] === 'recording') throw new OpError('set: /recording describes the source file and is read-only');
  const root = structuredClone(p) as unknown as Record<string, unknown>;
  let cur: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = (cur as Record<string, unknown>)[path[i]];
    if (next === null || typeof next !== 'object') throw new OpError(`set: ${'/' + path.slice(0, i + 1).join('/')} is not an object`);
    cur = next as Record<string, unknown>;
  }
  const key = path[path.length - 1];
  const existing = Array.isArray(cur) && key === '-' ? undefined : (cur as Record<string, unknown>)[key];
  if (existing !== undefined && existing !== null && value !== null && typeName(existing) !== typeName(value)) {
    throw new OpError(`set: ${ptr} is a ${typeName(existing)}, got a ${typeName(value)}`);
  }
  if (Array.isArray(cur)) {
    if (key === '-') cur.push(value);
    else {
      const i = Number(key);
      if (!Number.isInteger(i) || i < 0 || i > cur.length) throw new OpError(`set: bad array index ${key}`);
      cur[i] = value;
    }
  } else if (value === undefined) delete cur[key];
  else cur[key] = value;
  return root as unknown as Project;
}

// ---------------------------------------------------------------------------
// The ops

/** Agent swatch names → backgrounds (the editor's backdrop tiles). */
export const SWATCHES: Record<string, Background> = Object.fromEntries(BACKDROPS.map((b) => [b.id, b.bg]));

/** Default manual zoom shape (the editor's Option-click): 0.5s in, 0.9s hold, 0.7s out. */
export function manualZoom(at: number, center: { x: number; y: number }, scale = 2, hold = 0.9): FocusSegment {
  return { inStart: at, holdStart: at + 0.5, holdEnd: at + 0.5 + hold, outEnd: at + 0.5 + hold + 0.7, center: { x: clamp01(center.x), y: clamp01(center.y) }, scale };
}

/** Captions from transcript segments (source seconds), mapped onto the output timeline. */
export function captionsFromSegments(p: Project, segs: TranscriptSegment[], newId: () => string): CaptionCue[] {
  const tl = new Timeline(p.recording.duration, p.clips);
  const out: CaptionCue[] = [];
  for (const s of segs) {
    const start = tl.outputTime(s.start);
    const end = tl.outputTime(s.end);
    if (start === null || end === null || !(end > start)) continue;
    const words = (s.words ?? [])
      .map((w) => {
        const ws = tl.outputTime(w.start);
        const we = tl.outputTime(w.end);
        return ws !== null && we !== null && we > ws ? { start: ws, end: we, text: w.text } : null;
      })
      .filter((w): w is TranscriptWord => w !== null);
    const text = words.length ? words.map((w) => w.text).join(' ') : s.text.trim();
    if (!text) continue;
    out.push({ id: newId(), start, end, text, ...(words.length ? { words } : {}) });
  }
  return out;
}

/** Source ranges of output ranges (for transcript cuts). */
function outToSource(p: Project, start: number, end: number): TimeRange | null {
  const tl = new Timeline(p.recording.duration, p.clips);
  const s = tl.sourceTime(start);
  const e = tl.sourceTime(Math.max(start, end - 1e-4));
  return s !== null && e !== null && e > s ? { start: s, end: e } : null;
}

export interface OpResult {
  project: Project;
  /** One line per op for the CLI summary. */
  note: string;
}

/** Every op name `applyOp` understands, for help text and the parity table. */
export const OP_NAMES = [
  'trim', 'cut', 'split', 'reorder', 'deleteClip', 'trimClip', 'clipSpeed', 'speed', 'setClips',
  'addZoom', 'moveZoom', 'removeZoom', 'clearZooms', 'zoomSettings',
  'cursor', 'audio',
  'cutSilences', 'smartCut', 'cutFillers', 'cutCue', 'cutWords',
  'addCaption', 'editCaption', 'removeCaption', 'clearCaptions', 'setCaptions', 'importCaptions', 'captionsFromTranscript',
  'addChapter', 'editChapter', 'removeChapter', 'clearChapters', 'suggestChapters',
  'addAnnotation', 'editAnnotation', 'removeAnnotation',
  'camera', 'content', 'phone', 'style', 'background', 'crop',
  'device', 'tapStyle', 'addTap', 'moveTap', 'removeTap', 'clearTaps', 'analyzeTaps',
  'speedUpWaits', 'cutWaits', 'setWaits',
  'layout', 'titleCard', 'exportSettings',
  'addAudio', 'moveAudio', 'trimAudio', 'editAudio', 'fitAudio', 'removeAudio', 'audioTrack',
  'set',
] as const;

/** An audio item by `id` (any track) or by `index` within track `track` (default 0). */
function locateAudio(o: EditOp, p: Project): { ti: number; ii: number } {
  if (typeof o.id === 'string') {
    for (let ti = 0; ti < p.tracks.length; ti++) {
      const ii = p.tracks[ti].items.findIndex((i) => i.id === o.id);
      if (ii >= 0) return { ti, ii };
    }
    throw new OpError(`${o.op}: no audio item with id ${o.id}`);
  }
  const ti = optNum(o, 'track') ?? 0;
  const track = p.tracks[ti];
  if (!track) throw new OpError(`${o.op}: no audio track ${ti} (the project has ${p.tracks.length})`);
  return { ti, ii: locateItem(o, track.items, 'audio item') };
}

/** The project with audio item (ti, ii) replaced by `fn` of it. */
function withAudioItem(p: Project, at: { ti: number; ii: number }, fn: (i: AudioItem) => AudioItem): Project {
  return {
    ...p,
    tracks: p.tracks.map((t, ti) => (ti === at.ti ? { ...t, items: t.items.map((i, ii) => (ii === at.ii ? fn(i) : i)) } : t)),
  };
}

const nonNegative = (o: EditOp, k: string): number | undefined => {
  const v = optNum(o, k);
  if (v !== undefined && v < 0) throw new OpError(`${o.op}: "${k}" must be >= 0`);
  return v;
};

export function applyOp(p: Project, o: EditOp, ctx: ApplyContext = {}): OpResult {
  const id = ctx.newId ?? (() => crypto.randomUUID());
  const tl = () => new Timeline(p.recording.duration, p.clips);
  const dur = p.recording.duration;
  switch (o.op) {
    // --- clips (source seconds) -------------------------------------------
    case 'trim': {
      // Keep only [start, end] of the recording.
      const start = optNum(o, 'start') ?? 0;
      const end = optNum(o, 'end') ?? dur;
      if (!(end > start)) throw new OpError('trim: end must be > start');
      const rs = [{ start: -1, end: start }, { start: end, end: dur + 1 }].filter((r) => r.end > Math.max(0, r.start) && r.start < dur);
      const { project, removed } = cutSource(p, rs);
      return { project, note: `trim to source ${start.toFixed(2)}–${end.toFixed(2)}s (${removed.toFixed(2)}s removed)` };
    }
    case 'cut': {
      const { project, removed } = cutSource(p, ranges(o));
      return { project, note: `cut ${removed.toFixed(2)}s of source` };
    }
    case 'split': {
      const at = num(o, 'at');
      const t = tl();
      if (!t.split(at)) throw new OpError(`split: output time ${at} is not inside a clip`);
      return { project: withClips(p, t.clips), note: `split at output ${at}s` };
    }
    case 'reorder': {
      const from = num(o, 'from');
      const to = num(o, 'to');
      if (from < 0 || to < 0 || from >= p.clips.length || to >= p.clips.length) throw new OpError(`reorder: indexes must be 0..${p.clips.length - 1}`);
      const t = tl();
      t.reorder(from, to);
      return { project: withClips(p, t.clips), note: `moved clip ${from} to ${to}` };
    }
    case 'deleteClip': {
      const i = locateItem(o, p.clips, 'clip');
      if (p.clips.length <= 1) throw new OpError('deleteClip: cannot delete the only clip');
      return { project: withClips(p, p.clips.filter((_, j) => j !== i)), note: `deleted clip ${i}` };
    }
    case 'trimClip': {
      const i = locateItem(o, p.clips, 'clip');
      const c = p.clips[i];
      const s = optNum(o, 'sourceStart') ?? c.sourceStart;
      const e = optNum(o, 'sourceEnd') ?? c.sourceEnd;
      if (!(e > s) || s < 0 || e > dur + EPS) throw new OpError(`trimClip: need 0 <= sourceStart < sourceEnd <= ${dur}`);
      return { project: withClips(p, p.clips.map((x, j) => (j === i ? { ...x, sourceStart: s, sourceEnd: e } : x))), note: `clip ${i} now source ${s}–${e}s` };
    }
    case 'clipSpeed': {
      const i = locateItem(o, p.clips, 'clip');
      const speed = num(o, 'speed');
      if (!(speed >= SPEED_MIN && speed <= SPEED_MAX)) throw new OpError(`clipSpeed: speed must be ${SPEED_MIN}..${SPEED_MAX}`);
      return { project: withClips(p, p.clips.map((x, j) => (j === i ? { ...x, speed } : x))), note: `clip ${i} at ${speed}x` };
    }
    case 'speed': {
      const start = num(o, 'start');
      const end = num(o, 'end');
      const speed = num(o, 'speed');
      if (!(end > start)) throw new OpError('speed: end must be > start');
      if (!(speed >= SPEED_MIN && speed <= SPEED_MAX)) throw new OpError(`speed: speed must be ${SPEED_MIN}..${SPEED_MAX}`);
      return { project: withClips(p, setRangeSpeed(p.clips, start, end, speed)), note: `source ${start}–${end}s at ${speed}x` };
    }
    case 'setClips': {
      const v = o.clips;
      if (!Array.isArray(v) || !v.length) throw new OpError('setClips: "clips" must be a non-empty array of {sourceStart,sourceEnd,speed}');
      const clips = v.map((c: Partial<Clip>) => ({ id: typeof c.id === 'string' ? c.id : id(), sourceStart: Number(c.sourceStart), sourceEnd: Number(c.sourceEnd), speed: Number(c.speed ?? 1) }));
      return { project: withClips(p, clips), note: `${clips.length} clips set` };
    }

    // --- zoom (output seconds) ---------------------------------------------
    case 'addZoom': {
      const at = num(o, 'at');
      const scale = optNum(o, 'scale') ?? 2;
      const hold = optNum(o, 'hold') ?? 0.9;
      const c = (o.center as { x: number; y: number } | undefined) ?? { x: optNum(o, 'x') ?? 0.5, y: optNum(o, 'y') ?? 0.5 };
      if (typeof c.x !== 'number' || typeof c.y !== 'number') throw new OpError('addZoom: center needs numeric x and y (0..1)');
      const z = manualZoom(at, c, scale, hold);
      return { project: { ...p, manualZooms: [...p.manualZooms, z].sort((a, b) => a.inStart - b.inStart) }, note: `zoom ${scale}x at ${at}s → (${c.x}, ${c.y})` };
    }
    case 'moveZoom': {
      const i = locateItem(o, p.manualZooms as (FocusSegment & { id?: string })[], 'manual zoom');
      const z = p.manualZooms[i];
      const at = optNum(o, 'at');
      const d = at === undefined ? 0 : at - z.inStart;
      const c = (o.center as { x: number; y: number } | undefined) ?? { x: optNum(o, 'x') ?? z.center.x, y: optNum(o, 'y') ?? z.center.y };
      const nz: FocusSegment = { ...z, inStart: z.inStart + d, holdStart: z.holdStart + d, holdEnd: z.holdEnd + d, outEnd: z.outEnd + d, center: { x: clamp01(c.x), y: clamp01(c.y) }, scale: optNum(o, 'scale') ?? z.scale };
      const hold = optNum(o, 'hold');
      if (hold !== undefined) {
        nz.holdEnd = nz.holdStart + hold;
        nz.outEnd = nz.holdEnd + (z.outEnd - z.holdEnd);
      }
      const list = p.manualZooms.map((x, j) => (j === i ? nz : x)).sort((a, b) => a.inStart - b.inStart);
      return { project: { ...p, manualZooms: list }, note: `manual zoom ${i} updated` };
    }
    case 'removeZoom': {
      const i = locateItem(o, p.manualZooms as (FocusSegment & { id?: string })[], 'manual zoom');
      return { project: { ...p, manualZooms: p.manualZooms.filter((_, j) => j !== i) }, note: `manual zoom ${i} removed` };
    }
    case 'clearZooms':
      return { project: { ...p, manualZooms: [] }, note: 'manual zooms cleared' };
    case 'zoomSettings': {
      const patch = pick<Project['zoom']>(o, ['autofocus', 'dwell', 'depth', 'fromTaps']);
      if (patch.depth !== undefined && !(patch.depth >= 1 && patch.depth <= 4)) throw new OpError('zoomSettings: depth must be 1..4');
      return { project: { ...p, zoom: { ...p.zoom, ...patch } }, note: `zoom ${JSON.stringify(patch)}` };
    }

    // --- cursor / audio ------------------------------------------------------
    case 'cursor': {
      const patch: Partial<Project['style']> = {};
      const size = optNum(o, 'size');
      if (size !== undefined) patch.cursorSize = size;
      const hex = optStr(o, 'hex');
      if (hex !== undefined) patch.cursorHex = hex;
      const trail = optBool(o, 'trail');
      if (trail !== undefined) patch.cursorTrail = trail;
      const show = optBool(o, 'show');
      if (show !== undefined) patch.cursorShow = show;
      const opacity = optNum(o, 'opacity');
      if (opacity !== undefined) patch.cursorOpacity = opacity;
      return { project: { ...p, style: { ...p.style, ...patch } }, note: `cursor ${JSON.stringify(patch)}` };
    }
    case 'audio': {
      const patch = pick<Project['audio']>(o, ['clickSounds', 'voiceCleanup']);
      return { project: { ...p, audio: { ...p.audio, ...patch } }, note: `audio ${JSON.stringify(patch)}` };
    }

    // --- cuts from audio / transcript ---------------------------------------
    case 'cutSilences':
    case 'smartCut': {
      if (!ctx.silences) throw new OpError(`${o.op}: silences were not detected (the CLI runs ffmpeg silencedetect for this op)`);
      const srcWords: TranscriptWord[] = [];
      if (o.op === 'smartCut') {
        const t = tl();
        for (const c of p.captions) for (const w of c.words ?? []) {
          const s = t.sourceTime(w.start);
          const e = t.sourceTime(w.end);
          if (s !== null && e !== null && e > s) srcWords.push({ start: s, end: e, text: w.text });
        }
      }
      const proposals = planSmartCuts({
        silences: ctx.silences,
        words: srcWords,
        fillerCues: [],
        sourceDuration: dur,
        silenceInset: optNum(o, 'inset'),
        minSilence: optNum(o, 'minSilence'),
      });
      const { project, removed } = cutSource(p, proposals);
      return { project, note: `${proposals.length} ${o.op === 'smartCut' ? 'silence/filler' : 'silence'} cuts, ${removed.toFixed(2)}s removed` };
    }
    case 'cutFillers': {
      const t = tl();
      const rs: TimeRange[] = [];
      for (const c of p.captions) {
        if (c.words?.length) {
          for (const w of c.words) if (isFillerWord(w.text)) {
            const r = outToSource(p, w.start, w.end);
            if (r) rs.push(r);
          }
        } else if (/^\W*(?:um+|uh+|er+|ah+|hmm+|mm+)\W*$/i.test(c.text)) {
          const r = outToSource(p, c.start, c.end);
          if (r) rs.push(r);
        }
      }
      void t;
      const { project, removed } = cutSource(p, rs);
      return { project, note: `${rs.length} fillers cut, ${removed.toFixed(2)}s removed` };
    }
    case 'cutCue': {
      const i = locateItem(o, p.captions, 'caption');
      const c = p.captions[i];
      const r = outToSource(p, c.start, c.end);
      if (!r) throw new OpError('cutCue: that cue is already cut');
      const { project, removed } = cutSource(p, [r]);
      return { project, note: `cut cue "${c.text.slice(0, 40)}" (${removed.toFixed(2)}s)` };
    }
    case 'cutWords': {
      const i = locateItem(o, p.captions, 'caption');
      const c = p.captions[i];
      if (!c.words?.length) throw new OpError('cutWords: that caption has no word timing (use cutCue)');
      const from = num(o, 'from');
      const to = optNum(o, 'to') ?? from;
      const sel = c.words.slice(Math.min(from, to), Math.max(from, to) + 1);
      if (!sel.length) throw new OpError('cutWords: word indexes out of range');
      const r = outToSource(p, sel[0].start, sel[sel.length - 1].end);
      if (!r) throw new OpError('cutWords: selection already cut');
      const { project, removed } = cutSource(p, [r]);
      return { project, note: `cut "${sel.map((w) => w.text).join(' ')}" (${removed.toFixed(2)}s)` };
    }

    // --- captions (output seconds) --------------------------------------------
    case 'addCaption': {
      const cue: CaptionCue = { id: id(), start: num(o, 'start'), end: num(o, 'end'), text: str(o, 'text') };
      if (!(cue.end > cue.start)) throw new OpError('addCaption: end must be > start');
      return { project: { ...p, captions: [...p.captions, cue].sort((a, b) => a.start - b.start) }, note: `caption ${cue.start}–${cue.end}s "${cue.text}"` };
    }
    case 'editCaption': {
      const i = locateItem(o, p.captions, 'caption');
      const c = { ...p.captions[i], ...pick<CaptionCue>(o, ['start', 'end', 'text']) };
      // Hand-edited text no longer matches word timing.
      if (o.text !== undefined) delete c.words;
      return { project: { ...p, captions: p.captions.map((x, j) => (j === i ? c : x)).sort((a, b) => a.start - b.start) }, note: `caption ${i} edited` };
    }
    case 'removeCaption': {
      const i = locateItem(o, p.captions, 'caption');
      return { project: { ...p, captions: p.captions.filter((_, j) => j !== i) }, note: `caption ${i} removed` };
    }
    case 'clearCaptions':
      return { project: { ...p, captions: [] }, note: 'captions cleared' };
    case 'setCaptions': {
      const v = o.captions;
      if (!Array.isArray(v)) throw new OpError('setCaptions: "captions" must be an array of {start,end,text}');
      const cues = v.map((c: Partial<CaptionCue>) => ({ id: typeof c.id === 'string' ? c.id : id(), start: Number(c.start), end: Number(c.end), text: String(c.text ?? ''), ...(c.words ? { words: c.words } : {}) }));
      return { project: { ...p, captions: cues.sort((a, b) => a.start - b.start) }, note: `${cues.length} captions set` };
    }
    case 'importCaptions': {
      const text = typeof o.text === 'string' ? o.text : typeof o.file === 'string' ? ctx.files?.[o.file] : undefined;
      if (text === undefined) throw new OpError('importCaptions: pass "text" (SRT/VTT) or "file" (a path)');
      const cues = parseCaptions(text).map((c) => ({ ...c, id: id() }));
      if (!cues.length) throw new OpError('importCaptions: no cues found');
      return { project: { ...p, captions: cues }, note: `${cues.length} captions imported` };
    }
    case 'captionsFromTranscript': {
      if (!ctx.transcript) throw new OpError('captionsFromTranscript: no transcript (run with --transcribe or add transcript.json)');
      const cues = captionsFromSegments(p, ctx.transcript, id);
      return { project: { ...p, captions: cues }, note: `${cues.length} captions from transcript` };
    }

    // --- chapters (output seconds) ------------------------------------------
    case 'addChapter': {
      const ch: Chapter = { id: id(), start: num(o, 'start'), title: str(o, 'title') };
      return { project: { ...p, chapters: [...p.chapters, ch].sort((a, b) => a.start - b.start) }, note: `chapter ${ch.start}s "${ch.title}"` };
    }
    case 'editChapter': {
      const i = locateItem(o, p.chapters, 'chapter');
      const ch = { ...p.chapters[i], ...pick<Chapter>(o, ['start', 'title']) };
      return { project: { ...p, chapters: p.chapters.map((x, j) => (j === i ? ch : x)).sort((a, b) => a.start - b.start) }, note: `chapter ${i} edited` };
    }
    case 'removeChapter': {
      const i = locateItem(o, p.chapters, 'chapter');
      return { project: { ...p, chapters: p.chapters.filter((_, j) => j !== i) }, note: `chapter ${i} removed` };
    }
    case 'clearChapters':
      return { project: { ...p, chapters: [] }, note: 'chapters cleared' };
    case 'suggestChapters': {
      const ch = suggestChapters(p.captions, tl().outputDuration).map((c) => ({ ...c, id: id() }));
      if (!ch.length) throw new OpError('suggestChapters: not enough transcript for chapters');
      return { project: { ...p, chapters: ch }, note: `${ch.length} chapters suggested` };
    }

    // --- annotations (output seconds) ---------------------------------------
    case 'addAnnotation': {
      const band = (optNum(o, 'band') ?? 1) as 0 | 1 | 2;
      const start = num(o, 'start');
      const a: Annotation = { id: id(), start, end: optNum(o, 'end') ?? start + 3, text: str(o, 'text'), band, hex: optStr(o, 'hex') ?? '#ffffff' };
      return { project: { ...p, annotations: [...p.annotations, a] }, note: `text overlay "${a.text}" ${a.start}–${a.end}s` };
    }
    case 'editAnnotation': {
      const i = locateItem(o, p.annotations, 'annotation');
      const a = { ...p.annotations[i], ...pick<Annotation>(o, ['start', 'end', 'text', 'band', 'hex']) };
      return { project: { ...p, annotations: p.annotations.map((x, j) => (j === i ? a : x)) }, note: `annotation ${i} edited` };
    }
    case 'removeAnnotation': {
      const i = locateItem(o, p.annotations, 'annotation');
      return { project: { ...p, annotations: p.annotations.filter((_, j) => j !== i) }, note: `annotation ${i} removed` };
    }

    // --- camera / style ----------------------------------------------------
    case 'camera': {
      const patch = pick<Project['cameraOverlay']>(o, ['enabled', 'corner', 'sizeFraction', 'circular']);
      const next = { ...p.cameraOverlay, ...patch };
      // x/y: the bubble's centre as a fraction of the canvas. A corner on its own puts it back in that corner.
      if (o.x !== undefined || o.y !== undefined) {
        const x = Number(o.x ?? next.position?.x ?? 0.5);
        const y = Number(o.y ?? next.position?.y ?? 0.5);
        if (![x, y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) throw new OpError('camera: x and y are fractions of the canvas, 0..1');
        next.position = { x, y };
        Object.assign(patch, { position: next.position });
      } else if (o.corner !== undefined) {
        delete next.position;
      }
      return { project: { ...p, cameraOverlay: next }, note: `camera ${JSON.stringify(patch)}` };
    }
    case 'content': {
      // The recording moved and resized on the canvas: x/y its centre (canvas fractions), scale against the fitted size.
      if (o.reset === true) {
        const { contentTransform: _, ...style } = p.style;
        return { project: { ...p, style }, note: 'content back where the layout fits it' };
      }
      if (o.x === undefined && o.y === undefined && o.scale === undefined) throw new OpError('content: pass x, y, scale, or reset:true');
      const cur = p.style.contentTransform;
      const next: ContentTransform = { scale: cur?.scale ?? 1 };
      if (cur?.x !== undefined) next.x = cur.x;
      if (cur?.y !== undefined) next.y = cur.y;
      for (const k of ['x', 'y'] as const) {
        if (o[k] === undefined) continue;
        const v = Number(o[k]);
        if (!Number.isFinite(v)) throw new OpError(`content: ${k} is the centre as a fraction of the canvas (0..1; 0.5 is the middle)`);
        next[k] = v;
      }
      if (o.scale !== undefined) {
        const v = Number(o.scale);
        if (!(v >= MIN_CONTENT_SCALE && v <= MAX_CONTENT_SCALE)) throw new OpError(`content: scale is ${MIN_CONTENT_SCALE}..${MAX_CONTENT_SCALE} (1 = the size the layout fits it at)`);
        next.scale = v;
      }
      return { project: { ...p, style: { ...p.style, contentTransform: next } }, note: `content ${JSON.stringify(next)}` };
    }
    case 'phone': {
      if (!p.recording.phoneVideoFile) throw new OpError('phone: this recording has no phone video (only Mac takes recorded with "iPhone or iPad" on have one)');
      const patch = pick<Project['phoneOverlay']>(o, ['enabled', 'layout', 'corner', 'size', 'frame', 'shadow', 'sound', 'modelId', 'finishId']);
      const next = { ...p.phoneOverlay, ...patch };
      if (o.modelId === null) delete next.modelId;
      if (o.finishId === null) delete next.finishId;
      return { project: { ...p, phoneOverlay: next }, note: `phone ${JSON.stringify(patch)}` };
    }
    case 'style': {
      const patch = pick<Project['style']>(o, ['paddingFraction', 'cornerRadius', 'shadowRadius', 'shadowOpacity', 'cropRect', 'background', 'deviceFrame', 'cursorSize', 'cursorTrail', 'cursorHex', 'cursorShow', 'cursorOpacity']);
      return { project: { ...p, style: { ...p.style, ...patch } }, note: `style ${JSON.stringify(patch)}` };
    }
    case 'background': {
      // {swatch:"ocean"} | {solid:"#hex"} | {gradient:{startHex,endHex,angle}} | {image:"/path", blur?} | {blurred:true}
      if (o.blurred === true) return { project: { ...p, layout: { ...p.layout, background: 'blurred' } }, note: 'background: blurred recording' };
      let bg: Background;
      if (typeof o.swatch === 'string') {
        const s = SWATCHES[o.swatch.toLowerCase()];
        if (!s) throw new OpError(`background: swatch must be one of ${Object.keys(SWATCHES).join(', ')}`);
        bg = s;
      } else if (typeof o.solid === 'string') bg = { kind: 'solid', hex: o.solid };
      else if (o.gradient && typeof o.gradient === 'object') {
        const g = o.gradient as { startHex: string; endHex: string; angle?: number };
        bg = { kind: 'gradient', startHex: g.startHex, endHex: g.endHex, angle: g.angle ?? 135 };
      } else if (typeof o.image === 'string') bg = { kind: 'imageFile', path: o.image, ...(typeof o.blur === 'number' ? { blur: o.blur } : {}) };
      else throw new OpError('background: pass swatch, solid, gradient, image or blurred:true');
      return { project: { ...p, style: { ...p.style, background: bg }, layout: { ...p.layout, background: 'style' } }, note: `background ${JSON.stringify(bg)}` };
    }
    case 'crop': {
      const r = o.rect as Project['style']['cropRect'];
      if (r !== null && (typeof r !== 'object' || r === undefined)) throw new OpError('crop: "rect" must be {x,y,w,h} (normalized) or null');
      return { project: { ...p, style: { ...p.style, cropRect: r } }, note: r ? `crop ${JSON.stringify(r)}` : 'crop cleared' };
    }

    // --- phone: device, taps, waits ------------------------------------------
    case 'device': {
      const patch = pick<Project['device']>(o, ['frame', 'modelId', 'finishId']);
      const dev = { ...p.device, ...patch };
      if (o.modelId === null) delete dev.modelId;
      if (o.finishId === null) delete dev.finishId;
      return { project: { ...p, device: dev }, note: `device ${JSON.stringify(dev)}` };
    }
    case 'tapStyle': {
      const patch = pick<Project['tapStyle']>(o, ['show', 'style', 'color', 'sizePt']);
      return { project: { ...p, tapStyle: { ...p.tapStyle, ...patch } }, note: `tap style ${JSON.stringify(patch)}` };
    }
    case 'addTap': {
      const t: TapSuggestion = { id: id(), t: num(o, 't'), x: clamp01(num(o, 'x')), y: clamp01(num(o, 'y')), kind: (optStr(o, 'kind') ?? 'tap') as TapSuggestion['kind'], confidence: 1 };
      for (const k of ['endX', 'endY', 'duration'] as const) if (typeof o[k] === 'number') t[k] = o[k] as number;
      return { project: { ...p, taps: [...p.taps, t].sort((a, b) => a.t - b.t), tapsAnalyzed: true }, note: `tap at source ${t.t}s (${t.x}, ${t.y})` };
    }
    case 'moveTap': {
      const i = locateItem(o, p.taps, 'tap');
      const cur = p.taps[i];
      const x = optNum(o, 'x');
      const y = optNum(o, 'y');
      const moved: TapSuggestion = { ...cur, t: optNum(o, 't') ?? cur.t, x: x === undefined ? cur.x : clamp01(x), y: y === undefined ? cur.y : clamp01(y) };
      // A swipe moves as a whole, keeping its direction (as the editor does).
      if (cur.endX !== undefined) moved.endX = clamp01(cur.endX + moved.x - cur.x);
      if (cur.endY !== undefined) moved.endY = clamp01(cur.endY + moved.y - cur.y);
      if (typeof o.kind === 'string') moved.kind = o.kind as TapSuggestion['kind'];
      return { project: { ...p, taps: p.taps.map((x2, j) => (j === i ? moved : x2)).sort((a, b) => a.t - b.t) }, note: `tap ${i} moved` };
    }
    case 'removeTap': {
      const i = locateItem(o, p.taps, 'tap');
      return { project: { ...p, taps: p.taps.filter((_, j) => j !== i) }, note: `tap ${i} removed` };
    }
    case 'clearTaps':
      return { project: { ...p, taps: [], tapsAnalyzed: true }, note: 'taps cleared' };
    case 'analyzeTaps': {
      if (!ctx.tapAnalysis) throw new OpError('analyzeTaps: tap analysis did not run (the CLI runs it for this op)');
      return { project: { ...p, taps: ctx.tapAnalysis.taps, waits: ctx.tapAnalysis.deadTime, tapsAnalyzed: true }, note: `${ctx.tapAnalysis.taps.length} taps, ${ctx.tapAnalysis.deadTime.length} waits found` };
    }
    case 'speedUpWaits':
    case 'cutWaits': {
      // which: all (default) | edge (dead air at the very start/end) | interior
      const which = optStr(o, 'which') ?? 'all';
      if (!['all', 'edge', 'interior'].includes(which)) throw new OpError(`${o.op}: which must be all, edge or interior`);
      const cores = pendingWaits(p.waits, tl())
        .filter((w) => which === 'all' || (which === 'edge' ? !!w.edge : !w.edge))
        .map((w) => waitCore(w))
        .filter((r): r is TimeRange => r !== null)
        // maxFraction: leave alone a "wait" that is most of the recording
        // (nothing happens on screen; speeding it up would just shorten it).
        .filter((r) => o.maxFraction === undefined || r.end - r.start <= num(o, 'maxFraction') * dur);
      if (!cores.length) return { project: p, note: 'no waits left to handle' };
      const secs = cores.reduce((n, r) => n + r.end - r.start, 0);
      if (o.op === 'speedUpWaits') {
        const speed = optNum(o, 'speed') ?? 3;
        return { project: withClips(p, speedUpRanges(p.clips, cores, speed)), note: `${cores.length} waits sped up ${speed}x (${(secs * (1 - 1 / speed)).toFixed(1)}s saved)` };
      }
      const { project, removed } = cutSource(p, cores);
      return { project, note: `${cores.length} waits cut (${removed.toFixed(1)}s removed)` };
    }
    case 'setWaits': {
      const ws = ranges(o, 'waits');
      return { project: { ...p, waits: ws }, note: `${ws.length} waits set` };
    }

    // --- layout / export ----------------------------------------------------
    case 'layout': {
      const presetId = optStr(o, 'presetId');
      if (presetId !== undefined && presetId !== 'none' && !LAYOUT_CHOICES.some((c) => c.id === presetId) && !PRESETS.some((x) => x.id === presetId)) {
        throw new OpError(`layout: presetId must be one of ${[...LAYOUT_CHOICES.map((c) => c.id)].join(', ')} (or an exportPresets id)`);
      }
      const patch = pick<Project['layout']>(o, ['presetId', 'background']);
      return { project: { ...p, layout: { ...p.layout, ...patch } }, note: `layout ${JSON.stringify(patch)}` };
    }
    case 'titleCard': {
      if (o.enabled === false || o.title === null) {
        const { titleCard: _t, ...rest } = p.layout;
        return { project: { ...p, layout: rest }, note: 'title card off' };
      }
      const tc = { title: optStr(o, 'title') ?? p.layout.titleCard?.title ?? '', subtitle: optStr(o, 'subtitle') ?? p.layout.titleCard?.subtitle ?? '' };
      return { project: { ...p, layout: { ...p.layout, titleCard: tc } }, note: `title card "${tc.title}"` };
    }
    case 'exportSettings': {
      const patch: Partial<Project> = {};
      if (o.preset !== undefined) patch.exportPreset = str(o, 'preset') as Project['exportPreset'];
      if (o.fps !== undefined) patch.outputFPS = num(o, 'fps');
      return { project: { ...p, ...patch }, note: `export ${JSON.stringify(patch)}` };
    }

    // --- audio tracks (item start: output seconds; sourceIn/sourceOut: seconds into the sound file) ---
    case 'addAudio': {
      const src = str(o, 'file');
      const got = ctx.audioFiles?.[src];
      if (!got) throw new OpError(`addAudio: ${src} was not imported (the CLI copies the file into the bundle first)`);
      let item = newAudioItem(id(), got.file, typeof o.name === 'string' ? o.name : got.name, got.duration, nonNegative(o, 'start') ?? 0);
      item = audioPatch(o, item);
      if (o.fit === true) item = fitToVideo(item, tl().outputDuration);
      return { project: addItem(p, item, id), note: `audio "${item.name}" at ${item.start}s (${segmentLength(item).toFixed(2)}s of ${got.duration.toFixed(2)}s)` };
    }
    case 'moveAudio': {
      const at = locateAudio(o, p);
      const start = nonNegative(o, 'start');
      if (start === undefined) throw new OpError('moveAudio: "start" must be a number');
      return { project: withAudioItem(p, at, (i) => ({ ...i, start })), note: `audio ${at.ti}/${at.ii} starts at ${start}s` };
    }
    case 'trimAudio': {
      const at = locateAudio(o, p);
      let note = '';
      const project = withAudioItem(p, at, (i) => {
        const sourceIn = nonNegative(o, 'sourceIn') ?? i.sourceIn;
        const sourceOut = optNum(o, 'sourceOut') ?? i.sourceOut;
        if (!(sourceOut > sourceIn)) throw new OpError('trimAudio: sourceOut must be > sourceIn');
        if (i.fileDuration > 0 && sourceOut > i.fileDuration + 0.05) throw new OpError(`trimAudio: sourceOut is past the end of the file (${i.fileDuration.toFixed(2)}s)`);
        note = `audio ${at.ti}/${at.ii} plays ${sourceIn}–${sourceOut}s of its file`;
        return { ...i, sourceIn, sourceOut: Math.min(sourceOut, i.fileDuration || sourceOut) };
      });
      return { project, note };
    }
    case 'editAudio': {
      const at = locateAudio(o, p);
      return { project: withAudioItem(p, at, (i) => audioPatch(o, i)), note: `audio ${at.ti}/${at.ii} ${JSON.stringify(pick(o, ['volume', 'fadeIn', 'fadeOut', 'loop', 'name']))}` };
    }
    case 'fitAudio': {
      const at = locateAudio(o, p);
      return { project: withAudioItem(p, at, (i) => fitToVideo(i, tl().outputDuration)), note: `audio ${at.ti}/${at.ii} fitted to the video` };
    }
    case 'removeAudio': {
      const at = locateAudio(o, p);
      return {
        project: { ...p, tracks: p.tracks.map((t, ti) => (ti === at.ti ? { ...t, items: t.items.filter((_, ii) => ii !== at.ii) } : t)) },
        note: `audio ${at.ti}/${at.ii} removed`,
      };
    }
    case 'audioTrack': {
      const { tracks, index } = o.track === undefined ? withMusicTrack(p.tracks, id) : { tracks: p.tracks, index: num(o, 'track') };
      if (!tracks[index]) throw new OpError(`audioTrack: no audio track ${index}`);
      const patch: Partial<Project['tracks'][number]> = {};
      const muted = optBool(o, 'muted');
      const duck = optBool(o, 'duck');
      const volume = optNum(o, 'volume');
      if (muted !== undefined) patch.muted = muted;
      if (duck !== undefined) patch.duck = duck;
      if (volume !== undefined) patch.volume = clamp01(volume);
      if (typeof o.name === 'string') patch.name = o.name;
      return { project: { ...p, tracks: tracks.map((t, i) => (i === index ? { ...t, ...patch } : t)) }, note: `audio track ${index} ${JSON.stringify(patch)}` };
    }

    case 'set':
      return { project: setPointer(p, str(o, 'path'), o.value), note: `set ${o.path} = ${JSON.stringify(o.value)}` };

    default:
      throw new OpError(`unknown op "${o.op}". Known ops: ${OP_NAMES.join(', ')}`);
  }
}

/** volume (0..1), fadeIn/fadeOut (s), loop and name from an op, onto an audio item. */
function audioPatch(o: EditOp, item: AudioItem): AudioItem {
  const next = { ...item };
  const volume = optNum(o, 'volume');
  if (volume !== undefined) next.gain = clamp01(volume);
  const fadeIn = nonNegative(o, 'fadeIn');
  if (fadeIn !== undefined) next.fadeIn = fadeIn;
  const fadeOut = nonNegative(o, 'fadeOut');
  if (fadeOut !== undefined) next.fadeOut = fadeOut;
  const loop = optBool(o, 'loop');
  if (loop !== undefined) next.loop = loop;
  if (typeof o.name === 'string') next.name = o.name;
  if (o.sourceIn !== undefined || o.sourceOut !== undefined) {
    next.sourceIn = nonNegative(o, 'sourceIn') ?? next.sourceIn;
    next.sourceOut = Math.min(optNum(o, 'sourceOut') ?? next.sourceOut, next.fileDuration || Infinity);
    if (!(next.sourceOut > next.sourceIn)) throw new OpError(`${o.op}: sourceOut must be > sourceIn`);
  }
  return next;
}

/** Ops that need the CLI to run analysis first. */
export const needsSilences = (ops: EditOp[]) => ops.some((o) => o.op === 'cutSilences' || o.op === 'smartCut');
export const needsTapAnalysis = (ops: EditOp[]) => ops.some((o) => o.op === 'analyzeTaps');
export const needsTranscript = (ops: EditOp[]) => ops.some((o) => o.op === 'captionsFromTranscript');
/** Sound files addAudio ops bring in (the CLI copies each into the bundle). */
export const audioImports = (ops: EditOp[]) => [...new Set(ops.filter((o) => o.op === 'addAudio' && typeof o.file === 'string').map((o) => o.file as string))];

/** Apply ops in order; stops at the first failing op (nothing is written by callers). Validates the result. */
export function applyOps(p: Project, ops: EditOp[], ctx: ApplyContext = {}): { project: Project; notes: string[] } {
  if (!Array.isArray(ops)) throw new OpError('edits must be an array of ops (or {"ops":[...]})');
  let cur = p;
  const notes: string[] = [];
  ops.forEach((o, i) => {
    if (!o || typeof o !== 'object' || typeof o.op !== 'string') throw new OpError(`op #${i} needs an "op" field`, i);
    try {
      const r = applyOp(cur, o, ctx);
      cur = r.project;
      notes.push(r.note);
    } catch (e) {
      throw new OpError(`op #${i} (${o.op}): ${(e as Error).message}`, i);
    }
  });
  const errs = validateProject(cur);
  if (errs.length) throw new OpError(`the edited project is invalid: ${errs.join('; ')}`);
  return { project: cur, notes };
}
