import { describe, expect, it } from 'vitest';
import { suggestChapters, toChapterList } from '../src/shared/chapters';

const cue = (start: number, end: number, text: string) => ({ id: 'x', start, end, text });

describe('suggestChapters', () => {
  it('starts a new chapter after a long gap', () => {
    const cues = [
      cue(0, 5, 'Welcome to the demo'),
      cue(6, 10, 'here we go'),
      // 4s gap
      cue(14, 20, 'Now the settings page'),
      cue(21, 25, 'and more'),
    ];
    const ch = suggestChapters(cues, 60, { minLen: 0 });
    expect(ch).toHaveLength(2);
    expect(ch[0].start).toBe(0);
    expect(ch[0].title).toBe('Welcome to the demo');
    expect(ch[1].start).toBe(14);
    expect(ch[1].title).toBe('Now the settings page');
  });

  it('splits an over-long chapter even without gaps', () => {
    const cues = Array.from({ length: 20 }, (_, i) => cue(i * 6, i * 6 + 5, `part ${i}`));
    const ch = suggestChapters(cues, 120, { gapSec: 60, maxLen: 30, minLen: 0 });
    expect(ch.length).toBeGreaterThan(1);
  });

  it('merges chapters shorter than minLen', () => {
    const cues = [
      cue(0, 3, 'Hi there'),
      cue(6, 8, 'quick aside'), // gap 3s but resulting chapter only 5s
      cue(40, 50, 'the real content begins here'),
      cue(52, 58, 'and continues'),
    ];
    const ch = suggestChapters(cues, 60, { gapSec: 2, minLen: 15 });
    // 'quick aside' merged forward into chapter 1
    expect(ch.length).toBeLessThan(3);
  });

  it('strips filler words and caps title length', () => {
    const ch = suggestChapters([cue(0, 5, 'Um uh welcome to this recorder demo today')], 30);
    expect(ch[0].title).not.toMatch(/um|uh/i);
    expect(ch[0].title.length).toBeLessThanOrEqual(45);
  });

  it('returns [] with no cues', () => {
    expect(suggestChapters([], 60)).toEqual([]);
  });
});

describe('toChapterList', () => {
  it('emits M:SS lines, prepending Intro when the first chapter starts late', () => {
    const list = toChapterList([
      { id: 'a', start: 75.4, title: 'Main part' },
      { id: 'b', start: 5, title: 'Setup' },
    ]);
    expect(list).toBe('0:00 Intro\n0:05 Setup\n1:15 Main part');
  });
});
