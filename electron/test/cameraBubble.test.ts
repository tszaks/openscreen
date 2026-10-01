import { describe, expect, it } from 'vitest';
import {
  BUBBLE_DIAMETER,
  BUBBLE_INSET,
  BUBBLE_PAD,
  CAMERA_LOST_NOTICE,
  bubbleInWindow,
  bubbleOpensFor,
  cornerForBubble,
  defaultBubbleWindow,
  nextBubble,
  overlayFromBubble,
  readShowBubble,
  resizeBubbleWindow,
  sizeFractionForBubble,
  windowForBubble,
  writeShowBubble,
  type BubbleState,
  type Rect,
} from '../src/shared/cameraBubble';
import { defaultCameraOverlay } from '../src/shared/types';

const laptop: Rect = { x: 0, y: 0, width: 1440, height: 900 };
// A second display to the left of and above the main one (negative origin).
const leftMonitor: Rect = { x: -2560, y: -300, width: 2560, height: 1440 };
// A portrait display to the right.
const portrait: Rect = { x: 1440, y: 0, width: 1080, height: 1920 };

/** A circle of diameter d centred at (cx, cy). */
const circleAt = (cx: number, cy: number, d: number): Rect => ({ x: cx - d / 2, y: cy - d / 2, width: d, height: d });

describe('bubble window frame', () => {
  it('is the circle plus the pad on every side, and back', () => {
    const c = circleAt(500, 400, 180);
    const w = windowForBubble(c);
    expect(w).toEqual({ x: c.x - BUBBLE_PAD, y: c.y - BUBBLE_PAD, width: 180 + 2 * BUBBLE_PAD, height: 180 + 2 * BUBBLE_PAD });
    expect(bubbleInWindow(w)).toEqual(c);
  });

  it('opens at the bottom-right of the work area, inset 32', () => {
    for (const area of [laptop, leftMonitor, portrait, { x: 0, y: 25, width: 1440, height: 800 }]) {
      const c = bubbleInWindow(defaultBubbleWindow(area));
      expect(c.width).toBe(BUBBLE_DIAMETER.m);
      expect(area.x + area.width - (c.x + c.width)).toBe(BUBBLE_INSET);
      expect(area.y + area.height - (c.y + c.height)).toBe(BUBBLE_INSET);
      expect(cornerForBubble(c, area)).toBe('bottomRight');
    }
  });

  it('honours the size it opens at', () => {
    expect(bubbleInWindow(defaultBubbleWindow(laptop, 's')).width).toBe(BUBBLE_DIAMETER.s);
    expect(bubbleInWindow(defaultBubbleWindow(laptop, 'l')).width).toBe(BUBBLE_DIAMETER.l);
  });

  it('keeps its centre when resized', () => {
    const w = windowForBubble(circleAt(700, 450, BUBBLE_DIAMETER.m));
    const c = bubbleInWindow(resizeBubbleWindow(w, 'l', laptop));
    expect(c.width).toBe(BUBBLE_DIAMETER.l);
    expect(c.x + c.width / 2).toBe(700);
    expect(c.y + c.height / 2).toBe(450);
  });

  it('stays on screen when growing in a corner', () => {
    const corner = bubbleInWindow(defaultBubbleWindow(laptop, 's'));
    const grown = bubbleInWindow(resizeBubbleWindow(windowForBubble(corner), 'l', laptop));
    expect(grown.x + grown.width).toBeLessThanOrEqual(laptop.width);
    expect(grown.y + grown.height).toBeLessThanOrEqual(laptop.height);
    // And on a display with a negative origin.
    const topLeft = windowForBubble({ x: leftMonitor.x + 4, y: leftMonitor.y + 4, width: 120, height: 120 });
    const g2 = bubbleInWindow(resizeBubbleWindow(topLeft, 'l', leftMonitor));
    expect(g2.x).toBeGreaterThanOrEqual(leftMonitor.x);
    expect(g2.y).toBeGreaterThanOrEqual(leftMonitor.y);
  });
});

describe('position → overlay corner', () => {
  const cases: [string, Rect, number, number, string][] = [
    ['laptop top-left', laptop, 150, 120, 'topLeft'],
    ['laptop top-right', laptop, 1300, 120, 'topRight'],
    ['laptop bottom-left', laptop, 150, 800, 'bottomLeft'],
    ['laptop bottom-right', laptop, 1300, 800, 'bottomRight'],
    ['laptop just right of centre, just above', laptop, 721, 449, 'topRight'],
    ['left monitor top-left', leftMonitor, -2400, -200, 'topLeft'],
    ['left monitor bottom-right', leftMonitor, -100, 1000, 'bottomRight'],
    ['left monitor top-right (x near 0)', leftMonitor, -50, 0, 'topRight'],
    ['portrait bottom-left', portrait, 1600, 1700, 'bottomLeft'],
    ['portrait top-right', portrait, 2400, 300, 'topRight'],
  ];
  for (const [name, display, cx, cy, corner] of cases) {
    it(name, () => expect(cornerForBubble(circleAt(cx, cy, 180), display)).toBe(corner));
  }

  it('uses the circle, not its window frame', () => {
    // The circle's centre is right of the middle; the window's left edge is not.
    const c = circleAt(730, 300, 120);
    expect(overlayFromBubble(defaultCameraOverlay(), { window: windowForBubble(c), display: laptop }, 'display').corner).toBe('topRight');
  });
});

describe('bubble size → overlay sizeFraction', () => {
  it('is the same share of the shorter side', () => {
    expect(sizeFractionForBubble(circleAt(0, 0, 180), laptop)).toBe(0.2);
    expect(sizeFractionForBubble(circleAt(0, 0, 180), portrait)).toBeCloseTo(180 / 1080, 3);
    expect(sizeFractionForBubble(circleAt(0, 0, 260), leftMonitor)).toBeCloseTo(260 / 1440, 3);
  });

  it('is clamped to sizes that still read as a face in the corner', () => {
    expect(sizeFractionForBubble(circleAt(0, 0, 120), { x: 0, y: 0, width: 5120, height: 2880 })).toBe(0.1);
    expect(sizeFractionForBubble(circleAt(0, 0, 260), { x: 0, y: 0, width: 600, height: 500 })).toBe(0.4);
  });

  it('falls back to the default on a display with no size', () => {
    expect(sizeFractionForBubble(circleAt(0, 0, 180), { x: 0, y: 0, width: 0, height: 0 })).toBe(defaultCameraOverlay().sizeFraction);
  });
});

describe('overlayFromBubble', () => {
  const placed = { window: windowForBubble(circleAt(150, 120, 260)), display: laptop };

  it('carries the corner and size into a display take', () => {
    const o = overlayFromBubble(defaultCameraOverlay(), placed, 'display');
    expect(o.corner).toBe('topLeft');
    expect(o.sizeFraction).toBeCloseTo(260 / 900, 3);
    // Everything else is left as it was.
    expect(o.circular).toBe(true);
    expect(o.enabled).toBe(false);
  });

  it('keeps the default for a window take (its bounds are unknown)', () => {
    expect(overlayFromBubble(defaultCameraOverlay(), placed, 'window')).toEqual(defaultCameraOverlay());
  });

  it('keeps the default when the bubble never showed', () => {
    expect(overlayFromBubble(defaultCameraOverlay(), null, 'display')).toEqual(defaultCameraOverlay());
  });
});

describe('bubble lifecycle', () => {
  const display = { source: 'display' as const, cameraOpen: true, showWhileRecording: true };
  const open: BubbleState = { status: 'open', size: 'm' };

  it('opens on start for a display or window take with the camera', () => {
    expect(nextBubble({ status: 'closed' }, { type: 'start', take: display }).state).toEqual(open);
    expect(nextBubble({ status: 'closed' }, { type: 'start', take: { ...display, source: 'window' } }).state).toEqual(open);
  });

  it('never opens with the camera off, the setting off, or for an iPhone or camera take', () => {
    for (const take of [
      { ...display, cameraOpen: false },
      { ...display, showWhileRecording: false },
      { ...display, source: 'iphone' as const },
      { ...display, source: 'camera' as const },
      { ...display, source: 'iosDevice' as const },
    ]) {
      expect(bubbleOpensFor(take)).toBe(false);
      expect(nextBubble({ status: 'closed' }, { type: 'start', take }).state).toEqual({ status: 'closed' });
    }
  });

  it('closes on stop, cancel and error, from any state', () => {
    for (const from of [open, { status: 'hidden' } as const, { status: 'lost' } as const, { status: 'closed' } as const]) {
      for (const type of ['stop', 'cancel', 'error'] as const) {
        expect(nextBubble(from, { type }).state).toEqual({ status: 'closed' });
      }
    }
  });

  it('hides for the rest of the take, and resizing then does nothing', () => {
    const hidden = nextBubble(open, { type: 'hide' }).state;
    expect(hidden).toEqual({ status: 'hidden' });
    expect(nextBubble(hidden, { type: 'resize', size: 'l' }).state).toEqual(hidden);
  });

  it('resizes while open', () => {
    expect(nextBubble(open, { type: 'resize', size: 's' }).state).toEqual({ status: 'open', size: 's' });
  });

  it('closes with a notice when the camera goes away, only if it was showing', () => {
    const lost = nextBubble(open, { type: 'cameraLost' });
    expect(lost.state).toEqual({ status: 'lost' });
    expect(lost.notice).toBe(CAMERA_LOST_NOTICE);
    expect(lost.notice).toMatch(/still recording/);
    expect(nextBubble({ status: 'hidden' }, { type: 'cameraLost' }).notice).toBeUndefined();
    expect(nextBubble({ status: 'closed' }, { type: 'cameraLost' }).notice).toBeUndefined();
  });
});

describe('"Show me while recording" setting', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('is on by default', () => {
    expect(readShowBubble(memory())).toBe(true);
  });

  it('remembers off and on', () => {
    const store = memory();
    writeShowBubble(store, false);
    expect(readShowBubble(store)).toBe(false);
    writeShowBubble(store, true);
    expect(readShowBubble(store)).toBe(true);
  });

  it('is on when storage is unavailable', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => writeShowBubble(broken, false)).not.toThrow();
    expect(readShowBubble(broken)).toBe(true);
  });
});
