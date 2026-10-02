import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  conversionArgs,
  displayedSize,
  dropHint,
  importConversion,
  importErrorMessage,
  importName,
  importedProject,
  importedSourceKind,
  importedVideoFile,
  routeDrop,
  uniqueBundleName,
} from '../src/shared/importVideo';
import { editorFeatures } from '../src/shared/justMe';
import { resetProject } from '../src/shared/types';
import { ffmpegPath, probeMedia } from '../src/node/media';
import { ImportCancelled, importVideoFile } from '../src/node/importVideo';

describe('bundle names', () => {
  it('names the project after the file', () => {
    expect(importName('/Users/me/Desktop/Product demo.mp4')).toBe('Product demo');
    expect(importName('clip.final.MOV')).toBe('clip.final');
    expect(importName('/x/.mp4')).toBe('Imported video');
  });

  it('de-duplicates against folders already there', () => {
    const taken = new Set(['Product demo.openscreen', 'Product demo 2.openscreen']);
    expect(uniqueBundleName('Product demo', (f) => taken.has(f))).toBe('Product demo 3.openscreen');
    expect(uniqueBundleName('Fresh', (f) => taken.has(f))).toBe('Fresh.openscreen');
  });

  it('makes names safe as folder names', () => {
    expect(uniqueBundleName('Launch: v2/final', () => false)).toBe('Launch- v2-final.openscreen');
  });
});

describe('phone or screen video', () => {
  it('treats native iPhone and iPad screen sizes as phone recordings', () => {
    expect(importedSourceKind(1179, 2556)).toBe('iosDevice');
    expect(importedSourceKind(1206, 2622)).toBe('iosDevice');
    expect(importedSourceKind(1320, 2868)).toBe('iosDevice');
    expect(importedSourceKind(750, 1334)).toBe('iosDevice'); // SE, exact
    expect(importedSourceKind(2064, 2752)).toBe('iosDevice'); // iPad Pro 13, exact
    expect(importedSourceKind(2556, 1179)).toBe('iosDevice'); // turned sideways
  });

  it('accepts an evenly scaled-down tall iPhone screen', () => {
    expect(importedSourceKind(886, 1920)).toBe('iosDevice');
  });

  it('keeps desktop and ordinary video shapes as screen videos', () => {
    expect(importedSourceKind(1920, 1080)).toBe('display');
    expect(importedSourceKind(2560, 1600)).toBe('display');
    expect(importedSourceKind(1080, 1920)).toBe('display'); // 9:16 social video
    expect(importedSourceKind(720, 1280)).toBe('display'); // 16:9 scaled, not only phones
    expect(importedSourceKind(1536, 2048)).toBe('display'); // 4:3 scaled, not only iPads
    expect(importedSourceKind(1024, 768)).toBe('display');
  });

  it('keeps odd sizes as screen videos', () => {
    expect(importedSourceKind(1001, 777)).toBe('display');
    expect(importedSourceKind(0, 0)).toBe('display');
    expect(importedSourceKind(NaN, 100)).toBe('display');
  });

  it('swaps width and height for a quarter-turned picture', () => {
    expect(displayedSize(1920, 1080, 90)).toEqual({ width: 1080, height: 1920 });
    expect(displayedSize(1920, 1080, -90)).toEqual({ width: 1080, height: 1920 });
    expect(displayedSize(1920, 1080, 180)).toEqual({ width: 1920, height: 1080 });
    expect(displayedSize(1920, 1080, 0)).toEqual({ width: 1920, height: 1080 });
  });
});

describe('transcode decision', () => {
  it('copies what Chromium plays', () => {
    for (const videoCodec of ['h264', 'hevc', 'vp8', 'vp9', 'av1']) {
      expect(importConversion({ videoCodec, audioCodec: null })).toBe('none');
    }
    for (const audioCodec of ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le']) {
      expect(importConversion({ videoCodec: 'h264', audioCodec })).toBe('none');
    }
  });

  it('re-encodes a picture Chromium shows blank', () => {
    expect(importConversion({ videoCodec: 'prores', audioCodec: 'pcm_s16le' })).toBe('full');
    expect(importConversion({ videoCodec: 'mpeg4', audioCodec: 'aac' })).toBe('full');
    expect(importConversion({ videoCodec: null, audioCodec: null })).toBe('full');
  });

  it('re-encodes only the sound when the sound is what is silent', () => {
    expect(importConversion({ videoCodec: 'h264', audioCodec: 'ac3' })).toBe('audio');
    expect(importConversion({ videoCodec: 'hevc', audioCodec: 'alac' })).toBe('audio');
    // vp8 can't go into mp4 on its own.
    expect(importConversion({ videoCodec: 'vp8', audioCodec: 'ac3' })).toBe('full');
  });

  it('turns a sideways phone screen upright, but leaves a sideways screen video alone', () => {
    expect(importConversion({ videoCodec: 'h264', audioCodec: 'aac', rotation: -90, sourceKind: 'iosDevice' })).toBe('full');
    expect(importConversion({ videoCodec: 'h264', audioCodec: 'aac', rotation: 90, sourceKind: 'display' })).toBe('none');
  });

  it('keeps the extension when copied and writes mp4 when converted', () => {
    expect(importedVideoFile('/a/Clip.MOV', 'none')).toBe('screen.mov');
    expect(importedVideoFile('/a/clip.webm', 'none')).toBe('screen.webm');
    expect(importedVideoFile('/a/clip.mov', 'full')).toBe('screen.mp4');
    expect(importedVideoFile('/a/clip.mkv', 'audio')).toBe('screen.mp4');
  });

  it('converts to H.264 + AAC, or copies the picture and swaps only the sound', () => {
    const full = conversionArgs('in.mov', 'out.mp4', 'full', { videoCodec: 'prores', hasAudio: true });
    expect(full).toEqual(expect.arrayContaining(['libx264', 'yuv420p', 'aac', '0:a:0']));
    const silent = conversionArgs('in.mov', 'out.mp4', 'full', { videoCodec: 'prores', hasAudio: false });
    expect(silent).not.toContain('0:a:0');
    const audio = conversionArgs('in.mkv', 'out.mp4', 'audio', { videoCodec: 'hevc', hasAudio: true });
    expect(audio.join(' ')).toContain('-c:v copy -tag:v hvc1');
    expect(audio).not.toContain('libx264');
  });
});

describe('drop routing', () => {
  it('imports a dropped video, on the picker and in the editor', () => {
    expect(routeDrop(['/a/clip.mp4'], 'picker')).toEqual({ action: 'import', index: 0 });
    expect(routeDrop(['/a/clip.MKV'], 'editor')).toEqual({ action: 'import', index: 0 });
  });

  it('adds a dropped sound to the music track in the editor only', () => {
    expect(routeDrop(['/a/song.mp3'], 'editor')).toEqual({ action: 'addMusic', index: 0 });
    expect(routeDrop(['/a/voice.aiff'], 'editor')).toEqual({ action: 'addMusic', index: 0 });
    expect(routeDrop(['/a/song.mp3'], 'picker')).toEqual({ action: 'ignore', index: -1 });
  });

  it('ignores everything else, and every drop mid-recording', () => {
    expect(routeDrop(['/a/photo.png', '/a/notes.txt'], 'editor')).toEqual({ action: 'ignore', index: -1 });
    expect(routeDrop(['/a/Bundle.openscreen'], 'picker').action).toBe('ignore');
    expect(routeDrop([], 'picker').action).toBe('ignore');
    expect(routeDrop(['/a/clip.mp4'], 'recording').action).toBe('ignore');
  });

  it('takes the first file it can use', () => {
    expect(routeDrop(['/a/photo.png', '/a/clip.mov', '/a/b.mp4'], 'picker')).toEqual({ action: 'import', index: 1 });
  });

  it('labels the overlay from the dragged types', () => {
    expect(dropHint(['video/mp4'], 'picker')).toBe('Drop to import');
    expect(dropHint([''], 'picker')).toBe('Drop to import'); // .mkv often has no type
    expect(dropHint(['audio/mpeg'], 'editor')).toBe('Drop to add to the music track');
    expect(dropHint(['audio/mpeg'], 'picker')).toBeNull();
    expect(dropHint(['image/png'], 'editor')).toBeNull();
    expect(dropHint(['video/mp4'], 'recording')).toBeNull();
  });
});

describe('the imported project', () => {
  const phone = importedProject({ name: 'Phone', videoFile: 'screen.mov', size: { width: 1206, height: 2622 }, duration: 6 });
  const screen = importedProject({ name: 'Demo', videoFile: 'screen.mp4', size: { width: 1920, height: 1080 }, duration: 6 });

  it('is named after the file and spans the whole video', () => {
    expect(screen.name).toBe('Demo');
    expect(screen.recording).toMatchObject({ screenVideoFile: 'screen.mp4', sourceKind: 'display', imported: true, duration: 6 });
    expect(screen.clips).toEqual([expect.objectContaining({ sourceStart: 0, sourceEnd: 6, speed: 1 })]);
  });

  it('gets the phone treatment for a phone screen: frame, 9:16, tap detection', () => {
    expect(phone.recording.sourceKind).toBe('iosDevice');
    expect(phone.device.frame).toBe(true);
    expect(phone.layout.presetId).toBe('social-9x16');
    expect(phone.tapsAnalyzed).toBe(false);
    expect(editorFeatures(phone)).toMatchObject({ taps: true, autoZoom: true, cursorTab: false });
  });

  it('has no cursor tab and no click zooms for a screen video, even after a reset', () => {
    expect(editorFeatures(screen)).toMatchObject({ cursorTab: false, autoZoom: false });
    expect(screen.zoom).toMatchObject({ autofocus: false, dwell: false });
    expect(screen.audio.clickSounds).toBe(false);
    expect(resetProject(screen).zoom).toMatchObject({ autofocus: false, dwell: false });
  });
});

describe('error messages', () => {
  it('says plainly what went wrong', () => {
    expect(importErrorMessage({ code: 'ENOSPC', message: 'ENOSPC: no space left on device, write' }, 'a.mp4')).toMatch(/enough free disk space/);
    expect(importErrorMessage(new Error('ffmpeg: No space left on device'), 'a.mp4')).toMatch(/enough free disk space/);
    expect(importErrorMessage({ code: 'ENOENT', message: 'x' }, 'a.mp4')).toBe("a.mp4 couldn't be found. It may have been moved or deleted.");
    expect(importErrorMessage({ code: 'EACCES', message: 'x' }, 'a.mp4')).toMatch(/isn't allowed to read/);
    expect(importErrorMessage(new Error('Something else.'), 'a.mp4')).toBe('Something else.');
  });
});

// Real ffmpeg on tiny clips, into a scratch recordings folder.
describe('importVideoFile', () => {
  const bin = ffmpegPath();
  let dir: string;
  let root: string;
  const src = (name: string) => join(dir, name);
  const sha = (file: string) => createHash('sha1').update(readFileSync(file)).digest('hex');
  const make = (name: string, size: string, codec: string[], audio = true) =>
    execFileSync(bin, [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=10`,
      ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440', '-shortest'] : []),
      '-t', '1', ...codec, src(name),
    ]);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'openscreen-import-'));
    root = join(dir, 'recordings');
    make('Demo.mp4', '320x180', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
    make('Phone.mov', '1206x2622', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
    make('Master.mov', '320x180', ['-c:v', 'prores_ks', '-c:a', 'pcm_s16le']);
    writeFileSync(src('notes.txt'), 'not a video');
    writeFileSync(src('Broken.mp4'), 'not a video either');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const bundles = () => (existsSync(root) ? readdirSync(root).sort() : []);

  it('copies a playable video in untouched and writes its project', async () => {
    const before = sha(src('Demo.mp4'));
    const r = await importVideoFile(src('Demo.mp4'), { root, bin });
    expect(r.dir).toBe(join(root, 'Demo.openscreen'));
    expect(r.conversion).toBe('none');
    expect(sha(join(r.dir, 'screen.mp4'))).toBe(before);
    expect(sha(src('Demo.mp4'))).toBe(before);
    const saved = JSON.parse(readFileSync(join(r.dir, 'project.json'), 'utf8'));
    expect(saved).toMatchObject({ name: 'Demo', recording: { sourceKind: 'display', sourceSize: { width: 320, height: 180 }, imported: true } });
    expect(saved.recording.duration).toBeCloseTo(1, 1);
    expect(JSON.parse(readFileSync(join(r.dir, 'cursor.json'), 'utf8'))).toEqual({ samples: [] });
  });

  it('de-duplicates a second import of the same file', async () => {
    const r = await importVideoFile(src('Demo.mp4'), { root, bin });
    expect(r.dir).toBe(join(root, 'Demo 2.openscreen'));
  });

  it('detects a phone screen recording', async () => {
    const r = await importVideoFile(src('Phone.mov'), { root, bin });
    expect(r.project.recording.sourceKind).toBe('iosDevice');
    expect(r.project.recording.screenVideoFile).toBe('screen.mov');
  });

  it('converts ProRes to H.264 + AAC, with progress', async () => {
    const seen: string[] = [];
    const r = await importVideoFile(src('Master.mov'), { root, bin, onProgress: (p) => seen.push(p.stage) });
    expect(r.conversion).toBe('full');
    expect(seen).toContain('convert');
    const out = await probeMedia(join(r.dir, 'screen.mp4'), bin);
    expect(out).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac', width: 320, height: 180 });
  });

  it('leaves nothing behind when cancelled', async () => {
    const before = bundles();
    const abort = new AbortController();
    const run = importVideoFile(src('Master.mov'), { root, bin, signal: abort.signal, onProgress: () => abort.abort() });
    await expect(run).rejects.toBeInstanceOf(ImportCancelled);
    expect(bundles()).toEqual(before);
  });

  it('refuses what it can not import, with a plain message and no bundle', async () => {
    const before = bundles();
    await expect(importVideoFile(src('notes.txt'), { root, bin })).rejects.toThrow(/isn't a video OpenScreen can import/);
    await expect(importVideoFile(src('Broken.mp4'), { root, bin })).rejects.toThrow(/has no picture OpenScreen can read/);
    await expect(importVideoFile(src('Gone.mp4'), { root, bin })).rejects.toThrow(/couldn't be found/);
    mkdirSync(src('Folder.mp4'));
    await expect(importVideoFile(src('Folder.mp4'), { root, bin })).rejects.toThrow(/is a folder/);
    expect(bundles()).toEqual(before);
  });
});
