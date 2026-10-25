// The one builder of a 3D phone's render settings (render3dSettings) that the
// export, `frames` and the paused preview's full-quality redraw all use.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render3dSettings } from '../src/renderer/src/render3dSettings';
import { projectForPreset } from '../src/shared/exportJobs';
import { getPreset } from '../src/shared/exportPresets';
import { phone3dActive } from '../src/shared/phone3d/placement';
import { phoneProject, with3d } from './helpers/phone3dFixtures';

const threeD = (supersample: 1 | 2 | 3 = 2) => {
  const p = with3d(phoneProject({ presetId: 'social-9x16' }), { supersample });
  p.device.frame = true;
  return p;
};

describe('render3dSettings', () => {
  it('is undefined only for a project with no 3D settings', () => {
    expect(render3dSettings(phoneProject({ presetId: 'social-9x16' }), { fps: 30 })).toBeUndefined();
  });

  it('export quality: the project supersampling and motion blur, strict by default', () => {
    const p = threeD(2);
    expect(render3dSettings(p, { fps: 30 })).toEqual({
      ss: 2,
      quality: 'full',
      motionBlur: { samples: p.phone3d!.motionBlur.samples, shutter: p.phone3d!.motionBlur.shutter },
      fps: 30,
      strict: true,
    });
    p.phone3d!.motionBlur.on = false;
    expect(render3dSettings(p, { fps: 60 })).toMatchObject({ motionBlur: null, fps: 60 });
  });

  it('draft: one sample at 1x and no motion blur, whatever the project says', () => {
    expect(render3dSettings(threeD(3), { fps: 30, draft: true })).toEqual({ ss: 1, quality: 'draft', motionBlur: null, fps: 30, strict: true });
  });

  it('the paused preview asks for export quality that never aborts (strict: false)', () => {
    expect(render3dSettings(threeD(2), { fps: 30, strict: false })).toMatchObject({ quality: 'full', ss: 2, strict: false });
  });

  it('does not gate on phone3dActive: a batch pass can draw 3D on a copy whose preset differs from the editor project', () => {
    // An App Store project draws flat, but exported as social 9:16 its copy draws in 3D.
    const p = with3d(phoneProject({ presetId: 'appstore' }));
    p.device.frame = true;
    expect(phone3dActive(p).active).toBe(false);
    const copy = projectForPreset(p, getPreset('social-9x16'));
    expect(phone3dActive(copy).active).toBe(true);
    // renderFrames builds the settings from the editor project for every pass: the 3D copy must get export quality.
    expect(render3dSettings(p, { fps: 30 })).toMatchObject({ quality: 'full', strict: true });
    // A disabled 3D phone still gets settings; the compositor ignores them when it draws flat.
    p.phone3d!.enabled = false;
    expect(render3dSettings(p, { fps: 30 })).toBeDefined();
  });

  it('is the only builder: the editor calls it for export, frames and the idle redraw, and the old two are gone', () => {
    const editor = readFileSync(join(__dirname, '../src/renderer/src/Editor.tsx'), 'utf8');
    expect(editor.match(/render3dSettings\(proj, \{[^}]*\}\)/g)).toEqual([
      'render3dSettings(proj, { fps: layoutPresetOf(proj)?.fps ?? proj.outputFPS, strict: false })',
      'render3dSettings(proj, { fps })',
      'render3dSettings(proj, { fps, draft: !!job.draft })',
    ]);
    for (const file of ['Editor.tsx', 'compositor.ts', 'headlessFrames.ts']) {
      const src = readFileSync(join(__dirname, '../src/renderer/src', file), 'utf8');
      expect(src).not.toMatch(/exportRender3d|render3dFor/);
    }
  });
});
