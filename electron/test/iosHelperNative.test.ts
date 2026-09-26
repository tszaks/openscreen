import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import ffmpegStatic from 'ffmpeg-static';
import { afterAll, describe, expect, it } from 'vitest';
import { createFrameParser } from '../src/shared/iosCapture';
import { parseFfmpegDuration, parseFfmpegVideoSize } from '../src/shared/recording';

// The real ios-capture binary, with no phone: its preview pipe as the app
// reads it, and a take killed mid-write. Skipped until `npm run build:helper`.

const helper = join(__dirname, '../dist/native/ios-capture');
const ffmpeg = ffmpegStatic as unknown as string;
const built = existsSync(helper);
const dir = mkdtempSync(join(tmpdir(), 'ios-helper-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const banner = (file: string) =>
  new Promise<string>((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-i', file]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => resolve(err));
  });

describe.skipIf(!built)('ios-capture helper (native)', () => {
  it('selftest-preview writes length-prefixed JPEGs on fd 3, ~360 px, ~10-12 fps, stdout stays JSON', async () => {
    const proc = spawn(helper, ['selftest-preview', '--seconds', '1.5'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const frames: Uint8Array[] = [];
    const corrupt: string[] = [];
    (proc.stdio[3] as Readable).on('data', createFrameParser((f) => frames.push(f), { onCorrupt: (r) => corrupt.push(r) }));
    let out = '';
    proc.stdout!.on('data', (d) => (out += d));
    const code = await new Promise<number | null>((r) => proc.on('close', r));
    expect(code).toBe(0);
    expect(corrupt).toEqual([]);
    const summary = JSON.parse(out.trim());
    expect(summary.event).toBe('selftest-preview');
    expect(frames.length).toBe(summary.sent);
    // 30 fps source, ~12 fps cap: every third frame (10 fps) over 1.5s.
    expect(frames.length).toBeGreaterThanOrEqual(10);
    expect(frames.length).toBeLessThanOrEqual(20);
    for (const f of frames) {
      expect([f[0], f[1]]).toEqual([0xff, 0xd8]);
      expect([f[f.length - 2], f[f.length - 1]]).toEqual([0xff, 0xd9]);
    }
    // The JPEG's SOF0/SOF2 marker holds its size: long edge 360.
    const f = frames[0];
    let i = 2;
    let size: { w: number; h: number } | null = null;
    while (i < f.length - 9) {
      if (f[i] === 0xff && (f[i + 1] === 0xc0 || f[i + 1] === 0xc2)) {
        size = { h: (f[i + 5] << 8) | f[i + 6], w: (f[i + 7] << 8) | f[i + 8] };
        break;
      }
      i += f[i] === 0xff && f[i + 1] !== 0xd8 ? 2 + ((f[i + 2] << 8) | f[i + 3]) : 1;
    }
    expect(size).not.toBeNull();
    expect(Math.max(size!.w, size!.h)).toBe(360);
  });

  it('refuses to write preview frames into a fd that is not a pipe', async () => {
    const proc = spawn(helper, ['selftest-preview', '--seconds', '0.2', '--fd', '9'], { stdio: 'pipe' });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    const code = await new Promise<number | null>((r) => proc.on('close', r));
    expect(code).toBe(1);
    expect(out).toMatch(/not a pipe/);
  });

  it('a take killed mid-write (SIGKILL) still plays up to its last fragment', async () => {
    const file = join(dir, 'killed.mov');
    const proc = spawn(helper, ['selftest', file, '--seconds', '10', '--realtime'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 7000));
    proc.kill('SIGKILL');
    await new Promise((r) => proc.on('close', r));
    expect(statSync(file).size).toBeGreaterThan(0);
    const info = await banner(file);
    const duration = parseFfmpegDuration(info);
    expect(duration, info).not.toBeNull();
    // Killed 7s in. A fragment covers 2s and reaches the disk about 1s
    // after it closes (measured: killed at 5.2s plays 4.2s, at 7.2s 6.1s),
    // so at most ~3s is lost; with margin for a loaded machine, >= 4s.
    expect(duration!).toBeGreaterThanOrEqual(3.9);
    expect(duration!).toBeLessThanOrEqual(7);
    expect(parseFfmpegVideoSize(info)).toEqual({ width: 392, height: 850 });
    expect(info).toMatch(/Audio: aac/);
  }, 25_000);
});
