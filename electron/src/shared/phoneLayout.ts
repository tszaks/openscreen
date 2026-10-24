// Floating-phone composition: where the phone, its screen and the title
// card go on each export canvas. Pure math, shared by the renderer's
// compositor, the CLI build and the 3D phone (shared/phone3d/placement.ts).
// Moved from renderer/src/mobile/layout.ts, which re-exports it.
//
// 9:16 puts a headline above a phone at ~70% height, with the headline kept
// inside the platform safe zone (856x1094 centre on 1080x1920). 16:9 puts
// the phone left and the text right. App Store presets are full-bleed: the
// recording fills the canvas, no frame.

import type { DeviceModel, Orientation } from './devices';
import { screenPoints } from './devices';
import { safeRect, type ExportPreset } from './exportPresets';
import {
  DEFAULT_FRAME_SHADOW,
  deviceBodyRect,
  screenCornerRadius,
  screenRectFor,
  type FrameShadow,
  type Rect,
} from './deviceGeometry';

export interface PhoneLayout {
  width: number;
  height: number;
  mode: 'full-bleed' | 'framed';
  /** Device body rect for drawDeviceFrame (null when full-bleed). */
  device: Rect | null;
  /** Where the video goes. Full-bleed covers the canvas and may overhang it. */
  screen: Rect;
  /** Screen corner radius (0 when full-bleed). */
  screenRadius: number;
  /** Title card rect, when requested and the layout has room. */
  title: Rect | null;
  /** Vertical alignment that keeps the title visually attached to the phone. */
  titleAlign: 'bottom' | 'center';
  titleTextAlign: 'center' | 'left';
  shadow: FrameShadow | null;
  /** Safe zone (whole canvas when the preset has none). */
  safe: Rect;
  /** Canvas px per device point, for tap indicators. */
  pointScale: number;
}

export interface LayoutOptions {
  /** Show a title card if the preset allows one. */
  titleCard?: boolean;
  /** Override the phone height (fraction of canvas height). */
  phoneHeight?: number;
  /** Force a frame on or off (App Store presets default to off). */
  deviceFrame?: boolean;
  orientation?: Orientation;
}

/** Contain / cover a w x h box in a rect, centred. */
export function fitRect(w: number, h: number, into: Rect, mode: 'contain' | 'cover'): Rect {
  const s = mode === 'contain' ? Math.min(into.w / w, into.h / h) : Math.max(into.w / w, into.h / h);
  const rw = w * s;
  const rh = h * s;
  return { x: into.x + (into.w - rw) / 2, y: into.y + (into.h - rh) / 2, w: rw, h: rh };
}

export function computePhoneLayout(
  preset: ExportPreset,
  device: DeviceModel,
  opts: LayoutOptions = {},
): PhoneLayout {
  const W = preset.width;
  const H = preset.height;
  const safe = safeRect(preset);
  const orientation: Orientation = opts.orientation ?? 'portrait';
  const landscapeDevice = orientation === 'landscape';
  const sw = landscapeDevice ? device.screenPx.height : device.screenPx.width;
  const sh = landscapeDevice ? device.screenPx.width : device.screenPx.height;
  const pts = screenPoints(device).width;
  const framed = opts.deviceFrame ?? preset.layout === 'framed';

  if (!framed) {
    const screen = fitRect(sw, sh, { x: 0, y: 0, w: W, h: H }, 'cover');
    return {
      width: W, height: H, mode: 'full-bleed', device: null, screen, screenRadius: 0,
      title: null, titleAlign: 'center', titleTextAlign: 'center', shadow: null, safe,
      pointScale: Math.min(screen.w, screen.h) / pts,
    };
  }

  const bodyW = landscapeDevice ? device.bodyMm.height : device.bodyMm.width;
  const bodyH = landscapeDevice ? device.bodyMm.width : device.bodyMm.height;
  const wantTitle = !!opts.titleCard && preset.titleCard;
  const canvasLandscape = W > H * 1.2;
  const margin = Math.min(W, H) * 0.04;
  let body: Rect;
  let title: Rect | null = null;
  let titleAlign: PhoneLayout['titleAlign'] = 'bottom';
  let titleTextAlign: PhoneLayout['titleTextAlign'] = 'center';

  if (canvasLandscape && wantTitle && !landscapeDevice) {
    // Phone left, text right.
    const ph = (opts.phoneHeight ?? preset.phoneHeight) * H;
    const box = { x: W * 0.06, y: (H - ph) / 2, w: W * 0.4, h: ph };
    body = fitRect(bodyW, bodyH, box, 'contain');
    const tx = Math.max(body.x + body.w + W * 0.06, W * 0.5);
    title = { x: tx, y: H * 0.3, w: W - tx - W * 0.07, h: H * 0.4 };
    titleAlign = 'center';
    titleTextAlign = 'left';
  } else if (wantTitle) {
    // Headline stacked above the phone; the headline stays inside the safe zone.
    const titleH = H * (H > W * 1.5 ? 0.14 : 0.15);
    const gap = H * 0.025;
    const maxPhone = H - margin - (Math.max(safe.y, margin) + titleH + gap);
    const ph = Math.min((opts.phoneHeight ?? preset.phoneHeight) * H, maxPhone);
    const phoneBox = fitRect(bodyW, bodyH, { x: margin, y: 0, w: W - margin * 2, h: ph }, 'contain');
    const total = titleH + gap + phoneBox.h;
    const top = Math.max((H - total) / 2, safe.y);
    title = { x: safe.x + safe.w * 0.04, y: top, w: safe.w * 0.92, h: titleH };
    body = { ...phoneBox, y: top + titleH + gap };
  } else {
    const frac = opts.phoneHeight ?? Math.min(0.86, preset.phoneHeight + (H > W * 1.5 ? 0.1 : 0));
    body = fitRect(bodyW, bodyH, { x: margin, y: (H - frac * H) / 2, w: W - margin * 2, h: frac * H }, 'contain');
  }

  const frameOpts = { orientation };
  const bodyRect = deviceBodyRect(body, device, frameOpts);
  const screen = screenRectFor(body, device, frameOpts);
  return {
    width: W, height: H, mode: 'framed',
    device: bodyRect,
    screen,
    screenRadius: screenCornerRadius(body, device, frameOpts),
    title, titleAlign, titleTextAlign,
    shadow: { ...DEFAULT_FRAME_SHADOW },
    safe,
    pointScale: Math.min(screen.w, screen.h) / pts,
  };
}
