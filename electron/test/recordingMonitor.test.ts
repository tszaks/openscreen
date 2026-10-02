import { describe, expect, it } from 'vitest';
import {
  CAMERA_LOST_NOTICE,
  DEFAULT_MONITOR,
  FACE_PX,
  MONITOR_INSET,
  MONITOR_PAD,
  SOURCE_MAX_W,
  TILE_GAP,
  clampInto,
  monitorLayout,
  monitorOpensFor,
  nextMonitor,
  overlayFromMonitor,
  placeMonitor,
  readMonitorPrefs,
  resizeMonitor,
  spotFor,
  writeMonitorPrefs,
  type MonitorState,
  type Rect,
} from '../src/shared/recordingMonitor';
import { OVERLAY_SIZES, macContentRect } from '../src/shared/cameraOverlay';
import { projectCanvasSize } from '../src/shared/mobileProject';
import { defaultCameraOverlay, defaultProject, type Project, type Size } from '../src/shared/types';

const laptop: Rect = { x: 0, y: 0, width: 1512, height: 982 };
const laptopWork: Rect = { x: 0, y: 33, width: 1512, height: 870 };
const leftMonitor: Rect = { x: -2560, y: -300, width: 2560, height: 1440 };
const MAC = 2880 / 1800;
const PHONE = 1179 / 2556;

describe('monitor layout', () => {
  it('defaults: Large, round, face on the right, screen tile on', () => {
    expect(DEFAULT_MONITOR).toEqual({ show: true, size: 'large', shape: 'round', faceSide: 'right', sourceTile: true });
  });

  it('Large with a Mac screen: screen left, a 220 pt face right, about 480 pt of tiles', () => {
    const l = monitorLayout({ size: 'large', faceSide: 'right', sourceAspect: MAC });
    expect(l.face.width).toBe(220);
    expect(l.face.height).toBe(220);
    expect(l.face.height).toBeGreaterThanOrEqual(220);
    expect(l.source).not.toBeNull();
    const s = l.source!;
    // The screen is fitted into the widest tile, centred beside the face.
    expect(s.width).toBe(SOURCE_MAX_W.large);
    expect(s.width / s.height).toBeCloseTo(MAC, 1);
    expect(Math.abs(s.y + s.height / 2 - (l.face.y + l.face.height / 2))).toBeLessThanOrEqual(1);
    expect(s.x).toBe(MONITOR_PAD);
    expect(l.face.x).toBe(MONITOR_PAD + s.width + TILE_GAP);
    const tiles = l.width - MONITOR_PAD * 2;
    expect(tiles).toBeGreaterThanOrEqual(460);
    expect(tiles).toBeLessThanOrEqual(500);
    expect(l.height).toBe(220 + MONITOR_PAD * 2);
  });

  it('an iPhone tile is the face height and the phone shape', () => {
    const l = monitorLayout({ size: 'large', faceSide: 'right', sourceAspect: PHONE });
    expect(l.source!.height).toBe(220);
    expect(l.source!.width).toBe(Math.round(220 * PHONE));
    expect(l.source!.x).toBe(MONITOR_PAD);
  });

  it('swaps sides', () => {
    const l = monitorLayout({ size: 'large', faceSide: 'left', sourceAspect: MAC });
    expect(l.face.x).toBe(MONITOR_PAD);
    expect(l.source!.x).toBe(MONITOR_PAD + 220 + TILE_GAP);
  });

  it('Small is smaller all round', () => {
    const l = monitorLayout({ size: 'small', faceSide: 'right', sourceAspect: MAC });
    expect(l.face.width).toBe(FACE_PX.small);
    expect(l.source!.width).toBe(SOURCE_MAX_W.small);
    expect(l.width).toBeLessThan(monitorLayout({ size: 'large', faceSide: 'right', sourceAspect: MAC }).width);
  });

  it('with the source tile off it is just the face', () => {
    for (const faceSide of ['left', 'right'] as const) {
      const l = monitorLayout({ size: 'large', faceSide, sourceAspect: null });
      expect(l.source).toBeNull();
      expect(l.face).toEqual({ x: MONITOR_PAD, y: MONITOR_PAD, width: 220, height: 220 });
      expect(l.width).toBe(220 + MONITOR_PAD * 2);
    }
  });

  it('ignores a nonsense aspect', () => {
    expect(monitorLayout({ size: 'large', faceSide: 'right', sourceAspect: NaN }).source).toBeNull();
    expect(monitorLayout({ size: 'large', faceSide: 'right', sourceAspect: 0 }).source).toBeNull();
  });
});

describe('monitor placement', () => {
  const size = { width: 520, height: 256 };

  it('opens with its tiles 32 pt from the work area bottom-right', () => {
    for (const area of [laptopWork, leftMonitor]) {
      const w = placeMonitor(area, size);
      expect(area.x + area.width - (w.x + w.width - MONITOR_PAD)).toBe(MONITOR_INSET);
      expect(area.y + area.height - (w.y + w.height - MONITOR_PAD)).toBe(MONITOR_INSET);
    }
  });

  it('reopens where it was left, on any display', () => {
    const w = placeMonitor(laptopWork, size, { u: 0.25, v: 0.3 });
    expect(spotFor(w, laptopWork).u).toBeCloseTo(0.25, 2);
    expect(spotFor(w, laptopWork).v).toBeCloseTo(0.3, 2);
    const w2 = placeMonitor(leftMonitor, size, { u: 0.25, v: 0.3 });
    expect(w2.x + w2.width / 2).toBeCloseTo(leftMonitor.x + 0.25 * leftMonitor.width, 0);
  });

  it('is pulled back on screen from a spot at the edge', () => {
    const w = placeMonitor(laptopWork, size, { u: 1, v: 0 });
    expect(w.x + w.width).toBe(laptopWork.x + laptopWork.width);
    expect(w.y).toBe(laptopWork.y);
  });

  it('keeps its centre when its layout changes size', () => {
    const w = { x: 400, y: 300, width: 520, height: 256 };
    const r = resizeMonitor(w, { width: 300, height: 176 }, laptopWork);
    expect(r.x + r.width / 2).toBe(660);
    expect(r.y + r.height / 2).toBe(428);
    expect(clampInto({ x: -50, y: 2000, width: 100, height: 100 }, laptopWork)).toEqual({ x: 0, y: 803, width: 100, height: 100 });
  });
});

describe('monitor → the project camera bubble', () => {
  const display = (source: Size, preset?: string): Project => {
    const p = defaultProject({ screenVideoFile: 'screen.webm', sourceKind: 'display', sourceSize: source, duration: 10 });
    if (preset) p.layout = { ...p.layout, presetId: preset as Project['layout']['presetId'] };
    return p;
  };
  const layout = monitorLayout({ size: 'large', faceSide: 'right', sourceAspect: MAC });
  // A window placed so the face's centre is at (378, 245) on the laptop display: u = 0.25, v ≈ 0.2495.
  const window: Rect = { x: 378 - (layout.face.x + 110), y: 245 - (layout.face.y + 110), width: layout.width, height: layout.height };
  const placement = { window, display: laptop, workArea: laptopWork };

  for (const preset of [undefined, 'landscape-16x9', 'social-9x16', 'square']) {
    it(`a display take puts the bubble over the same spot (${preset ?? 'classic'})`, () => {
      const p = display({ width: 3024, height: 1964 }, preset);
      const o = overlayFromMonitor(defaultCameraOverlay(), { placement, layout, size: 'large', shape: 'square' }, p, 'display');
      const canvas = projectCanvasSize(p);
      const content = macContentRect(p, canvas);
      expect(o.position!.x * canvas.width).toBeCloseTo(content.x + 0.25 * content.w, 4);
      expect(o.position!.y * canvas.height).toBeCloseTo(content.y + (245 / 982) * content.h, 4);
      expect(o.sizeFraction).toBe(OVERLAY_SIZES.large);
      expect(o.circular).toBe(false);
    });
  }

  it('a window or iPhone take keeps the default spot but carries size and shape', () => {
    for (const kind of ['window', 'iosDevice'] as const) {
      const o = overlayFromMonitor(defaultCameraOverlay(), { placement, layout, size: 'small', shape: 'round' }, display({ width: 1920, height: 1080 }), kind);
      expect(o.position).toBeUndefined();
      expect(o.corner).toBe('bottomRight');
      expect(o.sizeFraction).toBe(OVERLAY_SIZES.small);
      expect(o.circular).toBe(true);
    }
  });

  it('no placement (hidden before it showed) keeps the default spot', () => {
    const o = overlayFromMonitor(defaultCameraOverlay(), { placement: null, layout, size: 'large', shape: 'round' }, display({ width: 1920, height: 1080 }), 'display');
    expect(o.position).toBeUndefined();
    expect(o.sizeFraction).toBe(OVERLAY_SIZES.large);
  });
});

describe('monitor lifecycle', () => {
  const take = { source: 'display' as const, cameraOpen: true, show: true };
  const open: MonitorState = { status: 'open' };

  it('opens for display, window and iPhone takes with the camera', () => {
    for (const source of ['display', 'window', 'iosDevice'] as const) {
      expect(nextMonitor({ status: 'closed' }, { type: 'start', take: { ...take, source } }).state).toEqual(open);
    }
  });

  it('never opens with the camera off, the setting off, or for "Just me"', () => {
    for (const t of [{ ...take, cameraOpen: false }, { ...take, show: false }, { ...take, source: 'camera' as const }]) {
      expect(monitorOpensFor(t)).toBe(false);
      expect(nextMonitor({ status: 'closed' }, { type: 'start', take: t }).state).toEqual({ status: 'closed' });
    }
  });

  it('closes on stop, cancel and error from any state', () => {
    for (const from of [open, { status: 'hidden' } as const, { status: 'lost' } as const]) {
      for (const type of ['stop', 'cancel', 'error'] as const) expect(nextMonitor(from, { type }).state).toEqual({ status: 'closed' });
    }
  });

  it('hides for the rest of the take; a lost camera closes it with a notice', () => {
    expect(nextMonitor(open, { type: 'hide' }).state).toEqual({ status: 'hidden' });
    const lost = nextMonitor(open, { type: 'cameraLost' });
    expect(lost.state).toEqual({ status: 'lost' });
    expect(lost.notice).toBe(CAMERA_LOST_NOTICE);
    expect(nextMonitor({ status: 'hidden' }, { type: 'cameraLost' }).notice).toBeUndefined();
  });
});

describe('monitor preferences', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('start at the defaults', () => {
    expect(readMonitorPrefs(memory())).toEqual(DEFAULT_MONITOR);
  });

  it('remember every choice, including where it was left', () => {
    const store = memory();
    const prefs = { show: false, size: 'small' as const, shape: 'square' as const, faceSide: 'left' as const, sourceTile: false, spot: { u: 0.2, v: 0.7 } };
    writeMonitorPrefs(store, prefs);
    expect(readMonitorPrefs(store)).toEqual(prefs);
  });

  it('fall back field by field on garbage, and when storage throws', () => {
    const store = memory();
    store.setItem('openscreen.recordingMonitor', JSON.stringify({ size: 'huge', shape: 'square', spot: { u: 3, v: 0 } }));
    expect(readMonitorPrefs(store)).toEqual({ ...DEFAULT_MONITOR, shape: 'square' });
    store.setItem('openscreen.recordingMonitor', '{not json');
    expect(readMonitorPrefs(store)).toEqual(DEFAULT_MONITOR);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readMonitorPrefs(broken)).toEqual(DEFAULT_MONITOR);
    expect(() => writeMonitorPrefs(broken, DEFAULT_MONITOR)).not.toThrow();
  });
});
