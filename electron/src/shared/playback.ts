// Preview playback driven by the timeline: the <video> element only knows
// source time, so every tick maps it to output time, hops over removed
// footage to the next clip, and sets the clip's speed. Pure, so it's tested.
import type { Clip } from './types';
import type { Timeline } from './timeline';

export interface ClipSpan {
  index: number;
  clip: Clip;
  /** Output-time range the clip occupies. */
  outStart: number;
  outEnd: number;
}

export function clipSpans(tl: Timeline): ClipSpan[] {
  let cursor = 0;
  return tl.clips.map((clip, index) => {
    const outStart = cursor;
    cursor += (clip.sourceEnd - clip.sourceStart) / Math.max(clip.speed, 1e-9);
    return { index, clip, outStart, outEnd: cursor };
  });
}

/**
 * Which clip plays at output time `outT`, and the source time to show.
 * Clamped to the timeline: past the end it is the last clip's final frame.
 */
export function locate(tl: Timeline, outT: number): { index: number; srcT: number } {
  const spans = clipSpans(tl);
  const t = Math.max(0, outT);
  for (const s of spans) {
    if (t < s.outEnd) {
      return { index: s.index, srcT: s.clip.sourceStart + (t - s.outStart) * s.clip.speed };
    }
  }
  const last = spans[spans.length - 1];
  return { index: last.index, srcT: last.clip.sourceEnd };
}

export type PlaybackTick =
  /** Keep playing clip `index`; `outT` is where the playhead is. */
  | { kind: 'play'; index: number; outT: number; rate: number }
  /** The clip ran out: seek the video to `seekTo` and play clip `index`. */
  | { kind: 'jump'; index: number; outT: number; seekTo: number; rate: number }
  /** The last clip ran out: pause with the playhead at the end. */
  | { kind: 'end'; outT: number };

/**
 * One step of playback. `index` is the clip being played (a source moment can
 * appear in several clips after a reorder, so the caller tracks it) and
 * `srcT` is the video's current time. `eps` absorbs the frame of overshoot a
 * rAF tick allows at a clip's end.
 */
export function playbackTick(tl: Timeline, index: number, srcT: number, eps = 1 / 120): PlaybackTick {
  const spans = clipSpans(tl);
  const span = spans[index];
  if (!span) return { kind: 'end', outT: tl.outputDuration };
  const { clip } = span;
  if (srcT >= clip.sourceEnd - eps) {
    const next = spans[index + 1];
    if (!next) return { kind: 'end', outT: span.outEnd };
    return {
      kind: 'jump',
      index: next.index,
      outT: next.outStart,
      seekTo: next.clip.sourceStart,
      rate: next.clip.speed,
    };
  }
  // The video wandered before this clip (a stray seek): pull it back in.
  if (srcT < clip.sourceStart - 0.25) {
    return { kind: 'jump', index, outT: span.outStart, seekTo: clip.sourceStart, rate: clip.speed };
  }
  const outT = span.outStart + Math.max(0, srcT - clip.sourceStart) / Math.max(clip.speed, 1e-9);
  return { kind: 'play', index, outT: Math.min(outT, span.outEnd), rate: clip.speed };
}

/** The media element's duration when it's usable. MediaRecorder WebM reports
 *  Infinity (no duration in the header), so fall back to the recorded one. */
export function mediaDuration(videoDuration: number, fallback: number): number {
  return Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : fallback;
}
