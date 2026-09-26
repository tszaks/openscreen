import { describe, expect, it } from 'vitest';
import {
  clamp,
  decimalsOf,
  effectiveStep,
  formatScrubValue,
  normalizeValue,
  nudgeValue,
  parseScrubInput,
  roundTo,
  scrubDelta,
  stepMultiplier,
} from '../src/shared/scrub';
import { estimateRemainingMs, formatClock, formatEta, percentDone } from '../src/shared/exportProgress';

describe('decimalsOf / roundTo', () => {
  it('counts decimals, including exponent notation', () => {
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.1)).toBe(1);
    expect(decimalsOf(0.25)).toBe(2);
    expect(decimalsOf(1e-7)).toBe(7);
    expect(decimalsOf(5e3)).toBe(0);
  });

  it('rounds without float drift', () => {
    expect(roundTo(0.1 + 0.2, 1)).toBe(0.3);
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(1.6000000000000003, 1)).toBe(1.6);
    expect(roundTo(-0.04, 1)).toBe(0);
    expect(Object.is(roundTo(-0.04, 1), -0)).toBe(false);
  });
});

describe('normalizeValue', () => {
  it('keeps 1.6 at step 0.1 (the Math.round bug turned it into 2)', () => {
    expect(normalizeValue(1.6, { min: 1, max: 4, step: 0.1 })).toBe(1.6);
    expect(normalizeValue(1.6000000000000003, { min: 1, max: 4, step: 0.1 })).toBe(1.6);
  });

  it('keeps 0.35 at step 0.01', () => {
    expect(normalizeValue(0.35, { min: 0, max: 1, step: 0.01 })).toBe(0.35);
    expect(normalizeValue(0.35499999, { min: 0, max: 1, step: 0.01 })).toBe(0.35);
  });

  it('rounds to the step precision', () => {
    expect(normalizeValue(1.64, { step: 0.1 })).toBe(1.6);
    expect(normalizeValue(1.65, { step: 0.1 })).toBe(1.7);
    expect(normalizeValue(24.4, { step: 1 })).toBe(24);
  });

  it('clamps to min and max', () => {
    expect(normalizeValue(5, { min: 1, max: 4, step: 0.1 })).toBe(4);
    expect(normalizeValue(-3, { min: 0, max: 100, step: 1 })).toBe(0);
    expect(clamp(7)).toBe(7);
  });

  it('falls back to min for non-finite input', () => {
    expect(normalizeValue(Number.NaN, { min: 2, max: 9 })).toBe(2);
  });
});

describe('modifiers', () => {
  it('Shift is 10x, Alt is 0.1x, Shift wins', () => {
    expect(stepMultiplier()).toBe(1);
    expect(stepMultiplier({ shiftKey: true })).toBe(10);
    expect(stepMultiplier({ altKey: true })).toBe(0.1);
    expect(stepMultiplier({ shiftKey: true, altKey: true })).toBe(10);
  });

  it('gives exact effective steps', () => {
    expect(effectiveStep(0.1, { altKey: true })).toBe(0.01);
    expect(effectiveStep(0.1, { shiftKey: true })).toBe(1);
    expect(effectiveStep(0.01, { altKey: true })).toBe(0.001);
    expect(effectiveStep(1, { altKey: true })).toBe(0.1);
  });

  it('nudges by the modified step without drift', () => {
    const zoom = { min: 1, max: 4, step: 0.1 };
    expect(nudgeValue(1.6, 1, zoom)).toBe(1.7);
    expect(nudgeValue(1.6, -1, zoom)).toBe(1.5);
    expect(nudgeValue(1.6, 1, zoom, { shiftKey: true })).toBe(2.6);
    expect(nudgeValue(1.6, 1, zoom, { altKey: true })).toBe(1.61);
    expect(nudgeValue(3.5, 1, zoom, { shiftKey: true })).toBe(4);
    expect(nudgeValue(0.35, 1, { min: 0, max: 1, step: 0.01 })).toBe(0.36);
    expect(nudgeValue(24, 1, { step: 1 }, { altKey: true })).toBe(24.1);
  });

  it('adds up many tiny steps without drift', () => {
    let v = 0;
    for (let i = 0; i < 10; i++) v = nudgeValue(v, 1, { step: 0.1 });
    expect(v).toBe(1);
  });
});

describe('scrubDelta', () => {
  it('moves one step per two pixels by default, scaled by modifiers', () => {
    expect(scrubDelta(2, 1)).toBe(1);
    expect(scrubDelta(-4, 0.1)).toBeCloseTo(-0.2);
    expect(scrubDelta(2, 1, { shiftKey: true })).toBe(10);
    expect(scrubDelta(2, 1, { altKey: true })).toBeCloseTo(0.1);
    expect(scrubDelta(1, 1, {}, 2)).toBe(2);
  });
});

describe('format / parse', () => {
  it('formats at the fine (Alt) precision with trailing zeros trimmed', () => {
    expect(formatScrubValue(1.6, 0.1)).toBe('1.6');
    expect(formatScrubValue(1.63, 0.1)).toBe('1.63');
    expect(formatScrubValue(1.6000000000000003, 0.1)).toBe('1.6');
    expect(formatScrubValue(24, 1)).toBe('24');
    expect(formatScrubValue(2, 0.1)).toBe('2');
    expect(formatScrubValue(0.35, 0.01)).toBe('0.35');
  });

  it('parses typed values with units', () => {
    expect(parseScrubInput('1.6')).toBe(1.6);
    expect(parseScrubInput(' 24px ')).toBe(24);
    expect(parseScrubInput('1.6×')).toBe(1.6);
    expect(parseScrubInput('-.5')).toBe(-0.5);
    expect(parseScrubInput('1,200')).toBe(1200);
    expect(parseScrubInput('−3')).toBe(-3);
    expect(parseScrubInput('abc')).toBeNull();
    expect(parseScrubInput('')).toBeNull();
  });
});

describe('export progress math', () => {
  it('formats m:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(7_900)).toBe('0:07');
    expect(formatClock(83_000)).toBe('1:23');
    expect(formatClock(3_725_000)).toBe('62:05');
    expect(formatClock(-50)).toBe('0:00');
  });

  it('floors percent and guards a zero total', () => {
    expect(percentDone(0, 0)).toBe(0);
    expect(percentDone(2999, 3000)).toBe(99);
    expect(percentDone(3000, 3000)).toBe(100);
    expect(percentDone(1, 3)).toBe(33);
  });

  it('withholds the ETA until the rate is stable', () => {
    expect(estimateRemainingMs(10, 3000, 1000)).toBeNull(); // too early
    expect(estimateRemainingMs(50, 3000, 10_000)).toBeNull(); // under 3% done
    expect(estimateRemainingMs(3000, 3000, 60_000)).toBeNull(); // finished
    expect(estimateRemainingMs(1000, 3000, 20_000)).toBe(40_000);
  });

  it('phrases the ETA', () => {
    expect(formatEta(65_000)).toBe('About 1:05 left');
    expect(formatEta(4_000)).toBe('Almost done');
  });
});
