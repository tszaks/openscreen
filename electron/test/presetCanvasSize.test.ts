// 4K for preset layouts (D18): `exportPreset: 'uhd4k'` scales a social or web
// layout preset so its short side is 2160; App Store presets never scale;
// p1080 and original keep the preset's size. The size goes through
// projectCanvasSize, layoutPreset (so the compositor and phoneHome lay out on
// the same pixels), planRenders and the transcode (sizedPreset).
import { describe, expect, it } from 'vitest';
import { presetCanvasSize, sizedPreset, UHD_SHORT_SIDE } from '../src/shared/exportArgs';
import { ffmpegArgsFor, PRESETS, getPreset, type ExportPreset } from '../src/shared/exportPresets';
import { planRenders } from '../src/shared/exportJobs';
import { layoutPreset, projectCanvasSize, resolveDevice } from '../src/shared/mobileProject';
import { computePhoneLayout } from '../src/shared/phoneLayout';
import { phoneHome } from '../src/shared/phone3d/placement';
import { normalizeProject, type Project } from '../src/shared/types';
import { createHarness, goldenFixtureNames, loadGoldenFixture } from './helpers/compositorHarness';
import { phoneProject } from './helpers/phone3dFixtures';

const EXPORT_PRESETS = ['p1080', 'original', 'uhd4k'] as const;
const appStore = (p: ExportPreset) => p.group === 'App Store';

describe('presetCanvasSize', () => {
  it('every preset × every export resolution', () => {
    for (const p of PRESETS) {
      for (const e of EXPORT_PRESETS) {
        const s = presetCanvasSize(p, e);
        if (e !== 'uhd4k' || appStore(p)) {
          expect(s, `${p.id} ${e}`).toEqual({ width: p.width, height: p.height });
        } else {
          expect(Math.min(s.width, s.height), `${p.id} ${e}`).toBe(UHD_SHORT_SIDE);
          expect(s.width % 2 + (s.height % 2), `${p.id} even`).toBe(0);
          expect(s.width / s.height, `${p.id} aspect`).toBeCloseTo(p.width / p.height, 3);
        }
      }
    }
  });

  it('gives the D18 sizes', () => {
    const at4k = (id: Parameters<typeof getPreset>[0]) => presetCanvasSize(getPreset(id), 'uhd4k');
    expect(at4k('social-9x16')).toEqual({ width: 2160, height: 3840 });
    expect(at4k('shorts-hq')).toEqual({ width: 2160, height: 3840 });
    expect(at4k('landscape-16x9')).toEqual({ width: 3840, height: 2160 });
    expect(at4k('square')).toEqual({ width: 2160, height: 2160 });
    expect(at4k('feed-4x5')).toEqual({ width: 2160, height: 2700 });
    expect(at4k('appstore-iphone')).toEqual({ width: 886, height: 1920 });
    expect(at4k('appstore-ipad-landscape')).toEqual({ width: 1600, height: 1200 });
    expect(presetCanvasSize(getPreset('social-9x16'), undefined)).toEqual({ width: 1080, height: 1920 });
  });
});

describe('sizedPreset', () => {
  it('is the same object when nothing scales', () => {
    for (const p of PRESETS) {
      expect(sizedPreset(p, 'p1080')).toBe(p);
      expect(sizedPreset(p, 'original')).toBe(p);
      if (appStore(p)) expect(sizedPreset(p, 'uhd4k')).toBe(p);
    }
  });

  it('scales the size, the safe zone and the bitrate together, and nothing else', () => {
    const p = getPreset('social-9x16');
    const s = sizedPreset(p, 'uhd4k');
    expect([s.width, s.height]).toEqual([2160, 3840]);
    expect(s.safeZone).toEqual({ top: 500, right: 328, bottom: 1152, left: 120 });
    expect(s.video.bitrateKbps).toEqual({ target: 40000, max: 48000 });
    expect({ ...s, width: p.width, height: p.height, safeZone: p.safeZone, video: p.video }).toEqual(p);
    // A CRF preset keeps its quality setting.
    expect(sizedPreset(getPreset('landing-loop'), 'uhd4k').video).toEqual(getPreset('landing-loop').video);
    // The original preset object is untouched.
    expect(getPreset('social-9x16').width).toBe(1080);
  });

  it('makes the transcode encode at the 4K size', () => {
    const args = ffmpegArgsFor(sizedPreset(getPreset('social-9x16'), 'uhd4k'), { input: 'in.mov', output: 'out.mp4', hasAudio: false });
    expect(args.join(' ')).toContain('scale=2160:3840:force_original_aspect_ratio=increase');
    expect(args.join(' ')).toContain('-b:v 40000k');
  });
});

describe('the project canvas', () => {
  const phone = (presetId: string, exportPreset: Project['exportPreset']) => ({ ...phoneProject({ presetId }), exportPreset });

  it('a layout preset renders at 4K with uhd4k, the preset size otherwise; Classic is unchanged', () => {
    expect(projectCanvasSize(phone('social-9x16', 'uhd4k'))).toEqual({ width: 2160, height: 3840 });
    expect(projectCanvasSize(phone('landscape-16x9', 'uhd4k'))).toEqual({ width: 3840, height: 2160 });
    expect(projectCanvasSize(phone('social-9x16', 'p1080'))).toEqual({ width: 1080, height: 1920 });
    expect(projectCanvasSize(phone('social-9x16', 'original'))).toEqual({ width: 1080, height: 1920 });
    expect(projectCanvasSize(phone('appstore', 'uhd4k'))).toEqual({ width: 886, height: 1920 });
    // Classic keeps the source-aspect export size (exportCanvasSize).
    expect(projectCanvasSize(phone('none', 'uhd4k'))).toEqual({ width: 994, height: 2160 });
    expect(projectCanvasSize(phone('none', 'p1080'))).toEqual({ width: 496, height: 1080 });
  });

  it('layoutPreset comes back at the size it renders at', () => {
    expect(layoutPreset(phone('social-9x16', 'uhd4k'))).toMatchObject({ id: 'social-9x16', width: 2160, height: 3840 });
    expect(layoutPreset(phone('social-9x16', 'p1080'))).toBe(getPreset('social-9x16'));
    // A caller without exportPreset gets the preset's own size.
    const { exportPreset: _drop, ...noExport } = phone('social-9x16', 'uhd4k');
    expect(layoutPreset(noExport)).toBe(getPreset('social-9x16'));
  });

  it('every flat-identity fixture (all p1080) keeps exactly the size it had', () => {
    for (const name of goldenFixtureNames()) {
      const p = normalizeProject(loadGoldenFixture(name).project);
      expect(p.exportPreset, name).toBe('p1080');
      const preset = layoutPreset(p);
      const before = preset ? { width: getPreset(preset.id).width, height: getPreset(preset.id).height } : null;
      if (before && preset!.group !== 'App Store') expect(projectCanvasSize(p), name).toEqual(before);
    }
  });
});

describe('planRenders at 4K', () => {
  it('sizes each pass at the export resolution; App Store passes keep their size', () => {
    const ids = ['social-9x16', 'shorts-hq', 'appstore-iphone', 'landscape-16x9'] as const;
    const passes = planRenders(ids.map((id) => getPreset(id)), 'uhd4k');
    const byLayout = Object.fromEntries(passes.map((p) => [p.presetIds.join('+'), [p.width, p.height]]));
    expect(byLayout).toEqual({
      'social-9x16+shorts-hq': [2160, 3840],
      'appstore-iphone': [886, 1920],
      'landscape-16x9': [3840, 2160],
    });
    // Unchanged without uhd4k (the largest preset in a pass).
    const p1080 = planRenders(ids.map((id) => getPreset(id)), 'p1080');
    expect(p1080.find((p) => p.presetIds.includes('shorts-hq'))).toMatchObject({ width: 1440, height: 2560, layoutPreset: 'shorts-hq' });
    expect(planRenders(ids.map((id) => getPreset(id)))).toEqual(p1080);
  });
});

// The 4K-downscale layout check: the layout is resolution-independent, so a
// 4K canvas is the 1080 canvas scaled by exactly 2: the phone, its screen,
// the title box and the safe zone, through the real compositor. (Pixels:
// see the WP3 report; text sizes are whole pixels, so glyph edges differ.)
describe('4K layout = 2 × the 1080 layout', () => {
  const scale = (r: { x: number; y: number; w: number; h: number } | null | undefined, k: number) => r && { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k };
  const close = (a: unknown, b: unknown, label: string) => {
    const flat = (v: unknown): number[] => (v && typeof v === 'object' ? Object.values(v as object).flatMap(flat) : typeof v === 'number' ? [v] : []);
    const fa = flat(a);
    const fb = flat(b);
    expect(fa.length, label).toBe(fb.length);
    fa.forEach((x, i) => expect(x, `${label}[${i}]`).toBeCloseTo(fb[i], 6));
  };

  it('computePhoneLayout on the sized preset is the 1080 layout × 2', () => {
    for (const id of ['social-9x16', 'square', 'feed-4x5', 'landscape-16x9', 'shorts-hq'] as const) {
      const base = getPreset(id);
      const big = sizedPreset(base, 'uhd4k');
      const k = big.height / base.height;
      for (const titleCard of [false, true]) {
        const { device } = resolveDevice(phoneProject({ presetId: id }));
        const a = computePhoneLayout(base, device, { deviceFrame: true, titleCard });
        const b = computePhoneLayout(big, device, { deviceFrame: true, titleCard });
        close(b.device, scale(a.device, k), `${id} device`);
        close(b.screen, scale(a.screen, k), `${id} screen`);
        close(b.title, scale(a.title, k), `${id} title`);
        close(b.safe, scale(a.safe, k), `${id} safe`);
      }
    }
  });

  it('the real compositor places the phone at 2× on the 4K canvas, and phoneHome agrees', async () => {
    const h = await createHarness();
    try {
      for (const id of ['social-9x16', 'landscape-16x9', 'square']) {
        const at = (e: Project['exportPreset']) => {
          const p = { ...phoneProject({ presetId: id, ...(id === 'landscape-16x9' ? { width: 2622, height: 1206 } : {}) }), exportPreset: e };
          p.layout.titleCard = { title: 'Headline', subtitle: 'Sub' };
          const canvas = projectCanvasSize(p);
          const c = h.compositor(p, canvas);
          h.render(c, 1, { frame: h.video('screen', p.recording.sourceSize.width, p.recording.sourceSize.height), cursor: null, ripples: [] });
          return { c, p, canvas };
        };
        const small = at('p1080');
        const big = at('uhd4k');
        const k = big.canvas.height / small.canvas.height;
        expect(k, id).toBe(2);
        close(big.c.contentRect, scale(small.c.contentRect, k), `${id} contentRect`);
        close(big.c.screenMap?.screen, scale(small.c.screenMap?.screen, k), `${id} screen`);
        close(big.c.phoneLayout?.title, scale(small.c.phoneLayout?.title, k), `${id} title`);
        close(phoneHome(big.p, big.canvas)?.body, big.c.contentRect, `${id} phoneHome`);
      }
    } finally {
      h.dispose();
    }
  });
});
