// Floating-phone composition: the blurred-recording background and the
// title card. Where the phone, its screen and the title card go on each
// export canvas is shared/phoneLayout.ts (re-exported below).

import { fitRect } from '../../../shared/phoneLayout';
import type { Rect } from './deviceFrame';

// The placement math lives in shared/phoneLayout.ts (the CLI build and the 3D
// phone need it); re-exported here so importers are unchanged.
export { computePhoneLayout, fitRect, type LayoutOptions, type PhoneLayout } from '../../../shared/phoneLayout';

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
  /** Canvas px per px of the layout preset's own (1080-class) canvas: 2 at uhd4k. The card is laid out at that
   *  size and scaled, so it is the same layout at every resolution (1 = as before). */
  scale: number;
}

export const defaultTitleCardStyle: TitleCardStyle = {
  theme: 'light',
  align: 'center',
  valign: 'bottom',
  weight: 700,
  maxTitleLines: 2,
  fontFamily: '-apple-system, "SF Pro Display", BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif',
  scale: 1,
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
  // Laid out at the 1080-class size (px), then scaled by k: the same font sizes and line breaks at every resolution.
  const k = s.scale;
  // Measuring leaves its font and letterSpacing on ctx, and later text (captions, overlays) is drawn with that
  // letterSpacing (requests.md R5). At k != 1 the state is set once more at the drawn size, so it scales with k.
  let last: [number, number, (n: number) => number] | null = null;
  const leave = <T,>(m: T): T => {
    if (k !== 1 && last) setFont(ctx, last[0], last[1] * k, s.fontFamily, last[2](last[1] * k));
    return m;
  };
  const measure = (weight: number, px: number, tr: (n: number) => number) => (str: string) => {
    setFont(ctx, weight, px, s.fontFamily, tr(px));
    last = [weight, px, tr];
    return ctx.measureText(str).width * k;
  };
  for (let px = Math.floor((rect.h / k) * 0.46); px >= 10; px = Math.floor(px * 0.94)) {
    const titleLines = wrapBalanced(titleWords, s.maxTitleLines, rect.w, measure(s.weight, px, titleTracking));
    if (!titleLines) continue;
    const subPx = Math.max(10, Math.round(px * 0.46));
    const subtitleLines = subWords.length ? wrapBalanced(subWords, 2, rect.w, measure(500, subPx, subtitleTracking)) : [];
    if (!subtitleLines) continue;
    const blockHeight =
      (titleLines.length * px * 1.06 + (subtitleLines.length ? px * 0.32 + subtitleLines.length * subPx * 1.3 : 0)) * k;
    if (blockHeight <= rect.h) return leave({ titlePx: px * k, subtitlePx: subPx * k, titleLines, subtitleLines, blockHeight });
  }
  return leave({ titlePx: 10 * k, subtitlePx: 10 * k, titleLines: [text.title], subtitleLines: [], blockHeight: 12 * k });
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
