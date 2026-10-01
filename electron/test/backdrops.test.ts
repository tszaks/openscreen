import { describe, expect, it } from 'vitest';
import { BACKDROPS, BACKDROP_GROUPS, backdropById, backgroundCss, sameBackground } from '../src/shared/backdrops';
import { applyOp, validateProject } from '../src/shared/agentOps';
import { defaultProject } from '../src/shared/types';
import { isColourBackground, paintBackdrop } from '../src/renderer/src/backdrop';
import { mockCanvas } from './helpers/mockCanvas';

const HEX = /^#[0-9a-f]{6}$/;
const desktop = () =>
  defaultProject({ screenVideoFile: 'screen.webm', sourceKind: 'display', sourceSize: { width: 1920, height: 1080 }, duration: 10 });

describe('backdrop presets', () => {
  it('have unique ids and names, a known group, and valid colours', () => {
    expect(new Set(BACKDROPS.map((b) => b.id)).size).toBe(BACKDROPS.length);
    expect(new Set(BACKDROPS.map((b) => b.name)).size).toBe(BACKDROPS.length);
    const groups = BACKDROP_GROUPS.map((g) => g.id);
    for (const b of BACKDROPS) {
      expect(groups).toContain(b.group);
      const bg = b.bg;
      if (bg.kind === 'solid') expect(bg.hex).toMatch(HEX);
      else if (bg.kind === 'gradient') {
        expect(bg.startHex).toMatch(HEX);
        expect(bg.endHex).toMatch(HEX);
      } else if (bg.kind === 'mesh') {
        expect(bg.baseHex).toMatch(HEX);
        expect(bg.blobs.length).toBeGreaterThan(0);
        for (const p of bg.blobs) {
          expect(p.hex).toMatch(HEX);
          expect(p.r).toBeGreaterThan(0);
        }
        expect(bg.grain ?? 0).toBeLessThanOrEqual(0.2);
      } else throw new Error(`${b.id}: presets must be colour backdrops`);
    }
  });

  it('keep the original agent swatch ids with their exact values', () => {
    // Saved projects and agent scripts reference these; never change them.
    expect(backdropById('aurora')?.bg).toEqual({ kind: 'gradient', startHex: '#3a1c71', endHex: '#d76d77', angle: 120 });
    expect(backdropById('ocean')?.bg).toEqual({ kind: 'gradient', startHex: '#0f2027', endHex: '#2c5364', angle: 135 });
    expect(backdropById('sunset')?.bg).toEqual({ kind: 'gradient', startHex: '#ff7e5f', endHex: '#feb47b', angle: 160 });
    expect(backdropById('MONO')?.bg).toEqual({ kind: 'solid', hex: '#17171c' });
  });

  it('every id resolves through the agent op, validates, and paints without throwing', () => {
    for (const b of BACKDROPS) {
      const p = applyOp(desktop(), { op: 'background', swatch: b.id }).project;
      expect(sameBackground(p.style.background, b.bg)).toBe(true);
      expect(validateProject(p)).toEqual([]);
      const m = mockCanvas();
      expect(isColourBackground(b.bg)).toBe(true);
      if (isColourBackground(b.bg)) paintBackdrop(m.ctx, b.bg, 1920, 1080);
      expect(m.count('fillRect')).toBeGreaterThanOrEqual(1);
      expect(m.depth()).toBe(0);
      expect(backgroundCss(b.bg)).not.toBe('#111');
    }
  });

  it('a mesh paints its base, then one radial fill per blob', () => {
    const bg = backdropById('nebula')!.bg;
    if (bg.kind !== 'mesh') throw new Error('nebula is a mesh');
    const m = mockCanvas();
    paintBackdrop(m.ctx, bg, 1600, 900);
    expect(m.count('createRadialGradient')).toBe(bg.blobs.length);
    // No canvas in node, so grain is skipped rather than failing.
    expect(m.count('fillRect')).toBe(1 + bg.blobs.length);
  });

  it('only one preset is built on the UI accent', () => {
    const accent = BACKDROPS.filter((b) => JSON.stringify(b.bg).toLowerCase().includes('#ff8a3d'));
    expect(accent.map((b) => b.id)).toEqual(['citrus']);
  });

  it('sameBackground ignores hex case and tells meshes apart', () => {
    expect(sameBackground({ kind: 'solid', hex: '#ABCDEF' }, { kind: 'solid', hex: '#abcdef' })).toBe(true);
    expect(sameBackground(backdropById('peach')!.bg, backdropById('mist')!.bg)).toBe(false);
    expect(sameBackground(backdropById('peach')!.bg, JSON.parse(JSON.stringify(backdropById('peach')!.bg)))).toBe(true);
    expect(sameBackground(backdropById('mono')!.bg, backdropById('graphite')!.bg)).toBe(false);
  });

  it('swatch CSS turns canvas angles into CSS angles', () => {
    expect(backgroundCss({ kind: 'gradient', startHex: '#000000', endHex: '#ffffff', angle: 0 })).toBe('linear-gradient(90deg, #000000, #ffffff)');
  });
});

describe('mesh validation', () => {
  it('rejects blobs with missing or non-finite numbers, which would break every frame', () => {
    const p = desktop();
    const ok = { kind: 'mesh' as const, baseHex: '#101018', blobs: [{ x: 0.3, y: 0.4, r: 0.6, hex: '#ff8a3d' }] };
    p.style.background = ok;
    expect(validateProject(p)).toEqual([]);
    for (const bad of [{ y: 0.4, r: 0.6, hex: '#ff8a3d' }, { x: 0.3, y: 0.4, r: Infinity, hex: '#ff8a3d' }, { x: NaN, y: 0.4, r: 0.6, hex: '#ff8a3d' }]) {
      p.style.background = { ...ok, blobs: [bad as never] };
      expect(validateProject(p).join(' ')).toMatch(/mesh/);
    }
    p.style.background = { ...ok, grain: NaN };
    expect(validateProject(p).join(' ')).toMatch(/mesh/);
  });
});
