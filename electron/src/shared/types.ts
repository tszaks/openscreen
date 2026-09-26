// Shared model layer — pure types, no Electron/DOM deps. Everything here is
// unit-tested in vitest and mirrors the (now legacy) Swift modules' semantics.

import type { FocusSegment } from './autofocus';

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

export interface ZoomSettings {
  /** Zoom toward each click. */
  autofocus: boolean;
  /** Also zoom where the cursor lingers. */
  dwell: boolean;
  /** Max auto-zoom scale. */
  depth: number;
  /** Touch regions found by "Detect touches" (source time). */
  motionEvents: CursorSample[];
}

export interface AudioSettings {
  clickSounds: boolean;
  voiceCleanup: boolean;
}

export interface Project {
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

export const defaultZoom = (): ZoomSettings => ({
  autofocus: true,
  dwell: true,
  depth: 2,
  motionEvents: [],
});

export const defaultAudio = (): AudioSettings => ({ clickSounds: true, voiceCleanup: false });

export const defaultProject = (recording: RecordingRef): Project => ({
  recording,
  clips: [{ id: crypto.randomUUID(), sourceStart: 0, sourceEnd: recording.duration, speed: 1 }],
  zoomKeyframes: [],
  manualZooms: [],
  zoom: defaultZoom(),
  audio: defaultAudio(),
  style: defaultStyle(),
  cameraOverlay: { enabled: false, corner: 'bottomLeft', sizeFraction: 0.22, circular: true },
  captions: [],
  chapters: [],
  annotations: [],
  exportPreset: 'p1080',
  outputFPS: 60,
});

/** Fill in fields that bundles saved by older versions don't have. */
export function normalizeProject(raw: Project): Project {
  const p = { ...raw };
  p.annotations ??= [];
  p.captions ??= [];
  p.chapters ??= [];
  p.zoomKeyframes ??= [];
  p.manualZooms ??= [];
  p.zoom = { ...defaultZoom(), ...p.zoom };
  p.audio = { ...defaultAudio(), ...p.audio };
  if (p.style) p.style = { ...p.style, deviceFrame: p.style.deviceFrame ?? 'none' };
  return p;
}
