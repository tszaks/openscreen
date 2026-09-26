// Transcode one rendered master into every file an export preset produces
// (ffmpegJobsFor: one video per container, plus a poster), one ffmpeg at a
// time, reporting progress from ffmpeg's -progress stream. A failed or
// cancelled preset leaves none of its files behind.

import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { ffmpegFailure, type FfmpegExit } from '../shared/exportArgs';
import { ffmpegJobsFor, type ExportPreset } from '../shared/exportPresets';

export interface TranscodeRun {
  /** Resolves with the files written; rejects with ffmpeg's reason. */
  done: Promise<string[]>;
  /** Kill ffmpeg and delete this preset's files. `done` rejects with CANCELLED. */
  cancel(): Promise<void>;
}

export const CANCELLED = 'cancelled';
const STDERR_KEEP = 16 * 1024;

/** Quiet stderr (its first line is then the root cause) and a machine-readable
 *  progress stream on stdout. */
function withProgress(args: string[]): string[] {
  return ['-loglevel', 'error', '-nostats', '-progress', 'pipe:1', ...args];
}

export function transcodePreset(
  bin: string,
  preset: ExportPreset,
  input: string,
  outBase: string,
  hasAudio: boolean,
  /** Master length in seconds, to turn out_time into a fraction. */
  duration: number,
  onProgress: (fraction: number) => void = () => {},
): TranscodeRun {
  const jobs = ffmpegJobsFor(preset, input, outBase, hasAudio);
  const videos = Math.max(1, jobs.filter((j) => j.kind === 'video').length);
  let child: ChildProcess | null = null;
  let cancelled = false;
  const removeAll = () => jobs.forEach((j) => rmSync(j.output, { force: true }));

  const runOne = (argv: string[], index: number) =>
    new Promise<void>((resolve, reject) => {
      const ff = spawn(bin, argv);
      child = ff;
      let stderr = '';
      ff.stderr.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-STDERR_KEEP);
      });
      ff.stdout.on('data', (d: Buffer) => {
        const last = d.toString().split('\n').filter((l) => l.startsWith('out_time_us=')).pop();
        const us = last ? Number(last.slice('out_time_us='.length)) : NaN;
        if (Number.isFinite(us) && duration > 0) onProgress(Math.min(1, (index + Math.max(0, us) / 1e6 / duration) / videos));
      });
      let exit: FfmpegExit | null = null;
      ff.once('error', (error) => {
        exit ??= { code: null, signal: null, error };
        reject(new Error(ffmpegFailure(exit, stderr)!));
      });
      ff.once('close', (code, signal) => {
        exit ??= { code, signal };
        child = null;
        if (cancelled) return reject(new Error(CANCELLED));
        const why = ffmpegFailure(exit, stderr);
        if (why) {
          console.error(`ffmpeg ${preset.id} failed:`, why, '\n', stderr);
          reject(new Error(why));
        } else resolve();
      });
    });

  const done = (async () => {
    try {
      let index = 0;
      for (const job of jobs) {
        if (cancelled) throw new Error(CANCELLED);
        await runOne(job.kind === 'video' ? withProgress(job.args) : ['-loglevel', 'error', ...job.args], index);
        if (job.kind === 'video') index++;
      }
      onProgress(1);
      return jobs.map((j) => j.output);
    } catch (e) {
      removeAll();
      throw e;
    }
  })();

  return {
    done,
    async cancel() {
      cancelled = true;
      child?.kill('SIGKILL');
      await done.catch(() => {});
    },
  };
}
