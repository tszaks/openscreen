import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ffmpegStatic from 'ffmpeg-static';
import { startFfmpegJob } from '../src/main/ffmpegJob';
import { FFMPEG_MISSING, buildExportArgs, exportCanvasSize } from '../src/shared/exportArgs';

const dir = mkdtempSync(join(tmpdir(), 'os-ffjob-'));
const node = process.execPath;
// Stand-in "ffmpeg" processes: node scripts with the behaviour under test.
const fake = (script: string) => ['-e', script];
const within = <T>(p: Promise<T>, ms = 5000) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`still pending after ${ms}ms`)), ms))]);

describe('startFfmpegJob (BH-01)', () => {
  it('end() rejects with the reason, instead of hanging, when ffmpeg already exited', async () => {
    const out = join(dir, 'early.mp4');
    writeFileSync(out, 'partial');
    const job = await startFfmpegJob(node, fake('process.stderr.write("[libx264 @ 0x1] width not divisible by 2\\n"); process.exit(1)'), out);
    await new Promise((r) => setTimeout(r, 300)); // ffmpeg is gone before end() is called
    await expect(within(job.end())).rejects.toThrow('ffmpeg failed (exit 1): width not divisible by 2');
    expect(existsSync(out)).toBe(false);
  });

  it('write() rejects once ffmpeg has stopped, so the frame loop ends early', async () => {
    const job = await startFfmpegJob(node, fake('process.exit(0)'), join(dir, 'w.mp4'));
    await new Promise((r) => setTimeout(r, 300));
    await expect(within(job.write(new Uint8Array(16)))).rejects.toThrow('ffmpeg stopped before all frames were sent');
  });

  it('reports a missing ffmpeg from start', async () => {
    await expect(startFfmpegJob(join(dir, 'no-such-ffmpeg'), [], join(dir, 'x.mp4'))).rejects.toThrow(FFMPEG_MISSING);
  });

  it('streams frames and resolves end() on success', async () => {
    const out = join(dir, 'ok.bin');
    const job = await startFfmpegJob(node, fake(`process.stdin.pipe(require('fs').createWriteStream(${JSON.stringify(out)}))`), out);
    for (let i = 0; i < 4; i++) await job.write(new Uint8Array(1024 * 1024).fill(i));
    await within(job.end());
    expect(readFileSync(out).length).toBe(4 * 1024 * 1024);
  });

  it('abort() kills ffmpeg and deletes the partial file', async () => {
    const out = join(dir, 'cancel.mp4');
    writeFileSync(out, 'partial');
    const job = await startFfmpegJob(node, fake('setInterval(() => {}, 1000)'), out);
    await within(job.abort());
    expect(existsSync(out)).toBe(false);
  });
});

// The real encoder with the real argv (ffmpeg-static ships with the app).
const ffmpeg = ffmpegStatic as unknown as string | null;
const durationOf = (file: string) => {
  let se = '';
  try {
    execFileSync(ffmpeg!, ['-hide_banner', '-i', file], { stdio: 'pipe' });
  } catch (e) {
    se = String((e as { stderr?: Buffer }).stderr ?? '');
  }
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(se);
  const size = /Video: .*?, (\d+)x(\d+)/.exec(se);
  return {
    seconds: m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : NaN,
    width: size ? +size[1] : NaN,
    height: size ? +size[2] : NaN,
  };
};
const encode = async (w: number, h: number, frames: number, extra: { audioIn?: string; hasAudio?: boolean; clicks?: number[] }) => {
  const out = join(dir, `real-${w}x${h}-${frames}.mp4`);
  const job = await startFfmpegJob(ffmpeg!, buildExportArgs({ outPath: out, w, h, fps: 30, duration: frames / 30, hasAudio: false, ...extra }), out);
  const frame = new Uint8Array(w * h * 4).fill(128);
  for (let i = 0; i < frames; i++) await job.write(frame);
  await job.end();
  return durationOf(out);
};

describe.skipIf(!ffmpeg || !existsSync(ffmpeg))('real ffmpeg export', () => {
  it('clicks with no program audio keep the full video length (BH-02)', async () => {
    const r = await encode(64, 48, 90, { clicks: [0.2, 0.5] }); // 3 s video, last click at 0.5 s
    expect(r.seconds).toBeGreaterThan(2.9);
    expect(r.seconds).toBeLessThan(3.2);
  }, 30000);

  it('encodes a 3024x1964 display at 1080p (BH-03)', async () => {
    const { width, height } = exportCanvasSize({ width: 3024, height: 1964 }, 'p1080');
    const r = await encode(width, height, 5, {});
    expect(r).toMatchObject({ width: 1662, height: 1080 });
  }, 30000);
});
