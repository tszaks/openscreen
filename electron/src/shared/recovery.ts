// Recovering iPhone takes the app never got to save. The helper writes
// screen.mov straight into the take's bundle and the renderer adds
// project.json when the take is stopped, so a bundle with the first and not
// the second is a take cut off by a crash or a quit. Its movie is
// fragmented, so it usually still plays up to its last fragment.

import { defaultProject, type Project } from './types';

export const RECOVERABLE_VIDEO = 'screen.mov';

/**
 * A screen.mov written to this recently may still be recording (in another
 * copy of the app; this one skips its own take), so it is left alone. The
 * helper flushes a fragment every 2s, so a live take is never this quiet.
 */
export const RECOVERY_QUIET_MS = 10_000;

export interface BundleListing {
  dir: string;
  files: string[];
  /** screen.mov's modification time, when it exists. */
  videoMtimeMs?: number;
}

/**
 * The bundles holding an interrupted take, oldest first. `skip` is the
 * take in flight right now, if any.
 */
export function interruptedBundles(listings: BundleListing[], skip: string | null, nowMs: number): string[] {
  return listings
    .filter(
      (b) =>
        b.dir !== skip &&
        b.dir.endsWith('.openscreen') &&
        b.files.includes(RECOVERABLE_VIDEO) &&
        !b.files.includes('project.json') &&
        b.videoMtimeMs !== undefined &&
        nowMs - b.videoMtimeMs >= RECOVERY_QUIET_MS,
    )
    .sort((a, b) => (a.videoMtimeMs ?? 0) - (b.videoMtimeMs ?? 0))
    .map((b) => b.dir);
}

/**
 * The project for a recovered take, from what ffmpeg reads of its file, or
 * null when the file doesn't play (no length or no picture).
 */
export function recoveredProject(probe: {
  duration: number | null;
  size: { width: number; height: number } | null;
}): Project | null {
  const { duration, size } = probe;
  if (duration === null || !(duration > 0) || !size || !(size.width > 0) || !(size.height > 0)) return null;
  return defaultProject({
    screenVideoFile: RECOVERABLE_VIDEO,
    sourceKind: 'iosDevice',
    sourceSize: { width: size.width, height: size.height },
    duration,
  });
}

/** The picker's notice for what was recovered. */
export function recoveryNotice(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? 'Recovered an interrupted recording.' : `Recovered ${count} interrupted recordings.`;
}
