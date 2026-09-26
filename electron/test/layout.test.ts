import { describe, expect, it } from 'vitest';
import { getDevice } from '../src/shared/devices';
import { PRESETS, getPreset, safeRect, validateExport } from '../src/shared/exportPresets';
import { screenRectFor } from '../src/renderer/src/mobile/deviceFrame';
import {
  computePhoneLayout,
  drawBlurredBackground,
  drawTitleCard,
  fitRect,
  layoutTitleCard,
  wrapBalanced,
} from '../src/renderer/src/mobile/layout';
import { mockCanvas } from './helpers/mockCanvas';

const p17 = getDevice('iphone-17-pro')!;
const inside = (r: { x: number; y: number; w: number; h: number }, o: { x: number; y: number; w: number; h: number }) =>
  r.x >= o.x - 1e-6 && r.y >= o.y - 1e-6 && r.x + r.w <= o.x + o.w + 1e-6 && r.y + r.h <= o.y + o.h + 1e-6;

describe('computePhoneLayout', () => {
  it('fills App Store canvases edge to edge with no frame or title', () => {
    const L = computePhoneLayout(getPreset('appstore-iphone'), p17, { titleCard: true });
    expect(L.mode).toBe('full-bleed');
    expect(L.device).toBeNull();
    expect(L.title).toBeNull();
    // Cover: the screen reaches every canvas edge.
    expect(L.screen.x).toBeLessThanOrEqual(0);
    expect(L.screen.y).toBeLessThanOrEqual(0);
    expect(L.screen.x + L.screen.w).toBeGreaterThanOrEqual(886 - 1e-6);
    expect(L.screen.y + L.screen.h).toBeGreaterThanOrEqual(1920 - 1e-6);
    // 886x1920 is within 0.4% of the 17 Pro panel, so almost nothing is cropped.
    expect(L.screen.h / 1920).toBeLessThan(1.005);
  });

  it('stacks a safe-zone title above a ~70% phone on 9:16', () => {
    const p = getPreset('social-9x16');
    const L = computePhoneLayout(p, p17, { titleCard: true });
    expect(L.mode).toBe('framed');
    expect(inside(L.title!, safeRect(p))).toBe(true);
    expect(L.device!.y).toBeGreaterThan(L.title!.y + L.title!.h);
    expect(L.device!.h / 1920).toBeGreaterThan(0.62);
    expect(L.device!.h / 1920).toBeLessThanOrEqual(0.7 + 1e-9);
    expect(L.device!.y + L.device!.h).toBeLessThanOrEqual(1920);
    expect(L.device!.x + L.device!.w / 2).toBeCloseTo(540, 6);
    expect(validateExport(p, { duration: 20, titleRect: L.title! })).toEqual([]);
    expect(L.shadow).not.toBeNull();
  });

  it('grows and centres the phone when there is no title', () => {
    const L = computePhoneLayout(getPreset('social-9x16'), p17);
    expect(L.title).toBeNull();
    expect(L.device!.h / 1920).toBeCloseTo(0.8, 6);
    expect(L.device!.y + L.device!.h / 2).toBeCloseTo(960, 6);
  });

  it('puts the phone left and the text right on 16:9', () => {
    const L = computePhoneLayout(getPreset('landscape-16x9'), p17, { titleCard: true });
    expect(L.device!.x + L.device!.w).toBeLessThan(L.title!.x);
    expect(L.titleTextAlign).toBe('left');
    expect(L.title!.x + L.title!.w).toBeLessThanOrEqual(1920);
  });

  it('keeps every framed layout on canvas and the screen inside the body', () => {
    for (const p of PRESETS.filter((x) => x.layout === 'framed')) {
      for (const titleCard of [false, true]) {
        const L = computePhoneLayout(p, p17, { titleCard });
        const canvas = { x: 0, y: 0, w: p.width, h: p.height };
        expect(inside(L.device!, canvas), `${p.id} ${titleCard}`).toBe(true);
        expect(inside(L.screen, L.device!)).toBe(true);
        if (L.title) expect(inside(L.title, canvas)).toBe(true);
        expect(L.pointScale).toBeCloseTo(L.screen.w / 402, 6);
        // The screen rect agrees with the frame renderer.
        const s = screenRectFor(L.device!, p17);
        expect(s.w).toBeCloseTo(L.screen.w, 6);
      }
    }
  });

  it('can force a frame onto an App Store canvas', () => {
    const L = computePhoneLayout(getPreset('appstore-iphone'), p17, { deviceFrame: true });
    expect(L.mode).toBe('framed');
    expect(L.screenRadius).toBeGreaterThan(0);
  });
});

describe('fitRect', () => {
  it('contains and covers', () => {
    expect(fitRect(100, 200, { x: 0, y: 0, w: 100, h: 100 }, 'contain')).toEqual({ x: 25, y: 0, w: 50, h: 100 });
    expect(fitRect(100, 200, { x: 0, y: 0, w: 100, h: 100 }, 'cover')).toEqual({ x: 0, y: -50, w: 100, h: 200 });
  });
});

describe('title card', () => {
  const measure = (s: string) => s.length;

  it('balances two-line titles instead of leaving a widow', () => {
    const lines = wrapBalanced('Know exactly what you can spend'.split(' '), 2, 26, measure)!;
    expect(lines).toHaveLength(2);
    expect(Math.abs(lines[0].length - lines[1].length)).toBeLessThanOrEqual(6);
    expect(wrapBalanced(['short'], 2, 10, measure)).toEqual(['short']);
    expect(wrapBalanced('a b c d e f g h'.split(' '), 1, 5, measure)).toBeNull();
  });

  it('picks the largest size that fits, with a clearly smaller subtitle', () => {
    const m = mockCanvas();
    const rect = { x: 0, y: 0, w: 800, h: 260 };
    const lay = layoutTitleCard(m.ctx, rect, { title: 'Know exactly what you can spend', subtitle: 'One honest number.' });
    expect(lay.blockHeight).toBeLessThanOrEqual(260);
    expect(lay.titleLines.length).toBeLessThanOrEqual(2);
    expect(lay.subtitlePx).toBeLessThan(lay.titlePx * 0.6);
    for (const l of lay.titleLines) expect(l.length * lay.titlePx * 0.5).toBeLessThanOrEqual(800);
    // A bigger box gets bigger type.
    const big = layoutTitleCard(m.ctx, { ...rect, w: 1600, h: 520 }, { title: 'Know exactly what you can spend' });
    expect(big.titlePx).toBeGreaterThan(lay.titlePx);
  });

  it('draws with tight tracking and balanced save/restore', () => {
    const m = mockCanvas();
    drawTitleCard(m.ctx, { x: 0, y: 0, w: 800, h: 260 }, { title: 'Know exactly what you can spend', subtitle: 'One honest number.' });
    expect(m.depth()).toBe(0);
    expect(m.count('fillText')).toBeGreaterThanOrEqual(2);
    const spacing = m.calls.find((c) => c.name === 'set:letterSpacing');
    expect(String(spacing?.args[0])).toMatch(/^-\d/);
  });
});

describe('drawBlurredBackground', () => {
  it('blurs, saturates and darkens the frame, then vignettes', () => {
    const m = mockCanvas();
    drawBlurredBackground(m.ctx, {} as CanvasImageSource, { width: 1206, height: 2622 }, { width: 1080, height: 1920 });
    const filter = m.calls.find((c) => c.name === 'set:filter');
    expect(String(filter?.args[0])).toMatch(/blur\([\d.]+px\) saturate\([\d.]+\) brightness\(0\.\d+\)/);
    expect(m.count('drawImage')).toBe(1);
    expect(m.count('fillRect')).toBe(1);
    expect(m.depth()).toBe(0);
  });
});
