import { OVERLAY_SIZES, macContentRect, positionForScreenPoint } from './cameraOverlay';
import type { Rect as CanvasRect } from './phoneLayer';
import type { CameraOverlay, Project, SourceKind } from './types';
import { projectCanvasSize } from './mobileProject';

// The recording monitor: a small floating window shown during a take with
// the camera on, so the person recording sees themselves. It has two live
// tiles side by side: what is being recorded (the Mac screen, or the iPhone)
// and the face camera. The source tile can be switched off, leaving just
// the face bubble. It is never in the recording (main hides it from screen
// capture; the camera is recorded on its own and composited in the editor),
// and its face size, shape and position become the new project's camera
// bubble.

/** A rect in screen points (window frames, displays). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FaceSize = 'small' | 'large';
export type FaceShape = 'round' | 'square';

/** What the person chose for the monitor; remembered between takes. */
export interface MonitorPrefs {
  /** "Show me while recording". */
  show: boolean;
  size: FaceSize;
  shape: FaceShape;
  /** Which side the face tile is on; the source tile takes the other. */
  faceSide: 'left' | 'right';
  /** Show the screen/iPhone tile beside the face. Off: just the face. */
  sourceTile: boolean;
  /** Where the window was last left: its centre as a fraction of the
   *  display's work area. Unset: the bottom-right corner. */
  spot?: { u: number; v: number };
}

export const DEFAULT_MONITOR: MonitorPrefs = { show: true, size: 'large', shape: 'round', faceSide: 'right', sourceTile: true };

/** The face tile's side (points): big enough to see yourself at Large. */
export const FACE_PX: Record<FaceSize, number> = { small: 140, large: 220 };
/** The widest the source tile gets; a wide Mac screen is letterboxed into it. */
export const SOURCE_MAX_W: Record<FaceSize, number> = { small: 168, large: 260 };
/** Between the tiles. */
export const TILE_GAP = 8;
/** Clear space inside the window around the tiles, for their shadow and the hide button. */
export const MONITOR_PAD = 18;
/** Default distance from the work area's bottom-right corner to the tiles. */
export const MONITOR_INSET = 32;

/** The monitor's tiles in window coordinates, and the window's size. */
export interface MonitorLayout {
  width: number;
  height: number;
  face: Rect;
  /** Null: no source tile (switched off, or nothing to show). */
  source: Rect | null;
}

/**
 * Lay out the monitor. `sourceAspect` is the source's width/height, or null
 * for no source tile. Both tiles are the face's height; a source wider than
 * SOURCE_MAX_W is fitted inside that width and centred vertically.
 */
export function monitorLayout(opts: { size: FaceSize; faceSide: 'left' | 'right'; sourceAspect: number | null }): MonitorLayout {
  const h = FACE_PX[opts.size];
  const aspect = opts.sourceAspect && Number.isFinite(opts.sourceAspect) && opts.sourceAspect > 0 ? opts.sourceAspect : null;
  let source: Rect | null = null;
  let sourceBoxW = 0;
  if (aspect) {
    const fitsHeight = h * aspect <= SOURCE_MAX_W[opts.size];
    sourceBoxW = fitsHeight ? Math.round(h * aspect) : SOURCE_MAX_W[opts.size];
    const sh = fitsHeight ? h : Math.round(sourceBoxW / aspect);
    source = { x: 0, y: MONITOR_PAD + Math.round((h - sh) / 2), width: sourceBoxW, height: sh };
  }
  const gap = source ? TILE_GAP : 0;
  const width = MONITOR_PAD * 2 + h + gap + sourceBoxW;
  const height = MONITOR_PAD * 2 + h;
  const faceLeft = opts.faceSide === 'left' || !source;
  const face = { x: faceLeft ? MONITOR_PAD : MONITOR_PAD + sourceBoxW + gap, y: MONITOR_PAD, width: h, height: h };
  if (source) source.x = faceLeft ? MONITOR_PAD + h + gap : MONITOR_PAD;
  return { width, height, face, source };
}

/** `r` moved (not resized) so it lies inside `area` where it fits. */
export function clampInto(r: Rect, area: Rect): Rect {
  const x = Math.min(Math.max(r.x, area.x), area.x + area.width - r.width);
  const y = Math.min(Math.max(r.y, area.y), area.y + area.height - r.height);
  return { ...r, x: Math.max(area.x, x), y: Math.max(area.y, y) };
}

/**
 * Where the monitor window opens on a display's work area (the part the Dock
 * and menu bar leave): where it was last left (`spot`), else with its tiles
 * MONITOR_INSET from the bottom-right corner. Always fully on the work area.
 */
export function placeMonitor(workArea: Rect, size: { width: number; height: number }, spot?: { u: number; v: number }): Rect {
  const at = spot && [spot.u, spot.v].every((n) => Number.isFinite(n))
    ? {
        x: Math.round(workArea.x + spot.u * workArea.width - size.width / 2),
        y: Math.round(workArea.y + spot.v * workArea.height - size.height / 2),
      }
    : {
        x: workArea.x + workArea.width - MONITOR_INSET - size.width + MONITOR_PAD,
        y: workArea.y + workArea.height - MONITOR_INSET - size.height + MONITOR_PAD,
      };
  return clampInto({ ...at, ...size }, workArea);
}

/** The window after its layout changed size: same centre, pulled back inside `area`. */
export function resizeMonitor(win: Rect, size: { width: number; height: number }, area: Rect): Rect {
  const cx = win.x + win.width / 2;
  const cy = win.y + win.height / 2;
  return clampInto({ x: Math.round(cx - size.width / 2), y: Math.round(cy - size.height / 2), ...size }, area);
}

/** The spot to remember for a window: its centre on the work area. */
export const spotFor = (win: Rect, workArea: Rect) => ({
  u: (win.x + win.width / 2 - workArea.x) / workArea.width,
  v: (win.y + win.height / 2 - workArea.y) / workArea.height,
});

/** Where the monitor was when the take ended. */
export interface MonitorPlacement {
  /** The window frame. */
  window: Rect;
  /** The display's full bounds and its work area. */
  display: Rect;
  workArea: Rect;
}

/**
 * The new project's camera bubble from the monitor: the face's size and
 * shape always carry over. On a display take its position does too: the
 * bubble lands over the spot of the recording the face tile covered on
 * screen. Other takes (a window, an iPhone) keep the default position, since
 * the monitor wasn't over what was recorded.
 */
export function overlayFromMonitor(
  overlay: CameraOverlay,
  monitor: { placement: MonitorPlacement | null; layout: MonitorLayout; size: FaceSize; shape: FaceShape },
  project: Project,
  sourceKind: SourceKind,
): CameraOverlay {
  const next: CameraOverlay = { ...overlay, sizeFraction: OVERLAY_SIZES[monitor.size], circular: monitor.shape === 'round' };
  const p = monitor.placement;
  if (!p || sourceKind !== 'display' || !(p.display.width > 0 && p.display.height > 0)) return next;
  const f = monitor.layout.face;
  const u = (p.window.x + f.x + f.width / 2 - p.display.x) / p.display.width;
  const v = (p.window.y + f.y + f.height / 2 - p.display.y) / p.display.height;
  const canvas = projectCanvasSize(project);
  const content: CanvasRect = macContentRect(project, canvas);
  next.position = positionForScreenPoint(u, v, content, canvas);
  return next;
}

/** What a take records, for whether the monitor opens. */
export type TakeSource = SourceKind | 'camera';

/**
 * The monitor opens for a display, window or iPhone take (an iPhone alongside
 * a Mac take too) whose camera actually opened, when "Show me while
 * recording" is on. A camera-only take ("Just me") has its own big mirrored
 * preview instead, and no camera means no monitor.
 */
export function monitorOpensFor(take: { source: TakeSource; cameraOpen: boolean; show: boolean }): boolean {
  return take.show && take.cameraOpen && (take.source === 'display' || take.source === 'window' || take.source === 'iosDevice');
}

/**
 * The monitor's lifecycle in one take: `open` until the take ends, the hide
 * button is pressed, or the camera goes away. Hidden or lost, it stays
 * closed for the rest of the take. `notice` is what to tell the person.
 */
export type MonitorState = { status: 'closed' } | { status: 'open' } | { status: 'hidden' } | { status: 'lost' };

export type MonitorEvent =
  | { type: 'start'; take: Parameters<typeof monitorOpensFor>[0] }
  | { type: 'hide' }
  | { type: 'cameraLost' }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'error' };

export const CAMERA_LOST_NOTICE = 'The camera was disconnected, so your camera view closed. The screen is still recording.';

export function nextMonitor(state: MonitorState, event: MonitorEvent): { state: MonitorState; notice?: string } {
  switch (event.type) {
    case 'start':
      return { state: monitorOpensFor(event.take) ? { status: 'open' } : { status: 'closed' } };
    case 'hide':
      return { state: state.status === 'open' ? { status: 'hidden' } : state };
    case 'cameraLost':
      return state.status === 'open' ? { state: { status: 'lost' }, notice: CAMERA_LOST_NOTICE } : { state };
    case 'stop':
    case 'cancel':
    case 'error':
      return { state: { status: 'closed' } };
  }
}

const PREFS_KEY = 'openscreen.recordingMonitor';

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

/** The remembered choices, with anything missing or unreadable at its default. */
export function readMonitorPrefs(store: KeyValue): MonitorPrefs {
  let raw: Partial<MonitorPrefs> = {};
  try {
    raw = JSON.parse(store.getItem(PREFS_KEY) ?? '{}') ?? {};
  } catch {}
  const d = DEFAULT_MONITOR;
  const spot = raw.spot && [raw.spot.u, raw.spot.v].every((n) => typeof n === 'number' && n >= 0 && n <= 1) ? { u: raw.spot.u, v: raw.spot.v } : undefined;
  return {
    show: typeof raw.show === 'boolean' ? raw.show : d.show,
    size: raw.size === 'small' || raw.size === 'large' ? raw.size : d.size,
    shape: raw.shape === 'round' || raw.shape === 'square' ? raw.shape : d.shape,
    faceSide: raw.faceSide === 'left' || raw.faceSide === 'right' ? raw.faceSide : d.faceSide,
    sourceTile: typeof raw.sourceTile === 'boolean' ? raw.sourceTile : d.sourceTile,
    ...(spot ? { spot } : {}),
  };
}

export function writeMonitorPrefs(store: KeyValue, prefs: MonitorPrefs) {
  try {
    store.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}
