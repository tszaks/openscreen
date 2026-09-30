// Node-only media helpers (ffmpeg, whisper) with no Electron dependency, so
// the main process and the agent CLI run the exact same analysis.

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseFfmpegDuration, parseFfmpegProgressTime, parseFfmpegVideoSize, findWhisperCli, partialPath } from '../shared/recording';
import { extractWavArgs, parseSilences, silenceDetectArgs } from '../shared/silence';
import { analysisFrameSize, analyzeFrames, detectTaps, findDeadTime, splitRawGray, tapAnalysisFfmpegArgs, type TapSuggestion } from '../shared/taps';
import { tokensToWords, type WhisperToken } from '../shared/transcript';
import type { TranscriptWord, WaitRange } from '../shared/types';

/** The bundled ffmpeg (ffmpeg-static; unpacked from the asar when packaged), else PATH. */
export function ffmpegPath(): string {
  if (process.env.OPENSCREEN_FFMPEG) return process.env.OPENSCREEN_FFMPEG;
  try {
    const req = createRequire(__filename);
    const p = req('ffmpeg-static') as string;
    if (p) {
      const unpacked = p.replace('app.asar', 'app.asar.unpacked');
      if (existsSync(unpacked)) return unpacked;
      if (existsSync(p)) return p;
    }
  } catch {}
  return 'ffmpeg';
}

/** Run ffmpeg; resolves with stderr whatever the exit code (callers parse it). */
export function ffmpegStderr(args: string[], bin = ffmpegPath()): Promise<string> {
  return new Promise((resolve) =>
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024 }, (_e, _so, se) => resolve(String(se ?? ''))),
  );
}

/** Run ffmpeg; rejects with its last stderr lines on a non-zero exit. */
export function ffmpegRun(args: string[], bin = ffmpegPath()): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024 }, (e, _so, se) => {
      if (!e) return resolve();
      const tail = String(se ?? '').trim().split('\n').slice(-3).join(' | ');
      reject(new Error(`ffmpeg failed: ${tail || e.message}`));
    }),
  );
}

/** ffmpeg's banner for a file. */
export const probeBanner = (file: string, bin = ffmpegPath()) => ffmpegStderr(['-hide_banner', '-i', file], bin);

/** A file's real duration: from its header, else by reading every packet. */
export async function probeDuration(file: string, bin = ffmpegPath()): Promise<number | null> {
  const fromHeader = parseFfmpegDuration(await probeBanner(file, bin));
  if (fromHeader !== null) return fromHeader;
  const se = await ffmpegStderr(['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'], bin);
  return parseFfmpegProgressTime(se);
}

export interface MediaInfo {
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  videoCodec: string | null;
}

export async function probeMedia(file: string, bin = ffmpegPath()): Promise<MediaInfo> {
  const banner = await probeBanner(file, bin);
  const size = parseFfmpegVideoSize(banner);
  const codec = banner.match(/Stream #\d+:\d+.*Video:\s*([a-z0-9_]+)/)?.[1] ?? null;
  return {
    duration: parseFfmpegDuration(banner) ?? (size ? await probeDuration(file, bin) : null),
    width: size?.width ?? null,
    height: size?.height ?? null,
    hasAudio: /Stream #\d+:\d+.*Audio:/.test(banner),
    videoCodec: codec,
  };
}

/** 16 kHz mono audio.wav next to the video (for silencedetect and whisper). */
export async function extractWav(dir: string, videoFile: string, bin = ffmpegPath()): Promise<string> {
  const wav = join(dir, 'audio.wav');
  await ffmpegRun(extractWavArgs(join(dir, videoFile), wav), bin);
  return wav;
}

/** Silent ranges (source seconds) of a bundle's audio. Empty when it has no audio. */
export async function detectSilences(
  dir: string,
  videoFile: string,
  opts: { thresholdDb?: number; minDur?: number } = {},
  bin = ffmpegPath(),
): Promise<{ start: number; end: number }[]> {
  const wav = await extractWav(dir, videoFile, bin);
  const se = await ffmpegStderr(silenceDetectArgs(wav, opts.thresholdDb, opts.minDur), bin);
  return parseSilences(se, parseFfmpegDuration(se) ?? undefined);
}

/** The editor's tap analysis: tap/swipe suggestions and still stretches (source seconds). */
export async function analyzeTapsInFile(file: string, bin = ffmpegPath()): Promise<{ taps: TapSuggestion[]; deadTime: WaitRange[] }> {
  const banner = await probeBanner(file, bin);
  const size = parseFfmpegVideoSize(banner);
  if (!size) throw new Error('could not read the video size');
  // Long takes analyse at 15 fps so the frames stay in memory comfortably.
  const fps = (parseFfmpegDuration(banner) ?? 0) > 240 ? 15 : 30;
  const { w, h } = analysisFrameSize(size.width, size.height);
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let err = '';
    const ff = spawn(bin, tapAnalysisFfmpegArgs(file, { fps }));
    ff.stdout.on('data', (c: Buffer) => chunks.push(c));
    ff.stderr.on('data', (c: Buffer) => (err += c.toString()));
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
  });
  const frames = splitRawGray(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), w, h, fps);
  const analysis = analyzeFrames(frames);
  const taps = detectTaps(analysis).map((t) => ({ ...t, id: randomUUID() }));
  const deadTime = findDeadTime(analysis).map((d) => ({ start: d.start, end: d.end, ...(d.edge ? { edge: d.edge } : {}) }));
  return { taps, deadTime };
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}

export const whisperCli = () => findWhisperCli(existsSync, (process.env.PATH ?? '').split(delimiter));

/** whisper-cli --output-json-full output → segments in source seconds. */
export function parseWhisperJson(parsed: unknown): TranscriptSegment[] {
  const o = parsed as { transcription?: unknown[]; result?: unknown[] };
  const segs = (o?.transcription ?? o?.result ?? []) as { offsets?: { from: number; to: number }; text?: string; tokens?: WhisperToken[] }[];
  return segs
    .map((s) => ({
      start: (s.offsets?.from ?? 0) / 1000,
      end: (s.offsets?.to ?? 0) / 1000,
      text: (s.text ?? '').trim(),
      words: s.tokens ? tokensToWords(s.tokens) : [],
    }))
    .filter((c) => c.end > c.start && c.text);
}

/** Below this peak level (dBFS) a recording has no audible sound. */
export const SILENT_PEAK_DB = -60;

/** max_volume from ffmpeg's volumedetect output, in dB; null if absent. */
export function parseMaxVolume(stderr: string): number | null {
  const at = stderr.lastIndexOf('max_volume:');
  if (at < 0) return null;
  const value = parseFloat(stderr.slice(at + 'max_volume:'.length));
  return Number.isFinite(value) ? value : null;
}

/**
 * Transcribe a bundle with whisper-cli into transcript.json (whisper's own
 * format) and return its segments. The model downloads on first use.
 */
export async function transcribeBundle(dir: string, videoFile: string, bin = ffmpegPath()): Promise<TranscriptSegment[]> {
  const run = (cmd: string, argv: string[]) =>
    new Promise<void>((resolve, reject) => execFile(cmd, argv, { maxBuffer: 64 * 1024 * 1024 }, (e) => (e ? reject(e) : resolve())));
  const cli = whisperCli();
  if (!cli) throw new Error('Transcription needs whisper-cpp. Install it with: brew install whisper-cpp');
  const modelDir = join(homedir(), 'models');
  const model = process.env.OPENSCREEN_WHISPER_MODEL ?? join(modelDir, 'ggml-base.en.bin');
  if (!existsSync(model)) {
    mkdirSync(modelDir, { recursive: true });
    const part = partialPath(model);
    try {
      await run('curl', ['-fL', '--silent', '--show-error', 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin', '-o', part]);
      renameSync(part, model);
    } catch {
      rmSync(part, { force: true });
      throw new Error('Could not download the speech model (148 MB). Check your connection and try again.');
    }
  }
  const wav = await extractWav(dir, videoFile, bin).catch(() => {
    throw new Error('Could not read the audio from this recording.');
  });
  const jsonOut = join(dir, 'transcript.json');
  // Whisper hallucinates words ("You") on silent audio, which would become
  // bogus captions. A recording with no audible sound has no transcript.
  const peak = parseMaxVolume(await ffmpegStderr(['-hide_banner', '-i', wav, '-af', 'volumedetect', '-f', 'null', '-'], bin));
  if (peak !== null && peak < SILENT_PEAK_DB) {
    writeFileSync(jsonOut, JSON.stringify({ transcription: [], silent: true }));
    return [];
  }
  try {
    await run(cli, ['-m', model, '-f', wav, '--output-json-full', '--output-file', jsonOut.replace(/\.json$/, ''), '-t', '4']);
  } catch {
    throw new Error('whisper-cli failed to transcribe this recording.');
  }
  if (!existsSync(jsonOut)) throw new Error('whisper-cli produced no transcript.');
  return parseWhisperJson(JSON.parse(readFileSync(jsonOut, 'utf8')));
}
