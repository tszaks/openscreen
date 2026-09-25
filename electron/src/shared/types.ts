// Shared model layer — pure types, no Electron/DOM deps. Everything here is
// unit-tested in vitest and mirrors the (now legacy) Swift modules' semantics.

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
  background: Background;
}

export type Background =
  | { kind: 'solid'; hex: string }
  | { kind: 'gradient'; startHex: string; endHex: string; angle: number }
  | { kind: 'imageFile'; path: string }
  | { kind: 'wallpaper' };

export interface CaptionCue {
  id: string;
  start: number;
  end: number;
  text: string;
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
}

export interface Project {
  recording: RecordingRef;
  clips: Clip[];
  zoomKeyframes: ZoomKeyframe[];
  style: StyleSettings;
  cameraOverlay: CameraOverlay;
  captions: CaptionCue[];
  exportPreset: 'original' | 'p1080' | 'uhd4k';
  outputFPS: number;
}

export const defaultStyle = (): StyleSettings => ({
  paddingFraction: 0.08,
  cornerRadius: 24,
  shadowRadius: 60,
  shadowOpacity: 0.35,
  background: { kind: 'gradient', startHex: '#3a1c71', endHex: '#d76d77', angle: 120 },
});

export const defaultProject = (recording: RecordingRef): Project => ({
  recording,
  clips: [{ id: crypto.randomUUID(), sourceStart: 0, sourceEnd: recording.duration, speed: 1 }],
  zoomKeyframes: [],
  style: defaultStyle(),
  cameraOverlay: { enabled: false, corner: 'bottomLeft', sizeFraction: 0.22, circular: true },
  captions: [],
  exportPreset: 'p1080',
  outputFPS: 60,
});
