import { projectCanvasSize } from './mobileProject';
import type { Project, StyleSettings } from './types';

// "Just me": a camera recorded on its own, as the main source. It is a face
// video, so the editor leaves out what only means something for a screen
// (the cursor, click and dwell zooms, taps) and starts it on a canvas with a
// backdrop and rounded corners, the camera filling its frame.

export const isCameraProject = (p: Pick<Project, 'recording'>) => p.recording.sourceKind === 'camera';

/** What the editor shows for a project. */
export interface EditorFeatures {
  /** The Cursor tab. */
  cursorTab: boolean;
  /** Automatic zooms (click and dwell, or taps) and their switches. */
  autoZoom: boolean;
  /** The Taps lane and touch indicators. */
  taps: boolean;
  /** The Wide 16:9 / Vertical 9:16 canvas choice ("Just me"). */
  canvasChoice: boolean;
}

export function editorFeatures(p: Pick<Project, 'recording'>): EditorFeatures {
  const kind = p.recording.sourceKind;
  if (kind === 'camera') return { cursorTab: false, autoZoom: false, taps: false, canvasChoice: true };
  if (kind === 'iosDevice') return { cursorTab: false, autoZoom: true, taps: true, canvasChoice: false };
  return { cursorTab: true, autoZoom: true, taps: false, canvasChoice: false };
}

/** The canvases a "Just me" video offers. */
export const CAMERA_CANVASES = [
  { id: 'landscape-16x9', label: 'Wide 16:9' },
  { id: 'social-9x16', label: 'Vertical 9:16' },
] as const;
export type CameraCanvas = (typeof CAMERA_CANVASES)[number]['id'];

/** A "Just me" video's look: a soft backdrop, rounded corners, no cursor. */
export const cameraStyle = (style: StyleSettings): StyleSettings => ({
  ...style,
  paddingFraction: 0.06,
  cornerRadius: 36,
  cursorShow: false,
  background: { kind: 'gradient', startHex: '#1d2b64', endHex: '#f8cdda', angle: 135 },
});

/**
 * Put a camera project on `canvas`, cropping the camera (centred) to the
 * shape of its padded frame, so the face fills it on a Wide or a Vertical
 * canvas alike.
 */
export function withCameraCanvas(p: Project, canvas: CameraCanvas): Project {
  const next: Project = { ...p, layout: { ...p.layout, presetId: canvas } };
  const size = projectCanvasSize(next);
  const pad = Math.min(size.width, size.height) * next.style.paddingFraction;
  const frame = (size.width - 2 * pad) / (size.height - 2 * pad);
  const src = p.recording.sourceSize.width / p.recording.sourceSize.height;
  const r = (n: number) => Math.round(n * 10000) / 10000;
  const cropRect =
    Math.abs(src - frame) < 0.005
      ? null
      : src > frame
        ? { x: r((1 - frame / src) / 2), y: 0, w: r(frame / src), h: 1 }
        : { x: 0, y: r((1 - src / frame) / 2), w: 1, h: r(src / frame) };
  return { ...next, style: { ...next.style, cropRect } };
}

/** A new "Just me" project's starting point: Wide, filled, styled, no automatic zooms. */
export function cameraDefaults(p: Project): Project {
  return withCameraCanvas(
    { ...p, style: cameraStyle(p.style), zoom: { ...p.zoom, autofocus: false, dwell: false, fromTaps: false } },
    'landscape-16x9',
  );
}
