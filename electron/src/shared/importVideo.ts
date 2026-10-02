// Import Video…: turning a video file made elsewhere into a project. What
// to call the bundle, whether the phone treatment applies, whether Chromium
// can play the file as it is, and what a file dropped on the window does.
// Pure, so the app, the agent CLI and the tests all agree.

import { detectDevice } from './devices';
import { AUDIO_EXTENSIONS } from './audioTracks';
import { defaultProject, fileSafeName, type Project, type SourceKind } from './types';

/** File types Import Video… offers and a drop accepts. */
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'];

const extOf = (name: string) => name.match(/\.([^./\\]+)$/)?.[1]?.toLowerCase() ?? '';
export const isVideoFile = (name: string) => VIDEO_EXTENSIONS.includes(extOf(name));
export const isAudioFile = (name: string) => AUDIO_EXTENSIONS.includes(extOf(name));

/** The project name for a file: its name without folder or extension. */
export function importName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? '';
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  return stem.trim() || 'Imported video';
}

/**
 * The bundle folder for an import: "<name>.openscreen", or "<name> 2.openscreen"
 * (3, 4, …) when that is taken. `taken` answers for a folder name.
 */
export function uniqueBundleName(name: string, taken: (folder: string) => boolean): string {
  const safe = fileSafeName(name);
  for (let n = 1; ; n++) {
    const folder = `${n === 1 ? safe : `${safe} ${n}`}.openscreen`;
    if (!taken(folder)) return folder;
  }
}

/**
 * 'iosDevice' when the video is an iPhone or iPad screen: exactly a model's
 * native size (the phone's own Screen Recording), either way up, or an
 * iPhone screen scaled down evenly (a shared or re-encoded copy). Only the
 * tall Face ID iPhones count when scaled: 16:9 and 4:3 are ordinary video
 * shapes too. Anything else is a screen video ('display').
 */
export function importedSourceKind(width: number, height: number): SourceKind {
  if (!(width > 0) || !(height > 0)) return 'display';
  const match = detectDevice(width, height);
  if (match.exact) return 'iosDevice';
  const d = match.device;
  const tallIphone = d.family === 'iphone' && d.screenPx.height / d.screenPx.width > 2;
  return match.confidence >= 0.8 && tallIphone ? 'iosDevice' : 'display';
}

/**
 * What Electron's Chromium decodes, measured in Electron 41 by playing a
 * file of each kind (canPlayType can't tell: it says '' for QuickTime,
 * which plays). h264 and hevc at any bit depth and chroma, vp8, vp9 and av1
 * play in mp4, mov, m4v, webm and mkv. mpeg4 part 2 and ProRes play their
 * sound over a blank picture, with no error.
 */
export const PLAYABLE_VIDEO = ['h264', 'hevc', 'vp8', 'vp9', 'av1'];
/** Sound that plays. ac3 and alac play silently, with no error. */
export const PLAYABLE_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];
const playableAudio = (codec: string) => PLAYABLE_AUDIO.includes(codec) || codec.startsWith('pcm_');

/**
 * How an import gets a file the editor can play:
 *  - 'none': copied as it is;
 *  - 'audio': the picture is copied and the sound re-encoded to AAC (mp4);
 *  - 'full': re-encoded to H.264 + AAC (mp4).
 * A phone screen stored sideways (a rotation flag) is re-encoded upright,
 * because tap detection reads the stored frames.
 */
export type ImportConversion = 'none' | 'audio' | 'full';

export function importConversion(info: {
  videoCodec: string | null;
  audioCodec: string | null;
  rotation?: number;
  sourceKind?: SourceKind;
}): ImportConversion {
  const video = (info.videoCodec ?? '').toLowerCase();
  if (!PLAYABLE_VIDEO.includes(video)) return 'full';
  if (info.sourceKind === 'iosDevice' && quarterTurn(info.rotation)) return 'full';
  const audio = (info.audioCodec ?? '').toLowerCase();
  if (!audio || playableAudio(audio)) return 'none';
  // vp8 has no place in mp4, so its sound can't be swapped on its own.
  return video === 'vp8' ? 'full' : 'audio';
}

/** True for a 90° or 270° display rotation (the picture shows sideways from how it is stored). */
export const quarterTurn = (rotation?: number) => !!rotation && Math.abs(Math.round(rotation / 90)) % 2 === 1;

/** The picture's size as it plays: rotated a quarter turn, width and height swap. */
export function displayedSize(width: number, height: number, rotation?: number) {
  return quarterTurn(rotation) ? { width: height, height: width } : { width, height };
}

/** The video file inside the bundle: the original's extension when copied, mp4 when converted. */
export function importedVideoFile(source: string, conversion: ImportConversion): string {
  return conversion === 'none' ? `screen.${extOf(source) || 'mp4'}` : 'screen.mp4';
}

/** ffmpeg arguments for a conversion (with -progress on stdout for the sheet). */
export function conversionArgs(
  input: string,
  output: string,
  conversion: Exclude<ImportConversion, 'none'>,
  info: { videoCodec: string | null; hasAudio: boolean },
): string[] {
  const audio = info.hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k'] : [];
  const video =
    conversion === 'audio'
      ? ['-c:v', 'copy', ...((info.videoCodec ?? '') === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
      : // H.264 needs even sides; yuv420p is what every player decodes.
        ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];
  return ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', '-i', input, '-map', '0:v:0', ...audio, ...video, '-movflags', '+faststart', output];
}

/** The project for an imported video. */
export function importedProject(args: {
  name: string;
  videoFile: string;
  size: { width: number; height: number };
  duration: number;
}): Project {
  const project = defaultProject({
    screenVideoFile: args.videoFile,
    sourceKind: importedSourceKind(args.size.width, args.size.height),
    sourceSize: { width: args.size.width, height: args.size.height },
    duration: args.duration,
    imported: true,
  });
  // No clicks were recorded, so there are none to sound.
  return { ...project, name: args.name, audio: { ...project.audio, clickSounds: false } };
}

/** What a file dropped on the window does where it lands. */
export type DropAction = 'import' | 'addMusic' | 'ignore';

/**
 * The first dropped file OpenScreen can use, and what to do with it: a
 * video imports as a new project; a sound joins the music track, in the
 * editor only. Everything else (folders, images, a drop mid-recording) is
 * left alone.
 */
export function routeDrop(names: string[], where: 'picker' | 'editor' | 'recording'): { action: DropAction; index: number } {
  if (where === 'recording') return { action: 'ignore', index: -1 };
  for (let i = 0; i < names.length; i++) {
    if (isVideoFile(names[i])) return { action: 'import', index: i };
    if (where === 'editor' && isAudioFile(names[i])) return { action: 'addMusic', index: i };
  }
  return { action: 'ignore', index: -1 };
}

/**
 * The drop overlay's words while files are dragged over the window, from
 * their MIME types (names can't be read until the drop). Null: no overlay.
 */
export function dropHint(types: string[], where: 'picker' | 'editor' | 'recording'): string | null {
  if (where === 'recording') return null;
  // An empty or generic type (an .mkv often has none) may still be a video.
  const maybeVideo = types.some((t) => !t || t.startsWith('video/') || t === 'application/octet-stream');
  if (maybeVideo) return 'Drop to import';
  if (where === 'editor' && types.some((t) => t.startsWith('audio/'))) return 'Drop to add to the music track';
  return null;
}

/** A plain sentence for an import that failed (Node's error codes are not for people). */
export function importErrorMessage(e: unknown, fileName: string): string {
  const err = e as { code?: string; message?: string };
  const text = String(err?.message ?? e);
  if (err?.code === 'ENOSPC' || /No space left on device/i.test(text)) return `There isn't enough free disk space to import ${fileName}. Free up some space and try again.`;
  if (err?.code === 'ENOENT') return `${fileName} couldn't be found. It may have been moved or deleted.`;
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return `OpenScreen isn't allowed to read ${fileName}.`;
  if (err?.code === 'EISDIR') return `${fileName} is a folder, not a video.`;
  return text.replace(/^Error:\s*/, '');
}
