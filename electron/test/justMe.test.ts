import { describe, expect, it } from 'vitest';
import { cameraDefaults, editorFeatures, isCameraProject, withCameraCanvas } from '../src/shared/justMe';
import { macContentRect } from '../src/shared/cameraOverlay';
import { projectCanvasSize } from '../src/shared/mobileProject';
import { planPolish } from '../src/shared/polish';
import { defaultProject, normalizeProject, type SourceKind } from '../src/shared/types';

const project = (sourceKind: SourceKind, sourceSize = { width: 1920, height: 1080 }) =>
  defaultProject({ screenVideoFile: 'screen.webm', sourceKind, sourceSize, duration: 12 });

describe('"Just me" source kind', () => {
  it('is its own kind and survives a save and reload', () => {
    const p = cameraDefaults(project('camera'));
    expect(isCameraProject(p)).toBe(true);
    const reloaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(reloaded.recording.sourceKind).toBe('camera');
    expect(isCameraProject(project('display'))).toBe(false);
  });

  it('hides the cursor, automatic zooms and taps in the editor, and offers a canvas choice', () => {
    expect(editorFeatures(project('camera'))).toEqual({ cursorTab: false, autoZoom: false, taps: false, canvasChoice: true });
  });

  it('leaves the other kinds as they were', () => {
    expect(editorFeatures(project('display'))).toEqual({ cursorTab: true, autoZoom: true, taps: false, canvasChoice: false });
    expect(editorFeatures(project('window'))).toEqual({ cursorTab: true, autoZoom: true, taps: false, canvasChoice: false });
    expect(editorFeatures(project('iosDevice'))).toEqual({ cursorTab: false, autoZoom: true, taps: true, canvasChoice: false });
  });

  it('starts Wide 16:9 with a backdrop, rounded corners, no cursor and no automatic zooms', () => {
    const p = cameraDefaults(project('camera'));
    expect(p.layout.presetId).toBe('landscape-16x9');
    expect(projectCanvasSize(p)).toEqual({ width: 1920, height: 1080 });
    expect(p.style.background.kind).toBe('gradient');
    expect(p.style.cornerRadius).toBeGreaterThan(0);
    expect(p.style.paddingFraction).toBeGreaterThan(0);
    expect(p.style.cursorShow).toBe(false);
    expect(p.zoom.autofocus).toBe(false);
    expect(p.zoom.dwell).toBe(false);
  });

  for (const [name, source] of [
    ['a 16:9 camera', { width: 1920, height: 1080 }],
    ['a 4:3 camera', { width: 1440, height: 1080 }],
  ] as const) {
    for (const canvas of ['landscape-16x9', 'social-9x16'] as const) {
      it(`fills its frame: ${name} on ${canvas}`, () => {
        const p = withCameraCanvas(cameraDefaults(project('camera', source)), canvas);
        const size = projectCanvasSize(p);
        const content = macContentRect(p, size);
        const pad = Math.min(size.width, size.height) * p.style.paddingFraction;
        // The camera (cropped, centred) fills the padded frame edge to edge.
        expect(content.w).toBeCloseTo(size.width - 2 * pad, 0);
        expect(content.h).toBeCloseTo(size.height - 2 * pad, 0);
        const c = p.style.cropRect;
        if (c) {
          expect(c.x + c.w / 2).toBeCloseTo(0.5, 3);
          expect(c.y + c.h / 2).toBeCloseTo(0.5, 3);
        }
      });
    }
  }

  it('Vertical crops a wide camera to a portrait slice', () => {
    const p = withCameraCanvas(cameraDefaults(project('camera')), 'social-9x16');
    expect(projectCanvasSize(p)).toEqual({ width: 1080, height: 1920 });
    expect(p.style.cropRect!.h).toBe(1);
    expect(p.style.cropRect!.w).toBeLessThan(0.4);
  });

  it('polish gives it a look but no zooms or cursor', () => {
    const ops = planPolish(cameraDefaults(project('camera')), { style: 'clean', analyzed: false, transcript: false });
    expect(ops.map((o) => o.op)).toEqual(['background', 'style']);
  });
});
