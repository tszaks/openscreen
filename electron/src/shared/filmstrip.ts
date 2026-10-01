// The timeline's clip thumbnails: which source moments to grab, and which of
// them a clip shows. Pure, so it can be tested without a video.

/** `count` evenly spaced source times across a recording, each the middle
 *  of its slice (never the very first or last frame, which may be black). */
export function filmstripTimes(duration: number, count: number): number[] {
  if (!(duration > 0) || count < 1) return [];
  const n = Math.floor(count);
  return Array.from({ length: n }, (_, i) => +(((i + 0.5) / n) * duration).toFixed(3));
}

/** The grabbed frame nearest slot `k` of `slots` across a clip's source
 *  range: an index into `times`. A clip with more slots than frames
 *  repeats the nearest one (as Final Cut does zoomed in), so tiles keep
 *  their shape instead of stretching. */
export function slotFrame(times: number[], start: number, end: number, slots: number, k: number): number {
  const t = start + ((k + 0.5) / Math.max(1, slots)) * (end - start);
  let best = 0;
  for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
  return best;
}

/** Every slot's frame, in order (see slotFrame). */
export function clipFrames(times: number[], start: number, end: number, slots: number): number[] {
  if (!times.length || slots < 1) return [];
  const n = Math.floor(slots);
  return Array.from({ length: n }, (_, k) => slotFrame(times, start, end, n, k));
}

/**
 * The slots of a clip worth drawing: those within the visible part of the
 * timeline (`viewLeft`..`viewRight`, in lane pixels) plus one viewport of
 * margin each side, so a deeply zoomed portrait take draws dozens of tiles
 * rather than thousands. `clipLeft` is the clip's left edge in lane pixels.
 * Returns [first, last) slot indexes.
 */
export function visibleSlots(slots: number, slotW: number, clipLeft: number, viewLeft: number, viewRight: number): [number, number] {
  if (slots < 1 || !(slotW > 0)) return [0, 0];
  const margin = Math.max(0, viewRight - viewLeft);
  const first = Math.max(0, Math.floor((viewLeft - margin - clipLeft) / slotW));
  const last = Math.min(slots, Math.ceil((viewRight + margin - clipLeft) / slotW));
  return first < last ? [first, last] : [0, 0];
}

/**
 * One thumbnail's box in a clip whose frames area is `frameH` px tall:
 * always the whole frame at its own shape, as Final Cut draws it, so a
 * portrait phone take is a row of narrow screens rather than crops of one.
 * Very wide sources are capped (and cropped at the sides); a frame never
 * gets narrower than 12px.
 */
export function filmstripTile(source: { width: number; height: number }, frameH: number): { width: number; portrait: boolean } {
  const h = Math.max(1, frameH);
  const aspect = source.width > 0 && source.height > 0 ? source.width / source.height : 16 / 9;
  return { width: Math.max(12, Math.round(h * Math.min(aspect, 2.4))), portrait: aspect < 1 };
}

/** How many tiles of `tileW` fit a clip that covers `fraction` of lanes
 *  `lanesW` px wide (the lanes' width already includes the timeline zoom). */
export function tilesForClip(fraction: number, lanesW: number, tileW: number): number {
  if (!(tileW > 0) || !(lanesW > 0) || !(fraction > 0)) return 1;
  return Math.max(1, Math.round((fraction * lanesW) / tileW));
}
