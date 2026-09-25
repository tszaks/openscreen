import { describe, expect, it } from 'vitest';
import { parseCaptions, toSrt } from '../src/shared/captions';

describe('parseCaptions', () => {
  it('parses SRT', () => {
    const srt = `1\n00:00:01,000 --> 00:00:03,500\nHello world\n\n2\n00:00:04,000 --> 00:00:05,250\nSecond line\nspans two\n`;
    const cues = parseCaptions(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0].start).toBe(1);
    expect(cues[0].end).toBe(3.5);
    expect(cues[0].text).toBe('Hello world');
    expect(cues[1].text).toBe('Second line spans two');
  });

  it('parses WebVTT with header and cue settings', () => {
    const vtt = `WEBVTT\n\ncue-1\n00:00:02.000 --> 00:00:04.000 align:center\n<b>Bold</b> text\n`;
    const cues = parseCaptions(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].start).toBe(2);
    expect(cues[0].text).toBe('Bold text');
  });

  it('drops malformed and empty blocks', () => {
    expect(parseCaptions('not\na caption\nfile')).toEqual([]);
  });

  it('round-trips through toSrt', () => {
    const cues = parseCaptions('1\n00:00:01,500 --> 00:00:02,000\nHi\n');
    const cues2 = parseCaptions(toSrt(cues));
    expect(cues2).toHaveLength(1);
    expect(cues2[0].text).toBe('Hi');
    expect(cues2[0].start).toBeCloseTo(1.5);
  });
});
