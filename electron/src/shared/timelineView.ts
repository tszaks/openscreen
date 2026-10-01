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

export function clampZoom(z: number) {
  return clamp(z, ZOOM_MIN, ZOOM_MAX);
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

/** Base heights of the lanes under the ruler: clips, zoom, (taps), audio, and
 *  the music lane only once the project has a sound on it. */
export function laneHeights(phone: boolean, music = false): number[] {
  return [56, 22, ...(phone ? [26] : []), 38, ...(music ? [MUSIC_LANE] : [])];
}

/** The timeline's height with no override: padding, ruler and lanes with
 *  their gaps. It's also the floor a dragged or saved height clamps to. */
export function naturalTimelineHeight(lanes: number[]): number {
  return 6 + 14 + 22 + lanes.reduce((a, b) => a + b, 0) + lanes.length * 6;
}
