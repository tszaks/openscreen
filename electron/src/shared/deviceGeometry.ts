// Where a procedural iPhone / iPad frame puts its body and screen, as pure
// math (no canvas). Moved here from renderer/src/mobile/deviceFrame.ts so the
// CLI build (tsconfig.main.json: main, preload, shared, node) and the 3D
// phone (shared/phone3d) use the exact numbers the 2D frame draws with.
// deviceFrame.ts re-exports everything here, so its importers are unchanged.
//
// Geometry comes from the public numbers in shared/devices.ts (body mm,
// screen px + ppi, corner radius in points), so the screen hole, corner
// radius and island land where they are on the real phone.
//
// `rect` is the body's bounding box. The body is fitted inside it keeping the
// real aspect ratio; side buttons protrude ~0.5 mm beyond it.

import { screenMm, screenPoints, type DeviceModel, type Orientation } from './devices';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameShadow {
  /** Ambient shadow blur, as a fraction of the body's long side. */
  blur: number;
  /** Downward offset, fraction of the body's long side. */
  offsetY: number;
  /** 0..1 */
  opacity: number;
}

export interface DeviceFrameOptions {
  /** Defaults to the rect's aspect (wider than tall = landscape). */
  orientation?: Orientation;
  /** Landscape only: which side the top of the phone (the island) faces. Default 'left'. */
  landscapeTop?: 'left' | 'right';
  /** Soft floating shadow. `true` = the default look; `false` = none. Default true. */
  shadow?: boolean | Partial<FrameShadow>;
  /** Draw side buttons. Default true. */
  buttons?: boolean;
  /** Faint glass reflection on the bezel. Default true. */
  glare?: boolean;
}

export const DEFAULT_FRAME_SHADOW: FrameShadow = { blur: 0.085, offsetY: 0.04, opacity: 0.38 };

export interface FrameGeometry {
  orientation: Orientation;
  /** Rotation applied to the portrait drawing, radians. */
  rotation: number;
  /** Body centre in canvas space. */
  cx: number;
  cy: number;
  /** Portrait-space body size (canvas px). */
  bodyW: number;
  bodyH: number;
  /** Canvas px per millimetre. */
  pxPerMm: number;
  bodyRadius: number;
  rim: number;
  /** Portrait-space screen size and corner radius (canvas px). */
  screenW: number;
  screenH: number;
  screenRadius: number;
  /** Canvas px per device point. */
  pxPerPoint: number;
}

function orientationOf(rect: Rect, o?: Orientation): Orientation {
  return o ?? (rect.w > rect.h ? 'landscape' : 'portrait');
}

export function frameGeometry(
  rect: Rect,
  device: DeviceModel,
  opts: Pick<DeviceFrameOptions, 'orientation' | 'landscapeTop'> = {},
): FrameGeometry {
  const orientation = orientationOf(rect, opts.orientation);
  const landscape = orientation === 'landscape';
  const { width: mmW, height: mmH } = device.bodyMm;
  // Fit the (possibly rotated) body inside rect.
  const boxW = landscape ? mmH : mmW;
  const boxH = landscape ? mmW : mmH;
  const pxPerMm = Math.min(rect.w / boxW, rect.h / boxH);
  const bodyW = mmW * pxPerMm;
  const bodyH = mmH * pxPerMm;
  const smm = screenMm(device);
  const screenW = smm.width * pxPerMm;
  const screenH = smm.height * pxPerMm;
  const pxPerPoint = screenW / screenPoints(device).width;
  const screenRadius = device.cornerRadiusPt * pxPerPoint;
  const border = (bodyW - screenW) / 2;
  // Concentric corners: body radius grows by the border width. Home-button
  // phones and iPads have a flat-edged screen but a rounded body.
  const bodyRadius =
    device.homeButton ? 10.5 * pxPerMm : screenRadius + border * (device.family === 'ipad' ? 0.9 : 1.05);
  const rotation = landscape ? (opts.landscapeTop === 'right' ? Math.PI / 2 : -Math.PI / 2) : 0;
  return {
    orientation,
    rotation,
    cx: rect.x + rect.w / 2,
    cy: rect.y + rect.h / 2,
    bodyW,
    bodyH,
    pxPerMm,
    bodyRadius,
    rim: Math.max(0.75, device.rimMm * pxPerMm),
    screenW,
    screenH,
    screenRadius,
    pxPerPoint,
  };
}

/** Where the body sits inside `rect` (canvas space, after rotation). */
export function deviceBodyRect(rect: Rect, device: DeviceModel, opts: DeviceFrameOptions = {}): Rect {
  const g = frameGeometry(rect, device, opts);
  const w = g.orientation === 'landscape' ? g.bodyH : g.bodyW;
  const h = g.orientation === 'landscape' ? g.bodyW : g.bodyH;
  return { x: g.cx - w / 2, y: g.cy - h / 2, w, h };
}

/** Where to draw the video inside the frame (canvas space). */
export function screenRectFor(rect: Rect, device: DeviceModel, opts: DeviceFrameOptions = {}): Rect {
  const g = frameGeometry(rect, device, opts);
  const w = g.orientation === 'landscape' ? g.screenH : g.screenW;
  const h = g.orientation === 'landscape' ? g.screenW : g.screenH;
  return { x: g.cx - w / 2, y: g.cy - h / 2, w, h };
}

/** Screen corner radius in canvas px for a frame drawn in `rect`. */
export function screenCornerRadius(rect: Rect, device: DeviceModel, opts: DeviceFrameOptions = {}): number {
  return frameGeometry(rect, device, opts).screenRadius;
}

/**
 * Inverse of screenRectFor: the body rect that puts the screen exactly on
 * `screen`. Lets the compositor keep its existing video rect and wrap a
 * frame around it.
 */
export function frameRectForScreen(screen: Rect, device: DeviceModel, orientation?: Orientation): Rect {
  const o = orientationOf(screen, orientation);
  const smm = screenMm(device);
  const screenLong = o === 'landscape' ? screen.w : screen.h;
  const pxPerMm = screenLong / smm.height;
  const w = (o === 'landscape' ? device.bodyMm.height : device.bodyMm.width) * pxPerMm;
  const h = (o === 'landscape' ? device.bodyMm.width : device.bodyMm.height) * pxPerMm;
  return { x: screen.x + screen.w / 2 - w / 2, y: screen.y + screen.h / 2 - h / 2, w, h };
}

/** Canvas px per device point, for sizing touch indicators in real finger units. */
export function pointScaleFor(screen: Rect, device: DeviceModel): number {
  return Math.min(screen.w, screen.h) / screenPoints(device).width;
}
