// Paints the colour backdrops (solid, linear gradient, mesh) behind the
// recording. The editor preview and the headless export both draw through
// CanvasCompositor, so this is the one place a backdrop's look is defined.
import type { Background } from '../../shared/types';
import { BLOB_STOPS, hexAlpha } from '../../shared/backdrops';

type ColourBackground = Extract<Background, { kind: 'solid' | 'gradient' | 'mesh' }>;

export function isColourBackground(bg: Background): bg is ColourBackground {
  return bg.kind === 'solid' || bg.kind === 'gradient' || bg.kind === 'mesh';
}

export function paintBackdrop(ctx: CanvasRenderingContext2D, bg: ColourBackground, W: number, H: number): void {
  if (bg.kind === 'solid') {
    ctx.fillStyle = bg.hex;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  if (bg.kind === 'gradient') {
    const rad = (bg.angle * Math.PI) / 180;
    const x0 = W / 2 - (Math.cos(rad) * W) / 2;
    const y0 = H / 2 - (Math.sin(rad) * H) / 2;
    const x1 = W / 2 + (Math.cos(rad) * W) / 2;
    const y1 = H / 2 + (Math.sin(rad) * H) / 2;
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, bg.startHex);
    g.addColorStop(1, bg.endHex);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  ctx.fillStyle = bg.baseHex;
  ctx.fillRect(0, 0, W, H);
  const side = Math.max(W, H);
  for (const b of bg.blobs) {
    const cx = b.x * W;
    const cy = b.y * H;
    const r = Math.max(1, b.r * side);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const [t, a] of BLOB_STOPS) g.addColorStop(t, hexAlpha(b.hex, a));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  if (bg.grain && bg.grain > 0) paintGrain(ctx, Math.min(bg.grain, 0.2), W, H);
}

// Film grain: one seeded noise tile, repeated. Seeded so the preview and
// every export frame get the same grain (no shimmer, no export drift).
const TILE = 256;
let grainTile: HTMLCanvasElement | OffscreenCanvas | null | undefined;

function noiseTile(): HTMLCanvasElement | OffscreenCanvas | null {
  if (grainTile !== undefined) return grainTile;
  grainTile = null;
  let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(TILE, TILE);
  else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = TILE;
    canvas.height = TILE;
  }
  const c = canvas?.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
  if (!canvas || !c) return null;
  const img = c.createImageData(TILE, TILE);
  let seed = 0x9e3779b9;
  for (let i = 0; i < img.data.length; i += 4) {
    // xorshift32
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const v = (seed >>> 0) / 0xffffffff;
    // Light or dark speck, strength by distance from mid: brightens and
    // darkens equally, so the backdrop's overall tone doesn't shift.
    const level = v > 0.5 ? 255 : 0;
    img.data[i] = level;
    img.data[i + 1] = level;
    img.data[i + 2] = level;
    img.data[i + 3] = Math.round(Math.abs(v - 0.5) * 2 * 255);
  }
  c.putImageData(img, 0, 0);
  grainTile = canvas;
  return grainTile;
}

function paintGrain(ctx: CanvasRenderingContext2D, amount: number, W: number, H: number) {
  const tile = noiseTile();
  if (!tile) return;
  const pattern = ctx.createPattern(tile as CanvasImageSource, 'repeat');
  if (!pattern) return;
  ctx.save();
  ctx.globalAlpha = amount;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}
