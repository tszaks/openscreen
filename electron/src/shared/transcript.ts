import type { TranscriptWord } from './types';

/** whisper.cpp `--output-json-full` token shape (the fields we use). */
export interface WhisperToken {
  text?: string;
  /** Millisecond offsets relative to audio start. */
  offsets?: { from?: number; to?: number };
}

const SPECIAL = /^\[_.*\]$/;
const PUNCT_ONLY = /^[\p{P}\p{S}]+$/u;

/**
 * Merge whisper token stream into words with real timestamps. A token that
 * starts with whitespace begins a new word; punctuation and apostrophe
 * continuations glue onto the previous word. Special tokens ([_BEG_],
 * [_TT_70]) carry no speech and are dropped.
 */
export function tokensToWords(tokens: WhisperToken[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  // Zero-length tokens (common at silence boundaries) hold no timing, so their
  // text is parked in `pending` and folded into the next timed word — or glued
  // straight onto the current word when it's punctuation.
  let pending = '';
  for (const tok of tokens) {
    const text = tok.text ?? '';
    const trimmed = text.trim();
    if (!trimmed || SPECIAL.test(trimmed)) continue;
    const from = (tok.offsets?.from ?? 0) / 1000;
    const to = (tok.offsets?.to ?? 0) / 1000;
    const cur = words[words.length - 1];
    const glues =
      cur !== undefined && (/^['’]/.test(trimmed) || PUNCT_ONLY.test(trimmed));
    if (!(to > from)) {
      if (glues) cur.text += trimmed;
      else pending += pending && /^\s/.test(text) ? ' ' + trimmed : trimmed;
      continue;
    }
    const startsNew = !cur || (/^\s/.test(text) && !glues);
    if (startsNew) {
      const sep = pending && /^\s/.test(text) && !PUNCT_ONLY.test(trimmed) ? ' ' : '';
      words.push({ start: from, end: to, text: pending + sep + trimmed });
      pending = '';
    } else {
      cur.text += trimmed;
      cur.end = Math.max(cur.end, to);
    }
  }
  return words;
}

/** Strip a token down to letters/digits for matching ("Um," → "um"). */
export function bareWord(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}
