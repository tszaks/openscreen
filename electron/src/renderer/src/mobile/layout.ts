// Floating-phone composition: where the phone, its screen and the title
// card go on each export canvas, plus the blurred-recording background and
// the title card itself.
//
// 9:16 puts a headline above a phone at ~70% height, with the headline kept
// inside the platform safe zone (856x1094 centre on 1080x1920). 16:9 puts
// the phone left and the text right. App Store presets are full-bleed: the
// recording fills the canvas, no frame.

import type { DeviceModel, Orientation } from '../../../shared/devices';
import { screenPoints } from '../../../shared/devices';
import { safeRect, type ExportPreset } from '../../../shared/exportPresets';
import {
  DEFAULT_FRAME_SHADOW,
  deviceBodyRect,
  screenCornerRadius,
  screenRectFor,
  type FrameShadow,
  type Rect,
} from './deviceFrame';

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

// ---------------------------------------------------------------------------
// Blurred recording background

export interface BlurredBackgroundOptions {
  /** Blur radius as a fraction of the canvas' short side. */
  blur: number;
  /** 0..1 darkening, so the phone and title pop. */
  darken: number;
  /** Saturation boost; blurred UI goes grey without it. */
  saturate: number;
  /** 0..1 edge vignette. */
  vignette: number;
}

export const defaultBlurredBackground: BlurredBackgroundOptions = {
  blur: 0.06,
  darken: 0.36,
  saturate: 1.6,
  vignette: 0.35,
};

type Scratch = { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D };
let scratch: Scratch | null = null;

function scratchCanvas(w: number, h: number): Scratch | null {
  if (!scratch) {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (ctx) scratch = { canvas, ctx };
    } else if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (ctx) scratch = { canvas, ctx };
    }
  }
  if (scratch && (scratch.canvas.width !== w || scratch.canvas.height !== h)) {
    scratch.canvas.width = w;
    scratch.canvas.height = h;
  }
  return scratch;
}

/**
 * Fills the canvas with the current video frame, scaled to cover, heavily
 * blurred, saturated and darkened: the "keynote" backdrop that always
 * matches the app's colours. Blurs at 1/8 resolution and scales up, which is
 * both cheaper and smoother than a full-resolution blur.
 */
export function drawBlurredBackground(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceSize: { width: number; height: number },
  canvasSize: { width: number; height: number },
  options: Partial<BlurredBackgroundOptions> = {},
): void {
  const o = { ...defaultBlurredBackground, ...options };
  const { width: W, height: H } = canvasSize;
  const down = 8;
  const sw = Math.max(8, Math.round(W / down));
  const sh = Math.max(8, Math.round(H / down));
  const radius = Math.max(1, (Math.min(W, H) * o.blur) / down);
  const filter = `blur(${radius.toFixed(2)}px) saturate(${o.saturate}) brightness(${1 - o.darken})`;
  const s = scratchCanvas(sw, sh);
  ctx.save();
  if (s) {
    // Overscan by the blur radius so edges do not fade to transparent.
    const cover = fitRect(sourceSize.width, sourceSize.height, { x: -radius * 2, y: -radius * 2, w: sw + radius * 4, h: sh + radius * 4 }, 'cover');
    s.ctx.save();
    s.ctx.clearRect(0, 0, sw, sh);
    s.ctx.filter = filter;
    s.ctx.drawImage(source, cover.x, cover.y, cover.w, cover.h);
    s.ctx.restore();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s.canvas as CanvasImageSource, 0, 0, W, H);
  } else {
    const r = radius * down;
    const cover = fitRect(sourceSize.width, sourceSize.height, { x: -r * 2, y: -r * 2, w: W + r * 4, h: H + r * 4 }, 'cover');
    ctx.filter = filter;
    ctx.drawImage(source, cover.x, cover.y, cover.w, cover.h);
    ctx.filter = 'none';
  }
  if (o.vignette > 0) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) / 2);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${o.vignette})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Title card

export interface TitleCardText {
  title: string;
  subtitle?: string;
}

export interface TitleCardStyle {
  /** 'light' = white text for dark / blurred backdrops. */
  theme: 'light' | 'dark';
  align: 'center' | 'left';
  valign: 'top' | 'center' | 'bottom';
  /** Title weight (SF Pro Display 600-800 reads as a headline). */
  weight: number;
  /** Optional subtitle colour, e.g. the brand accent. */
  accent?: string;
  maxTitleLines: number;
  fontFamily: string;
}

export const defaultTitleCardStyle: TitleCardStyle = {
  theme: 'light',
  align: 'center',
  valign: 'bottom',
  weight: 700,
  maxTitleLines: 2,
  fontFamily: '-apple-system, "SF Pro Display", BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif',
};

/** Apple's display tracking tightens as size grows: about -2.2% of the size for headlines. */
export const titleTracking = (px: number) => -0.022 * px;
const subtitleTracking = (px: number) => -0.004 * px;

function setFont(ctx: CanvasRenderingContext2D, weight: number, px: number, family: string, tracking: number) {
  ctx.font = `${weight} ${px}px ${family}`;
  // Chromium 99+; older engines ignore the property.
  ctx.letterSpacing = `${tracking.toFixed(2)}px`;
}

/**
 * Wraps words into at most `maxLines` lines no wider than `maxW`, balancing
 * line lengths (no one-word widow under a long line). Returns null if the
 * text cannot fit at this size.
 */
export function wrapBalanced(
  words: string[],
  maxLines: number,
  maxW: number,
  measure: (s: string) => number,
): string[] | null {
  if (words.length === 0) return [];
  const whole = words.join(' ');
  if (measure(whole) <= maxW) return [whole];
  if (maxLines < 2) return null;
  // Greedy wrap to get the line count, then rebalance two-line splits.
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (measure(next) <= maxW || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines || lines.some((l) => measure(l) > maxW)) return null;
  if (lines.length === 2) {
    let best: string[] = lines;
    let bestW = Math.max(...lines.map(measure));
    for (let k = 1; k < words.length; k++) {
      const a = words.slice(0, k).join(' ');
      const b = words.slice(k).join(' ');
      const wmax = Math.max(measure(a), measure(b));
      if (wmax <= maxW && wmax < bestW) {
        best = [a, b];
        bestW = wmax;
      }
    }
    return best;
  }
  return lines;
}

export interface TitleCardMetrics {
  titlePx: number;
  subtitlePx: number;
  titleLines: string[];
  subtitleLines: string[];
  blockHeight: number;
}

/** Picks the largest title size that fits the rect with strong hierarchy. */
export function layoutTitleCard(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  text: TitleCardText,
  style: Partial<TitleCardStyle> = {},
): TitleCardMetrics {
  const s = { ...defaultTitleCardStyle, ...style };
  const titleWords = text.title.trim().split(/\s+/).filter(Boolean);
  const subWords = (text.subtitle ?? '').trim().split(/\s+/).filter(Boolean);
  const measure = (weight: number, px: number, tr: (n: number) => number) => (str: string) => {
    setFont(ctx, weight, px, s.fontFamily, tr(px));
    return ctx.measureText(str).width;
  };
  for (let px = Math.floor(rect.h * 0.46); px >= 10; px = Math.floor(px * 0.94)) {
    const titleLines = wrapBalanced(titleWords, s.maxTitleLines, rect.w, measure(s.weight, px, titleTracking));
    if (!titleLines) continue;
    const subPx = Math.max(10, Math.round(px * 0.46));
    const subtitleLines = subWords.length ? wrapBalanced(subWords, 2, rect.w, measure(500, subPx, subtitleTracking)) : [];
    if (!subtitleLines) continue;
    const blockHeight =
      titleLines.length * px * 1.06 + (subtitleLines.length ? px * 0.32 + subtitleLines.length * subPx * 1.3 : 0);
    if (blockHeight <= rect.h) return { titlePx: px, subtitlePx: subPx, titleLines, subtitleLines, blockHeight };
  }
  return { titlePx: 10, subtitlePx: 10, titleLines: [text.title], subtitleLines: [], blockHeight: 12 };
}

/** Headline + optional subtitle in SF Pro-style type with tight tracking. */
export function drawTitleCard(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  text: TitleCardText,
  style: Partial<TitleCardStyle> = {},
): TitleCardMetrics {
  const s = { ...defaultTitleCardStyle, ...style };
  const m = layoutTitleCard(ctx, rect, text, s);
  const fg = s.theme === 'light' ? '#FFFFFF' : '#111111';
  const sub = s.theme === 'light' ? 'rgba(255,255,255,0.72)' : 'rgba(17,17,17,0.62)';
  let y =
    s.valign === 'top' ? rect.y : s.valign === 'bottom' ? rect.y + rect.h - m.blockHeight : rect.y + (rect.h - m.blockHeight) / 2;
  const x = s.align === 'center' ? rect.x + rect.w / 2 : rect.x;
  ctx.save();
  ctx.textAlign = s.align;
  ctx.textBaseline = 'alphabetic';
  if (s.theme === 'light') {
    // A whisper of shadow keeps white type legible on busy blurred backdrops.
    ctx.shadowColor = 'rgba(0,0,0,0.16)';
    ctx.shadowBlur = m.titlePx * 0.2;
    ctx.shadowOffsetY = m.titlePx * 0.03;
  }
  setFont(ctx, s.weight, m.titlePx, s.fontFamily, titleTracking(m.titlePx));
  ctx.fillStyle = fg;
  for (const line of m.titleLines) {
    y += m.titlePx * 0.9;
    // Canvas centres text including the trailing letter-spacing; nudge it back.
    ctx.fillText(line, x + (s.align === 'center' ? -titleTracking(m.titlePx) / 2 : 0), y);
    y += m.titlePx * 0.16;
  }
  if (m.subtitleLines.length) {
    y += m.titlePx * 0.32;
    setFont(ctx, 500, m.subtitlePx, s.fontFamily, subtitleTracking(m.subtitlePx));
    ctx.fillStyle = s.accent ?? sub;
    for (const line of m.subtitleLines) {
      y += m.subtitlePx * 1.0;
      ctx.fillText(line, x, y);
      y += m.subtitlePx * 0.3;
    }
  }
  ctx.restore();
  return m;
}
