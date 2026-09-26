// One running ffmpeg export: frames go in through stdin, and its exit is
// captured from the moment it spawns, so an ffmpeg that dies (or finishes)
// early is noticed instead of leaving the export waiting forever.

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { ffmpegFailure, type FfmpegExit } from '../shared/exportArgs';

export interface FfmpegJob {
  /** Write one frame. Throws once ffmpeg has exited. */
  write(bytes: Uint8Array): Promise<void>;
  /** Close stdin and wait for ffmpeg. Throws (and deletes the partial
   *  output) when it failed. */
  end(): Promise<void>;
  /** Kill ffmpeg and delete whatever it wrote. */
  abort(): Promise<void>;
}

const STDERR_KEEP = 16 * 1024;

export async function startFfmpegJob(bin: string, argv: string[], outPath: string): Promise<FfmpegJob> {
  const ff = spawn(bin, argv);
  let stderr = '';
  ff.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-STDERR_KEEP);
  });
  // EPIPE after ffmpeg dies surfaces through `exited`, not as a crash.
  ff.stdin.on('error', () => {});

  let exit: FfmpegExit | null = null;
  const exited = new Promise<FfmpegExit>((resolve) => {
    ff.once('error', (error) => resolve((exit ??= { code: null, signal: null, error })));
    ff.once('close', (code, signal) => resolve((exit ??= { code, signal })));
  });
  const failure = () => (exit ? ffmpegFailure(exit, stderr) : null);
  const removeOutput = () => rmSync(outPath, { force: true });

  // Surface "ffmpeg is missing" from begin, not from the first frame.
  const early = await Promise.race([new Promise<null>((r) => ff.once('spawn', () => r(null))), exited]);
  if (early?.error) throw new Error(ffmpegFailure(early, stderr)!);

  return {
    async write(bytes) {
      if (exit) throw new Error(failure() ?? 'ffmpeg stopped before all frames were sent');
      if (!ff.stdin.write(bytes)) {
        await Promise.race([new Promise((r) => ff.stdin.once('drain', r)), exited]);
      }
    },
    async end() {
      ff.stdin.end();
      await exited;
      const why = failure();
      if (why) {
        console.error('ffmpeg export failed:', why, '\n', stderr);
        removeOutput();
        throw new Error(why);
      }
    },
    async abort() {
      if (!exit) ff.kill('SIGKILL');
      await exited;
      removeOutput();
    },
  };
}
