import { describe, expect, it } from 'vitest';
import { ffmpegArgsFor, getPreset } from '../src/shared/exportPresets';

describe('loudness normalization on silent audio', () => {
  const social = getPreset('social-9x16');
  it('normalizes audible audio on a loudness-targeted preset', () => {
    const args = ffmpegArgsFor(social, { input: 'in.mov', output: 'out.mp4', hasAudio: true });
    expect(args.some((a) => a.startsWith('loudnorm='))).toBe(true);
  });
  it('skips loudnorm when the audio is digital silence', () => {
    const args = ffmpegArgsFor(social, { input: 'in.mov', output: 'out.mp4', hasAudio: true, audible: false });
    expect(args.some((a) => a.startsWith('loudnorm='))).toBe(false);
    expect(args).toContain('aac');
  });
});
