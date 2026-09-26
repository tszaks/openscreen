import { describe, expect, it } from 'vitest';
import { getPreset, type PresetId } from '../src/shared/exportPresets';
import {
  batchUnits,
  croppedSource,
  layoutPresetOf,
  outputBase,
  outputFiles,
  planRenders,
  presetChoices,
  presetWarnings,
  projectForPreset,
  renderKey,
} from '../src/shared/exportJobs';
import { defaultProject, type Project } from '../src/shared/types';

const ids = (xs: { id: PresetId }[]) => xs.map((x) => x.id);
const project = (width = 1206, height = 2622): Project =>
  defaultProject({ screenVideoFile: 'screen.mp4', sourceKind: 'iosDevice', sourceSize: { width, height }, duration: 20 });

describe('presetChoices', () => {
  it('offers the portrait App Store size and no iPad for an iPhone capture', () => {
    expect(ids(presetChoices({ width: 1206, height: 2622 }))).toEqual([
      'appstore-iphone', 'social-9x16', 'square', 'feed-4x5', 'landscape-16x9', 'landing-loop',
    ]);
  });

  it('switches to the landscape App Store size for a landscape capture', () => {
    expect(ids(presetChoices({ width: 2622, height: 1206 }))[0]).toBe('appstore-iphone-landscape');
  });

  it('adds the iPad App Store size only for iPad captures', () => {
    expect(ids(presetChoices({ width: 2064, height: 2752 })).slice(0, 2)).toEqual(['appstore-iphone', 'appstore-ipad']);
    expect(ids(presetChoices({ width: 2752, height: 2064 })).slice(0, 2)).toEqual([
      'appstore-iphone-landscape', 'appstore-ipad-landscape',
    ]);
    // a Mac display recording is not mistaken for an iPad
    expect(ids(presetChoices({ width: 3024, height: 1964 }))).not.toContain('appstore-ipad-landscape');
  });
});

describe('planRenders', () => {
  it('gives App Store (full-bleed) and 9:16 (framed) separate passes', () => {
    const passes = planRenders(['appstore-iphone', 'social-9x16', 'square'].map((id) => getPreset(id as PresetId)));
    expect(passes.map((p) => p.presetIds)).toEqual([['appstore-iphone'], ['social-9x16'], ['square']]);
    expect(passes[0]).toMatchObject({ width: 886, height: 1920, fps: 30, zoom: false, layoutPreset: 'appstore-iphone' });
    expect(passes[1]).toMatchObject({ width: 1080, height: 1920, zoom: true });
  });

  it('shares one pass between presets that draw the same picture, at the larger size', () => {
    const passes = planRenders([getPreset('social-9x16'), getPreset('shorts-hq')]);
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ width: 1440, height: 2560, layoutPreset: 'shorts-hq', presetIds: ['social-9x16', 'shorts-hq'] });
  });

  it('keeps the landing loop apart from 9:16 social: same shape, different phone size and no title', () => {
    expect(renderKey(getPreset('landing-loop'))).not.toBe(renderKey(getPreset('social-9x16')));
  });

  it('ignores a preset picked twice', () => {
    const p = getPreset('square');
    expect(planRenders([p, p])[0].presetIds).toEqual(['square']);
  });

  it('counts render frames plus weighted encode work', () => {
    const passes = planRenders([getPreset('social-9x16'), getPreset('shorts-hq')]);
    expect(batchUnits(passes, 10)).toBeCloseTo(300 + 300 * 0.4 * 2);
  });
});

describe('file naming', () => {
  it('names files "<project> – <format>" inside the picked folder', () => {
    const base = outputBase('/Users/t/Movies/OpenScreen/Vero demo/', 'Vero demo', getPreset('appstore-iphone'));
    expect(base).toBe('/Users/t/Movies/OpenScreen/Vero demo/Vero demo – App Store');
    expect(outputFiles(base, getPreset('appstore-iphone'))).toEqual([`${base}.mp4`]);
  });

  it('lists every landing-loop file: MP4, WebM and the poster', () => {
    const base = outputBase('/x', 'Vero', getPreset('landing-loop'));
    expect(outputFiles(base, getPreset('landing-loop'))).toEqual([
      '/x/Vero – Landing loop.mp4', '/x/Vero – Landing loop.webm', '/x/Vero – Landing loop-poster.jpg',
    ]);
  });

  it('keeps names valid when the project name has slashes or colons', () => {
    expect(outputBase('/x', 'a/b: c', getPreset('square'))).toBe('/x/a-b- c – Square');
    expect(outputBase('/x', '', getPreset('feed-4x5'))).toBe('/x/OpenScreen – 4x5 Feed');
  });
});

describe('presetWarnings', () => {
  const src = { width: 1206, height: 2622 };

  it('says in plain words when an App Store preview is too long, and never mentions zoom or frames', () => {
    const w = presetWarnings(getPreset('appstore-iphone'), { duration: 42, source: src, hasAudio: true });
    expect(w.map((x) => x.message)).toEqual(['App Store previews must be 15–30 s; yours is 42 s.']);
  });

  it('explains the silent track for App Store and the muted feed for social', () => {
    expect(presetWarnings(getPreset('appstore-iphone'), { duration: 20, source: src, hasAudio: false })[0].message).toMatch(
      /silent stereo track will be added/,
    );
    expect(presetWarnings(getPreset('social-9x16'), { duration: 20, source: src, hasAudio: false })[0].message).toMatch(/autoplay muted/);
  });

  it('warns that a small recording will be upscaled for App Store', () => {
    const w = presetWarnings(getPreset('appstore-iphone'), { duration: 20, source: { width: 590, height: 1280 }, hasAudio: true });
    expect(w.map((x) => x.code)).toContain('upscale');
  });

  it('flags a landing loop outside its sweet spot as info only', () => {
    const w = presetWarnings(getPreset('landing-loop'), { duration: 42, source: src });
    expect(w).toEqual([expect.objectContaining({ level: 'info', message: 'Landing loops work best at 6–20 s; yours is 42 s.' })]);
  });

  it('checks the cropped size, not the full recording', () => {
    const p = project();
    p.style.cropRect = { x: 0, y: 0, w: 0.5, h: 0.5 };
    expect(croppedSource(p)).toEqual({ width: 603, height: 1311 });
  });
});

describe('projectForPreset', () => {
  it('sets layout.presetId and strips frame, padding and shadow for full-bleed', () => {
    const p = project();
    p.style.deviceFrame = 'phone';
    const out = projectForPreset(p, getPreset('appstore-iphone')) as Project & { layout: { presetId: string } };
    expect(out.layout.presetId).toBe('appstore-iphone');
    expect(out.style).toMatchObject({ deviceFrame: 'none', paddingFraction: 0, cornerRadius: 0, shadowOpacity: 0 });
    expect(p.style.deviceFrame).toBe('phone'); // the editor's project is untouched
  });

  it('keeps the style for framed presets and keeps other layout fields', () => {
    const p = Object.assign(project(), { layout: { presetId: 'square', titleCard: { title: 'Hi' } } });
    const out = projectForPreset(p, getPreset('social-9x16')) as Project & { layout: Record<string, unknown> };
    expect(out.style).toBe(p.style);
    expect(out.layout).toEqual({ presetId: 'social-9x16', titleCard: { title: 'Hi' } });
  });

  it('reads the layout preset only when it is a known one', () => {
    expect(layoutPresetOf(project())).toBeNull();
    expect(layoutPresetOf(Object.assign(project(), { layout: { presetId: 'appstore-iphone' } }))?.width).toBe(886);
    expect(layoutPresetOf(Object.assign(project(), { layout: { presetId: 'nope' } }))).toBeNull();
  });
});
