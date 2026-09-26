import type { CaptionCue, Chapter } from './types';
import { isFillerWord } from './editcuts';

export interface ChapterOptions {
  /** Silence gap (s) between cues that starts a new chapter. */
  gapSec?: number;
  /** Shortest allowed chapter (s); shorter ones merge into the previous. */
  minLen?: number;
  /** Force a boundary when a chapter runs longer than this (s). */
  maxLen?: number;
  /** Cap on total chapters (smallest merge upward). */
  maxChapters?: number;
}

/** First clause-ish run of content words, trimmed for a chapter title. */
function titleFromText(text: string): string {
  const words = text
    .split(/\s+/)
    .filter((w) => w && !isFillerWord(w))
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.!?]+$/gu, ''))
    .filter(Boolean);
  let title = '';
  for (const w of words) {
    const next = title ? `${title} ${w}` : w;
    if (next.length > 42 || /[.!?]$/.test(w)) {
      title = next;
      break;
    }
    title = next;
    if (title.split(' ').length >= 7) break;
  }
  return title.replace(/\s+/g, ' ').trim();
}

/**
 * Heuristic auto-chapters from a transcript: a new chapter starts at the
 * first cue after a long pause, or when the current chapter overruns. Titles
 * come from the chapter's opening words. Runs entirely locally — no model.
 */
export function suggestChapters(
  cues: CaptionCue[],
  outputDuration: number,
  opts: ChapterOptions = {},
): Chapter[] {
  const gapSec = opts.gapSec ?? 2.0;
  const minLen = opts.minLen ?? 15;
  const maxLen = opts.maxLen ?? 90;
  const maxChapters = opts.maxChapters ?? 12;
  if (!cues.length || outputDuration <= 0) return [];

  const sorted = [...cues].sort((a, b) => a.start - b.start);
  let starts: number[] = [sorted[0].start];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].start - sorted[i - 1].end;
    const chapterLen = sorted[i].start - starts[starts.length - 1];
    if (gap >= gapSec || chapterLen >= maxLen) starts.push(sorted[i].start);
  }

  // Merge chapters that came out too short into their predecessor.
  let merged = starts;
  for (let i = 1; i < merged.length; i++) {
    const next = merged[i + 1] ?? outputDuration;
    if (merged[i] - merged[i - 1] < minLen && next - merged[i - 1] <= maxLen * 1.5) {
      merged.splice(i, 1);
      i--;
    }
  }
  // Cap the count by merging the shortest chapter forward.
  while (merged.length > maxChapters) {
    let best = 1;
    let bestLen = Infinity;
    for (let i = 1; i < merged.length; i++) {
      const len = (merged[i + 1] ?? outputDuration) - merged[i];
      if (len < bestLen) {
        bestLen = len;
        best = i;
      }
    }
    merged.splice(best, 1);
  }

  const cueTextAt = (t: number) => sorted.find((c) => c.start <= t && t < c.end) ?? sorted.find((c) => c.start >= t);
  return merged.map((start, i) => {
    const cue = cueTextAt(start);
    return {
      id: crypto.randomUUID(),
      start,
      title: (cue && titleFromText(cue.text)) || `Chapter ${i + 1}`,
    };
  });
}

/** A title for the whole video — the first chapter's title. */
export function suggestTitle(chapters: Chapter[]): string {
  return chapters[0]?.title ?? '';
}

/** YouTube-style `M:SS Title` lines (must start at 0:00 for YouTube). */
export function toChapterList(chapters: Chapter[]): string {
  const sorted = [...chapters].sort((a, b) => a.start - b.start);
  if (sorted.length && sorted[0].start > 0.5) {
    sorted.unshift({ id: 'intro', start: 0, title: 'Intro' });
  }
  return sorted
    .map((c) => {
      const m = Math.floor(c.start / 60);
      const s = Math.floor(c.start % 60);
      return `${m}:${String(s).padStart(2, '0')} ${c.title}`;
    })
    .join('\n');
}
