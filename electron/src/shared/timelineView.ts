// Editor layout math: how wide the inspector is, how tall the timeline is, and
// how far the timeline is zoomed in. Pure so it can be tested without a DOM.

export const INSPECTOR_DEFAULT = 340;
export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 640;

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 40;
/** One press of + or − (and roughly one notch of pinch) changes zoom by this factor. */
export const ZOOM_STEP = 1.5;

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** Inspector width after a drag; never more than half the window. */
export function clampInspector(w: number, windowW: number) {
  return Math.round(clamp(w, INSPECTOR_MIN, Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, windowW * 0.5))));
}

/**
 * Timeline height after a drag. `natural` is the height it has with no
 * override (the lanes at their base sizes), which is also the floor; the
 * ceiling leaves the preview at least `stageMin` pixels.
 */
export function clampTimeline(h: number, natural: number, windowH: number, topbar: number, stageMin = 220) {
  return Math.round(clamp(h, natural, Math.max(natural, windowH - topbar - stageMin)));
}

/** The narrowest stretch of time the timeline can show, seconds (Frame Selection on a short move). */
export const ZOOM_SPAN_MIN = 1.5;

/** The deepest zoom for a take `total` seconds long: ZOOM_MAX, or more on a
 *  long take so Frame Selection can still show about ZOOM_SPAN_MIN seconds. */
export function maxZoom(total = 0) {
  return Math.max(ZOOM_MAX, total / ZOOM_SPAN_MIN);
}

export function clampZoom(z: number, max = ZOOM_MAX) {
  return clamp(z, ZOOM_MIN, Math.max(ZOOM_MIN, max));
}

/**
 * scrollLeft that keeps the point under `anchorX` (pixels from the viewport's
 * left edge) fixed while the content width goes from `oldW` to `newW`.
 */
export function anchoredScroll(scrollLeft: number, anchorX: number, oldW: number, newW: number, viewportW: number) {
  const frac = oldW > 0 ? (scrollLeft + anchorX) / oldW : 0;
  return clamp(frac * newW - anchorX, 0, Math.max(0, newW - viewportW));
}

/**
 * Evenly spaced ruler labels: the smallest round step giving at most ~10 per
 * screenful, so zooming in adds finer ticks.
 */
export function rulerTicks(total: number, zoom = 1) {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const visible = total / Math.max(1, zoom);
  const step = steps.find((s) => visible / s <= 10) ?? 3600;
  const out: number[] = [];
  // Integer multiples, so 0.1 steps don't drift to 0.30000000000000004.
  for (let i = 0; i * step < total - step * 0.3; i++) out.push(+(i * step).toFixed(3));
  return { ticks: out, step };
}

/** Ruler label: m:ss, with tenths when ticks are closer than a second apart. */
export function fmtTick(t: number, step: number) {
  const m = Math.floor(t / 60);
  if (step >= 1) return `${m}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const d = step === 0.25 ? 2 : 1;
  return `${m}:${(t - m * 60).toFixed(d).padStart(d + 3, '0')}`;
}

/** Base height of an added audio track's lane (music, voiceover). */
export const MUSIC_LANE = 34;

/** Base height of the 3D lane: tall enough for 12 px keys with 20 px hit areas. */
export const LANE_3D = 36;

/** Height of the ruler row above the lanes. */
export const RULER_ROW = 22;

/** Base heights of the lanes under the ruler: clips, zoom, the 3D lane (a
 *  project with a 3D phone), taps (phone takes), audio, and the music lane
 *  only once the project has a sound on it. */
export function laneHeights(phone: boolean, music = false, three = false): number[] {
  return [56, 22, ...(three ? [LANE_3D] : []), ...(phone ? [26] : []), 38, ...(music ? [MUSIC_LANE] : [])];
}

/** The timeline grid's rows (ruler, then lanes) as CSS grid-template-rows.
 *  With a dragged height (`sized`) the lanes share the extra room in
 *  proportion to their base sizes. */
export function timelineRows(lanes: number[], sized = false): string {
  return [`${RULER_ROW}px`, ...lanes.map((r) => (sized ? `minmax(${r}px, ${r}fr)` : `${r}px`))].join(' ');
}

/** The timeline's height with no override: padding, ruler and lanes with
 *  their gaps. It's also the floor a dragged or saved height clamps to. */
export function naturalTimelineHeight(lanes: number[]): number {
  return 6 + 14 + RULER_ROW + lanes.reduce((a, b) => a + b, 0) + lanes.length * 6;
}
