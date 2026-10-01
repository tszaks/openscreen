import { describe, expect, it } from 'vitest';
import { defaultProject, resetProject, type Project } from '../src/shared/types';

const phone = () =>
  defaultProject({ screenVideoFile: 'screen.mov', sourceKind: 'iosDevice', sourceSize: { width: 1206, height: 2622 }, duration: 12 });

/** A take with a bit of everything edited. */
function edited(base: Project): Project {
  const p = structuredClone(base);
  p.clips = [
    { id: 'a', sourceStart: 1, sourceEnd: 4, speed: 2 },
    { id: 'b', sourceStart: 6, sourceEnd: 11, speed: 1 },
  ];
  p.manualZooms = [{ inStart: 1, holdStart: 1.5, holdEnd: 2, outEnd: 2.5, center: { x: 0.4, y: 0.4 }, scale: 2 }];
  p.captions = [{ id: 'c', start: 0, end: 1, text: 'hi' } as Project['captions'][number]];
  p.taps = [{ id: 't', t: 2, x: 0.5, y: 0.5, kind: 'tap', confidence: 1 }];
  p.tapsAnalyzed = true;
  p.style.cropRect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  p.style.cornerRadius = 4;
  p.device.frame = false;
  p.layout.presetId = 'none';
  p.layout.titleCard = { title: 'Vero', subtitle: 'Money' };
  p.style.background = { kind: 'solid', hex: '#123456' };
  p.layout.background = 'style';
  return p;
}

describe('resetProject', () => {
  it('drops every edit and keeps only the recording and backdrop', () => {
    const before = edited(phone());
    const r = resetProject(before);
    const fresh = phone();
    expect(r.recording).toEqual(before.recording);
    expect(r.style.background).toEqual({ kind: 'solid', hex: '#123456' });
    expect(r.layout.background).toBe('style');
    // One clip spanning the whole take at 1x.
    expect(r.clips).toHaveLength(1);
    expect(r.clips[0]).toMatchObject({ sourceStart: 0, sourceEnd: 12, speed: 1 });
    expect(r.manualZooms).toEqual([]);
    expect(r.captions).toEqual([]);
    expect(r.taps).toEqual([]);
    expect(r.tapsAnalyzed).toBe(false);
    expect(r.style.cropRect).toBeNull();
    expect(r.style.cornerRadius).toBe(fresh.style.cornerRadius);
    expect(r.device).toEqual(fresh.device);
    expect(r.layout.presetId).toBe(fresh.layout.presetId);
    expect(r.layout.titleCard).toBeUndefined();
  });

  it('keeps the camera overlay on when the take has a camera file', () => {
    const p = defaultProject({ screenVideoFile: 'screen.webm', cameraVideoFile: 'cam.webm', sourceKind: 'display', sourceSize: { width: 1920, height: 1080 }, duration: 5 });
    p.cameraOverlay.enabled = false;
    expect(resetProject(p).cameraOverlay.enabled).toBe(true);
  });

  it('does not share objects with the project it came from', () => {
    const before = edited(phone());
    const r = resetProject(before);
    r.style.cornerRadius = 99;
    expect(before.style.cornerRadius).toBe(4);
  });
});
