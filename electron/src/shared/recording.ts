// Pure helpers for taking a recording: which source kind a capture id is,
// where the cursor sits relative to the recorded display, how to line the
// cursor track up with the video, and how to stop a MediaRecorder without
// waiting on an event that already fired. No Electron or DOM imports, so
// all of it is unit-tested in vitest.

import type { Project, SourceKind } from './types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** desktopCapturer ids look like "screen:1:0" or "window:1234:0". Anything
 *  else is a camera deviceId. */
export function sourceKindFor(id: string): SourceKind {
  return id.startsWith('window:') ? 'window' : 'display';
}

/**
 * How the cursor is tracked for a source. Displays track against that
 * display's bounds. Windows and cameras don't: we can't get a window's
 * bounds reliably, so a cursor drawn over window pixels would be in the
 * wrong place. Those takes get no cursor, clicks or auto-zoom.
 */
export function cursorModeFor(id: string): 'display' | 'none' {
  return id.startsWith('screen:') ? 'display' : 'none';
}

/** Pick the recorded display: by desktopCapturer display_id when it has one,
 *  else the display nearest the pointer (single-display fallback). */
export function pickDisplay<D extends { id: number }>(displays: D[], displayId: string | undefined, nearest: D): D {
  if (displayId) {
    const hit = displays.find((d) => String(d.id) === displayId);
    if (hit) return hit;
  }
  return nearest;
}

/** Normalize a screen point to `bounds`; null when it is off that display. */
export function normalizeToDisplay(p: { x: number; y: number }, bounds: Rect): { x: number; y: number } | null {
  const x = (p.x - bounds.x) / bounds.width;
  const y = (p.y - bounds.y) / bounds.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/**
 * Shift samples recorded against the tracker's clock onto the video's clock.
 * `offsetSec` is how long after the tracker started the video started;
 * anything from before the video started is dropped.
 */
export function alignToVideoStart<T extends { time: number }>(samples: T[], offsetSec: number): T[] {
  if (!Number.isFinite(offsetSec) || offsetSec === 0) return samples;
  return samples.map((s) => ({ ...s, time: s.time - offsetSec })).filter((s) => s.time >= 0);
}

const DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;
const VIDEO_SIZE_RE = /Stream #\d+:\d+.*Video:.*?\b(\d{2,5})x(\d{2,5})\b/;

/** Seconds from ffmpeg's "Duration: 00:01:02.35" banner; null when N/A. */
export function parseFfmpegDuration(stderr: string): number | null {
  const m = stderr.match(DURATION_RE);
  if (!m) return null;
  const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(s) && s > 0 ? s : null;
}

/** "Video: h264 ..., 1179x2556" from ffmpeg's banner. */
export function parseFfmpegVideoSize(stderr: string): { width: number; height: number } | null {
  const m = stderr.match(VIDEO_SIZE_RE);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * Replace a fresh project's duration with the file's real one. The single
 * default clip follows it; a project that has already been edited keeps its
 * clips.
 */
export function withProbedDuration(project: Project, duration: number | null): Project {
  if (duration === null || !(duration > 0)) return project;
  const old = project.recording.duration;
  const [first] = project.clips;
  const fresh = project.clips.length === 1 && first.sourceStart === 0 && first.sourceEnd === old;
  return {
    ...project,
    recording: { ...project.recording, duration },
    clips: fresh ? [{ ...first, sourceEnd: duration }] : project.clips,
  };
}

/** The last "time=00:00:54.46" progress stamp from an ffmpeg run; used
 *  for files whose header has no duration (MediaRecorder WebM). */
export function parseFfmpegProgressTime(stderr: string): number | null {
  const all = [...stderr.matchAll(/time=\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  const m = all[all.length - 1];
  if (!m) return null;
  const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(s) && s > 0 ? s : null;
}

/** Stored durations within this of the file's real one are left alone. */
export const DURATION_TOLERANCE = 0.1;

/**
 * Correct an opened project whose stored duration disagrees with its file
 * (older takes were timed by wall clock). Clips that ran to the old end
 * follow the new one; clips past the real end are clamped or dropped.
 * Returns the same object when nothing needs to change.
 */
export function correctDuration(project: Project, probed: number | null): Project {
  const old = project.recording.duration;
  if (probed === null || !(probed > 0) || Math.abs(probed - old) <= DURATION_TOLERANCE) return project;
  const eps = 1e-6;
  const clips = project.clips
    .filter((c) => c.sourceStart < probed - eps)
    .map((c) => ({ ...c, sourceEnd: Math.abs(c.sourceEnd - old) < eps ? probed : Math.min(c.sourceEnd, probed) }));
  return {
    ...project,
    recording: { ...project.recording, duration: probed },
    clips: clips.length ? clips : [{ id: project.clips[0]?.id ?? 'clip-1', sourceStart: 0, sourceEnd: probed, speed: 1 }],
  };
}

/** The bit of MediaRecorder the stop logic needs. */
export interface StoppableRecorder {
  state: 'inactive' | 'recording' | 'paused';
  onstop: ((ev: Event) => void) | null;
  stop(): void;
}

/**
 * Attach to a recorder when it starts, so a recorder that stops by itself
 * (its only track ended because the window closed or the display went
 * away) is still noticed. `stop()` is safe to call any number of times, and
 * never waits on an `onstop` that already fired or will never fire.
 */
export function createStopLatch(rec: StoppableRecorder, onStoppedByItself?: () => void) {
  let resolve!: () => void;
  let stopped = false;
  let requested = false;
  const done = new Promise<void>((r) => (resolve = r));
  rec.onstop = () => {
    stopped = true;
    resolve();
    if (!requested) onStoppedByItself?.();
  };
  return {
    get stopped() {
      return stopped;
    },
    stop(): Promise<void> {
      requested = true;
      if (!stopped && rec.state !== 'inactive') {
        rec.stop();
      } else if (!stopped) {
        // Inactive but onstop never ran (never started, or it fired before
        // we attached): nothing more will come, so don't wait.
        stopped = true;
        resolve();
      }
      return done;
    },
  };
}

export type EndReason = 'sourceEnded' | 'deviceEnded';

/** What to tell the user after a take ended without them pressing Stop. */
export function endNotice(reason: EndReason, detail?: string): string {
  if (reason === 'deviceEnded') {
    return `The iPhone stopped sending video${detail ? ` (${detail})` : ''}, so recording stopped.`;
  }
  return 'The recorded window or display went away, so recording stopped. What was recorded has been saved.';
}

/** Turn a getUserMedia/capture failure into a sentence. */
export function captureErrorMessage(e: unknown, sourceName?: string): string {
  const name = (e as { name?: string })?.name;
  const what = sourceName ? `"${sourceName}"` : 'that source';
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'NotFoundError' || name === 'OverconstrainedError') {
    return `Couldn't capture ${what}. It may have closed. Refresh the list and pick it again.`;
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'macOS blocked the capture. Allow OpenScreen under Screen Recording in System Settings, then Quit & Reopen.';
  }
  const msg = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  return `Couldn't start recording: ${msg}`;
}

/** Cameras keep an entry even before permission gives them a label. */
export function cameraLabel(d: { label: string }, index: number): string {
  return d.label || `Camera ${index + 1}`;
}

/** Whisper model download goes to `<model>.part` and is renamed on success,
 *  so an interrupted download never looks like a finished model. */
export const partialPath = (path: string) => `${path}.part`;

/** Where whisper-cli might live, in lookup order (a Finder-launched app's
 *  PATH misses the Homebrew prefixes). */
export const WHISPER_CANDIDATES = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'];

export function findWhisperCli(exists: (p: string) => boolean, pathDirs: string[]): string | null {
  for (const p of [...WHISPER_CANDIDATES, ...pathDirs.filter(Boolean).map((d) => `${d.replace(/\/$/, '')}/whisper-cli`)]) {
    if (exists(p)) return p;
  }
  return null;
}
