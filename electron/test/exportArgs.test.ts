import { describe, expect, it } from 'vitest';
import {
  FFMPEG_MISSING,
  buildExportArgs,
  evenDimension,
  exportCanvasSize,
  ffmpegFailure,
  ipcErrorMessage,
} from '../src/shared/exportArgs';

const filterOf = (argv: string[]) => argv[argv.indexOf('-filter_complex') + 1] ?? '';
const mappedAudio = (argv: string[]) => argv.filter((_, i) => argv[i - 1] === '-map')[1];

describe('exportCanvasSize (BH-03)', () => {
  it('rounds a 3024x1964 display at 1080p to an even width', () => {
    // old code: Math.round(1080 * 3024 / 1964) = 1663, which libx264 rejects
    expect(exportCanvasSize({ width: 3024, height: 1964 }, 'p1080')).toEqual({ width: 1662, height: 1080 });
  });

  it('keeps both sides even for odd window recordings, including Original', () => {
    for (const src of [{ width: 1011, height: 677 }, { width: 1273, height: 841 }, { width: 3, height: 1 }]) {
      for (const preset of ['p1080', 'uhd4k', 'original'] as const) {
        const { width, height } = exportCanvasSize(src, preset);
        expect(width % 2, `${src.width}x${src.height} ${preset}`).toBe(0);
        expect(height % 2, `${src.width}x${src.height} ${preset}`).toBe(0);
      }
    }
  });

  it('never rounds to zero', () => {
    expect(evenDimension(0.4)).toBe(2);
    expect(evenDimension(1663)).toBe(1664);
    expect(evenDimension(1662.4)).toBe(1662);
  });
});

describe('buildExportArgs', () => {
  const base = { outPath: '/o.mp4', w: 1662, h: 1080, fps: 30, duration: 6 };
  const BED = 'anullsrc=r=48000:cl=stereo:d=6.000[bed]';

  it('lays a click-only sfx track over a bed as long as the video, with no -shortest (BH-02)', () => {
    const argv = buildExportArgs({ ...base, audioIn: '/in.mp4', hasAudio: false, clicks: [0.5, 1] });
    // old argv: -map [sfx] + -shortest, which ended the file at the last click
    expect(argv).not.toContain('-shortest');
    expect(mappedAudio(argv)).toBe('[aout]');
    expect(filterOf(argv)).toContain(`${BED};[bed][sfx]amix=inputs=2:duration=first:normalize=0[aout]`);
    // lavfi tick is input 2 when audioIn is passed, even without an audio stream
    expect(filterOf(argv)).toMatch(/^\[2:a\]anull\[sfxin\]/);
  });

  it('mixes program audio and clicks over the bed', () => {
    const argv = buildExportArgs({ ...base, audioIn: '/in.mp4', hasAudio: true, clicks: [1] });
    expect(filterOf(argv)).toMatch(/\[bed\]\[1:a\]\[sfx\]amix=inputs=3:duration=first:normalize=0\[aout\]$/);
    expect(argv).not.toContain('-shortest');
  });

  it('uses cut-timeline program audio', () => {
    const argv = buildExportArgs({
      ...base,
      audioIn: '/in.mp4',
      hasAudio: true,
      audioClips: [{ start: 0, end: 1, speed: 2 }],
    });
    expect(filterOf(argv)).toMatch(/concat=n=1:v=0:a=1\[prog\];anullsrc.*\[bed\]\[prog\]amix=inputs=2/);
  });

  it('bounds identity audio to the video too', () => {
    const argv = buildExportArgs({ ...base, audioIn: '/in.mp4', hasAudio: true });
    expect(filterOf(argv)).toBe(`${BED};[bed][1:a]amix=inputs=2:duration=first:normalize=0[aout]`);
    expect(argv.join(' ')).toContain('-i /in.mp4 -filter_complex');
  });

  it('has no audio at all when there is nothing to hear', () => {
    const argv = buildExportArgs({ ...base, audioIn: '/in.mp4', hasAudio: false });
    expect(argv).not.toContain('-filter_complex');
    expect(argv).not.toContain('/in.mp4');
    expect(argv.join(' ')).toContain('-s 1662x1080 -r 30 -i pipe:0 -c:v libx264');
    expect(argv.at(-1)).toBe('/o.mp4');
  });
});

describe('ffmpegFailure (BH-01)', () => {
  it('is null on a clean exit', () => {
    expect(ffmpegFailure({ code: 0, signal: null }, '')).toBeNull();
  });

  it('reports the exit code with the first error line, not the fallout', () => {
    const stderr = [
      '[libx264 @ 0x8bd030a80] width not divisible by 2 (1663x1080)',
      '[vost#0:0/libx264 @ 0x8bd044000] [enc:libx264 @ 0x8bd028230] Error while opening encoder',
      'Conversion failed!',
      '',
    ].join('\n');
    expect(ffmpegFailure({ code: 187, signal: null }, stderr)).toBe(
      'ffmpeg failed (exit 187): width not divisible by 2 (1663x1080)',
    );
  });

  it('reports a kill', () => {
    expect(ffmpegFailure({ code: null, signal: 'SIGKILL' }, '')).toBe('ffmpeg failed (killed by SIGKILL)');
  });

  it('explains a missing ffmpeg instead of showing ENOENT', () => {
    const error = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    expect(ffmpegFailure({ code: null, signal: null, error }, '')).toBe(FFMPEG_MISSING);
  });
});

describe('ipcErrorMessage', () => {
  it('strips the Electron IPC wrapper', () => {
    const e = new Error("Error invoking remote method 'export:end': Error: ffmpeg failed (exit 1): boom");
    expect(ipcErrorMessage(e)).toBe('ffmpeg failed (exit 1): boom');
    expect(ipcErrorMessage('plain')).toBe('plain');
  });
});
