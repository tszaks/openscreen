// Display math for the export progress card (ExportProgress).

/** Milliseconds as m:ss ("0:07", "12:40"). Hours roll into minutes. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Whole percent, floored so 99.6% never reads as 100% before the last frame lands. */
export function percentDone(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
}

/** An estimate is only shown once this much time and work have passed. */
export const ETA_MIN_ELAPSED_MS = 3000;
export const ETA_MIN_FRACTION = 0.03;

/**
 * Remaining milliseconds at the average rate so far, or null while the rate is
 * still too noisy to trust (the first seconds of an export include encoder startup).
 */
export function estimateRemainingMs(done: number, total: number, elapsedMs: number): number | null {
  if (!(total > 0) || !(done > 0) || done >= total) return null;
  if (elapsedMs < ETA_MIN_ELAPSED_MS || done / total < ETA_MIN_FRACTION) return null;
  return (elapsedMs / done) * (total - done);
}

/** "About 1:05 left", or "Almost done" under five seconds. */
export function formatEta(remainingMs: number): string {
  if (remainingMs < 5000) return 'Almost done';
  return `About ${formatClock(remainingMs)} left`;
}
