import { describe, expect, it } from 'vitest';
import { DEVICES, getDevice, screenMm } from '../src/shared/devices';
import {
  clipToScreen,
  deviceBodyRect,
  drawDeviceFrame,
  frameGeometry,
  frameRectForScreen,
  pointScaleFor,
  screenCornerRadius,
  screenRectFor,
} from '../src/renderer/src/mobile/deviceFrame';
import { mockCanvas } from './helpers/mockCanvas';

const p17 = getDevice('iphone-17-pro')!;

describe('frame geometry', () => {
  it('fits the body inside the rect at the real aspect ratio, centred', () => {
    const rect = { x: 100, y: 50, w: 400, h: 1000 };
    const body = deviceBodyRect(rect, p17);
    expect(body.w).toBeCloseTo(400, 6);
    expect(body.h).toBeCloseTo((400 * 150.0) / 71.9, 6);
    expect(body.y + body.h / 2).toBeCloseTo(550, 6);
  });

  it('puts the screen where the real panel is (mm-accurate border)', () => {
    const rect = { x: 0, y: 0, w: 719, h: 1500 }; // 10 px per mm
    const s = screenRectFor(rect, p17);
    const mm = screenMm(p17);
    expect(s.w).toBeCloseTo(mm.width * 10, 6);
    expect(s.h).toBeCloseTo(mm.height * 10, 6);
    // Border is ~2.6 mm on every side of a 17 Pro.
    expect(s.x / 10).toBeCloseTo((71.9 - mm.width) / 2, 6);
    expect(s.x / 10).toBeGreaterThan(2.4);
    expect(s.x / 10).toBeLessThan(2.9);
    // Screen aspect equals the native capture aspect, so video fills it exactly.
    expect(s.h / s.w).toBeCloseTo(2622 / 1206, 6);
  });

  it('scales the corner radius with the frame', () => {
    const rect = { x: 0, y: 0, w: 719, h: 1500 };
    const s = screenRectFor(rect, p17);
    expect(screenCornerRadius(rect, p17)).toBeCloseTo((62 * s.w) / 402, 6);
    expect(pointScaleFor(s, p17)).toBeCloseTo(s.w / 402, 6);
  });

  it('handles landscape by rotating the portrait frame', () => {
    const rect = { x: 0, y: 0, w: 1500, h: 719 };
    const g = frameGeometry(rect, p17);
    expect(g.orientation).toBe('landscape');
    expect(g.rotation).toBeCloseTo(-Math.PI / 2);
    const s = screenRectFor(rect, p17);
    expect(s.w).toBeGreaterThan(s.h);
    expect(s.w / s.h).toBeCloseTo(2622 / 1206, 6);
    expect(frameGeometry(rect, p17, { landscapeTop: 'right' }).rotation).toBeCloseTo(Math.PI / 2);
  });

  it('frameRectForScreen is the inverse of screenRectFor', () => {
    for (const d of DEVICES) {
      for (const screen of [
        { x: 30, y: 40, w: 300, h: (300 * d.screenPx.height) / d.screenPx.width },
        { x: 10, y: 20, w: (300 * d.screenPx.height) / d.screenPx.width, h: 300 },
      ]) {
        const body = frameRectForScreen(screen, d);
        const back = screenRectFor(body, d);
        expect(back.x, d.id).toBeCloseTo(screen.x, 6);
        expect(back.y, d.id).toBeCloseTo(screen.y, 6);
        expect(back.w, d.id).toBeCloseTo(screen.w, 6);
        expect(back.h, d.id).toBeCloseTo(screen.h, 6);
      }
    }
  });
});

describe('drawDeviceFrame', () => {
  it('draws every model and finish in both orientations with balanced save/restore', () => {
    for (const d of DEVICES) {
      for (const fin of d.finishes) {
        for (const rect of [{ x: 0, y: 0, w: 300, h: 700 }, { x: 0, y: 0, w: 700, h: 300 }]) {
          const m = mockCanvas();
          drawDeviceFrame(m.ctx, rect, d, fin.id);
          expect(m.depth(), `${d.id} ${fin.id}`).toBe(0);
          expect(m.count('fill')).toBeGreaterThan(3);
        }
      }
    }
  });

  it('accepts hex colours and can skip shadow and buttons', () => {
    const m = mockCanvas();
    drawDeviceFrame(m.ctx, { x: 0, y: 0, w: 300, h: 700 }, p17, '#FF8A3D', { shadow: false, buttons: false });
    expect(m.calls.some((c) => c.name === 'set:shadowBlur')).toBe(false);
    const withShadow = mockCanvas();
    drawDeviceFrame(withShadow.ctx, { x: 0, y: 0, w: 300, h: 700 }, p17);
    expect(withShadow.calls.some((c) => c.name === 'set:shadowBlur')).toBe(true);
    expect(withShadow.count('fill')).toBeGreaterThan(m.count('fill'));
  });

  it('clipToScreen intersects the clip and leaves the transform stack balanced', () => {
    const m = mockCanvas();
    clipToScreen(m.ctx, { x: 0, y: 0, w: 300, h: 700 }, p17);
    expect(m.count('clip')).toBe(1);
    expect(m.depth()).toBe(0);
  });
});
