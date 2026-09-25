import type { CursorSample, Point, ZoomKeyframe } from './types';
import { butterEase, clamp01, lerp } from './easing';

export interface AutofocusOptions {
  /** Seconds before a click to start zooming in. */
  leadIn: number;
  /** Seconds after the last click of a cluster before zooming back out. */
  holdAfter: number;
  /** Max click spacing (s) merged into one zoom target. */
  clusterGap: number;
  /** Peak zoom scale. */
  maxScale: number;
  /** Normalized distance under which clicks share a zoom center. */
  mergeRadius: number;
  /** Minimum seconds a zoom-in transition takes (slower = heavier feel). */
  transitionIn: number;
  /** Minimum seconds a zoom-out transition takes. */
  transitionOut: number;
}

export const defaultAutofocus: AutofocusOptions = {
  leadIn: 0.25,
  holdAfter: 0.9,
  clusterGap: 1.2,
  maxScale: 2.0,
  mergeRadius: 0.08,
  transitionIn: 0.5,
  transitionOut: 0.7,
};

/**
 * Turns click history into camera segments — the auto-focus feature:
 * glide toward where clicks happen, hold while the user interacts,
 * settle back out. Unlike a raw keyframe list, this planner emits
 * *segments* with explicit transition windows so rendering can apply
 * per-transition easing (smootherstep) instead of linear ramps —
 * that's the "buttery" part: no corner accelerations, ever.
 */
export interface FocusSegment {
  /** Output-time window the camera is AT this focus (post-transition). */
  holdStart: number;
  holdEnd: number;
  /** Window the camera spends gliding INTO this segment. */
  inStart: number;
  /** Window the camera spends gliding back OUT (toward next segment or 1x). */
  outEnd: number;
  center: Point;
  scale: number;
}

export class AutofocusPlanner {
  constructor(public options: AutofocusOptions = defaultAutofocus) {}

  /** Cluster clicks close in time AND space into focus targets. */
  planSegments(clicks: CursorSample[], duration: number): FocusSegment[] {
    const downs = clicks.filter((c) => c.kind === 'clickDown').sort((a, b) => a.time - b.time);
    if (downs.length === 0) return [];

    const clusters: CursorSample[][] = [];
    for (const click of downs) {
      const lastCluster = clusters[clusters.length - 1];
      const lastClick = lastCluster?.[lastCluster.length - 1];
      if (
        lastClick &&
        click.time - lastClick.time <= this.options.clusterGap &&
        Math.hypot(click.x - lastClick.x, click.y - lastClick.y) <= this.options.mergeRadius
      ) {
        lastCluster.push(click);
      } else {
        clusters.push([click]);
      }
    }

    const segments: FocusSegment[] = clusters.map((cluster) => {
      const first = cluster[0];
      const last = cluster[cluster.length - 1];
      const center = {
        x: cluster.reduce((s, c) => s + c.x, 0) / cluster.length,
        y: cluster.reduce((s, c) => s + c.y, 0) / cluster.length,
      };
      const inStart = Math.max(0, first.time - this.options.leadIn);
      const holdStart = Math.min(duration, first.time + this.options.transitionIn * 0.5);
      const holdEnd = Math.min(duration, last.time + this.options.holdAfter);
      const outEnd = Math.min(duration, holdEnd + this.options.transitionOut);
      return { inStart, holdStart, holdEnd, outEnd, center, scale: this.options.maxScale };
    });
    return segments;
  }

  /** Compatibility: collapse segments to a plain keyframe list. */
  plan(clicks: CursorSample[], duration: number): ZoomKeyframe[] {
    const keys: ZoomKeyframe[] = [{ time: 0, center: { x: 0.5, y: 0.5 }, scale: 1 }];
    for (const seg of this.planSegments(clicks, duration)) {
      keys.push({ time: seg.inStart, center: seg.center, scale: seg.scale });
      keys.push({ time: seg.holdEnd, center: seg.center, scale: 1 });
    }
    keys.push({ time: duration, center: { x: 0.5, y: 0.5 }, scale: 1 });
    return keys.sort((a, b) => a.time - b.time);
  }
}

/**
 * Camera state at output `time`, evaluated over focus segments with
 * per-transition butter easing. Adjacent zoomed segments blend into a
 * continuous pan (no zoom-out detour) — that's what makes consecutive
 * clicks feel like one gliding move instead of a pulse.
 */
export function cameraAt(
  time: number,
  segments: FocusSegment[],
  opts: AutofocusOptions = defaultAutofocus,
): { center: Point; scale: number } {
  const idle = { center: { x: 0.5, y: 0.5 }, scale: 1 };
  if (segments.length === 0) return idle;

  // Before the first segment's glide-in.
  if (time < segments[0].inStart) return idle;
  // After the last segment's glide-out.
  if (time > segments[segments.length - 1].outEnd) return idle;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const next = segments[i + 1];

    // Gliding into this segment (from previous state — or idle).
    if (time < seg.holdStart) {
      // Anchor = camera state the instant this glide begins.
      const from = i === 0 ? idle : cameraAt(seg.inStart - 1e-9, segments, opts);
      const t = clamp01((time - seg.inStart) / Math.max(seg.holdStart - seg.inStart, 1e-6));
      const e = butterEase(t);
      return {
        center: { x: lerp(from.center.x, seg.center.x, e), y: lerp(from.center.y, seg.center.y, e) },
        scale: lerp(from.scale, seg.scale, e),
      };
    }

    // Holding at this segment.
    if (time < seg.holdEnd) return { center: seg.center, scale: seg.scale };

    // Gliding out — to next segment's focus if close, else back to idle.
    const outTarget = next && seg.outEnd >= next.inStart ? next : idle;
    if (time <= seg.outEnd) {
      const t = clamp01((time - seg.holdEnd) / Math.max(seg.outEnd - seg.holdEnd, 1e-6));
      const e = butterEase(t);
      return {
        center: {
          x: lerp(seg.center.x, outTarget.center.x, e),
          y: lerp(seg.center.y, outTarget.center.y, e),
        },
        scale: lerp(seg.scale, outTarget.scale, e),
      };
    }
  }
  return idle;
}
