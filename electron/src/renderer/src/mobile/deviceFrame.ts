// Procedural iPhone / iPad frame, drawn with Canvas2D at any size.
//
// No bitmap assets: Apple's bezel images may not be redistributed, and a
// vector frame stays crisp at 4K. Geometry comes from the public numbers in
// shared/devices.ts (body mm, screen px + ppi, corner radius in points), so
// the screen hole, corner radius and island land where they are on the real
// phone.
//
// Draw order for a frame:
//   1. clipToScreen(ctx, rect, device) + draw the video into screenRectFor(...)
//   2. drawDeviceFrame(ctx, rect, device, finish) — shadow, buttons, metal band,
//      black glass bezel and the Dynamic Island / notch, all ON TOP of the
//      content (the screen area itself is left untouched).
//
// `rect` is the body's bounding box. The body is fitted inside it keeping the
// real aspect ratio; side buttons protrude ~0.5 mm beyond it.

import {
  getFinish,
  screenMm,
  screenPoints,
  type DeviceFinish,
  type DeviceModel,
  type Orientation,
} from '../../../shared/devices';

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

// ---------------------------------------------------------------------------
// Geometry (pure; no canvas needed)

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

// ---------------------------------------------------------------------------
// Paths

// Apple's continuous ("squircle") corner, as a fraction of the nominal radius:
// the curve starts 1.5287r from the corner and has no curvature jump where it
// meets the straight edge, unlike arcTo. Points for one corner, listed from
// the edge that runs toward the corner to the edge that leaves it; each entry
// is [along-first-edge-inset, along-second-edge-inset].
const CORNER: Array<['M' | 'L' | 'C', ...number[]]> = [
  ['L', 1.52866483, 0],
  ['C', 1.08849323, 0, 0.86840689, 0, 0.66993427, 0.06549600],
  ['L', 0.63149399, 0.07491100],
  ['C', 0.37282392, 0.16905899, 0.16905899, 0.37282392, 0.07491100, 0.63149399],
  ['L', 0.06549600, 0.66993427],
  ['C', 0, 0.86840689, 0, 1.08849323, 0, 1.52866483],
];

/** Appends a continuous-corner rounded rect to the current path. */
export function continuousRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2 / 1.52866483));
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  // Each corner: origin + two unit axes (into the first edge, into the second).
  const corners: Array<[number, number, number, number, number, number]> = [
    [x + w, y, -1, 0, 0, 1], // top-right: along top edge (inset leftward), then down
    [x + w, y + h, 0, -1, -1, 0], // bottom-right
    [x, y + h, 1, 0, 0, -1], // bottom-left
    [x, y, 0, 1, 1, 0], // top-left
  ];
  const pt = (c: (typeof corners)[number], a: number, b: number): [number, number] => [
    c[0] + (c[2] * a + c[4] * b) * r,
    c[1] + (c[3] * a + c[5] * b) * r,
  ];
  const start = pt(corners[3], 0, 1.52866483);
  ctx.moveTo(start[0], start[1]);
  for (const c of corners) {
    for (const [op, ...n] of CORNER) {
      if (op === 'C') {
        const p1 = pt(c, n[0], n[1]);
        const p2 = pt(c, n[2], n[3]);
        const p3 = pt(c, n[4], n[5]);
        ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
      } else {
        const p = pt(c, n[0], n[1]);
        ctx.lineTo(p[0], p[1]);
      }
    }
  }
  ctx.closePath();
}

function capsulePath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = Math.min(w, h) / 2;
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + r, r, Math.PI / 2, (Math.PI * 3) / 2);
  ctx.closePath();
}

function applyTransform(ctx: CanvasRenderingContext2D, g: FrameGeometry) {
  ctx.translate(g.cx, g.cy);
  if (g.rotation) ctx.rotate(g.rotation);
}

/** Intersects the current clip with the screen shape. Wrap in save()/restore(). */
export function clipToScreen(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  device: DeviceModel,
  opts: DeviceFrameOptions = {},
): void {
  const g = frameGeometry(rect, device, opts);
  ctx.save();
  applyTransform(ctx, g);
  ctx.beginPath();
  continuousRectPath(ctx, -g.screenW / 2, -g.screenH / 2, g.screenW, g.screenH, g.screenRadius);
  ctx.restore(); // the path survives restore(); the transform does not matter any more
  ctx.clip();
}

// ---------------------------------------------------------------------------
// Colour helpers

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgba(c: RGB, a = 1): string {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
}

function luminance(c: RGB): number {
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}

const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];
const GLASS = '#060607';

/** How strongly each material reflects: [highlight, shade, specular line]. */
const MATERIAL_LIGHT: Record<DeviceModel['material'], [number, number, number]> = {
  steel: [0.6, 0.45, 0.85],
  titanium: [0.34, 0.32, 0.55],
  aluminum: [0.26, 0.26, 0.42],
};

function resolveFinish(device: DeviceModel, color: DeviceFinish | string | undefined): DeviceFinish {
  if (!color) return getFinish(device);
  if (typeof color !== 'string') return color;
  if (color.startsWith('#')) return { id: 'custom', name: 'Custom', hex: color };
  return getFinish(device, color);
}

// ---------------------------------------------------------------------------
// Drawing

/**
 * Draws the device frame around (and over the edges of) already-drawn screen
 * content. `color` is a finish object, a finish id ('cosmic-orange') or a hex.
 */
export function drawDeviceFrame(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  device: DeviceModel,
  color?: DeviceFinish | string,
  opts: DeviceFrameOptions = {},
): void {
  const g = frameGeometry(rect, device, opts);
  const finish = resolveFinish(device, color);
  const base = hexToRgb(finish.hex);
  const [hiAmt, shadeAmt, specAmt] = MATERIAL_LIGHT[device.material];
  const light = luminance(base);
  const { bodyW: W, bodyH: H, bodyRadius: R, rim } = g;
  const x0 = -W / 2;
  const y0 = -H / 2;

  ctx.save();
  applyTransform(ctx, g);

  // Light comes from the top of the canvas, slightly left, whatever the rotation.
  const lightDir = rotateVec(-0.35, -1, -g.rotation);
  const half = Math.hypot(W, H) / 2;
  const lightGradient = (stops: Array<[number, string]>) => {
    const grad = ctx.createLinearGradient(
      lightDir[0] * half, lightDir[1] * half, -lightDir[0] * half, -lightDir[1] * half,
    );
    for (const [o, c] of stops) grad.addColorStop(o, c);
    return grad;
  };

  // 1. Floating shadow, clipped to outside the body so it never darkens the screen.
  if (opts.shadow !== false) {
    const s = { ...DEFAULT_FRAME_SHADOW, ...(typeof opts.shadow === 'object' ? opts.shadow : {}) };
    const long = Math.max(W, H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(-long * 2, -long * 2, long * 4, long * 4);
    continuousRectPath(ctx, x0, y0, W, H, R);
    ctx.clip('evenodd');
    const layers: Array<[number, number, number]> = [
      [s.blur, s.offsetY, s.opacity], // ambient
      [s.blur * 0.22, s.offsetY * 0.2, Math.min(1, s.opacity * 0.7)], // contact
    ];
    for (const [blur, off, op] of layers) {
      if (op <= 0) continue;
      ctx.shadowColor = `rgba(0,0,0,${op})`;
      ctx.shadowBlur = blur * long * canvasScale(ctx);
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = off * long * canvasScale(ctx);
      ctx.fillStyle = '#000';
      ctx.beginPath();
      continuousRectPath(ctx, x0, y0, W, H, R);
      ctx.fill();
    }
    ctx.restore();
  }

  // 2. Side buttons, tucked under the band.
  if (opts.buttons !== false) {
    for (const b of device.buttons) {
      const flush = b.kind === 'cameraControl';
      const out = Math.max(1, (flush ? 0.28 : 0.55) * g.pxPerMm);
      const by = y0 + b.top * H;
      const bh = b.length * H;
      const left = b.side === 'left';
      const bx = left ? x0 - out : x0 + W - rim * 1.5;
      const bw = out + rim * 1.5;
      const grad = ctx.createLinearGradient(left ? bx : bx + bw, 0, left ? bx + bw : bx, 0);
      const tone = flush ? mix(base, BLACK, 0.45) : base;
      grad.addColorStop(0, rgba(mix(tone, BLACK, 0.4)));
      grad.addColorStop(0.35, rgba(mix(tone, WHITE, hiAmt * 0.6)));
      grad.addColorStop(1, rgba(mix(tone, BLACK, 0.15)));
      ctx.fillStyle = grad;
      ctx.beginPath();
      roundRectPath(ctx, bx, by, bw, bh, Math.min(out * 1.1, bh / 2));
      ctx.fill();
      ctx.strokeStyle = rgba(mix(tone, BLACK, 0.55), 0.6);
      ctx.lineWidth = Math.max(0.5, out * 0.12);
      ctx.stroke();
    }
  }

  // 3. Metal band: body minus the glass.
  const bandPath = () => {
    ctx.beginPath();
    continuousRectPath(ctx, x0, y0, W, H, R);
    continuousRectPath(ctx, x0 + rim, y0 + rim, W - rim * 2, H - rim * 2, R - rim);
  };
  bandPath();
  ctx.fillStyle = rgba(base);
  ctx.fill('evenodd');
  ctx.save();
  bandPath();
  ctx.clip('evenodd');
  // Directional light across the band.
  ctx.fillStyle = lightGradient([
    [0, rgba(WHITE, hiAmt)],
    [0.45, rgba(WHITE, 0)],
    [0.55, rgba(BLACK, 0)],
    [1, rgba(BLACK, shadeAmt)],
  ]);
  ctx.fillRect(x0 - 2, y0 - 2, W + 4, H + 4);
  // Chamfer highlight: a bright line a third of the way into the band.
  ctx.beginPath();
  const ci = rim * 0.38;
  continuousRectPath(ctx, x0 + ci, y0 + ci, W - ci * 2, H - ci * 2, R - ci);
  ctx.strokeStyle = lightGradient([
    [0, rgba(WHITE, specAmt)],
    [0.5, rgba(WHITE, specAmt * 0.35)],
    [1, rgba(WHITE, specAmt * 0.15)],
  ]);
  ctx.lineWidth = Math.max(0.5, rim * 0.2);
  ctx.stroke();
  ctx.restore();
  // Outer edge: keeps light finishes from dissolving into light backgrounds.
  ctx.beginPath();
  continuousRectPath(ctx, x0 + 0.25, y0 + 0.25, W - 0.5, H - 0.5, R);
  ctx.strokeStyle = rgba(mix(base, BLACK, light > 0.6 ? 0.45 : 0.6), 0.85);
  ctx.lineWidth = Math.max(0.6, rim * 0.14);
  ctx.stroke();

  // 4. Black glass bezel between the band and the screen. The hole is inset
  //    half a pixel so the bezel overlaps the content's anti-aliased edge.
  const sx = -g.screenW / 2;
  const sy = -g.screenH / 2;
  const gx = x0 + rim;
  const gy = y0 + rim;
  const gw = W - rim * 2;
  const gh = H - rim * 2;
  const bezelPath = () => {
    ctx.beginPath();
    continuousRectPath(ctx, gx, gy, gw, gh, R - rim);
    continuousRectPath(ctx, sx + 0.5, sy + 0.5, g.screenW - 1, g.screenH - 1, Math.max(0, g.screenRadius - 0.5));
  };
  bezelPath();
  ctx.fillStyle = GLASS;
  ctx.fill('evenodd');
  // Where metal meets glass: a dark seam, then a faint lit glass lip.
  ctx.beginPath();
  continuousRectPath(ctx, gx, gy, gw, gh, R - rim);
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = Math.max(0.5, rim * 0.22);
  ctx.stroke();
  if (opts.glare !== false) {
    ctx.save();
    bezelPath();
    ctx.clip('evenodd');
    ctx.beginPath();
    const li = rim * 0.35;
    continuousRectPath(ctx, gx + li, gy + li, gw - li * 2, gh - li * 2, R - rim - li);
    ctx.strokeStyle = lightGradient([
      [0, 'rgba(255,255,255,0.22)'],
      [0.35, 'rgba(255,255,255,0.05)'],
      [1, 'rgba(255,255,255,0.02)'],
    ]);
    ctx.lineWidth = Math.max(0.5, rim * 0.3);
    ctx.stroke();
    // Soft sheen falling across the upper bezel.
    ctx.fillStyle = lightGradient([
      [0, 'rgba(255,255,255,0.07)'],
      [0.4, 'rgba(255,255,255,0)'],
    ]);
    ctx.fillRect(x0, y0, W, H);
    ctx.restore();
  }

  // 5. Cutout / front hardware, on top of the content.
  const pt = g.pxPerPoint;
  const cut = device.cutout;
  if (cut.kind === 'island') {
    const iw = cut.width * pt;
    const ih = cut.height * pt;
    const ix = -iw / 2;
    const iy = sy + cut.top * pt;
    ctx.beginPath();
    capsulePath(ctx, ix, iy, iw, ih);
    ctx.fillStyle = '#000';
    ctx.fill();
    // Front camera behind the glass: barely-there lens with a pinpoint glint.
    drawLens(ctx, ix + iw - ih / 2 - ih * 0.12, iy + ih / 2, ih * 0.27);
  } else if (cut.kind === 'notch') {
    const hw = (cut.width * pt) / 2;
    const nh = cut.height * pt;
    const er = cut.earRadius * pt;
    const br = cut.bottomRadius * pt;
    ctx.beginPath();
    ctx.moveTo(-hw - er, sy - 1);
    ctx.lineTo(-hw - er, sy);
    ctx.quadraticCurveTo(-hw, sy, -hw, sy + er);
    ctx.lineTo(-hw, sy + nh - br);
    ctx.arcTo(-hw, sy + nh, -hw + br, sy + nh, br);
    ctx.lineTo(hw - br, sy + nh);
    ctx.arcTo(hw, sy + nh, hw, sy + nh - br, br);
    ctx.lineTo(hw, sy + er);
    ctx.quadraticCurveTo(hw, sy, hw + er, sy);
    ctx.lineTo(hw + er, sy - 1);
    ctx.closePath();
    ctx.fillStyle = GLASS;
    ctx.fill();
    // Earpiece grille and camera.
    const gwid = 46 * pt;
    const ghei = 5 * pt;
    ctx.beginPath();
    capsulePath(ctx, -gwid / 2, sy + 6 * pt, gwid, ghei);
    ctx.fillStyle = '#16161a';
    ctx.fill();
    drawLens(ctx, hw - 26 * pt, sy + nh * 0.48, 4.6 * pt);
  } else if (device.homeButton) {
    // iPhone SE: earpiece + camera above the screen, home button below.
    const topBezelMid = (gy + sy) / 2;
    const ew = W * 0.14;
    const eh = Math.max(1, 1.1 * g.pxPerMm);
    ctx.beginPath();
    capsulePath(ctx, -ew / 2, topBezelMid - eh / 2, ew, eh);
    ctx.fillStyle = '#1d1d21';
    ctx.fill();
    drawLens(ctx, -W * 0.14, topBezelMid, 1.5 * g.pxPerMm);
    const hbY = (sy + g.screenH + y0 + H - rim) / 2;
    const hbR = 5.5 * g.pxPerMm;
    ctx.beginPath();
    ctx.arc(0, hbY, hbR, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0b0d';
    ctx.fill();
    ctx.strokeStyle = lightGradient([
      [0, 'rgba(255,255,255,0.28)'],
      [1, 'rgba(255,255,255,0.08)'],
    ]);
    ctx.lineWidth = Math.max(0.75, 0.35 * g.pxPerMm);
    ctx.stroke();
  } else if (device.family === 'ipad') {
    // Front camera sits in the bezel: landscape edge on Pro/Air, top on mini.
    const onTop = device.id.startsWith('ipad-mini');
    const r = 1.4 * g.pxPerMm;
    if (onTop) drawLens(ctx, 0, (gy + sy) / 2, r);
    else drawLens(ctx, (sx + g.screenW + x0 + W - rim) / 2, 0, r);
  }

  ctx.restore();
}

function drawLens(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  grad.addColorStop(0, '#26252b');
  grad.addColorStop(0.6, '#111114');
  grad.addColorStop(1, '#050506');
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - r * 0.32, y - r * 0.32, Math.max(0.4, r * 0.18), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.fill();
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function rotateVec(x: number, y: number, a: number): [number, number] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const n = Math.hypot(x, y);
  return [(x * c - y * s) / n, (x * s + y * c) / n];
}

/** shadowBlur/offset ignore the transform; scale them by the current zoom. */
function canvasScale(ctx: CanvasRenderingContext2D): number {
  const m = ctx.getTransform();
  return Math.hypot(m.a, m.b) || 1;
}
