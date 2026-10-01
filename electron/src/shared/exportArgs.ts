// Export encode plumbing that doesn't need Electron: output size, the ffmpeg
// argv for the frame pipe, and turning an ffmpeg exit into a readable error.

import { DUCK_GAIN, insideDir, type MusicInput } from './audioTracks';
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
  /** An intermediate for preset transcodes (a .mov): near-lossless video
   *  and PCM audio, so the second encode starts from clean pixels. */
  master?: boolean;
  /** Added sounds from the audio tracks (audioTracks.musicInputs), in output time. */
  music?: MusicInput[];
  /** The project's bundle: every music path must be inside it. Required with music. */
  bundleDir?: string;
  /** Output-time ranges where the recording's own sound is lowered under music. */
  duck?: { start: number; end: number }[];
  /** A Mac + iPhone take with "Phone sound" on: the phone movie and its
   *  offset (phone time = source time - offset). Mixed in only with hasPhoneAudio. */
  phone?: { path: string; offset: number };
  /** Whether the phone movie really has an audio stream (main probes for it). */
  hasPhoneAudio?: boolean;
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
  const duck = (args.duck ?? []).filter((r) => r.end > r.start);
  // Lower the recording under music: a fixed cut while any music plays.
  const duckFilter = duck.length
    ? `volume=${DUCK_GAIN}:enable='${duck.map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`).join('+')}'`
    : '';

  const filters: string[] = [];
  let programPad = ''; // labeled pad feeding program audio into amix, or ''
  if (hasAudio && args.audioIn && args.audioClips?.length) {
    const clips = args.audioClips;
    filters.push(
      ...clips.map(
        (c, i) =>
          `[1:a]atrim=start=${c.start.toFixed(3)}:end=${c.end.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${Math.min(100, Math.max(0.5, c.speed))}${cleanup ? ',' + CLEANUP : ''}[a${i}]`,
      ),
      `${clips.map((_, i) => `[a${i}]`).join('')}concat=n=${clips.length}:v=0:a=1${duckFilter ? `[cat];[cat]${duckFilter}` : ''}[prog]`,
    );
    programPad = '[prog]';
  } else if (hasAudio && args.audioIn && (cleanup || duckFilter)) {
    filters.push(`[1:a]${[cleanup ? CLEANUP : '', duckFilter].filter(Boolean).join(',')}[prog]`);
    programPad = '[prog]';
  } else if (hasAudio && args.audioIn) {
    programPad = '[1:a]'; // identity timeline: the source track as is
  }

  // Inputs after the frame pipe: the recording (1), the click tick, then one per added sound.
  const lavfiIndex = args.audioIn ? 2 : 1;
  const lavfiInputs: string[] = clicks.length
    ? ['-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(1900*2*PI*t)*exp(-t*70):s=44100:d=0.09']
    : [];
  if (clicks.length) filters.unshift(`[${lavfiIndex}:a]anull[sfxin]`, ...sfxParts);

  const outside = (args.music ?? []).find((m) => !args.bundleDir || !insideDir(m.path, args.bundleDir));
  if (outside) throw new Error(`The sound file ${outside.path} is outside this project, so it can't be exported.`);
  const music = (args.music ?? []).filter((m) => m.length > 1e-3 && m.gain > 0 && m.sourceOut > m.sourceIn);
  const musicBase = lavfiIndex + (clicks.length ? 1 : 0);
  const musicInputs = music.flatMap((m) => ['-i', m.path]);
  music.forEach((m, k) => filters.push(`[${musicBase + k}:a]${musicChain(m)}[m${k}]`));

  // The phone's sound: shifted onto the Mac's source clock, then cut and sped
  // up exactly like the program audio, so it stays with its picture.
  const phoneIndex = musicBase + music.length;
  const phoneOn = !!args.phone && args.hasPhoneAudio === true;
  const phoneInputs = phoneOn ? ['-i', args.phone!.path] : [];
  if (phoneOn) filters.push(...phoneChain(phoneIndex, args.phone!.offset, args.audioClips));

  // Everything audible is mixed over a silent bed exactly as long as the
  // video, so the file always ends where the video ends. `-shortest` can't
  // be trusted for that: a click-only track ends at the last click and cut
  // the video off there, and ffmpeg 6 ignores apad in this graph.
  const audible = [programPad, clicks.length ? '[sfx]' : '', ...music.map((_, k) => `[m${k}]`), phoneOn ? '[phone]' : ''].filter(Boolean);
  const audioArgs = audible.length
    ? [
        ...(args.audioIn ? ['-i', args.audioIn] : []),
        ...lavfiInputs,
        ...musicInputs,
        ...phoneInputs,
        '-filter_complex',
        [
          ...filters,
          `anullsrc=r=48000:cl=stereo:d=${args.duration.toFixed(3)}[bed]`,
          `[bed]${audible.join('')}amix=inputs=${audible.length + 1}:duration=first:normalize=0[aout]`,
        ].join(';'),
        '-map', '0:v', '-map', '[aout]',
        '-c:a', args.master ? 'pcm_s16le' : 'aac',
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
    ...(args.master ? ['-preset', 'veryfast', '-crf', '10'] : ['-crf', '18']),
    args.outPath,
  ];
}

/**
 * The phone movie's sound (input `index`) as filters ending in [phone]: moved
 * onto the Mac recording's source clock (delayed when the phone started
 * later, trimmed when it started first), then through the same clip cuts and
 * speeds as the program audio.
 */
export function phoneChain(index: number, offset: number, clips?: { start: number; end: number; speed: number }[]): string[] {
  const f = (n: number) => n.toFixed(3);
  const ms = Math.round(offset * 1000);
  const shift = ms > 0 ? `adelay=delays=${ms}:all=1` : ms < 0 ? `atrim=start=${f(-offset)},asetpts=PTS-STARTPTS` : 'anull';
  const base = `[${index}:a]${shift},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo`;
  if (!clips?.length) return [`${base}[phone]`];
  return [
    `${base},asplit=${clips.length}${clips.map((_, i) => `[ph${i}]`).join('')}`,
    ...clips.map(
      (c, i) => `[ph${i}]atrim=start=${f(c.start)}:end=${f(c.end)},asetpts=PTS-STARTPTS,atempo=${Math.min(100, Math.max(0.5, c.speed))}[pc${i}]`,
    ),
    `${clips.map((_, i) => `[pc${i}]`).join('')}concat=n=${clips.length}:v=0:a=1[phone]`,
  ];
}

/**
 * One added sound's filter chain: cut the part of the file that plays,
 * repeat it when looping, cut it where it stops (the video's end at the
 * latest), set its volume and fades, then delay it to its start. Resampled to
 * 48 kHz stereo first so a loop's length in samples is exact.
 */
export function musicChain(m: MusicInput): string {
  const f = (n: number) => n.toFixed(3);
  const parts = m.loop
    ? [
        `atrim=start=${f(m.sourceIn)}:end=${f(m.sourceOut)}`,
        'asetpts=PTS-STARTPTS',
        'aresample=48000',
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
        `aloop=loop=-1:size=${Math.max(1, Math.round((m.sourceOut - m.sourceIn) * 48000))}`,
        'asetpts=N/SR/TB',
        `atrim=end=${f(m.length)}`,
      ]
    : [
        `atrim=start=${f(m.sourceIn)}:end=${f(Math.min(m.sourceOut, m.sourceIn + m.length))}`,
        'asetpts=PTS-STARTPTS',
        'aresample=48000',
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
      ];
  if (Math.abs(m.gain - 1) > 1e-6) parts.push(`volume=${+m.gain.toFixed(4)}`);
  if (m.fadeIn > 0) parts.push(`afade=t=in:st=0:d=${f(m.fadeIn)}`);
  if (m.fadeOut > 0) parts.push(`afade=t=out:st=${f(Math.max(0, m.length - m.fadeOut))}:d=${f(m.fadeOut)}`);
  const ms = Math.round(m.delay * 1000);
  if (ms > 0) parts.push(`adelay=delays=${ms}:all=1`);
  return parts.join(',');
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
