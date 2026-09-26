import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ffmpegPath from 'ffmpeg-static';
import {
  PRESETS,
  appStorePresetFor,
  ffmpegArgsFor,
  ffmpegJobsFor,
  getPreset,
  safeRect,
  validateExport,
} from '../src/shared/exportPresets';

describe('preset registry', () => {
  it('matches the App Store preview spec', () => {
    const p = getPreset('appstore-iphone');
    expect([p.width, p.height]).toEqual([886, 1920]);
    expect(p.maxFps).toBe(30);
    expect(p.video).toMatchObject({ profile: 'high', level: '4.0', bitrateKbps: { target: 11000, max: 12000 } });
    expect(p.audio).toMatchObject({ mode: 'aac-stereo', bitrateKbps: 256, sampleRate: 48000, silentIfMissing: true });
    expect(p.duration).toEqual({ min: 15, max: 30 });
    expect(p.layout).toBe('full-bleed');
    expect(p.defaults).toMatchObject({ autoZoom: false, deviceFrame: false });
    expect([getPreset('appstore-ipad').width, getPreset('appstore-ipad').height]).toEqual([1200, 1600]);
    expect(appStorePresetFor('iphone', true).width).toBe(1920);
    expect(appStorePresetFor('ipad', false).height).toBe(1600);
  });

  it('keeps H.264 Level 4.0 limits for App Store sizes at 30 fps', () => {
    for (const p of PRESETS.filter((x) => x.video.level === '4.0')) {
      const mbs = Math.ceil(p.width / 16) * Math.ceil(p.height / 16);
      expect(mbs, p.id).toBeLessThanOrEqual(8192); // max frame size
      expect(mbs * p.fps, p.id).toBeLessThanOrEqual(245760); // max macroblocks/s
    }
  });

  it('defines the 9:16 safe zone as the centre 856x1094', () => {
    const p = getPreset('social-9x16');
    expect(safeRect(p)).toEqual({ x: 60, y: 250, w: 856, h: 1094 });
    expect(p.layout).toBe('framed');
    expect(p.phoneHeight).toBeCloseTo(0.7);
    expect(safeRect(getPreset('square'))).toEqual({ x: 0, y: 0, w: 1080, h: 1080 });
  });

  it('covers every requested shape', () => {
    const sizes = PRESETS.map((p) => `${p.width}x${p.height}`);
    for (const s of ['886x1920', '1920x886', '1200x1600', '1080x1920', '1080x1080', '1080x1350', '1920x1080']) {
      expect(sizes).toContain(s);
    }
    const loop = getPreset('landing-loop');
    expect(loop.containers).toEqual(['mp4', 'webm']);
    expect(loop.audio.mode).toBe('none');
    expect(loop.video.crf).toBe(28);
    expect(loop.poster).toBe(true);
  });
});

describe('validateExport', () => {
  const store = getPreset('appstore-iphone');

  it('rejects App Store previews outside 15-30 s, in plain words', () => {
    const w = validateExport(store, { duration: 42 });
    expect(w).toContainEqual({ level: 'error', code: 'too-long', message: 'App Store previews must be 15–30 s; yours is 42 s.' });
    expect(validateExport(store, { duration: 9.4 })[0].message).toBe('App Store previews must be 15–30 s; yours is 9.4 s.');
    expect(validateExport(store, { duration: 22 })).toEqual([]);
  });

  it('explains resampling, silent audio, zoom and frame choices for App Store', () => {
    const codes = validateExport(store, {
      duration: 20, sourceFps: 60, hasAudio: false, usesAutoZoom: true, usesDeviceFrame: true, transitions: ['slide'],
    }).map((w) => w.code);
    expect(codes).toEqual(['fps-resample', 'silent-audio', 'appstore-zoom', 'appstore-frame', 'transitions']);
  });

  it('warns about upscaling and cropping a small or odd-shaped source', () => {
    const w = validateExport(store, { duration: 20, sourceWidth: 590, sourceHeight: 1278 });
    expect(w.map((x) => x.code)).toContain('upscale');
    const odd = validateExport(store, { duration: 20, sourceWidth: 1080, sourceHeight: 1920 });
    expect(odd.map((x) => x.code)).toContain('crop');
    expect(validateExport(store, { duration: 20, sourceWidth: 1206, sourceHeight: 2622 })).toEqual([]);
  });

  it('gives advice, not errors, for social lengths and flags titles outside the safe zone', () => {
    const p = getPreset('social-9x16');
    expect(validateExport(p, { duration: 45 })).toEqual([
      { level: 'info', code: 'outside-ideal', message: '15–30 s is the sweet spot for Reels / TikTok / Shorts 9:16; yours is 45 s.' },
    ]);
    expect(validateExport(p, { duration: 20, titleRect: { x: 100, y: 120, w: 800, h: 200 } })[0].code).toBe('unsafe-title');
    expect(validateExport(p, { duration: 20, titleRect: { x: 100, y: 280, w: 800, h: 200 } })).toEqual([]);
    expect(validateExport(getPreset('shorts-hq'), { duration: 200 })[0]).toMatchObject({ level: 'error', code: 'too-long' });
  });

  it('keeps landing loops small', () => {
    const w = validateExport(getPreset('landing-loop'), { duration: 12, fileSizeMB: 7.3 });
    expect(w).toEqual([
      {
        level: 'warning',
        code: 'file-too-big',
        message: 'Landing loops should stay under 5 MB to load fast; yours is 7.3 MB. Shorten it or raise the CRF.',
      },
    ]);
  });
});

describe('ffmpegArgsFor', () => {
  const store = getPreset('appstore-iphone');

  it('encodes App Store previews as H.264 High@4.0, 30 fps CFR, 11 Mbps, AAC 256k', () => {
    const a = ffmpegArgsFor(store, { input: 'in.mov', output: 'out.mp4', hasAudio: true });
    const val = (flag: string) => a[a.indexOf(flag) + 1];
    expect(val('-c:v')).toBe('libx264');
    expect(val('-profile:v')).toBe('high');
    expect(val('-level:v')).toBe('4.0');
    expect(val('-b:v')).toBe('11000k');
    expect(val('-maxrate')).toBe('12000k');
    expect(val('-r')).toBe('30');
    expect(val('-fps_mode')).toBe('cfr');
    expect(val('-vf')).toContain('scale=886:1920');
    expect(val('-c:a')).toBe('aac');
    expect(val('-b:a')).toBe('256k');
    expect(val('-ar')).toBe('48000');
    expect(val('-ac')).toBe('2');
    expect(val('-movflags')).toBe('+faststart');
    expect(a).not.toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(a[a.length - 1]).toBe('out.mp4');
  });

  it('adds a silent stereo track when the recording has none', () => {
    const a = ffmpegArgsFor(store, { input: 'in.mov', output: 'out.mp4', hasAudio: false });
    expect(a).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(a).toContain('-shortest');
    expect(a.slice(a.indexOf('-map'), a.indexOf('-map') + 4)).toEqual(['-map', '0:v:0', '-map', '1:a:0']);
  });

  it('normalizes loudness for social and strips audio for landing loops', () => {
    const s = ffmpegArgsFor(getPreset('social-9x16'), { input: 'i', output: 'o.mp4', hasAudio: true });
    expect(s).toContain('loudnorm=I=-14:TP=-1.5:LRA=11');
    const loop = getPreset('landing-loop');
    const mp4 = ffmpegArgsFor(loop, { input: 'i', output: 'o.mp4', hasAudio: true });
    expect(mp4).toContain('-an');
    expect(mp4[mp4.indexOf('-crf') + 1]).toBe('28');
    const webm = ffmpegArgsFor(loop, { input: 'i', output: 'o.webm', hasAudio: true, container: 'webm' });
    expect(webm[webm.indexOf('-c:v') + 1]).toBe('libvpx-vp9');
    expect(webm).not.toContain('-movflags');
    expect(() => ffmpegArgsFor(store, { input: 'i', output: 'o', hasAudio: true, container: 'webm' })).toThrow();
    const jobs = ffmpegJobsFor(loop, 'in.mov', '/out/demo', true);
    expect(jobs.map((j) => [j.kind, j.output])).toEqual([
      ['video', '/out/demo.mp4'], ['video', '/out/demo.webm'], ['poster', '/out/demo-poster.jpg'],
    ]);
  });
});

describe('ffmpeg integration', () => {
  const ff = ffmpegPath as unknown as string | null;
  it.runIf(!!ff && existsSync(ff!))('produces valid files with the bundled ffmpeg', () => {
    const dir = mkdtempSync(join(tmpdir(), 'os-presets-'));
    try {
      const src = join(dir, 'src.mp4');
      // A 1 s, 60 fps, silent phone-shaped clip.
      execFileSync(ff!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=402x874:rate=60:duration=1', '-pix_fmt', 'yuv420p', src]);
      const out = join(dir, 'store.mp4');
      execFileSync(ff!, [...ffmpegArgsFor(getPreset('appstore-iphone'), { input: src, output: out, hasAudio: false, x264Preset: 'medium' }).slice(0, -1), '-loglevel', 'error', out]);
      const info = (() => {
        try {
          execFileSync(ff!, ['-hide_banner', '-i', out], { stdio: 'pipe' });
          return '';
        } catch (e) {
          return String((e as { stderr: Buffer }).stderr);
        }
      })();
      expect(info).toMatch(/Video: h264 \(High\)/);
      expect(info).toMatch(/886x1920/);
      expect(info).toMatch(/30 fps/);
      expect(info).toMatch(/Audio: aac \(LC\).*48000 Hz, stereo/);
      for (const job of ffmpegJobsFor(getPreset('landing-loop'), src, join(dir, 'loop'), false)) {
        execFileSync(ff!, [...job.args.slice(0, -1), '-loglevel', 'error', job.output]);
        expect(statSync(job.output).size).toBeGreaterThan(1000);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
