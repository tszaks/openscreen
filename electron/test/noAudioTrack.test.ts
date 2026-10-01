import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectSilences, extractWav, ffmpegPath } from '../src/node/media';

// Real ffmpeg on tiny clips: a recording with no audio track used to make
// waveform and silence detection throw ("Output file does not contain any stream").
const bin = ffmpegPath();
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'openscreen-noaudio-'));
  const video = ['-f', 'lavfi', '-i', 'testsrc2=size=64x128:rate=10'];
  execFileSync(bin, ['-v', 'error', '-y', ...video, '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'silent-video.mov')]);
  execFileSync(bin, [
    '-v', 'error', '-y', ...video, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, 'with-audio.mov'),
  ]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('recordings without an audio track', () => {
  it('extractWav returns null and writes nothing', async () => {
    expect(await extractWav(dir, 'silent-video.mov', bin)).toBeNull();
    expect(existsSync(join(dir, 'audio.wav'))).toBe(false);
  });
  it('detectSilences returns no ranges instead of throwing', async () => {
    await expect(detectSilences(dir, 'silent-video.mov', {}, bin)).resolves.toEqual([]);
  });
  it('a video with an audio track still extracts its wav', async () => {
    const wav = await extractWav(dir, 'with-audio.mov', bin);
    expect(wav).toBe(join(dir, 'audio.wav'));
    expect(existsSync(wav!)).toBe(true);
  });
});
