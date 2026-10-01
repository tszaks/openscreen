// Audio tracks: where each added sound (music, a voiceover) plays on the
// output timeline, how loud it is at any moment, and the edits the timeline
// lane and the agent ops make to it. Pure, so the preview, the export and the
// CLI all agree, and all of it is unit-tested.
//
// Items live in OUTPUT seconds and play at normal speed; `sourceIn/sourceOut`
// are seconds into the item's own file.

import { bundleRelative, type AudioItem, type AudioTrack, type Project, type Track } from './types';

/** How much "Lower the recording's sound under music" turns the recording down (−12 dB). */
export const DUCK_GAIN = 0.25;
/** Shortest piece of sound an item can be trimmed to. */
export const MIN_ITEM = 0.1;
/** File types the import dialog offers. */
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'aiff', 'aif'];

export { bundleRelative };

/**
 * Whether absolute `path` lies inside folder `dir` once "." and ".." steps are
 * resolved (plain string work, so the renderer can use it too).
 */
export function insideDir(path: string, dir: string): boolean {
  const norm = (p: string) => {
    const out: string[] = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return '/' + out.join('/');
  };
  if (!path.startsWith('/') || !dir.startsWith('/') || path.includes('\0')) return false;
  const root = norm(dir);
  return norm(path).startsWith(root === '/' ? '/' : `${root}/`);
}

/** Seconds of the file that play once through. */
export const segmentLength = (item: AudioItem) => Math.max(0, item.sourceOut - item.sourceIn);

/**
 * The output-time range the item occupies on a timeline `outDur` long. A
 * looped item repeats until the video ends; anything past the end is cut, so
 * `end` never exceeds `outDur` (and `end <= start` means it never plays).
 */
export function itemSpan(item: AudioItem, outDur: number): { start: number; end: number } {
  const natural = item.loop ? Math.max(outDur, item.start + segmentLength(item)) : item.start + segmentLength(item);
  return { start: item.start, end: Math.min(natural, outDur) };
}

/** Where the timeline lane draws the item: its own length, past the video's end too. */
export function itemExtent(item: AudioItem, outDur: number): { start: number; end: number } {
  return { start: item.start, end: item.loop ? Math.max(outDur, item.start + segmentLength(item)) : item.start + segmentLength(item) };
}

/**
 * Stacking rows for the lane: items that overlap in time (they all play, mixed)
 * go on separate rows so none hides another. Returns each item's row by id and
 * how many rows there are.
 */
export function laneRows(items: AudioItem[], outDur: number): { row: Record<string, number>; count: number } {
  const ends: number[] = [];
  const row: Record<string, number> = {};
  for (const item of [...items].sort((a, b) => a.start - b.start)) {
    const ext = itemExtent(item, outDur);
    let r = ends.findIndex((end) => end <= ext.start + 1e-6);
    if (r < 0) r = ends.length;
    ends[r] = ext.end;
    row[item.id] = r;
  }
  return { row, count: Math.max(1, ends.length) };
}

/** Seconds into the file that play at output time `t`, or null outside the item. */
export function fileTimeAt(item: AudioItem, t: number, outDur: number): number | null {
  const span = itemSpan(item, outDur);
  if (t < span.start || t >= span.end) return null;
  const len = segmentLength(item);
  if (len <= 0) return null;
  const into = t - item.start;
  return item.sourceIn + (item.loop ? into % len : into);
}

/** Fades shortened so they fit the part that plays (half each when they'd overlap). */
export function effectiveFades(item: AudioItem, outDur: number): { fadeIn: number; fadeOut: number } {
  const span = itemSpan(item, outDur);
  const len = Math.max(0, span.end - span.start);
  let fadeIn = Math.max(0, item.fadeIn);
  let fadeOut = Math.max(0, item.fadeOut);
  if (fadeIn + fadeOut > len) {
    const k = len / (fadeIn + fadeOut || 1);
    fadeIn *= k;
    fadeOut *= k;
  }
  return { fadeIn, fadeOut };
}

/** Linear volume of the item at output time `t`: track volume × item gain × fades; 0 when muted or outside. */
export function itemGainAt(item: AudioItem, track: Pick<AudioTrack, 'muted' | 'volume'>, t: number, outDur: number): number {
  if (track.muted) return 0;
  const span = itemSpan(item, outDur);
  if (t < span.start || t >= span.end) return 0;
  const { fadeIn, fadeOut } = effectiveFades(item, outDur);
  let env = 1;
  if (fadeIn > 0 && t < span.start + fadeIn) env = Math.min(env, (t - span.start) / fadeIn);
  if (fadeOut > 0 && t > span.end - fadeOut) env = Math.min(env, (span.end - t) / fadeOut);
  return Math.max(0, track.volume * item.gain * env);
}

/** Whether a track contributes sound at all. */
export const audible = (track: Track) => !track.muted && track.volume > 0;

/**
 * Output-time ranges where the recording's own sound is lowered: wherever an
 * item of an audible track that ducks is playing. Merged and sorted.
 */
export function duckRanges(tracks: Track[], outDur: number): { start: number; end: number }[] {
  const spans = tracks
    .filter((t) => t.duck && audible(t))
    .flatMap((t) => t.items.filter((i) => i.gain > 0).map((i) => itemSpan(i, outDur)))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** The recording's volume multiplier at output time `t` (the preview's ducking). */
export function recordingGainAt(tracks: Track[], t: number, outDur: number): number {
  return duckRanges(tracks, outDur).some((r) => t >= r.start && t < r.end) ? DUCK_GAIN : 1;
}

/** One added sound as the export mixes it: everything ffmpeg needs, in plain numbers. */
export interface MusicInput {
  /** Absolute path of the file. */
  path: string;
  /** Output second it starts at. */
  delay: number;
  sourceIn: number;
  sourceOut: number;
  loop: boolean;
  /** Seconds it plays for (already cut at the video's end). */
  length: number;
  /** Combined linear volume (track × item). */
  gain: number;
  fadeIn: number;
  fadeOut: number;
}

/** Every item that makes sound in an export `outDur` long, with files resolved under `bundleDir`. */
export function musicInputs(tracks: Track[], bundleDir: string, outDur: number): MusicInput[] {
  const dir = bundleDir.replace(/\/+$/, '');
  return tracks.filter(audible).flatMap((track) =>
    track.items.flatMap((item) => {
      // Normally dropped on load already; never hand ffmpeg a path outside the bundle.
      if (!bundleRelative(item.file)) throw new Error(`The sound file "${String(item.file)}" is outside this project, so it can't be exported.`);
      const span = itemSpan(item, outDur);
      const length = span.end - span.start;
      const gain = track.volume * item.gain;
      if (length <= 1e-3 || gain <= 0 || segmentLength(item) <= 0) return [];
      const fades = effectiveFades(item, outDur);
      return [{ path: `${dir}/${item.file}`, delay: item.start, sourceIn: item.sourceIn, sourceOut: item.sourceOut, loop: item.loop, length, gain, ...fades }];
    }),
  );
}

/** A press only becomes a drag past DRAG_MIN_PX, and then only once it has
 *  lasted DRAG_SURE_MS or gone past DRAG_SURE_PX, so a trackpad tap (a few
 *  pixels of wobble in a few milliseconds) never nudges an item. */
export const DRAG_MIN_PX = 3;
export const DRAG_SURE_PX = 6;
export const DRAG_SURE_MS = 80;
export function dragLatched(dx: number, ms: number): boolean {
  const d = Math.abs(dx);
  return d >= DRAG_MIN_PX && (ms >= DRAG_SURE_MS || d >= DRAG_SURE_PX);
}

// ---------------------------------------------------------------------------
// Edits (the timeline lane, the inspector and the agent ops all use these)

/** Move the item so it starts at output time `start` (never before 0). */
export const moveItem = (item: AudioItem, start: number): AudioItem => ({ ...item, start: Math.max(0, start) });

/**
 * Drag the item's left edge to output time `t`: the sound under it stays put
 * on the timeline, so start and sourceIn move together. Clamped to the file's
 * beginning, to 0 on the timeline, and to MIN_ITEM before the right edge.
 */
export function trimItemStart(item: AudioItem, t: number): AudioItem {
  let delta = t - item.start;
  delta = Math.max(delta, -item.sourceIn, -item.start);
  delta = Math.min(delta, segmentLength(item) - MIN_ITEM);
  return { ...item, start: item.start + delta, sourceIn: item.sourceIn + delta };
}

/** Drag the item's right edge to output time `t` (clamped to the file's end and MIN_ITEM). */
export function trimItemEnd(item: AudioItem, t: number): AudioItem {
  const sourceOut = Math.min(item.fileDuration, Math.max(item.sourceIn + MIN_ITEM, item.sourceIn + (t - item.start)));
  return { ...item, sourceOut };
}

/**
 * "Fit to video": start at 0 and play the whole video. A longer file is cut
 * at the video's end (from where its kept part begins); a shorter one loops.
 */
export function fitToVideo(item: AudioItem, outDur: number): AudioItem {
  const available = item.fileDuration - item.sourceIn;
  if (available >= outDur) return { ...item, start: 0, sourceOut: item.sourceIn + outDur, loop: false };
  return { ...item, start: 0, sourceOut: item.fileDuration, loop: true };
}

/** A new item for a freshly imported file, starting at output time `start`. */
export function newAudioItem(id: string, file: string, name: string, fileDuration: number, start: number): AudioItem {
  return { id, file, name, fileDuration, start: Math.max(0, start), sourceIn: 0, sourceOut: fileDuration, gain: 1, fadeIn: 0, fadeOut: 0, loop: false };
}

/** The track phase 1 adds items to: the first audio track, created when there is none. */
export function withMusicTrack(tracks: Track[], newId: () => string): { tracks: Track[]; index: number } {
  const i = tracks.findIndex((t) => t.kind === 'audio');
  if (i >= 0) return { tracks, index: i };
  return { tracks: [...tracks, { id: newId(), kind: 'audio', name: 'Music', muted: false, volume: 1, duck: false, items: [] }], index: tracks.length };
}

/** Add an item to the music track (created if needed). */
export function addItem(p: Project, item: AudioItem, newId: () => string): Project {
  const { tracks, index } = withMusicTrack(p.tracks, newId);
  return { ...p, tracks: tracks.map((t, i) => (i === index ? { ...t, items: [...t.items, item].sort((a, b) => a.start - b.start) } : t)) };
}

/** Replace one item, wherever it is, through `fn`. Unknown ids leave the project as it is. */
export function updateItem(p: Project, id: string, fn: (item: AudioItem) => AudioItem): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.items.some((i) => i.id === id) ? { ...t, items: t.items.map((i) => (i.id === id ? fn(i) : i)) } : t)) };
}

/** Remove an item, wherever it is. */
export function removeItem(p: Project, id: string): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.items.some((i) => i.id === id) ? { ...t, items: t.items.filter((i) => i.id !== id) } : t)) };
}

/** Change a track's own settings. */
export function updateTrack(p: Project, id: string, patch: Partial<Pick<AudioTrack, 'muted' | 'volume' | 'duck' | 'name'>>): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

/** The item with this id and the track holding it. */
export function findItem(tracks: Track[], id: string | null): { track: AudioTrack; item: AudioItem } | null {
  if (!id) return null;
  for (const track of tracks) {
    const item = track.items.find((i) => i.id === id);
    if (item) return { track, item };
  }
  return null;
}

/** Problems with the tracks that would break the preview or the export. */
export function trackProblems(tracks: Track[]): string[] {
  const errs: string[] = [];
  tracks.forEach((t, ti) => {
    if (t.kind !== 'audio') errs.push(`tracks[${ti}].kind must be audio`);
    if (!(t.volume >= 0 && t.volume <= 1)) errs.push(`tracks[${ti}].volume must be 0..1`);
    t.items.forEach((i, ii) => {
      const at = `tracks[${ti}].items[${ii}]`;
      if (!bundleRelative(i.file)) errs.push(`${at}.file must be a path inside the bundle`);
      if (!(i.start >= 0)) errs.push(`${at}.start must be >= 0`);
      if (!(i.sourceIn >= 0 && i.sourceOut > i.sourceIn)) errs.push(`${at} needs 0 <= sourceIn < sourceOut`);
      if (i.fileDuration > 0 && i.sourceOut > i.fileDuration + 0.05) errs.push(`${at}.sourceOut is past the end of the file (${i.fileDuration}s)`);
      if (!(i.gain >= 0 && i.gain <= 1)) errs.push(`${at}.gain must be 0..1`);
      if (!(i.fadeIn >= 0 && i.fadeOut >= 0)) errs.push(`${at} fades must be >= 0`);
    });
  });
  return errs;
}
