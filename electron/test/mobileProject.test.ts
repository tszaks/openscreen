import { describe, expect, it } from 'vitest';
import { defaultProject, normalizeProject, type Clip, type Project, type RecordingRef } from '../src/shared/types';
import { Timeline } from '../src/shared/timeline';
import type { TapSuggestion } from '../src/shared/taps';
import {
  layoutPreset,
  pendingWaits,
  presetAllowsZoom,
  projectCanvasSize,
  rangesToOutput,
  resolveDevice,
  speedUpRanges,
  tapSourceTime,
  tapsToOutput,
  waitCore,
} from '../src/shared/mobileProject';

const phone: RecordingRef = {
  screenVideoFile: 'screen.mov',
  sourceKind: 'iosDevice',
  sourceSize: { width: 1206, height: 2622 },
  duration: 20,
};
const desktop: RecordingRef = { ...phone, screenVideoFile: 'screen.webm', sourceKind: 'display', sourceSize: { width: 2880, height: 1800 } };

const tap = (id: string, t: number, extra: Partial<TapSuggestion> = {}): TapSuggestion => ({
  id, t, x: 0.5, y: 0.5, kind: 'tap', confidence: 0.9, ...extra,
});
const clip = (sourceStart: number, sourceEnd: number, speed = 1): Clip => ({
  id: `${sourceStart}-${sourceEnd}`, sourceStart, sourceEnd, speed,
});

describe('project defaults', () => {
  it('opens phone recordings framed, on 9:16, blurred, with taps and tap zoom on', () => {
    const p = defaultProject(phone);
    expect(p.device.frame).toBe(true);
    expect(p.layout).toEqual({ presetId: 'social-9x16', background: 'blurred' });
    expect(p.tapStyle.show).toBe(true);
    expect(p.zoom.fromTaps).toBe(true);
    expect(p.taps).toEqual([]);
    expect(p.tapsAnalyzed).toBe(false);
  });

  it('keeps desktop recordings on the classic padded frame', () => {
    const p = defaultProject(desktop);
    expect(p.device.frame).toBe(false);
    expect(p.layout.presetId).toBe('none');
    expect(p.layout.background).toBe('style');
    expect(projectCanvasSize(p)).toEqual({ width: 1728, height: 1080 });
  });

  it('fills the new fields in bundles saved before they existed', () => {
    const old = { ...defaultProject(phone) } as Partial<Project>;
    delete old.device;
    delete old.taps;
    delete old.tapStyle;
    delete old.waits;
    delete old.tapsAnalyzed;
    delete old.layout;
    const p = normalizeProject(old as Project);
    expect(p.device).toEqual({ frame: true });
    expect(p.taps).toEqual([]);
    expect(p.tapStyle).toEqual({ show: true, style: 'ripple', color: 'white', sizePt: 52 });
    expect(p.layout.presetId).toBe('social-9x16');
  });

  it('carries the old phone-frame switch over and keeps saved choices', () => {
    const old = { ...defaultProject(desktop), style: { ...defaultProject(desktop).style, deviceFrame: 'phone' } } as Partial<Project>;
    delete old.device;
    expect(normalizeProject(old as Project).device.frame).toBe(true);
    const saved = normalizeProject({
      ...defaultProject(phone),
      layout: { presetId: 'square', background: 'style', titleCard: { title: 'Hi', subtitle: '' } },
      tapStyle: { sizePt: 60 } as Project['tapStyle'],
    });
    expect(saved.layout.presetId).toBe('square');
    expect(saved.layout.titleCard?.title).toBe('Hi');
    expect(saved.tapStyle.sizePt).toBe(60);
    expect(saved.tapStyle.style).toBe('ripple');
  });
});

describe('device and layout selection', () => {
  it('detects the model from the capture size unless one is chosen', () => {
    const p = defaultProject(phone);
    expect(resolveDevice(p).device.id).toBe('iphone-17-pro');
    expect(resolveDevice(p).detected.id).toBe('iphone-17-pro');
    const chosen = { ...p, device: { frame: true, modelId: 'iphone-17' } };
    expect(resolveDevice(chosen).device.id).toBe('iphone-17');
    expect(resolveDevice(chosen).detected.id).toBe('iphone-17-pro');
  });

  it('falls back to a generic frame for sizes no phone has', () => {
    const odd = defaultProject({ ...phone, sourceSize: { width: 1000, height: 1000 } });
    expect(resolveDevice(odd).device.id).toBe('generic');
  });

  it('sizes the canvas from the preset', () => {
    const at = (presetId: string, rec: RecordingRef = phone) => {
      const p = defaultProject(rec);
      return projectCanvasSize({ ...p, layout: { ...p.layout, presetId } });
    };
    expect(at('social-9x16')).toEqual({ width: 1080, height: 1920 });
    expect(at('feed-4x5')).toEqual({ width: 1080, height: 1350 });
    expect(at('square')).toEqual({ width: 1080, height: 1080 });
    expect(at('landscape-16x9')).toEqual({ width: 1920, height: 1080 });
    expect(at('landing-loop')).toEqual({ width: 720, height: 1280 });
    expect(at('none')).toEqual({ width: 496, height: 1080 });
    expect(at('bogus')).toEqual({ width: 496, height: 1080 });
  });

  it('picks the App Store size for the device family and orientation', () => {
    const at = (rec: RecordingRef) => {
      const p = defaultProject(rec);
      return layoutPreset({ ...p, layout: { ...p.layout, presetId: 'appstore' } })!;
    };
    expect(at(phone).id).toBe('appstore-iphone');
    expect([at(phone).width, at(phone).height]).toEqual([886, 1920]);
    expect(at({ ...phone, sourceSize: { width: 2622, height: 1206 } }).id).toBe('appstore-iphone-landscape');
    expect(at({ ...phone, sourceSize: { width: 2064, height: 2752 } }).id).toBe('appstore-ipad');
    expect(presetAllowsZoom(at(phone))).toBe(false);
    expect(presetAllowsZoom(null)).toBe(true);
    expect(at(phone).layout).toBe('full-bleed');
  });
});

describe('taps across edits (source time → output time)', () => {
  const taps = [tap('a', 2), tap('b', 6, { kind: 'swipe', duration: 0.4, settleT: 7 }), tap('c', 12)];

  it('is the identity on an unedited timeline', () => {
    const out = tapsToOutput(taps, new Timeline(20));
    expect(out.map((t) => t.t)).toEqual([2, 6, 12]);
    expect(out[1].duration).toBeCloseTo(0.4);
  });

  it('drops taps in cut footage and shifts the rest', () => {
    const tl = new Timeline(20, [clip(0, 4), clip(8, 20)]);
    const out = tapsToOutput(taps, tl);
    expect(out.map((t) => t.id)).toEqual(['a', 'c']);
    expect(out[1].t).toBeCloseTo(8); // 12 - 4 s cut
  });

  it('scales timing inside a sped-up clip', () => {
    const tl = new Timeline(20, [clip(0, 4), clip(4, 10, 2), clip(10, 20)]);
    const out = tapsToOutput(taps, tl);
    const swipe = out.find((t) => t.id === 'b')!;
    expect(swipe.t).toBeCloseTo(5); // 4 + (6-4)/2
    expect(swipe.duration).toBeCloseTo(0.2);
    expect(swipe.settleT).toBeCloseTo(5.5);
    expect(out.find((t) => t.id === 'c')!.t).toBeCloseTo(9); // 4 + 3 + 2
  });

  it('follows reordered clips and stays sorted', () => {
    const tl = new Timeline(20, [clip(10, 20), clip(0, 10)]);
    const out = tapsToOutput(taps, tl);
    expect(out.map((t) => t.id)).toEqual(['c', 'a', 'b']);
    expect(out.map((t) => t.t)).toEqual([2, 12, 16]);
  });

  it('maps a dragged marker back to source time, clamped to the timeline', () => {
    const tl = new Timeline(20, [clip(10, 20), clip(0, 10, 2)]);
    expect(tapSourceTime(3, tl)).toBeCloseTo(13);
    expect(tapSourceTime(12, tl)).toBeCloseTo(4);
    expect(tapSourceTime(-1, tl)).toBeCloseTo(10);
    expect(tapSourceTime(99, tl)).toBeCloseTo(10, 3);
    // Round trip: the tap lands where it was dropped.
    const src = tapSourceTime(11.5, tl);
    expect(tapsToOutput([tap('x', src)], tl)[0].t).toBeCloseTo(11.5);
  });
});

describe('speed up waits', () => {
  it('trims a margin off each wait, except at the recording edges', () => {
    expect(waitCore({ start: 4, end: 7 })).toEqual({ start: 4.25, end: 6.75 });
    expect(waitCore({ start: 0, end: 2, edge: 'start' })).toEqual({ start: 0, end: 1.75 });
    expect(waitCore({ start: 18, end: 20, edge: 'end' })).toEqual({ start: 18.25, end: 20 });
    expect(waitCore({ start: 4, end: 4.8 })).toBeNull();
  });

  it('splits clips at the wait edges and plays only the wait faster', () => {
    const out = speedUpRanges([clip(0, 20)], [{ start: 5, end: 8 }, { start: 12, end: 14 }], 3);
    expect(out.map((c) => [c.sourceStart, c.sourceEnd, c.speed])).toEqual([
      [0, 5, 1], [5, 8, 3], [8, 12, 1], [12, 14, 3], [14, 20, 1],
    ]);
    const tl = new Timeline(20, out);
    expect(tl.outputDuration).toBeCloseTo(20 - (3 + 2) * (2 / 3));
    // Footage outside the waits keeps its output time relative to its neighbours.
    expect(tl.outputTime(15)! - tl.outputTime(14)!).toBeCloseTo(1);
  });

  it('keeps clip order, faster clips and ranges spanning several clips', () => {
    const clips = [clip(10, 20, 4), clip(0, 10)];
    const out = speedUpRanges(clips, [{ start: 8, end: 12 }], 3);
    expect(out.map((c) => [c.sourceStart, c.sourceEnd, c.speed])).toEqual([
      [10, 12, 4], [12, 20, 4], [0, 8, 1], [8, 10, 3],
    ]);
  });

  it('leaves clips outside every range untouched', () => {
    const c = clip(0, 5);
    expect(speedUpRanges([c], [{ start: 6, end: 9 }], 3)[0]).toBe(c);
    expect(speedUpRanges([c], [{ start: 0, end: 5 }], 3)[0]).toMatchObject({ sourceStart: 0, sourceEnd: 5, speed: 3 });
  });

  it('stops listing a wait once it is sped up or cut', () => {
    const waits = [{ start: 4, end: 7 }, { start: 10, end: 13 }];
    const tl = new Timeline(20);
    expect(pendingWaits(waits, tl)).toHaveLength(2);
    const cores = waits.map((w) => waitCore(w)!);
    expect(pendingWaits(waits, new Timeline(20, speedUpRanges(tl.clips, cores, 3)))).toEqual([]);
    const cut = new Timeline(20, tl.clips.map((c) => ({ ...c })));
    cut.cutRanges([cores[0]]);
    expect(pendingWaits(waits, cut)).toEqual([waits[1]]);
  });

  it('draws waits where they play, one piece per clip', () => {
    const tl = new Timeline(20, [clip(0, 5), clip(5, 10, 2), clip(10, 20)]);
    expect(rangesToOutput([{ start: 4, end: 11 }], tl)).toEqual([
      { start: 4, end: 5, speed: 1 },
      { start: 5, end: 7.5, speed: 2 },
      { start: 7.5, end: 8.5, speed: 1 },
    ]);
  });
});
