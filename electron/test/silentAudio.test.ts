import { describe, expect, it } from 'vitest';
import { parseMaxVolume, SILENT_PEAK_DB } from '../src/node/media';

describe('parseMaxVolume', () => {
  it('reads max_volume from volumedetect output', () => {
    const out = '[Parsed_volumedetect_0 @ 0x1] mean_volume: -91.0 dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: -91.0 dB\n';
    expect(parseMaxVolume(out)).toBe(-91);
    expect(parseMaxVolume(out)! < SILENT_PEAK_DB).toBe(true);
  });
  it('treats normal speech as audible', () => {
    expect(parseMaxVolume('max_volume: -3.2 dB')! < SILENT_PEAK_DB).toBe(false);
  });
  it('returns null when there is no measurement', () => {
    expect(parseMaxVolume('no audio stream')).toBeNull();
  });
});
