import { describe, expect, it } from 'vitest';
import {
  DEVICES,
  cornerRadiusPx,
  defaultDevice,
  detectDevice,
  genericDevice,
  getDevice,
  getFinish,
  screenMm,
  screenPoints,
} from '../src/shared/devices';

describe('device registry', () => {
  it('has unique ids and sane geometry for every model', () => {
    const ids = new Set(DEVICES.map((d) => d.id));
    expect(ids.size).toBe(DEVICES.length);
    for (const d of DEVICES) {
      expect(d.finishes.length).toBeGreaterThan(0);
      expect(d.screenPx.height).toBeGreaterThan(d.screenPx.width);
      // The screen must fit inside the body with a plausible border (0.5 to 20 mm).
      const s = screenMm(d);
      const side = (d.bodyMm.width - s.width) / 2;
      const top = (d.bodyMm.height - s.height) / 2;
      expect(side, d.id).toBeGreaterThan(0.5);
      expect(side, d.id).toBeLessThan(d.family === 'ipad' ? 12 : 5);
      expect(top, d.id).toBeGreaterThan(0.5);
      expect(top, d.id).toBeLessThan(20);
      expect(d.rimMm).toBeLessThan(side);
      for (const f of d.finishes) expect(f.hex).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('bezel-less iPhones have near-equal side and top borders', () => {
    for (const d of DEVICES.filter((x) => x.family === 'iphone' && !x.homeButton)) {
      const s = screenMm(d);
      const side = (d.bodyMm.width - s.width) / 2;
      const top = (d.bodyMm.height - s.height) / 2;
      expect(Math.abs(side - top), d.id).toBeLessThan(0.6);
    }
  });

  it('reports HIG point sizes', () => {
    expect(screenPoints(getDevice('iphone-17-pro')!)).toEqual({ width: 402, height: 874 });
    expect(screenPoints(getDevice('iphone-16-pro-max')!)).toEqual({ width: 440, height: 956 });
    expect(screenPoints(getDevice('iphone-15')!)).toEqual({ width: 393, height: 852 });
    expect(screenPoints(getDevice('iphone-13-mini')!)).toEqual({ width: 375, height: 813 });
    expect(screenPoints(getDevice('iphone-se-3')!)).toEqual({ width: 375, height: 667 });
    expect(cornerRadiusPx(getDevice('iphone-16-pro')!)).toBe(186);
  });

  it('carries the official finishes', () => {
    const p17 = getDevice('iphone-17-pro')!;
    expect(p17.finishes.map((x) => x.name)).toEqual(['Cosmic Orange', 'Deep Blue', 'Silver']);
    const p16 = getDevice('iphone-16-pro')!;
    expect(p16.finishes.map((x) => x.name)).toEqual([
      'Desert Titanium', 'Natural Titanium', 'White Titanium', 'Black Titanium',
    ]);
    expect(getFinish(p16, 'black-titanium').name).toBe('Black Titanium');
    expect(getFinish(p16, 'nope').name).toBe('Desert Titanium');
    expect(getFinish(getDevice('iphone-14')!, 'productred').name).toBe('(PRODUCT)RED');
  });

  it('models cutouts and buttons per generation', () => {
    expect(getDevice('iphone-14-pro')!.cutout.kind).toBe('island');
    expect(getDevice('iphone-14')!.cutout.kind).toBe('notch');
    expect(getDevice('iphone-16e')!.cutout.kind).toBe('notch');
    expect(getDevice('iphone-se-3')!.cutout.kind).toBe('none');
    expect(getDevice('iphone-se-3')!.homeButton).toBe(true);
    const kinds = (id: string) => getDevice(id)!.buttons.map((b) => b.kind);
    expect(kinds('iphone-16')).toContain('cameraControl');
    expect(kinds('iphone-16')).toContain('action');
    expect(kinds('iphone-16e')).not.toContain('cameraControl');
    expect(kinds('iphone-15')).toContain('mute');
    expect(kinds('iphone-15-pro')).toContain('action');
  });
});

describe('detectDevice', () => {
  it('matches exact native captures and defaults to the newest model', () => {
    const m = detectDevice(1206, 2622);
    expect(m.exact).toBe(true);
    expect(m.device.id).toBe('iphone-17-pro');
    expect(m.candidates.map((d) => d.id)).toEqual(['iphone-17-pro', 'iphone-17', 'iphone-16-pro']);
    expect(m.orientation).toBe('portrait');
    expect(m.confidence).toBe(1);

    expect(detectDevice(1320, 2868).candidates.map((d) => d.id)).toEqual([
      'iphone-17-pro-max', 'iphone-16-pro-max',
    ]);
    expect(detectDevice(1179, 2556).candidates.map((d) => d.id)).toEqual([
      'iphone-16', 'iphone-15-pro', 'iphone-15', 'iphone-14-pro',
    ]);
    expect(detectDevice(1260, 2736).device.id).toBe('iphone-air');
    expect(detectDevice(750, 1334).device.id).toBe('iphone-se-3');
    expect(detectDevice(2064, 2752).device.id).toBe('ipad-pro-13-m4');
  });

  it('is orientation-aware', () => {
    const m = detectDevice(2556, 1179);
    expect(m.orientation).toBe('landscape');
    expect(m.device.id).toBe('iphone-16');
    expect(m.exact).toBe(true);
  });

  it('matches downscaled captures by uniform scale, tolerating even-rounding', () => {
    const m = detectDevice(603, 1311);
    expect(m.exact).toBe(false);
    expect(m.device.id).toBe('iphone-17-pro');
    expect(m.scale).toBeCloseTo(0.5, 3);
    expect(m.confidence).toBeGreaterThan(0.5);
    // 1179x2556 at 1/3 = 393x852
    expect(detectDevice(393, 852).device.id).toBe('iphone-16');
  });

  it('falls back to the nearest aspect with low confidence', () => {
    const m = detectDevice(1080, 2400); // an Android panel
    expect(m.exact).toBe(false);
    expect(m.confidence).toBeLessThan(0.5);
    expect(m.device.family).toBe('iphone');
  });

  it('can restrict to a family', () => {
    expect(detectDevice(1640, 2360, 'ipad').device.id).toBe('ipad-air-11');
    expect(detectDevice(1206, 2622, 'ipad').exact).toBe(false);
  });

  it('builds a generic device that fits any source', () => {
    const g = genericDevice(2400, 1080);
    expect(g.screenPx).toEqual({ width: 1080, height: 2400 });
    expect(g.cutout.kind).toBe('none');
    expect(defaultDevice().id).toBe('iphone-17-pro');
  });
});
