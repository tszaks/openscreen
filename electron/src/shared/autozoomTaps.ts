// Auto-zoom for phone footage: turns touch suggestions into camera segments.
//
// Mac recordings zoom on cursor clicks (autofocus.ts). A wired iPhone
// capture has no cursor, so the detected taps drive the same camera: glide
// in to ~1.8x centred on the tap starting 250 ms before it, hold while the
// screen reacts, and ease out once it settles. Taps in quick succession pan
// from one to the next without zooming out in between. Swipes and typing
// zoom out, because a scroll or keyboard needs the whole screen.
//
// Output is plain FocusSegment[], so cameraAt() and the compositor render it
// exactly like click-driven autofocus.

import type { FocusSegment } from './autofocus';
import type { TapKind, TapSuggestion } from './taps';

export interface TapZoomOptions {
  /** Off switch. The App Store preset turns this off by default. */
  enabled: boolean;
  /** Zoom factor (1.6 to 2 reads as "focus" without losing context). */
  scale: number;
  /** Seconds before the tap to start gliding in. */
  leadIn: number;
  /** Seconds the glide in takes. */
  transitionIn: number;
  /** Minimum seconds to stay zoomed after the tap. */
  minHold: number;
  /** Seconds to stay zoomed after the screen stops changing. */
  settlePad: number;
  /** Seconds the glide out takes. */
  transitionOut: number;
  /** Seconds each pan between clustered taps takes. */
  panDuration: number;
  /** Taps closer than this (hold end to next glide start) pan instead of zooming out. */
  clusterGap: number;
  /** Ignore suggestions below this confidence. */
  minConfidence: number;
  /** Which suggestion kinds zoom. */
  kinds: TapKind[];
}

export const defaultTapZoom: TapZoomOptions = {
  enabled: true,
  scale: 1.8,
  leadIn: 0.25,
  transitionIn: 0.45,
  minHold: 0.8,
  settlePad: 0.35,
  transitionOut: 0.7,
  panDuration: 0.45,
  clusterGap: 1.2,
  minConfidence: 0.5,
  kinds: ['tap', 'longpress'],
};

/** Keeps the zoomed viewport inside the frame. */
export function clampCenter(v: number, scale: number): number {
  const half = 0.5 / scale;
  return Math.min(1 - half, Math.max(half, v));
}

export function planTapZoom(
  suggestions: TapSuggestion[],
  duration: number,
  options: Partial<TapZoomOptions> = {},
): FocusSegment[] {
  const o = { ...defaultTapZoom, ...options };
  if (!o.enabled || o.scale <= 1) return [];
  const sorted = [...suggestions].sort((a, b) => a.t - b.t);
  // Swipes and typing force a zoom-out: nothing may hold across them.
  const barriers = sorted.filter((s) => s.kind === 'swipe' || s.kind === 'typing').map((s) => s.t);
  const taps = sorted.filter((s) => o.kinds.includes(s.kind) && s.confidence >= o.minConfidence && s.t < duration);

  const segs: Array<FocusSegment & { tap: number; pansToNext?: boolean }> = [];
  for (const s of taps) {
    const hold = s.kind === 'longpress' ? (s.duration ?? 0) : 0;
    const inStart = Math.max(0, s.t - o.leadIn);
    const holdStart = Math.min(duration, inStart + o.transitionIn);
    let holdEnd = Math.max(s.t + hold + o.minHold, (s.settleT ?? s.t) + o.settlePad);
    const barrier = barriers.find((b) => b > s.t);
    if (barrier !== undefined) holdEnd = Math.min(holdEnd, barrier - 0.05);
    holdEnd = Math.min(duration, Math.max(holdStart, holdEnd));
    segs.push({
      tap: s.t,
      inStart,
      holdStart,
      holdEnd,
      outEnd: Math.min(duration, holdEnd + o.transitionOut),
      center: { x: clampCenter(s.x, o.scale), y: clampCenter(s.y, o.scale) },
      scale: o.scale,
    });
  }

  // Cluster: pan straight from one tap to the next when they are close in
  // time and nothing (swipe, typing) separates them.
  for (let i = 0; i + 1 < segs.length; i++) {
    const cur = segs[i];
    const next = segs[i + 1];
    const separated = barriers.some((b) => b > cur.tap && b < next.tap);
    if (separated || next.inStart - cur.holdEnd > o.clusterGap) continue;
    const panStart = Math.max(cur.holdStart, Math.min(cur.holdEnd, next.tap - o.leadIn));
    const panEnd = Math.min(duration, panStart + o.panDuration);
    cur.holdEnd = panStart;
    cur.outEnd = panEnd;
    cur.pansToNext = true;
    next.inStart = panStart;
    next.holdStart = Math.max(next.holdStart, panEnd);
    next.holdEnd = Math.max(next.holdEnd, next.holdStart);
    next.outEnd = Math.min(duration, Math.max(next.outEnd, next.holdEnd + o.transitionOut));
  }

  // Not clustered but overlapping (a swipe sits between them): finish the
  // glide out first. cameraAt treats any overlap as a pan, so the next glide
  // in starts only after the previous one has fully zoomed out.
  for (let i = 0; i + 1 < segs.length; i++) {
    const cur = segs[i];
    const next = segs[i + 1];
    if (!cur.pansToNext && cur.outEnd >= next.inStart) {
      next.inStart = cur.outEnd + 1e-3;
      next.holdStart = Math.max(next.holdStart, next.inStart + o.transitionIn * 0.6);
      next.holdEnd = Math.max(next.holdEnd, next.holdStart);
      next.outEnd = Math.max(next.outEnd, next.holdEnd + o.transitionOut);
    }
  }

  return segs
    .filter((s) => s.inStart < duration)
    .map(({ tap: _tap, pansToNext: _pan, ...seg }) => seg);
}
