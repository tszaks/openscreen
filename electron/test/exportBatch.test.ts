// A real 3-format batch through the bundled ffmpeg: synthetic frames are
// piped into a master per render pass (as the editor does), then each preset
// is transcoded from it. Checks sizes, durations, codecs and audio.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import ffmpegStatic from 'ffmpeg-static';
import { startFfmpegJob } from '../src/main/ffmpegJob';
import { CANCELLED, transcodePreset } from '../src/main/transcodeJob';
import { buildExportArgs } from '../src/shared/exportArgs';
import { getPreset, type PresetId } from '../src/shared/exportPresets';
import { outputBase, outputFiles, planRenders } from '../src/shared/exportJobs';

const bin = ffmpegStatic as unknown as string;
const dir = mkdtempSync(join(tmpdir(), 'os-batch-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SECONDS = 2;

/** What `ffmpeg -i` says about a file (the bundled build has no ffprobe). */
function probe(path: string) {
  let out = '';
  try {
    execFileSync(bin, ['-hide_banner', '-i', path], { stdio: 'pipe' });
  } catch (e) {
    out = String((e as { stderr?: Buffer }).stderr ?? '');
  }
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(out);
  const video = /Stream #\d+:\d+.*Video: (\w+)(?: \((\w+)\))?.*?, (\d+)x(\d+)/.exec(out);
  const fps = /, ([\d.]+) fps/.exec(out);
  const audio = /Stream #\d+:\d+.*Audio: (\w+).*?, (\d+) Hz, (\w+)/.exec(out);
  return {
    duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : NaN,
    codec: video?.[1],
    profile: video?.[2],
    width: video ? +video[3] : 0,
    height: video ? +video[4] : 0,
    fps: fps ? +fps[1] : NaN,
    audio: audio ? { codec: audio[1], rate: +audio[2], layout: audio[3] } : null,
  };
}

/** Render a master the way Editor.renderFrames does: RGBA frames into ffmpeg. */
async function renderMaster(w: number, h: number, fps: number, out: string) {
  const total = SECONDS * fps;
  const job = await startFfmpegJob(bin, buildExportArgs({ outPath: out, w, h, fps, hasAudio: false, duration: total / fps, master: true }), out);
  const frame = new Uint8Array(w * h * 4);
  for (let i = 0; i < total; i++) {
    const v = Math.round((i / total) * 255);
    for (let p = 0; p < frame.length; p += 4) {
      frame[p] = v;
      frame[p + 1] = 255 - v;
      frame[p + 2] = (p >> 12) & 255; // some structure for the encoder
      frame[p + 3] = 255;
    }
    await job.write(frame);
  }
  await job.end();
}

describe('multi-format export batch (real ffmpeg)', () => {
  it(
    'renders once per pass and writes every preset at its exact size and length',
    async () => {
      const ids: PresetId[] = ['appstore-iphone', 'square', 'landing-loop'];
      const passes = planRenders(ids.map(getPreset));
      expect(passes).toHaveLength(3);
      const progress: Record<string, number[]> = {};
      for (const pass of passes) {
        const master = join(dir, `master-${pass.layoutPreset}.mov`);
        await renderMaster(pass.width, pass.height, pass.fps, master);
        for (const id of pass.presetIds) {
          const p = getPreset(id);
          const base = outputBase(dir, 'Vero demo', p);
          const files = await transcodePreset(bin, p, master, base, false, SECONDS, (f) => (progress[id] ??= []).push(f)).done;
          expect(files).toEqual(outputFiles(base, p));
        }
        rmSync(master);
      }

      const appStore = probe(join(dir, 'Vero demo – App Store.mp4'));
      expect(appStore).toMatchObject({ codec: 'h264', profile: 'High', width: 886, height: 1920, fps: 30 });
      expect(appStore.duration).toBeCloseTo(SECONDS, 1);
      // no audio in the recording: App Store gets a silent stereo AAC track
      expect(appStore.audio).toEqual({ codec: 'aac', rate: 48000, layout: 'stereo' });

      const square = probe(join(dir, 'Vero demo – Square.mp4'));
      expect(square).toMatchObject({ codec: 'h264', width: 1080, height: 1080, fps: 30, audio: null });
      expect(square.duration).toBeCloseTo(SECONDS, 1);

      const loopMp4 = probe(join(dir, 'Vero demo – Landing loop.mp4'));
      const loopWebm = probe(join(dir, 'Vero demo – Landing loop.webm'));
      expect(loopMp4).toMatchObject({ codec: 'h264', width: 720, height: 1280, audio: null });
      expect(loopWebm).toMatchObject({ codec: 'vp9', width: 720, height: 1280, audio: null });
      expect(loopMp4.duration).toBeCloseTo(SECONDS, 1);
      expect(loopWebm.duration).toBeCloseTo(SECONDS, 1);
      expect(existsSync(join(dir, 'Vero demo – Landing loop-poster.jpg'))).toBe(true);

      for (const id of ids) {
        expect(progress[id].at(-1), id).toBe(1);
        expect(progress[id].some((f) => f > 0 && f < 1), id).toBe(true);
      }
    },
    120_000,
  );

  it('cancel stops the encode and leaves none of the preset files', async () => {
    const master = join(dir, 'master-cancel.mov');
    await renderMaster(720, 1280, 30, master);
    const p = getPreset('landing-loop');
    const base = outputBase(dir, 'Cancelled', p);
    // cancel as soon as the first encode reports progress
    let started!: () => void;
    const firstProgress = new Promise<void>((r) => (started = r));
    const run = transcodePreset(bin, p, master, base, false, SECONDS, () => started());
    await firstProgress;
    await run.cancel();
    await expect(run.done).rejects.toThrow(CANCELLED);
    for (const f of outputFiles(base, p)) expect(existsSync(f), f).toBe(false);
  }, 60_000);

  it('rejects with the reason and cleans up when the input is unreadable', async () => {
    const p = getPreset('square');
    const base = outputBase(dir, 'Broken', p);
    await expect(transcodePreset(bin, p, join(dir, 'missing.mov'), base, false, SECONDS).done).rejects.toThrow(/ffmpeg failed \(exit \d+\): .*missing\.mov/);
    expect(existsSync(`${base}.mp4`)).toBe(false);
  });
});
