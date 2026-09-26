import { describe, expect, it } from 'vitest';
import { tokensToWords, bareWord } from '../src/shared/transcript';

describe('tokensToWords', () => {
  it('merges sub-word tokens and punctuation into words with ms→s times', () => {
    const words = tokensToWords([
      { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
      { text: ' Welcome', offsets: { from: 30, to: 380 } },
      { text: ' to', offsets: { from: 450, to: 510 } },
      { text: ' this', offsets: { from: 510, to: 750 } },
      { text: ' demo', offsets: { from: 750, to: 1000 } },
      { text: '.', offsets: { from: 1000, to: 1400 } },
      { text: '[_TT_70]', offsets: { from: 1400, to: 1400 } },
      { text: ' Um', offsets: { from: 1430, to: 1730 } },
      { text: ',', offsets: { from: 1730, to: 1750 } },
    ]);
    expect(words.map((w) => w.text)).toEqual(['Welcome', 'to', 'this', 'demo.', 'Um,']);
    expect(words[0].start).toBeCloseTo(0.03);
    expect(words[0].end).toBeCloseTo(0.38);
    expect(words[3].end).toBeCloseTo(1.4); // punctuation extends the word
    expect(words[4].start).toBeCloseTo(1.43);
  });

  it('glues apostrophe continuations onto the previous word', () => {
    const words = tokensToWords([
      { text: ' It', offsets: { from: 0, to: 100 } },
      { text: "'s", offsets: { from: 100, to: 200 } },
      { text: ' fine', offsets: { from: 200, to: 400 } },
    ]);
    expect(words.map((w) => w.text)).toEqual(["It's", 'fine']);
  });

  it('drops special and zero-length tokens', () => {
    const words = tokensToWords([
      { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
      { text: '[_TT_0]', offsets: { from: 0, to: 0 } },
      { text: ' Go', offsets: { from: 0, to: 300 } },
    ]);
    expect(words).toHaveLength(1);
    expect(words[0].text).toBe('Go');
  });

  it('folds zero-length token text into the next timed word', () => {
    // whisper emits zero-length `from`/`to` tokens at silence boundaries —
    // their text must survive or fillers like "Uh" are lost entirely.
    const words = tokensToWords([
      { text: ' Uh', offsets: { from: 4160, to: 4160 } },
      { text: ',', offsets: { from: 4160, to: 4440 } },
      { text: ' let', offsets: { from: 4770, to: 4770 } },
      { text: ' me', offsets: { from: 4850, to: 4910 } },
    ]);
    expect(words.map((w) => w.text)).toEqual(['Uh,', 'let me']);
    expect(words[0].start).toBeCloseTo(4.16);
    expect(words[0].end).toBeCloseTo(4.44);
  });
});

describe('bareWord', () => {
  it('strips punctuation and lowercases', () => {
    expect(bareWord('  "Um,"  ')).toBe('um');
    expect(bareWord('Hmm.')).toBe('hmm');
    expect(bareWord('word')).toBe('word');
  });
});
