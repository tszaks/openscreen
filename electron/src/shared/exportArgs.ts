// Export encode plumbing that doesn't need Electron: output size, the ffmpeg
// argv for the frame pipe, and turning an ffmpeg exit into a readable error.

import type { Project } from './types';

/** libx264 + yuv420p needs even width and height. */
export const evenDimension = (x: number) => Math.max(2, 2 * Math.round(x / 2));

/** Output canvas for an export preset, both sides even. */
export function exportCanvasSize(
  sourceSize: { width: number; height: number },
  preset: Project['exportPreset'],
): { width: number; height: number } {
  const h = preset === 'uhd4k' ? 2160 : preset === 'original' ? sourceSize.height : 1080;
  return {
    width: evenDimension((h * sourceSize.width) / sourceSize.height),
    height: evenDimension(h),
  };
}

export interface ExportArgsInput {
  outPath: string;
  w: number;
  h: number;
  fps: number;
  audioIn?: string;
  /** Whether audioIn really has an audio stream (main probes for it). */
  hasAudio: boolean;
  audioClips?: { start: number; end: number; speed: number }[];
  clicks?: number[];
  voiceCleanup?: boolean;
  /** Output length in seconds (frames / fps); the audio is cut to match. */
  duration: number;
}

// Voice cleanup: rumble cut → FFT denoise → gentle compression → limiter.
const CLEANUP =
  'highpass=f=70,afftdn=nf=-24,acompressor=threshold=-20dB:ratio=2.5:attack=10:release=150:makeup=3,alimiter=limit=0.891';

/** ffmpeg argv: raw RGBA frames on stdin (+ optional audio) → h264 mp4. */
export function buildExportArgs(args: ExportArgsInput): string[] {
  const { hasAudio } = args;

  // Click sfx: a decaying-sine tick per output-time click, mixed into
  // whatever program audio exists (or as the whole track when none).
  const clicks = (args.clicks ?? []).filter((t) => t >= 0).slice(0, 300);
  const sfxParts: string[] = [];
  if (clicks.length) {
    // short decaying sine ping per click
    sfxParts.push(`[sfxin]asplit=${clicks.length}${clicks.map((_, i) => `[s${i}]`).join('')}`);
    clicks.forEach((t, i) => {
      const ms = Math.round(t * 1000);
      sfxParts.push(`[s${i}]adelay=${ms}|${ms},volume=0.6[c${i}]`);
    });
    sfxParts.push(`${clicks.map((_, i) => `[c${i}]`).join('')}amix=inputs=${clicks.length}:normalize=0[sfx]`);
  }

  const cleanup = args.voiceCleanup === true;

  const filters: string[] = [];
  let programPad = ''; // labeled pad feeding program audio into amix, or ''
  if (hasAudio && args.audioIn && args.audioClips?.length) {
    const clips = args.audioClips;
    filters.push(
      ...clips.map(
        (c, i) =>
          `[1:a]atrim=start=${c.start.toFixed(3)}:end=${c.end.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${Math.min(100, Math.max(0.5, c.speed))}${cleanup ? ',' + CLEANUP : ''}[a${i}]`,
      ),
      `${clips.map((_, i) => `[a${i}]`).join('')}concat=n=${clips.length}:v=0:a=1[prog]`,
    );
    programPad = '[prog]';
  } else if (hasAudio && args.audioIn && cleanup) {
    filters.push(`[1:a]${CLEANUP}[prog]`);
    programPad = '[prog]';
  } else if (hasAudio && args.audioIn) {
    programPad = '[1:a]'; // identity timeline: the source track as is
  }

  const lavfiIndex = args.audioIn ? 2 : 1;
  const lavfiInputs: string[] = clicks.length
    ? ['-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(1900*2*PI*t)*exp(-t*70):s=44100:d=0.09']
    : [];
  if (clicks.length) filters.unshift(`[${lavfiIndex}:a]anull[sfxin]`, ...sfxParts);

  // Everything audible is mixed over a silent bed exactly as long as the
  // video, so the file always ends where the video ends. `-shortest` can't
  // be trusted for that: a click-only track ends at the last click and cut
  // the video off there, and ffmpeg 6 ignores apad in this graph.
  const audible = [programPad, clicks.length ? '[sfx]' : ''].filter(Boolean);
  const audioArgs = audible.length
    ? [
        ...(args.audioIn ? ['-i', args.audioIn] : []),
        ...lavfiInputs,
        '-filter_complex',
        [
          ...filters,
          `anullsrc=r=48000:cl=stereo:d=${args.duration.toFixed(3)}[bed]`,
          `[bed]${audible.join('')}amix=inputs=${audible.length + 1}:duration=first:normalize=0[aout]`,
        ].join(';'),
        '-map', '0:v', '-map', '[aout]',
        '-c:a', 'aac',
      ]
    : [];
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${args.w}x${args.h}`,
    '-r', String(args.fps),
    '-i', 'pipe:0',
    ...audioArgs,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '18',
    args.outPath,
  ];
}

export interface FfmpegExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be started at all. */
  error?: { code?: string | number | null; message: string };
}

export const FFMPEG_MISSING =
  'ffmpeg was not found, so nothing can be exported. Reinstall OpenScreen to restore the bundled ffmpeg.';

/** A readable reason for a failed ffmpeg run, or null when it succeeded.
 *  `stderr` is what ffmpeg printed at -loglevel error; its first line is
 *  the root cause (later lines are the fallout). */
export function ffmpegFailure(exit: FfmpegExit, stderr: string): string | null {
  if (exit.error) {
    return exit.error.code === 'ENOENT' ? FFMPEG_MISSING : `ffmpeg could not start: ${exit.error.message}`;
  }
  if (exit.code === 0) return null;
  const how = exit.code !== null ? `exit ${exit.code}` : `killed by ${exit.signal ?? 'unknown signal'}`;
  const first = stderr
    .split('\n')
    .map((l) => l.replace(/^\[[^\]]*@ 0x[0-9a-f]+\]\s*/i, '').trim())
    .find((l) => l.length > 0);
  return `ffmpeg failed (${how})${first ? `: ${first}` : ''}`;
}

/** Electron wraps errors thrown in ipcMain.handle as
 *  "Error invoking remote method 'x': Error: msg". Keep just msg. */
export function ipcErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}
