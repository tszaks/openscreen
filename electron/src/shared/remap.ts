// Every clip edit (delete, trim, speed, reorder, cut) changes where output
// time lands. Captions, text overlays, chapters and manual zooms are stored in
// output time, so each edit runs them through here: old output time → source
// time (old timeline) → output time (new timeline). Content whose footage was
// removed snaps to the nearest surviving moment, or is dropped when nothing
// of it survives.
import type { FocusSegment } from './autofocus';
import type { Annotation, CaptionCue, Chapter, Project, TranscriptWord } from './types';
import type { Timeline } from './timeline';
import { clipSpans } from './playback';

type Bias = 'start' | 'end';

interface Snap {
  /** Where the surviving moment sat on the old timeline. */
  oldOut: number;
  /** Where it sits on the new one. */
  newOut: number;
}

/**
 * Find the surviving moment nearest to old output time `t`: the first one at
 * or after it for 'start', the last one at or before it for 'end'. Walks the
 * old clips in output order, so a removed stretch snaps to the next (or
 * previous) footage the viewer would have seen.
 */
function snap(t: number, oldTl: Timeline, newTl: Timeline, bias: Bias): Snap | null {
  const oldSpans = clipSpans(oldTl);
  const newSpans = clipSpans(newTl);
  t = Math.min(Math.max(t, 0), oldTl.outputDuration);
  // At a clip boundary, 'start' belongs to the later clip and 'end' to the earlier.
  const at = oldSpans.findIndex((s) =>
    bias === 'start' ? t >= s.outStart && t < s.outEnd : t > s.outStart && t <= s.outEnd,
  );
  if (at < 0) return null;
  const step = bias === 'start' ? 1 : -1;
  for (let i = at; i >= 0 && i < oldSpans.length; i += step) {
    const o = oldSpans[i];
    const here = o.clip.sourceStart + (t - o.outStart) * o.clip.speed;
    const lo = i === at && bias === 'start' ? here : o.clip.sourceStart;
    const hi = i === at && bias === 'end' ? here : o.clip.sourceEnd;
    let best: { src: number; newOut: number } | null = null;
    for (const n of newSpans) {
      const a = Math.max(lo, n.clip.sourceStart);
      const b = Math.min(hi, n.clip.sourceEnd);
      if (b - a <= 1e-9) continue;
      const src = bias === 'start' ? a : b;
      if (best && (bias === 'start' ? src >= best.src : src <= best.src)) continue;
      best = { src, newOut: n.outStart + (src - n.clip.sourceStart) / Math.max(n.clip.speed, 1e-9) };
    }
    if (best) {
      return {
        oldOut: o.outStart + (best.src - o.clip.sourceStart) / Math.max(o.clip.speed, 1e-9),
        newOut: best.newOut,
      };
    }
  }
  return null;
}

/** Old output time → new output time; null when nothing from `t` on (or,
 *  for 'end', up to `t`) survives. */
export function remapTime(t: number, oldTl: Timeline, newTl: Timeline, bias: Bias = 'start'): number | null {
  return snap(t, oldTl, newTl, bias)?.newOut ?? null;
}

/** Remap an output-time range; null when less than `minLen` of it survives. */
export function remapRange(
  start: number,
  end: number,
  oldTl: Timeline,
  newTl: Timeline,
  minLen = 0.03,
): { start: number; end: number } | null {
  const s = snap(start, oldTl, newTl, 'start');
  const e = snap(end, oldTl, newTl, 'end');
  if (!s || !e) return null;
  // Snapped past each other on the old timeline: all of it was removed.
  if (e.oldOut - s.oldOut < minLen) return null;
  let ne = e.newOut;
  if (ne <= s.newOut) {
    // A reorder moved the range's tail ahead of its head: keep the part in
    // the head's clip.
    const span = clipSpans(newTl).find((c) => s.newOut >= c.outStart && s.newOut < c.outEnd);
    ne = Math.min(span?.outEnd ?? s.newOut, s.newOut + (end - start));
  }
  return ne - s.newOut < minLen ? null : { start: s.newOut, end: ne };
}

/** Captions follow their footage; cut words are dropped and the cue text
 *  rebuilt from the words that survive. */
export function remapCaptions(cues: CaptionCue[], oldTl: Timeline, newTl: Timeline): CaptionCue[] {
  const out: CaptionCue[] = [];
  for (const cue of cues) {
    const r = remapRange(cue.start, cue.end, oldTl, newTl);
    if (!r) continue;
    if (!cue.words?.length) {
      out.push({ ...cue, ...r });
      continue;
    }
    const words: TranscriptWord[] = [];
    for (const w of cue.words) {
      const wr = remapRange(w.start, w.end, oldTl, newTl, 0.02);
      if (wr) words.push({ ...wr, text: w.text });
    }
    if (!words.length) continue;
    out.push({ ...cue, ...r, text: words.map((w) => w.text).join(' '), words });
  }
  return out;
}

export function remapAnnotations(list: Annotation[], oldTl: Timeline, newTl: Timeline): Annotation[] {
  return list.flatMap((a) => {
    const r = remapRange(a.start, a.end, oldTl, newTl);
    return r ? [{ ...a, ...r }] : [];
  });
}

export function remapChapters(list: Chapter[], oldTl: Timeline, newTl: Timeline): Chapter[] {
  return list
    .flatMap((c) => {
      const start = remapTime(c.start, oldTl, newTl, 'start');
      return start === null ? [] : [{ ...c, start }];
    })
    .sort((a, b) => a.start - b.start);
}

/** A manual zoom moves with the moment it holds on; its glide timings stay. */
export function remapZooms(list: FocusSegment[], oldTl: Timeline, newTl: Timeline): FocusSegment[] {
  return list
    .flatMap((z) => {
      const hold = remapTime(z.holdStart, oldTl, newTl, 'start');
      if (hold === null) return [];
      const d = hold - z.holdStart;
      return [{ ...z, inStart: z.inStart + d, holdStart: hold, holdEnd: z.holdEnd + d, outEnd: z.outEnd + d }];
    })
    .sort((a, b) => a.inStart - b.inStart);
}

/** Apply a clip edit to the project: new clips, and everything stored in
 *  output time moved to match. */
export function remapProject(p: Project, oldTl: Timeline, newTl: Timeline): Project {
  return {
    ...p,
    clips: newTl.clips,
    captions: remapCaptions(p.captions, oldTl, newTl),
    annotations: remapAnnotations(p.annotations, oldTl, newTl),
    chapters: remapChapters(p.chapters, oldTl, newTl),
    manualZooms: remapZooms(p.manualZooms, oldTl, newTl),
  };
}
