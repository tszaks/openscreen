// The timeline's clip thumbnails: which source moments to grab, and which of
// them a clip shows. Pure, so it can be tested without a video.

/** `count` evenly spaced source times across a recording, each the middle
 *  of its slice (never the very first or last frame, which may be black). */
export function filmstripTimes(duration: number, count: number): number[] {
  if (!(duration > 0) || count < 1) return [];
  const n = Math.floor(count);
  return Array.from({ length: n }, (_, i) => +(((i + 0.5) / n) * duration).toFixed(3));
}

/**
 * The thumbnails a clip shows, in order: one per tile slot, each the grabbed
 * frame nearest that slot's moment in the clip's source range. A clip wider
 * than its grabbed frames repeats the nearest one (as Final Cut does when
 * zoomed in), so tiles keep their shape instead of stretching. Returns
 * indexes into `times`.
 */
export function clipFrames(times: number[], start: number, end: number, slots: number): number[] {
  if (!times.length || slots < 1) return [];
  const n = Math.floor(slots);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = start + ((k + 0.5) / n) * (end - start);
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
    out.push(best);
  }
  return out;
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

/** Most tiles one clip draws. Deep timeline zoom on a portrait take would
 *  otherwise mean thousands of images; past this the tiles widen instead. */
export const MAX_TILES_PER_CLIP = 400;

/** How many tiles of `tileW` fit a clip that covers `fraction` of lanes
 *  `lanesW` px wide (the lanes' width already includes the timeline zoom). */
export function tilesForClip(fraction: number, lanesW: number, tileW: number, max = MAX_TILES_PER_CLIP): number {
  if (!(tileW > 0) || !(lanesW > 0) || !(fraction > 0)) return 1;
  return Math.min(max, Math.max(1, Math.round((fraction * lanesW) / tileW)));
}
