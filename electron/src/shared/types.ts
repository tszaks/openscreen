// Shared model layer — pure types, no Electron/DOM deps. Everything here is
// unit-tested in vitest and mirrors the (now legacy) Swift modules' semantics.

import type { FocusSegment } from './autofocus';
import type { TapSuggestion } from './taps';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export type CursorKind = 'move' | 'clickDown' | 'clickUp' | 'dragMove';

/** A single cursor observation during recording; position normalized [0,1]. */
export interface CursorSample {
  /** Seconds since recording start. */
  time: number;
  x: number;
  y: number;
  kind: CursorKind;
}

/** A pressed key observed during recording. */
export interface KeystrokeSample {
  /** Seconds since recording start. */
  time: number;
  /** Human-readable key name ("A", "Enter", "Shift"). */
  key: string;
}

/** Camera instruction: at `time`, look at `center` (normalized) at `scale`. */
export interface ZoomKeyframe {
  time: number;
  center: Point;
  scale: number;
}

export interface Clip {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  speed: number;
}

export interface StyleSettings {
  paddingFraction: number;
  cornerRadius: number;
  shadowRadius: number;
  shadowOpacity: number;
  /** Normalized source-space crop (null = full frame). Applied before zoom. */
  cropRect: { x: number; y: number; w: number; h: number } | null;
  background: Background;
  /** Wrap the content frame in device hardware chrome. */
  deviceFrame: 'none' | 'phone';
  /** Software cursor rendering. */
  cursorSize: number; // dot diameter as a fraction of frame height
  cursorTrail: boolean;
  cursorHex: string;
}

export type Background =
  | { kind: 'solid'; hex: string }
  | { kind: 'gradient'; startHex: string; endHex: string; angle: number }
  /** Soft radial colour blobs over a base colour, plus optional film grain.
   *  Blob x/y are 0..1 of the canvas; r is a fraction of its longer side.
   *  grain is the noise opacity (0..0.2). */
  | { kind: 'mesh'; baseHex: string; blobs: { x: number; y: number; r: number; hex: string }[]; grain?: number }
  | { kind: 'imageFile'; path: string; blur?: number }
  | { kind: 'wallpaper' };

/** One word of a transcript with its own time range (whisper token-level). */
export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
}

export interface CaptionCue {
  id: string;
  start: number;
  end: number;
  text: string;
  /** Word-level timing when the transcript came from whisper -ojf. */
  words?: TranscriptWord[];
}

/** A named section marker on the output timeline (YouTube-style chapter). */
export interface Chapter {
  id: string;
  /** Output-time seconds the chapter starts at. */
  start: number;
  title: string;
}

export interface Annotation {
  id: string;
  /** output-time range the overlay is visible (seconds) */
  start: number;
  end: number;
  text: string;
  /** 0=top, 1=middle, 2=bottom third of the content frame */
  band: 0 | 1 | 2;
  hex: string;
}

export interface CameraOverlay {
  enabled: boolean;
  corner: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
  sizeFraction: number;
  circular: boolean;
}

export type SourceKind = 'display' | 'window' | 'region' | 'iosDevice' | 'synthetic';

export interface RecordingRef {
  screenVideoFile: string;
  cameraVideoFile?: string;
  audioFile?: string;
  sourceKind: SourceKind;
  sourceSize: Size;
  duration: number;
  /** Seconds the video started after cursor tracking did. Already applied
   *  to cursor.json/keystrokes.json times; kept for reference. */
  cursorOffset?: number;
  /** Seconds the camera recording started after the screen recording
   *  (near zero: both recorders start together). Not applied anywhere. */
  cameraOffset?: number;
}

/** Whether any automatic zoom source is on: taps for phone takes; clicks or
 *  lingering cursor for screen takes. Manual zooms are separate and unaffected. */
export function autoZoomOn(zoom: Pick<ZoomSettings, 'autofocus' | 'dwell' | 'fromTaps'>, phone: boolean): boolean {
  return phone ? !!zoom.fromTaps : zoom.autofocus || zoom.dwell;
}

/** The timeline's one-click switch: every automatic source off, or back to
 *  the defaults. Manual zooms live in `manualZooms` and are never touched. */
export function withAutoZoom<Z extends Pick<ZoomSettings, 'autofocus' | 'dwell' | 'fromTaps'>>(zoom: Z, phone: boolean, on: boolean): Z {
  return phone ? { ...zoom, fromTaps: on } : { ...zoom, autofocus: on, dwell: on };
}

export interface ZoomSettings {
  /** Zoom toward each click. */
  autofocus: boolean;
  /** Also zoom where the cursor lingers. */
  dwell: boolean;
  /** Max auto-zoom scale. */
  depth: number;
  /** Touch regions found by the old "Detect touches" (source time). Kept so
   *  bundles that have them still zoom; new projects use `taps`. */
  motionEvents: CursorSample[];
  /** Phone recordings: zoom toward each tap on the taps track. */
  fromTaps: boolean;
}

/** Hardware frame around a phone recording. */
export interface DeviceSettings {
  frame: boolean;
  /** devices.ts model id; unset = detected from the recording's size. */
  modelId?: string;
  finishId?: string;
}

export interface TapStyle {
  /** Draw the indicators at all (the taps stay on the track either way). */
  show: boolean;
  style: 'ripple' | 'pulse' | 'ring';
  color: 'white' | 'accent';
  /** Indicator diameter in device points. */
  sizePt: number;
}

/** A still stretch of the recording (source time), from tap analysis. */
export interface WaitRange {
  start: number;
  end: number;
  /** Stillness at the very start or end of the recording. */
  edge?: 'start' | 'end';
}

export interface LayoutSettings {
  /** exportPresets.ts id, or 'none' for the classic padded frame. */
  presetId: string;
  background: 'style' | 'blurred';
  titleCard?: { title: string; subtitle: string };
}

export interface AudioSettings {
  clickSounds: boolean;
  voiceCleanup: boolean;
}

/**
 * A piece of added sound (music, a voiceover) placed on an audio track. Its
 * file lives inside the bundle so the project stays self-contained. Items sit
 * in OUTPUT time and stay put when clips are cut or sped up, the way music
 * does on a separate track; they always play at normal speed.
 */
export interface AudioItem {
  id: string;
  /** Bundle-relative path of the copied file, e.g. "audio/<id>.mp3". */
  file: string;
  /** What to call it: the imported file's name. */
  name: string;
  /** Length of the whole file in seconds, so trims can't run past it. */
  fileDuration: number;
  /** Output-time second the item starts playing at. */
  start: number;
  /** The part of the file that plays, in file seconds (sourceIn < sourceOut). */
  sourceIn: number;
  sourceOut: number;
  /** Linear volume, 0..1. */
  gain: number;
  /** Seconds of fade at each end. */
  fadeIn: number;
  fadeOut: number;
  /** Repeat the sourceIn..sourceOut part until the video ends. */
  loop: boolean;
}

/** A row of the timeline that plays sound alongside the recording. Only
 *  'audio' exists today; video and overlay tracks join this union later. */
export interface AudioTrack {
  id: string;
  kind: 'audio';
  name: string;
  muted: boolean;
  /** Linear volume for the whole track, 0..1 (multiplies each item's gain). */
  volume: number;
  /** Lower the recording's own sound while this track's items play. */
  duck: boolean;
  items: AudioItem[];
}

export type Track = AudioTrack;

export interface Project {
  /** What the user named it (double-click the title); else the folder's name. */
  name?: string;
  recording: RecordingRef;
  clips: Clip[];
  zoomKeyframes: ZoomKeyframe[];
  /** Zooms added by hand (Option-click the timeline), in output time. */
  manualZooms: FocusSegment[];
  zoom: ZoomSettings;
  audio: AudioSettings;
  style: StyleSettings;
  cameraOverlay: CameraOverlay;
  captions: CaptionCue[];
  chapters: Chapter[];
  annotations: Annotation[];
  exportPreset: 'original' | 'p1080' | 'uhd4k';
  outputFPS: number;
  device: DeviceSettings;
  /** Touch indicators, in SOURCE time like cursor samples. */
  taps: TapSuggestion[];
  tapStyle: TapStyle;
  /** Still stretches found alongside the taps (source time). */
  waits: WaitRange[];
  /** Tap analysis has run once, so opening the project doesn't rerun it. */
  tapsAnalyzed: boolean;
  layout: LayoutSettings;
  /** Extra tracks under the recording (music, voiceover). Empty for most projects. */
  tracks: Track[];
}

export const defaultStyle = (): StyleSettings => ({
  paddingFraction: 0.08,
  cornerRadius: 24,
  shadowRadius: 60,
  shadowOpacity: 0.35,
  cropRect: null,
  background: { kind: 'gradient', startHex: '#3a1c71', endHex: '#d76d77', angle: 120 },
  deviceFrame: 'none',
  cursorSize: 0.012,
  cursorTrail: false,
  cursorHex: '#ffffff',
});

// Phone footage zooms gentler: at 2x a tap target plus its context no longer
// fits the screen, so the push-in crops the UI the viewer needs to see.
export const defaultZoom = (r?: RecordingRef): ZoomSettings => ({
  autofocus: true,
  dwell: true,
  depth: isPhone(r) ? 1.6 : 2,
  motionEvents: [],
  fromTaps: true,
});

export const defaultTapStyle = (): TapStyle => ({ show: true, style: 'ripple', color: 'white', sizePt: 52 });

const isPhone = (r: RecordingRef | undefined) => r?.sourceKind === 'iosDevice';

/** Phone recordings open framed on a 9:16 canvas over a blurred backdrop;
 *  everything else keeps the classic padded frame. */
export const defaultLayout = (r: RecordingRef): LayoutSettings => ({
  presetId: isPhone(r) ? 'social-9x16' : 'none',
  background: isPhone(r) ? 'blurred' : 'style',
});

export const defaultAudio = (): AudioSettings => ({ clickSounds: true, voiceCleanup: false });

export const defaultProject = (recording: RecordingRef): Project => ({
  recording,
  clips: [{ id: crypto.randomUUID(), sourceStart: 0, sourceEnd: recording.duration, speed: 1 }],
  zoomKeyframes: [],
  manualZooms: [],
  zoom: defaultZoom(recording),
  audio: defaultAudio(),
  style: defaultStyle(),
  cameraOverlay: { enabled: false, corner: 'bottomLeft', sizeFraction: 0.22, circular: true },
  captions: [],
  chapters: [],
  annotations: [],
  exportPreset: 'p1080',
  outputFPS: 60,
  device: { frame: isPhone(recording) },
  taps: [],
  tapStyle: defaultTapStyle(),
  waits: [],
  tapsAnalyzed: false,
  layout: defaultLayout(recording),
  tracks: [],
});

/**
 * Back to the take as it was first opened: every edit gone (cuts, speed,
 * zooms, captions, text, crop, taps, frame and layout choices), keeping only
 * the recording and the backdrop (the style background, and whether a phone
 * take uses the blurred one). Taps come back empty and unanalysed, so the
 * next open (or Auto-edit, or Re-detect) finds them again, as on a fresh take.
 */
export function resetProject(p: Project): Project {
  const fresh = defaultProject(p.recording);
  if (p.name) fresh.name = p.name;
  fresh.style.background = structuredClone(p.style.background);
  fresh.layout.background = p.layout.background;
  // Recording sets this whenever a camera was captured.
  if (p.recording.cameraVideoFile) fresh.cameraOverlay.enabled = true;
  return fresh;
}

/** The name to show and to save exports under: the user's, else the folder's. */
export function projectName(project: Pick<Project, 'name'>, bundleDir: string) {
  const named = project.name?.trim();
  if (named) return named;
  return (bundleDir.split('/').filter(Boolean).pop() ?? 'Untitled').replace(/\.openscreen$/, '');
}

/** A project name made safe as a file name (no path separators or colons). */
export const fileSafeName = (name: string) => name.replace(/[/:\\]/g, '-').replace(/^\.+/, '').trim() || 'OpenScreen export';

/** Fill in fields that bundles saved by older versions don't have. */
export function normalizeProject(raw: Project): Project {
  const p = { ...raw };
  p.annotations ??= [];
  p.captions ??= [];
  p.chapters ??= [];
  p.zoomKeyframes ??= [];
  p.manualZooms ??= [];
  p.zoom = { ...defaultZoom(p.recording), ...p.zoom };
  p.audio = { ...defaultAudio(), ...p.audio };
  if (p.style) p.style = { ...p.style, deviceFrame: p.style.deviceFrame ?? 'none' };
  // Older phone bundles: the frame switch lived in style.deviceFrame.
  p.device ??= { frame: isPhone(p.recording) || p.style?.deviceFrame === 'phone' };
  p.taps ??= [];
  p.tapStyle = { ...defaultTapStyle(), ...p.tapStyle };
  p.waits ??= [];
  p.tapsAnalyzed ??= false;
  p.layout = { ...defaultLayout(p.recording), ...p.layout };
  p.tracks = normalizeTracks(p.tracks);
  return p;
}

/** A path that stays inside the bundle: relative, with no ".." step, no drive or backslash tricks. */
export const bundleRelative = (file: unknown): file is string =>
  typeof file === 'string' &&
  file.length > 0 &&
  !file.includes('\0') &&
  !/^([/\\~]|[a-z]:)/i.test(file) &&
  !file.split(/[\\/]/).includes('..');

/** Audio items in saved tracks whose file is not inside the bundle (normalizeTracks drops them). */
export function unsafeAudioFiles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) =>
    Array.isArray(t?.items) ? t.items.filter((i: { file?: unknown }) => i && typeof i === 'object' && !bundleRelative(i.file)).map((i: { file?: unknown }) => String(i.file)) : [],
  );
}

const finite = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const unit = (v: unknown, fallback: number) => Math.min(1, Math.max(0, finite(v, fallback)));

/** Tracks as saved, with every field present and in range. Older bundles have none. */
export function normalizeTracks(raw: unknown): Track[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Partial<AudioTrack> => !!t && typeof t === 'object' && (t.kind ?? 'audio') === 'audio')
    .map((t, ti) => ({
      id: typeof t.id === 'string' ? t.id : `track-${ti + 1}`,
      kind: 'audio' as const,
      name: typeof t.name === 'string' && t.name.trim() ? t.name : 'Music',
      muted: t.muted === true,
      volume: unit(t.volume, 1),
      duck: t.duck === true,
      items: (Array.isArray(t.items) ? t.items : [])
        // A file outside the bundle (absolute, "..") is never played or exported.
        .filter((i): i is AudioItem => !!i && typeof i === 'object' && bundleRelative(i.file))
        .map((i, ii) => {
          const fileDuration = Math.max(0, finite(i.fileDuration, finite(i.sourceOut, 0)));
          const sourceIn = Math.max(0, finite(i.sourceIn, 0));
          const sourceOut = Math.max(sourceIn, finite(i.sourceOut, fileDuration));
          return {
            id: typeof i.id === 'string' ? i.id : `item-${ti + 1}-${ii + 1}`,
            file: i.file,
            name: typeof i.name === 'string' ? i.name : i.file.split('/').pop() ?? i.file,
            fileDuration,
            start: Math.max(0, finite(i.start, 0)),
            sourceIn,
            sourceOut,
            gain: unit(i.gain, 1),
            fadeIn: Math.max(0, finite(i.fadeIn, 0)),
            fadeOut: Math.max(0, finite(i.fadeOut, 0)),
            loop: i.loop === true,
          };
        }),
    }));
}
