// Recorded touches from an agent-device capture.
//
// When agent-device records a video (`record start … capture.mp4`), it writes
// the gestures it performed next to it as `capture.gesture-telemetry.json`:
//
//   { "version": 1, "events": [
//       { "kind": "tap", "tMs": 2417.9, "x": 364, "y": 96,
//         "referenceWidth": 402, "referenceHeight": 874 }, … ] }
//
// `tMs` is milliseconds since the recording started and x/y are points in a
// `referenceWidth` × `referenceHeight` screen. These are the real touches, so
// an import uses them instead of guessing taps from the pixels.

import type { TapSuggestion } from './taps';

/** `/dir/capture.mp4` → `/dir/capture.gesture-telemetry.json` (agent-device's naming). */
export function gestureTelemetryPath(videoPath: string): string {
  const slash = Math.max(videoPath.lastIndexOf('/'), videoPath.lastIndexOf('\\'));
  const dot = videoPath.lastIndexOf('.');
  const stem = dot > slash ? videoPath.slice(0, dot) : videoPath;
  return `${stem}.gesture-telemetry.json`;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The taps track for a recording `duration` seconds long, from a parsed
 * telemetry file. Gestures OpenScreen has no indicator for (pinch, rotate)
 * and events outside the video are left out. Null when the file isn't
 * telemetry OpenScreen understands.
 */
export function tapsFromGestureTelemetry(raw: unknown, duration: number, newId: () => string = () => crypto.randomUUID()): TapSuggestion[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const { version, events } = raw as { version?: unknown; events?: unknown };
  if (version !== 1 || !Array.isArray(events)) return null;
  const taps: TapSuggestion[] = [];
  for (const e of events as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object') continue;
    const { kind, tMs, x, y, referenceWidth: w, referenceHeight: h } = e;
    if (!finite(tMs) || !finite(x) || !finite(y) || !finite(w) || !finite(h) || w <= 0 || h <= 0) continue;
    const t = tMs / 1000;
    if (t < 0 || t > duration) continue;
    const base = { id: newId(), t, x: clamp01(x / w), y: clamp01(y / h), confidence: 1 };
    const ms = finite(e.durationMs) && e.durationMs > 0 ? e.durationMs / 1000 : undefined;
    if (kind === 'tap') taps.push({ ...base, kind: 'tap' });
    else if (kind === 'longpress') taps.push({ ...base, kind: 'longpress', ...(ms ? { duration: ms } : {}) });
    else if ((kind === 'swipe' || kind === 'back-swipe' || kind === 'scroll' || kind === 'drag') && finite(e.x2) && finite(e.y2)) {
      taps.push({ ...base, kind: 'swipe', endX: clamp01(e.x2 / w), endY: clamp01(e.y2 / h), ...(ms ? { duration: ms } : {}) });
    }
  }
  return taps.sort((a, b) => a.t - b.t);
}
