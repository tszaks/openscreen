import { describe, expect, it } from 'vitest';
import { gestureTelemetryPath, tapsFromGestureTelemetry } from '../src/shared/gestureTelemetry';

const ref = { referenceWidth: 400, referenceHeight: 800 };
let n = 0;
const ids = () => `t${n++}`;

describe('gesture telemetry', () => {
  it('sits next to the video, as agent-device names it', () => {
    expect(gestureTelemetryPath('/Movies/job/capture.mp4')).toBe('/Movies/job/capture.gesture-telemetry.json');
    expect(gestureTelemetryPath('/a.b/clip.final.mov')).toBe('/a.b/clip.final.gesture-telemetry.json');
    expect(gestureTelemetryPath('/a.b/noext')).toBe('/a.b/noext.gesture-telemetry.json');
  });

  it('turns points and milliseconds into normalized taps in seconds, in time order', () => {
    const taps = tapsFromGestureTelemetry(
      { version: 1, events: [
        { kind: 'tap', tMs: 3000, x: 200, y: 400, ...ref },
        { kind: 'longpress', tMs: 1000, x: 0, y: 800, durationMs: 800, ...ref },
      ] },
      10,
      ids,
    );
    expect(taps).toEqual([
      { id: expect.any(String), t: 1, x: 0, y: 1, kind: 'longpress', duration: 0.8, confidence: 1 },
      { id: expect.any(String), t: 3, x: 0.5, y: 0.5, kind: 'tap', confidence: 1 },
    ]);
  });

  it('keeps swipes and scrolls as swipes with an end point', () => {
    const [s] = tapsFromGestureTelemetry({ version: 1, events: [{ kind: 'scroll', tMs: 500, x: 200, y: 600, x2: 200, y2: 200, durationMs: 250, ...ref }] }, 10, ids)!;
    expect(s).toMatchObject({ kind: 'swipe', t: 0.5, x: 0.5, y: 0.75, endX: 0.5, endY: 0.25, duration: 0.25 });
  });

  it('drops what it cannot show or place: pinches, bad numbers, times outside the video', () => {
    const taps = tapsFromGestureTelemetry(
      { version: 1, events: [
        { kind: 'pinch', tMs: 100, x: 1, y: 1, scale: 2, ...ref },
        { kind: 'tap', tMs: 100, x: 1, y: 1, referenceWidth: 0, referenceHeight: 800 },
        { kind: 'tap', tMs: 'soon', x: 1, y: 1, ...ref },
        { kind: 'tap', tMs: 20000, x: 1, y: 1, ...ref },
        { kind: 'swipe', tMs: 100, x: 1, y: 1, ...ref },
      ] },
      10,
      ids,
    );
    expect(taps).toEqual([]);
  });

  it('refuses files that are not version-1 telemetry', () => {
    expect(tapsFromGestureTelemetry(null, 10)).toBeNull();
    expect(tapsFromGestureTelemetry({ version: 2, events: [] }, 10)).toBeNull();
    expect(tapsFromGestureTelemetry({ version: 1 }, 10)).toBeNull();
  });
});
