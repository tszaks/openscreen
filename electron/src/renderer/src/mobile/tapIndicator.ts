// Touch indicators: tap ripples, long-press holds and swipe trails.
//
// Sized in device points so a tap reads as a fingertip at any export size
// (Apple's minimum hit target is 44 pt; indicators default to 52 pt), and
// timed so cause visibly precedes effect: press-in 0.8 -> 1.0 over 80 ms,
// hold while the finger is down, then an expanding ring 1.0 -> 1.6x that
// fades over ~360 ms. A plain tap is visible for ~0.55 s.
//
// drawTouchIndicator is a pure function of (ctx, suggestion, t, screenRect,
// scale): call it every frame, in screen space, after the video and before
// the device frame, inside the same camera transform as the video so the
// indicator zooms with the content.

import type { TapSuggestion } from '../../../shared/taps';
import type { Rect } from './deviceFrame';

export type TouchStyle = 'ripple' | 'pulse' | 'ring';

export interface TouchIndicatorOptions {
  style: TouchStyle;
  /** Fill / ring colour. White reads on light and dark UI; accent is optional. */
  color: string;
  /** Diameter in device points. */
  sizePt: number;
  /** Fill opacity at full press. */
  fillOpacity: number;
  /** Rim stroke width in device points (1 pt = 3 px on a @3x capture). */
  strokePt: number;
  /** Soft dark shadow behind the indicator (0 disables). */
  shadowOpacity: number;
}

export const defaultTouchIndicator: TouchIndicatorOptions = {
  style: 'ripple',
  color: '#FFFFFF',
  sizePt: 52,
  fillOpacity: 0.4,
  strokePt: 1,
  shadowOpacity: 0.35,
};

/** The OpenScreen accent, for an on-brand variant. */
export const ACCENT_TOUCH_COLOR = '#FF8A3D';

// Timing (seconds).
export const PRESS_IN = 0.08;
export const TAP_HOLD = 0.12;
export const RELEASE = 0.36;
/** How much of the swipe path stays visible behind the finger. */
export const TRAIL = 0.15;

/** Seconds the finger is down for a suggestion. */
function holdFor(s: TapSuggestion): number {
  if (s.kind === 'longpress') return Math.max(0.3, s.duration ?? 0.6);
  if (s.kind === 'swipe') return Math.max(0.1, s.duration ?? 0.25);
  return TAP_HOLD;
}

/** [start, end] in seconds during which the indicator draws anything. */
export function indicatorWindow(s: TapSuggestion): [number, number] {
  if (s.kind === 'typing') return [s.t, s.t];
  return [s.t, s.t + PRESS_IN + holdFor(s) + RELEASE];
}

/** Suggestions with something to draw at time t. */
export function activeIndicators(suggestions: TapSuggestion[], t: number): TapSuggestion[] {
  return suggestions.filter((s) => {
    const [a, b] = indicatorWindow(s);
    return b > a && t >= a && t <= b;
  });
}

const easeOut = (x: number) => 1 - (1 - x) ** 3;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Touch state at local time u (seconds since touch-down). */
export function touchPhase(s: TapSuggestion, u: number) {
  const hold = holdFor(s);
  const pressEnd = PRESS_IN;
  const releaseStart = PRESS_IN + hold;
  if (u < 0) return { visible: false, scale: 0, fill: 0, ring: 0, ringScale: 1, down: false };
  if (u < pressEnd) {
    const p = easeOut(u / PRESS_IN);
    return { visible: true, scale: 0.8 + 0.2 * p, fill: p, ring: p, ringScale: 1, down: true };
  }
  if (u < releaseStart) {
    // Long presses swell slightly while held, so the hold reads as deliberate.
    const grow = s.kind === 'longpress' ? 0.08 * easeOut(clamp01((u - pressEnd) / Math.max(0.2, hold))) : 0;
    return { visible: true, scale: 1 + grow, fill: 1, ring: 1, ringScale: 1 + grow, down: true };
  }
  const r = (u - releaseStart) / RELEASE;
  if (r > 1) return { visible: false, scale: 0, fill: 0, ring: 0, ringScale: 1.6, down: false };
  const e = easeOut(r);
  const base = s.kind === 'longpress' ? 1.08 : 1;
  return {
    visible: true,
    scale: base * (1 - 0.1 * e),
    fill: 1 - easeOut(clamp01(r * 1.6)),
    ring: 1 - e,
    ringScale: base * (1 + 0.6 * e),
    down: false,
  };
}

function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Position along a swipe at local time u, with the path eased like a real drag. */
export function swipePoint(s: TapSuggestion, u: number): { x: number; y: number } {
  const dur = holdFor(s);
  const p = easeInOut(clamp01((u - PRESS_IN * 0.5) / dur));
  const ex = s.endX ?? s.x;
  const ey = s.endY ?? s.y;
  return { x: s.x + (ex - s.x) * p, y: s.y + (ey - s.y) * p };
}

/**
 * Draws one touch indicator at time t. `screenRect` is where the video's
 * screen is on the canvas; `scale` is canvas px per device point (see
 * pointScaleFor in deviceFrame.ts).
 */
export function drawTouchIndicator(
  ctx: CanvasRenderingContext2D,
  s: TapSuggestion,
  t: number,
  screenRect: Rect,
  scale: number,
  options: Partial<TouchIndicatorOptions> = {},
): void {
  if (s.kind === 'typing') return;
  const o = { ...defaultTouchIndicator, ...options };
  const u = t - s.t;
  const ph = touchPhase(s, u);
  if (!ph.visible) return;

  const radius = (o.sizePt * scale) / 2;
  const stroke = Math.max(1.5, o.strokePt * scale);
  const toPx = (p: { x: number; y: number }) => ({
    x: screenRect.x + p.x * screenRect.w,
    y: screenRect.y + p.y * screenRect.h,
  });
  const at = toPx(s.kind === 'swipe' ? swipePoint(s, Math.min(u, PRESS_IN + holdFor(s))) : s);

  ctx.save();
  if (s.kind === 'swipe') drawTrail(ctx, s, u, toPx, radius, o);

  const shadow = (blurMul: number, alpha: number) => {
    if (o.shadowOpacity <= 0) return;
    ctx.shadowColor = `rgba(0,0,0,${o.shadowOpacity * alpha})`;
    ctx.shadowBlur = radius * blurMul;
    ctx.shadowOffsetY = radius * 0.08;
  };
  const noShadow = () => {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  };
  // Crisp rim: the colour stroke plus a faint dark hairline just outside it,
  // so a white indicator still has an edge on a white screen.
  const rim = (x: number, y: number, rad: number, width: number, alpha: number) => {
    ctx.beginPath();
    ctx.arc(x, y, rad + width * 0.5 + 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(0,0,0,${0.16 * alpha})`;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(o.color, 0.95 * alpha);
    ctx.lineWidth = width;
    ctx.stroke();
  };

  // Released ring, expanding and fading (all styles but pulse).
  if (!ph.down && o.style !== 'pulse' && ph.ring > 0) {
    shadow(0.3, ph.ring);
    rim(at.x, at.y, radius * ph.ringScale, stroke * (0.6 + 0.4 * ph.ring), ph.ring);
    noShadow();
  }

  const r = radius * ph.scale;
  if (o.style === 'ring') {
    const alpha = ph.down ? ph.ring : ph.fill;
    if (alpha > 0) {
      shadow(0.35, alpha);
      rim(at.x, at.y, r, stroke * 1.5, alpha);
      noShadow();
      ctx.beginPath();
      ctx.arc(at.x, at.y, r * 0.16, 0, Math.PI * 2);
      ctx.fillStyle = rgba(o.color, 0.95 * alpha);
      ctx.fill();
    }
  } else {
    // Disc: soft radial fill with a crisp rim. Pulse expands the disc itself on release.
    const discScale = o.style === 'pulse' && !ph.down ? 0.4 + ph.ringScale / 1.6 : 1;
    const rr = r * discScale;
    const alpha = o.style === 'pulse' && !ph.down ? ph.ring : ph.fill;
    if (alpha > 0) {
      shadow(0.45, alpha);
      const g = ctx.createRadialGradient(at.x, at.y, rr * 0.1, at.x, at.y, rr);
      g.addColorStop(0, rgba(o.color, Math.min(1, o.fillOpacity * 1.2) * alpha));
      g.addColorStop(1, rgba(o.color, o.fillOpacity * 0.8 * alpha));
      ctx.beginPath();
      ctx.arc(at.x, at.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
      noShadow();
      rim(at.x, at.y, rr, stroke, alpha);
    }
  }
  ctx.restore();
}

/** Tapering trail over the last TRAIL seconds of the finger's path, as one filled shape. */
function drawTrail(
  ctx: CanvasRenderingContext2D,
  s: TapSuggestion,
  u: number,
  toPx: (p: { x: number; y: number }) => { x: number; y: number },
  radius: number,
  o: TouchIndicatorOptions,
) {
  const end = PRESS_IN + holdFor(s);
  const head = Math.min(u, end);
  // After lift the tail catches up with the head, so the trail retracts.
  const tail = Math.max(0, Math.min(head, u - TRAIL));
  if (head - tail <= 0.005) return;
  const steps = 16;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) pts.push(toPx(swipePoint(s, tail + ((head - tail) * i) / steps)));
  const a = pts[0];
  const b = pts[pts.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return;
  const nx = -(b.y - a.y) / len;
  const ny = (b.x - a.x) / len;
  const fade = u > end ? 1 - clamp01((u - end) / RELEASE) : 1;
  const left: Array<{ x: number; y: number }> = [];
  const right: Array<{ x: number; y: number }> = [];
  pts.forEach((p, i) => {
    const k = i / steps; // 0 at the tail, 1 at the finger
    const half = radius * 0.62 * Math.sqrt(k);
    left.push({ x: p.x + nx * half, y: p.y + ny * half });
    right.push({ x: p.x - nx * half, y: p.y - ny * half });
  });
  ctx.beginPath();
  ctx.moveTo(left[0].x, left[0].y);
  for (const p of left) ctx.lineTo(p.x, p.y);
  ctx.arc(b.x, b.y, radius * 0.62, Math.atan2(ny, nx), Math.atan2(ny, nx) - Math.PI, true);
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
  ctx.closePath();
  const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
  g.addColorStop(0, rgba(o.color, 0));
  g.addColorStop(1, rgba(o.color, Math.min(1, o.fillOpacity * 1.1) * fade));
  ctx.fillStyle = g;
  if (o.shadowOpacity > 0) {
    ctx.shadowColor = `rgba(0,0,0,${o.shadowOpacity * 0.6 * fade})`;
    ctx.shadowBlur = radius * 0.3;
  }
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
}

/** Draws every active indicator at time t. */
export function drawTouchIndicators(
  ctx: CanvasRenderingContext2D,
  suggestions: TapSuggestion[],
  t: number,
  screenRect: Rect,
  scale: number,
  options: Partial<TouchIndicatorOptions> = {},
): void {
  for (const s of activeIndicators(suggestions, t)) drawTouchIndicator(ctx, s, t, screenRect, scale, options);
}
