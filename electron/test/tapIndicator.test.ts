import { describe, expect, it } from 'vitest';
import type { TapSuggestion } from '../src/shared/taps';
import {
  PRESS_IN,
  RELEASE,
  TAP_HOLD,
  activeIndicators,
  drawTouchIndicator,
  drawTouchIndicators,
  indicatorWindow,
  swipePoint,
  touchPhase,
} from '../src/renderer/src/mobile/tapIndicator';
import { mockCanvas } from './helpers/mockCanvas';

const tap: TapSuggestion = { id: 't', t: 2, x: 0.5, y: 0.5, kind: 'tap', confidence: 0.9 };
const swipe: TapSuggestion = {
  id: 's', t: 5, x: 0.5, y: 0.8, endX: 0.5, endY: 0.3, kind: 'swipe', duration: 0.3, confidence: 0.8,
};
const typing: TapSuggestion = { id: 'k', t: 7, x: 0.5, y: 0.8, kind: 'typing', duration: 2, confidence: 0.8 };
const screen = { x: 100, y: 50, w: 402, h: 874 };

describe('touch timing', () => {
  it('lasts about 0.55 s for a tap', () => {
    const [a, b] = indicatorWindow(tap);
    expect(a).toBe(2);
    expect(b - a).toBeCloseTo(PRESS_IN + TAP_HOLD + RELEASE, 6);
    expect(b - a).toBeGreaterThan(0.5);
    expect(b - a).toBeLessThan(0.6);
  });

  it('presses in from 0.8 to 1.0 over 80 ms, then rings out from 1.0 to 1.6x', () => {
    expect(touchPhase(tap, 0).scale).toBeCloseTo(0.8, 6);
    expect(touchPhase(tap, PRESS_IN - 1e-6).scale).toBeCloseTo(1, 3);
    const held = touchPhase(tap, PRESS_IN + TAP_HOLD / 2);
    expect(held.down).toBe(true);
    expect(held.scale).toBe(1);
    const rel = touchPhase(tap, PRESS_IN + TAP_HOLD + 1e-4);
    expect(rel.down).toBe(false);
    expect(rel.ringScale).toBeCloseTo(1, 2);
    const late = touchPhase(tap, PRESS_IN + TAP_HOLD + RELEASE - 1e-4);
    expect(late.ringScale).toBeCloseTo(1.6, 2);
    expect(late.ring).toBeLessThan(0.01);
    expect(touchPhase(tap, 1).visible).toBe(false);
    expect(touchPhase(tap, -0.01).visible).toBe(false);
  });

  it('holds a long press for its duration and swells slightly', () => {
    const lp: TapSuggestion = { ...tap, kind: 'longpress', duration: 0.7 };
    const [a, b] = indicatorWindow(lp);
    expect(b - a).toBeCloseTo(PRESS_IN + 0.7 + RELEASE, 6);
    expect(touchPhase(lp, 0.7).down).toBe(true);
    expect(touchPhase(lp, 0.7).scale).toBeGreaterThan(1.05);
  });

  it('moves the swipe dot from start to end', () => {
    expect(swipePoint(swipe, 0)).toEqual({ x: 0.5, y: 0.8 });
    const end = swipePoint(swipe, 10);
    expect(end.y).toBeCloseTo(0.3, 6);
    const mid = swipePoint(swipe, PRESS_IN * 0.5 + 0.15);
    expect(mid.y).toBeCloseTo(0.55, 2);
  });

  it('filters active indicators and never draws typing markers', () => {
    const all = [tap, swipe, typing];
    expect(activeIndicators(all, 2.1).map((s) => s.id)).toEqual(['t']);
    expect(activeIndicators(all, 5.2).map((s) => s.id)).toEqual(['s']);
    expect(activeIndicators(all, 7.5)).toEqual([]);
    expect(activeIndicators(all, 3)).toEqual([]);
  });
});

describe('drawTouchIndicator', () => {
  it('draws a finger-sized disc at the tap point, in device points', () => {
    const m = mockCanvas();
    drawTouchIndicator(m.ctx, tap, 2.15, screen, 1);
    const arcs = m.calls.filter((c) => c.name === 'arc');
    expect(arcs.length).toBeGreaterThan(0);
    const [x, y, r] = arcs[0].args as number[];
    expect(x).toBeCloseTo(100 + 0.5 * 402);
    expect(y).toBeCloseTo(50 + 0.5 * 874);
    expect(r).toBeCloseTo(26); // 52 pt diameter at 1 px/pt
    expect(m.depth()).toBe(0);
    // Scale doubles the size.
    const m2 = mockCanvas();
    drawTouchIndicator(m2.ctx, tap, 2.15, screen, 2);
    expect((m2.calls.find((c) => c.name === 'arc')!.args as number[])[2]).toBeCloseTo(52);
  });

  it('draws every style, swipes and nothing outside the window', () => {
    for (const style of ['ripple', 'pulse', 'ring'] as const) {
      for (const t of [2.02, 2.1, 2.3, 2.45]) {
        const m = mockCanvas();
        drawTouchIndicator(m.ctx, tap, t, screen, 1.5, { style, color: '#FF8A3D' });
        expect(m.depth()).toBe(0);
        expect(m.count('arc')).toBeGreaterThan(0);
      }
    }
    const sw = mockCanvas();
    drawTouchIndicator(sw.ctx, swipe, 5.25, screen, 1);
    expect(sw.count('fill')).toBeGreaterThanOrEqual(2); // trail + dot
    const none = mockCanvas();
    drawTouchIndicators(none.ctx, [tap, swipe, typing], 4, screen, 1);
    expect(none.calls.length).toBe(0);
  });
});
