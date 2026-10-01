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
 * The thumbnails a clip shows, in order: every grabbed frame inside its
 * source range, thinned to at most `max`; a clip too short to hold one
 * shows the frame nearest its middle. Returns indexes into `times`.
 */
export function clipFrames(times: number[], start: number, end: number, max: number): number[] {
  if (!times.length || max < 1) return [];
  const inside = times.map((t, i) => ({ t, i })).filter(({ t }) => t >= start && t <= end);
  if (!inside.length) {
    const mid = (start + end) / 2;
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - mid) < Math.abs(times[best] - mid)) best = i;
    return [best];
  }
  if (inside.length <= max) return inside.map((x) => x.i);
  const out: number[] = [];
  for (let k = 0; k < max; k++) out.push(inside[Math.floor(((k + 0.5) / max) * inside.length)].i);
  return out;
}
