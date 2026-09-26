import { describe, expect, it } from 'vitest';
import { Timeline, toOutputTime } from '../src/shared/timeline';
import { AutofocusPlanner, defaultAutofocus } from '../src/shared/autofocus';
import { normalizeProject, type Project } from '../src/shared/types';
import { fileUrl } from '../src/shared/fileUrl';
import type { CursorSample } from '../src/shared/types';

const clip = (id: string, sourceStart: number, sourceEnd: number, speed = 1) => ({
  id,
  sourceStart,
  sourceEnd,
  speed,
});

describe('focus events in output time (BH-06)', () => {
  it('a click at source 8s zooms at output 4s after cutting 0-4s', () => {
    const tl = new Timeline(12, [clip('b', 4, 12)]);
    const clicks: CursorSample[] = [
      { time: 2, x: 0.1, y: 0.1, kind: 'clickDown' }, // in the cut: dropped
      { time: 8, x: 0.5, y: 0.5, kind: 'clickDown' },
    ];
    const mapped = toOutputTime(clicks, tl);
    expect(mapped.map((c) => c.time)).toEqual([4]);
    const segs = new AutofocusPlanner(defaultAutofocus).planSegments(mapped, tl.outputDuration);
    expect(segs).toHaveLength(1);
    expect(segs[0].inStart).toBeLessThan(4);
    expect(segs[0].holdEnd).toBeGreaterThan(4);
    expect(segs[0].inStart).toBeGreaterThan(3); // not at source 8
  });

  it('sorts after a reorder', () => {
    const tl = new Timeline(10, [clip('b', 5, 10), clip('a', 0, 5)]);
    const mapped = toOutputTime(
      [
        { time: 1, x: 0, y: 0, kind: 'clickDown' as const },
        { time: 6, x: 0, y: 0, kind: 'clickDown' as const },
      ],
      tl,
    );
    expect(mapped.map((c) => c.time)).toEqual([1, 6]);
  });
});

describe('normalizeProject (BH-14)', () => {
  it('fills zoom, audio and manual zooms for bundles saved before they existed', () => {
    const old = {
      recording: { screenVideoFile: 's.webm', sourceKind: 'display', sourceSize: { width: 1, height: 1 }, duration: 1 },
      clips: [],
      zoomKeyframes: [],
      style: { cornerRadius: 1 },
      cameraOverlay: {},
      exportPreset: 'p1080',
      outputFPS: 60,
    } as unknown as Project;
    const p = normalizeProject(old);
    expect(p.manualZooms).toEqual([]);
    expect(p.zoom).toEqual({ autofocus: true, dwell: true, depth: 2, motionEvents: [], fromTaps: true });
    expect(p.audio).toEqual({ clickSounds: true, voiceCleanup: false });
    expect(p.captions).toEqual([]);
    expect(p.style.deviceFrame).toBe('none');
  });

  it('keeps saved settings', () => {
    const p = normalizeProject({
      zoom: { autofocus: false, depth: 3 },
      audio: { clickSounds: false },
      manualZooms: [{ inStart: 1 }],
    } as unknown as Project);
    expect(p.zoom.autofocus).toBe(false);
    expect(p.zoom.depth).toBe(3);
    expect(p.zoom.dwell).toBe(true);
    expect(p.audio.clickSounds).toBe(false);
    expect(p.manualZooms).toHaveLength(1);
  });
});

describe('fileUrl (BH-13)', () => {
  it('encodes spaces and URL metacharacters per segment', () => {
    expect(fileUrl('/System/Library/Desktop Pictures/Sonoma.jpg')).toBe(
      'file:///System/Library/Desktop%20Pictures/Sonoma.jpg',
    );
    expect(fileUrl('/Users/t/My #1?.png')).toBe('file:///Users/t/My%20%231%3F.png');
  });
});
