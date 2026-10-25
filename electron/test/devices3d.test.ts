import { describe, expect, it } from 'vitest';
import { DEVICES, genericDevice } from '../src/shared/devices';
import { BODY3D, BODY3D_IDS, BUTTON_DEPTH, body3dFor, body3dSource } from '../src/shared/devices3d';

// Apple tech-spec depths, as printed on each model's support.apple.com page
// (fetched 2026-10-24; URL per row in devices3d.ts). A typo in the table
// fails here.
const APPLE_DEPTH: Record<string, number> = {
  'iphone-17-pro-max': 8.75, 'iphone-17-pro': 8.75, 'iphone-air': 5.64, 'iphone-17': 7.95,
  'iphone-16-pro-max': 8.25, 'iphone-16-pro': 8.25, 'iphone-16-plus': 7.8, 'iphone-16': 7.8, 'iphone-16e': 7.8,
  'iphone-15-pro-max': 8.25, 'iphone-15-pro': 8.25, 'iphone-15-plus': 7.8, 'iphone-15': 7.8,
  'iphone-14-pro-max': 7.85, 'iphone-14-pro': 7.85, 'iphone-14-plus': 7.8, 'iphone-14': 7.8,
  'iphone-13-pro-max': 7.65, 'iphone-13-pro': 7.65, 'iphone-13': 7.65, 'iphone-13-mini': 7.65,
  'iphone-se-3': 7.3,
  'ipad-pro-13-m4': 5.1, 'ipad-pro-11-m4': 5.3, 'ipad-air-13': 6.1, 'ipad-air-11': 6.1, 'ipad-mini-a17': 6.3,
};

describe('devices3d', () => {
  it('has a measured row, with sources, for every model in devices.ts (22 iPhones, 5 iPads)', () => {
    expect(DEVICES.filter((d) => d.family === 'iphone')).toHaveLength(22);
    expect(DEVICES.filter((d) => d.family === 'ipad')).toHaveLength(5);
    for (const d of DEVICES) {
      expect(BODY3D_IDS).toContain(d.id);
      const src = body3dSource(d.id)!;
      expect(src.specs).toMatch(/^https:\/\/support\.apple\.com\/en-us\/\d+$/);
      expect(src.drawing).toMatch(/^https:\/\/developer\.apple\.com\/download\/files\/accessories\/dimensional-drawings\/[a-z0-9.-]+\.pdf$/);
      expect(src.note.length).toBeGreaterThan(10);
    }
  });

  it('depths are the Apple tech-spec values', () => {
    for (const d of DEVICES) {
      expect(body3dFor(d).depthMm, d.id).toBe(APPLE_DEPTH[d.id]);
      expect(BODY3D[d.id].depthMm).toBe(APPLE_DEPTH[d.id]);
    }
  });

  it('every plateau and lens sits on the back, inside the plateau, with sane sizes', () => {
    for (const d of DEVICES) {
      const b = body3dFor(d);
      const pl = b.plateau;
      expect(pl.x).toBeGreaterThanOrEqual(0);
      expect(pl.y).toBeGreaterThanOrEqual(0);
      expect(pl.x + pl.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(pl.y + pl.h).toBeLessThanOrEqual(1);
      expect(pl.heightMm).toBeGreaterThan(0);
      expect(pl.heightMm).toBeLessThan(4);
      expect(pl.lenses.length).toBeGreaterThanOrEqual(1);
      const wMm = pl.w * d.bodyMm.width;
      const hMm = pl.h * d.bodyMm.height;
      for (const l of pl.lenses) {
        // The lens opening fits inside the footprint.
        expect(l.x * wMm - l.rMm, d.id).toBeGreaterThanOrEqual(-0.01);
        expect(l.x * wMm + l.rMm, d.id).toBeLessThanOrEqual(wMm + 0.01);
        expect(l.y * hMm - l.rMm, d.id).toBeGreaterThanOrEqual(-0.01);
        expect(l.y * hMm + l.rMm, d.id).toBeLessThanOrEqual(hMm + 0.01);
      }
      expect(b.buttonDepth).toBeCloseTo(BUTTON_DEPTH, 12);
      expect(b.buttonDepth * b.depthMm).toBeLessThan(4);
    }
  });

  it('lens counts and plateau kinds follow the camera systems', () => {
    const count = (id: string) => body3dFor(DEVICES.find((d) => d.id === id)!).plateau.lenses.length;
    const kind = (id: string) => body3dFor(DEVICES.find((d) => d.id === id)!).plateau.kind;
    for (const id of ['iphone-17-pro', 'iphone-16-pro', 'iphone-15-pro-max', 'iphone-14-pro', 'iphone-13-pro']) expect(count(id)).toBe(3);
    for (const id of ['iphone-17', 'iphone-16', 'iphone-15', 'iphone-14', 'iphone-13', 'iphone-13-mini']) expect(count(id)).toBe(2);
    for (const id of ['iphone-air', 'iphone-16e', 'iphone-se-3', 'ipad-air-11', 'ipad-mini-a17', 'ipad-pro-11-m4']) expect(count(id)).toBe(1);
    expect(kind('iphone-17-pro')).toBe('bar');
    expect(kind('iphone-air')).toBe('pill');
    expect(kind('iphone-16')).toBe('pill');
    expect(kind('iphone-16-pro')).toBe('square');
    expect(kind('iphone-14')).toBe('square');
    expect(kind('iphone-16e')).toBe('single');
    // The 17 Pro bar spans the full width.
    const bar = body3dFor(DEVICES.find((d) => d.id === 'iphone-17-pro')!).plateau;
    expect(bar.x).toBe(0);
    expect(bar.w).toBeCloseTo(1, 12);
  });

  it('edge and back follow the spec (12–16 flat, 17 / Air rounded; Pro frosted)', () => {
    const get = (id: string) => body3dFor(DEVICES.find((d) => d.id === id)!);
    expect(get('iphone-16-pro').edge).toBe('flat');
    expect(get('iphone-13').edge).toBe('flat');
    expect(get('iphone-17').edge).toBe('rounded');
    expect(get('iphone-air').edge).toBe('rounded');
    expect(get('iphone-15-pro').back).toBe('frosted');
    expect(get('iphone-15').back).toBe('glossy');
  });

  it('a generic phone gets a 2-lens base module and typical depth; iPads get the top button', () => {
    const g = body3dFor(genericDevice(1080, 2400));
    expect(g.plateau.lenses).toHaveLength(2);
    expect(g.depthMm).toBe(7.8);
    const ipad = body3dFor(DEVICES.find((d) => d.id === 'ipad-pro-11-m4')!);
    expect(ipad.extraButtons?.[0].kind).toBe('top');
  });
});
