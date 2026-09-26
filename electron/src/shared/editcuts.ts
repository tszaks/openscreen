import type { TranscriptWord } from './types';
import { bareWord } from './transcript';
import type { Timeline } from './timeline';

export interface TimeRange {
  start: number;
  end: number;
}

/** A proposed span of dead air or filler to remove, in source time. */
export interface CutProposal extends TimeRange {
  kind: 'silence' | 'filler';
  label: string;
}

/** Whole-word fillers — matched against the stripped word, not substrings. */
export const FILLER_WORD = /^(?:um+|uh+|er+|eh+|ah+|hmm+|mm+|mhm+)$/;

export const isFillerWord = (text: string) => FILLER_WORD.test(bareWord(text));

/** Union-merge overlapping/adjacent ranges. */
export function mergeRanges(ranges: TimeRange[], joinGap = 0): TimeRange[] {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + joinGap) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

/**
 * Smallest source time ≥ t that survives `removed`. Returns sourceDuration
 * when everything from t on is cut.
 */
export function firstKeptAtOrAfter(
  t: number,
  removed: TimeRange[],
  sourceDuration: number,
): number {
  let s = t;
  for (const r of removed) {
    if (r.end <= s) continue;
    if (r.start > s) break;
    s = r.end; // t inside this range — jump past it
  }
  return Math.min(s, sourceDuration);
}

/** Largest source time ≤ t that survives `removed`. */
export function lastKeptAtOrBefore(t: number, removed: TimeRange[]): number {
  let e = t;
  for (let i = removed.length - 1; i >= 0; i--) {
    const r = removed[i];
    if (r.start >= e) continue;
    if (r.end < e) break;
    e = r.start;
  }
  return Math.max(e, 0);
}

/** Source-time ranges not covered by any clip on the timeline (already cut). */
export function removedRanges(tl: Timeline): TimeRange[] {
  const cov = mergeRanges(tl.clips.map((c) => ({ start: c.sourceStart, end: c.sourceEnd })));
  const out: TimeRange[] = [];
  let cur = 0;
  for (const r of cov) {
    if (r.start > cur) out.push({ start: cur, end: r.start });
    cur = Math.max(cur, r.end);
  }
  if (cur < tl.sourceDuration) out.push({ start: cur, end: tl.sourceDuration });
  return out;
}

export interface SmartCutOptions {
  /** silencedetect ranges (source time). */
  silences: TimeRange[];
  /** Word-level transcript (source time) — enables word-precise filler cuts. */
  words?: TranscriptWord[];
  /** Whole-cue filler ranges (source time) — fallback when no word data. */
  fillerCues?: TimeRange[];
  sourceDuration: number;
  /** Shave each silence edge so we don't clip speech onsets/breaths. */
  silenceInset?: number;
  /** Drop silences shorter than this after insetting. */
  minSilence?: number;
  /** Extra padding around a filler word. */
  fillerPad?: number;
}

/**
 * Combine detected silences and filler words into labeled cut proposals.
 * Overlaps merge; a filler reason outranks silence in the merged label.
 */
export function planSmartCuts(opts: SmartCutOptions): CutProposal[] {
  const inset = opts.silenceInset ?? 0.1;
  const minSilence = opts.minSilence ?? 0.25;
  const pad = opts.fillerPad ?? 0.08;

  const proposals: CutProposal[] = [];
  for (const s of opts.silences) {
    const start = s.start + inset;
    const end = s.end - inset;
    if (end - start >= minSilence) {
      proposals.push({ start, end, kind: 'silence', label: `${(end - start).toFixed(1)}s` });
    }
  }

  if (opts.words?.length) {
    const ws = [...opts.words].sort((a, b) => a.start - b.start);
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (!isFillerWord(w.text)) continue;
      // Pad, but never past the neighboring words — don't eat real speech.
      const start = Math.max(0, w.start - pad, i > 0 ? ws[i - 1].end : 0);
      const end = Math.min(
        opts.sourceDuration,
        w.end + pad,
        i + 1 < ws.length ? ws[i + 1].start : opts.sourceDuration,
      );
      if (end > start) proposals.push({ start, end, kind: 'filler', label: `“${w.text}”` });
    }
  } else {
    for (const c of opts.fillerCues ?? []) {
      if (c.end > c.start) proposals.push({ ...c, kind: 'filler', label: 'filler cue' });
    }
  }

  // Merge overlapping/nearby proposals (e.g. a filler inside a silence, or
  // right at its edge). Labels keep both reasons: `"uh" + 2.3s`.
  const joinGap = 0.15;
  const sorted = proposals.sort((a, b) => a.start - b.start);
  interface Merged extends CutProposal {
    fillers: string[];
    silenceSecs: number;
  }
  const merged: Merged[] = [];
  for (const p of sorted) {
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end + joinGap) {
      last.end = Math.max(last.end, p.end);
      if (p.kind === 'filler') last.fillers.push(p.label.replace(/[“”]/g, ''));
      else last.silenceSecs += p.end - p.start;
      last.kind = last.fillers.length ? 'filler' : 'silence';
      const parts = last.fillers.map((f) => `“${f}”`);
      if (last.silenceSecs > 0) parts.push(`${last.silenceSecs.toFixed(1)}s`);
      last.label = parts.join(' + ');
    } else {
      merged.push({
        ...p,
        fillers: p.kind === 'filler' ? [p.label.replace(/[“”]/g, '')] : [],
        silenceSecs: p.kind === 'silence' ? p.end - p.start : 0,
      });
    }
  }
  return merged.map(({ fillers: _f, silenceSecs: _s, ...p }) => p);
}
