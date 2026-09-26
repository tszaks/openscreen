import { describe, expect, it } from 'vitest';
import {
  planSmartCuts,
  mergeRanges,
  removedRanges,
  firstKeptAtOrAfter,
  lastKeptAtOrBefore,
  isFillerWord,
} from '../src/shared/editcuts';
import { Timeline } from '../src/shared/timeline';
import { remapCaptions } from '../src/shared/remap';

describe('isFillerWord', () => {
  it('matches fillers, not lookalikes', () => {
    expect(isFillerWord('Um,')).toBe(true);
    expect(isFillerWord('hmm')).toBe(true);
    expect(isFillerWord('UH')).toBe(true);
    expect(isFillerWord('summer')).toBe(false); // contains "um" but isn't one
    expect(isFillerWord('the')).toBe(false);
  });
});

describe('planSmartCuts', () => {
  it('insets silence edges and drops what is left under minSilence', () => {
    const props = planSmartCuts({
      silences: [{ start: 10, end: 12 }], // 2s silence → 1.8s cut after inset
      sourceDuration: 60,
      silenceInset: 0.1,
      minSilence: 0.25,
    });
    expect(props).toHaveLength(1);
    expect(props[0].kind).toBe('silence');
    expect(props[0].start).toBeCloseTo(10.1);
    expect(props[0].end).toBeCloseTo(11.9);
  });

  it('pads word-level fillers and clamps to the source', () => {
    const props = planSmartCuts({
      silences: [],
      words: [
        { start: 0.02, end: 0.05, text: 'Um,' }, // near start → clamps at 0
        { start: 5, end: 5.4, text: 'uh' },
        { start: 6, end: 6.3, text: 'show' },
      ],
      sourceDuration: 60,
      fillerPad: 0.1,
    });
    expect(props).toHaveLength(2);
    expect(props[0].kind).toBe('filler');
    expect(props[0].start).toBe(0);
    expect(props[1].start).toBeCloseTo(4.9);
    expect(props[1].end).toBeCloseTo(5.5);
  });

  it('merges a filler inside a silence into one proposal', () => {
    const props = planSmartCuts({
      silences: [{ start: 3, end: 6 }],
      words: [{ start: 4, end: 4.4, text: 'um' }],
      sourceDuration: 60,
      silenceInset: 0,
      fillerPad: 0.1,
    });
    expect(props).toHaveLength(1);
    expect(props[0].kind).toBe('filler'); // the more specific reason wins
    expect(props[0].start).toBeCloseTo(3);
    expect(props[0].end).toBeCloseTo(6);
    expect(props[0].label).toContain('um');
  });

  it('falls back to whole-cue filler ranges when no words exist', () => {
    const props = planSmartCuts({
      silences: [],
      fillerCues: [{ start: 2, end: 3 }],
      sourceDuration: 60,
    });
    expect(props).toEqual([{ start: 2, end: 3, kind: 'filler', label: 'filler cue' }]);
  });
});

describe('range helpers', () => {
  it('mergeRanges unions overlaps and touching gaps', () => {
    expect(mergeRanges([{ start: 5, end: 8 }, { start: 1, end: 3 }, { start: 7, end: 9 }]))
      .toEqual([{ start: 1, end: 3 }, { start: 5, end: 9 }]);
  });

  it('removedRanges reports the complement of clip coverage', () => {
    const tl = new Timeline(100, [
      { id: 'a', sourceStart: 10, sourceEnd: 40, speed: 1 },
      { id: 'b', sourceStart: 50, sourceEnd: 90, speed: 1 },
    ]);
    expect(removedRanges(tl)).toEqual([
      { start: 0, end: 10 },
      { start: 40, end: 50 },
      { start: 90, end: 100 },
    ]);
  });

  it('firstKeptAtOrAfter jumps out of a removed range', () => {
    const removed = [{ start: 10, end: 20 }, { start: 30, end: 40 }];
    expect(firstKeptAtOrAfter(5, removed, 100)).toBe(5);
    expect(firstKeptAtOrAfter(15, removed, 100)).toBe(20);
    expect(firstKeptAtOrAfter(95, removed, 100)).toBe(95);
    expect(firstKeptAtOrAfter(35, removed, 100)).toBe(40);
  });

  it('lastKeptAtOrBefore backs out of a removed range', () => {
    const removed = [{ start: 10, end: 20 }];
    expect(lastKeptAtOrBefore(5, removed)).toBe(5);
    expect(lastKeptAtOrBefore(15, removed)).toBe(10);
    expect(lastKeptAtOrBefore(50, removed)).toBe(50);
  });
});

describe('remapCaptions (cuts)', () => {
  const words = (xs: [number, number, string][]) =>
    xs.map(([start, end, text]) => ({ start, end, text }));

  it('shifts cues after a cut and drops cues fully inside it', () => {
    const oldTl = new Timeline(60); // single 0-60 clip
    const newTl = new Timeline(60);
    newTl.cutRanges([{ start: 10, end: 20 }]);
    const cues = [
      { id: 'a', start: 0, end: 5, text: 'before' },
      { id: 'b', start: 12, end: 15, text: 'inside the cut' },
      { id: 'c', start: 30, end: 35, text: 'after' },
    ];
    const out = remapCaptions(cues, oldTl, newTl);
    expect(out.map((c) => c.id)).toEqual(['a', 'c']);
    expect(out[0].start).toBeCloseTo(0);
    expect(out[1].start).toBeCloseTo(20); // 30s source → 20s output after cutting 10s
  });

  it('clamps a cue that straddles a cut boundary', () => {
    const oldTl = new Timeline(60);
    const newTl = new Timeline(60);
    newTl.cutRanges([{ start: 10, end: 20 }]);
    const cues = [{ id: 'x', start: 8, end: 25, text: 'straddles' }];
    const out = remapCaptions(cues, oldTl, newTl);
    expect(out).toHaveLength(1);
    expect(out[0].start).toBeCloseTo(8);
    expect(out[0].end).toBeCloseTo(15); // source 25 → output 15
  });

  it('drops cut words and rebuilds cue text', () => {
    const oldTl = new Timeline(60);
    const newTl = new Timeline(60);
    newTl.cutRanges([{ start: 1.4, end: 1.8 }]); // the "Um," word
    const cues = [
      {
        id: 'a',
        start: 1.4,
        end: 4,
        text: 'Um, today I will',
        words: words([
          [1.43, 1.75, 'Um,'],
          [1.9, 2.1, 'today'],
          [2.2, 2.4, 'I'],
          [2.5, 4.0, 'will'],
        ]),
      },
    ];
    const out = remapCaptions(cues, oldTl, newTl);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('today I will');
    expect(out[0].words).toHaveLength(3);
    // 'today' source 1.9 → output 1.9 - 0.4 removed = 1.5
    expect(out[0].words![0].start).toBeCloseTo(1.5);
  });

  it('drops a cue whose words were all cut', () => {
    const oldTl = new Timeline(60);
    const newTl = new Timeline(60);
    newTl.cutRanges([{ start: 5, end: 10 }]);
    const cues = [
      { id: 'a', start: 5.1, end: 9, text: 'Um uh', words: words([[5.1, 6, 'Um'], [7, 8.5, 'uh']]) },
    ];
    expect(remapCaptions(cues, oldTl, newTl)).toHaveLength(0);
  });
});
