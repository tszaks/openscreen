// Import Video…: copy (or convert) a video file into a new bundle in the
// recordings folder and give it a project. No Electron here, so the app and
// the agent CLI import the same way.
//
// The bundle is built in a hidden staging folder (".import-<id>", which
// neither recovery nor the bundle lists look at) and renamed into place only
// once project.json is written, so a failed or cancelled import never leaves
// a half-made project behind. The original file is only ever read.

import { spawn } from 'node:child_process';
import { closeSync, constants, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import {
  conversionArgs,
  displayedSize,
  importConversion,
  importErrorMessage,
  importName,
  importedProject,
  importedSourceKind,
  importedVideoFile,
  isVideoFile,
  uniqueBundleName,
  type ImportConversion,
} from '../shared/importVideo';
import type { Project } from '../shared/types';
import { ffmpegPath, probeMedia } from './media';

export interface ImportProgress {
  /** 'copy': the file is being copied in; 'convert': ffmpeg is re-encoding it. */
  stage: 'copy' | 'convert';
  /** 0..1 */
  fraction: number;
}

export interface ImportResult {
  dir: string;
  project: Project;
  conversion: ImportConversion;
  hasAudio: boolean;
}

/** The error an import rejects with when it was cancelled. */
export class ImportCancelled extends Error {
  constructor() {
    super('The import was cancelled.');
  }
}

const STAGING_PREFIX = '.import-';
// Below this much free space, a conversion is not worth starting.
const MIN_FREE_BYTES = 64 * 1024 * 1024;

/** Staging folders a crash left behind (older than a day; a running import's is fresh). */
function removeStaleStaging(root: string) {
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith(STAGING_PREFIX)) continue;
      const dir = join(root, e.name);
      if (Date.now() - statSync(dir).mtimeMs > 24 * 3600 * 1000) rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
}

const freeBytes = (dir: string) => {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
};

const noSpace = () => Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });

/** Copy with progress. A clone (APFS, same disk) is instant and takes no space; otherwise bytes are streamed. */
async function copyIn(src: string, dest: string, size: number, onFraction: (f: number) => void, signal?: AbortSignal) {
  try {
    copyFileSync(src, dest, constants.COPYFILE_FICLONE_FORCE);
    onFraction(1);
    return;
  } catch {
    rmSync(dest, { force: true });
  }
  // A copy needs its own size, plus room for project.json and the disk's own breathing space.
  if (freeBytes(join(dest, '..')) < size + 16 * 1024 * 1024) throw noSpace();
  let done = 0;
  let last = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
      const now = Date.now();
      if (now - last > 100) {
        last = now;
        onFraction(size > 0 ? Math.min(1, done / size) : 0);
      }
      cb(null, chunk);
    },
  });
  await pipeline(createReadStream(src), count, createWriteStream(dest), { signal });
  onFraction(1);
}

/** Run a conversion, reporting ffmpeg's out_time against the duration. */
function convert(bin: string, args: string[], duration: number, onFraction: (f: number) => void, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const ff = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const onAbort = () => ff.kill('SIGKILL');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    ff.stdout.on('data', (d: Buffer) => {
      const last = d.toString().split('\n').filter((l) => l.startsWith('out_time_us=')).pop();
      const us = last ? Number(last.slice('out_time_us='.length)) : NaN;
      if (Number.isFinite(us) && duration > 0) onFraction(Math.min(1, Math.max(0, us) / 1e6 / duration));
    });
    ff.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8192);
    });
    ff.once('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    ff.once('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new ImportCancelled());
      if (code === 0) return resolve();
      const why = stderr.trim().split('\n').slice(-2).join(' ');
      reject(/No space left on device/i.test(why) ? noSpace() : new Error(`The video couldn't be converted (${why || `ffmpeg exited ${code}`}).`));
    });
  });
}

/**
 * Import `source` as a new bundle in `root`, named after the file (or
 * `name`), de-duplicated. Rejects with a plain sentence on failure, or with
 * ImportCancelled after `signal` aborts; either way nothing is left behind.
 */
export async function importVideoFile(
  source: string,
  opts: { root: string; name?: string; bin?: string; onProgress?: (p: ImportProgress) => void; signal?: AbortSignal },
): Promise<ImportResult> {
  const fileName = basename(source);
  const bin = opts.bin ?? ffmpegPath();
  const report = opts.onProgress ?? (() => {});
  let staging: string | null = null;
  try {
    const stat = statSync(source);
    if (stat.isDirectory()) throw Object.assign(new Error('folder'), { code: 'EISDIR' });
    if (!isVideoFile(source)) {
      throw new Error(`${fileName} isn't a video OpenScreen can import. It imports MP4, MOV, M4V, WebM and MKV files.`);
    }
    // Opening it is the honest permission check (stat works on files macOS won't let us read).
    closeSync(openSync(source, 'r'));
    const info = await probeMedia(source, bin);
    if (!info.width || !info.height || !info.videoCodec) throw new Error(`${fileName} has no picture OpenScreen can read.`);
    if (!info.duration || !(info.duration > 0)) throw new Error(`${fileName} has no length OpenScreen can read. It may be damaged or still being written.`);
    const shown = displayedSize(info.width, info.height, info.rotation);
    const conversion = importConversion({ ...info, sourceKind: importedSourceKind(shown.width, shown.height) });

    mkdirSync(opts.root, { recursive: true });
    removeStaleStaging(opts.root);
    staging = join(opts.root, `${STAGING_PREFIX}${randomUUID()}`);
    mkdirSync(staging);
    const videoFile = importedVideoFile(source, conversion);
    const dest = join(staging, videoFile);
    if (opts.signal?.aborted) throw new ImportCancelled();
    if (conversion === 'none') {
      await copyIn(source, dest, stat.size, (fraction) => report({ stage: 'copy', fraction }), opts.signal);
    } else {
      if (freeBytes(staging) < MIN_FREE_BYTES) throw noSpace();
      report({ stage: 'convert', fraction: 0 });
      await convert(bin, conversionArgs(source, dest, conversion, info), info.duration, (fraction) => report({ stage: 'convert', fraction }), opts.signal);
    }
    if (opts.signal?.aborted) throw new ImportCancelled();

    // A converted file is measured again: ffmpeg turned it upright and may round its length.
    const out = conversion === 'none' ? info : await probeMedia(dest, bin);
    if (!out.width || !out.height || !out.duration) throw new Error(`The converted copy of ${fileName} doesn't play.`);
    const size = conversion === 'none' ? shown : displayedSize(out.width, out.height, out.rotation);
    const name = opts.name?.trim() || importName(source);
    const project = importedProject({ name, videoFile, size, duration: out.duration });
    writeFileSync(join(staging, 'cursor.json'), JSON.stringify({ samples: [] }, null, 2));
    writeFileSync(join(staging, 'keystrokes.json'), JSON.stringify({ keys: [] }, null, 2));
    writeFileSync(join(staging, 'project.json'), JSON.stringify(project, null, 2));
    const dir = join(opts.root, uniqueBundleName(name, (folder) => existsSync(join(opts.root, folder))));
    renameSync(staging, dir);
    staging = null;
    return { dir, project, conversion, hasAudio: out.hasAudio };
  } catch (e) {
    if (e instanceof ImportCancelled || (e as Error)?.name === 'AbortError' || opts.signal?.aborted) throw new ImportCancelled();
    throw new Error(importErrorMessage(e, fileName));
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}
