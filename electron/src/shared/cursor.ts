import type { CursorSample, Point } from './types';

/** Catmull-Rom spline over cursor move samples, resampled at a fixed step.
 *  Click events pass through untouched, merged into the sorted output. */
export class CursorSmoother {
  constructor(
    public step = 1 / 60,
    public dwellSpeed = 0.002,
  ) {}

  smoothedPath(samples: CursorSample[]): CursorSample[] {
    const moves = samples
      .filter((s) => s.kind === 'move' || s.kind === 'dragMove')
      .sort((a, b) => a.time - b.time);
    if (moves.length < 2) return [...samples].sort((a, b) => a.time - b.time);

    const result: CursorSample[] = [];
    const t0 = moves[0].time;
    const t1 = moves[moves.length - 1].time;
    for (let t = t0; t <= t1 + 1e-9; t += this.step) {
      const p = this.positionAt(t, moves);
      result.push({ time: Math.min(t, t1), x: p.x, y: p.y, kind: 'move' });
    }
    const clicks = samples.filter((s) => s.kind === 'clickDown' || s.kind === 'clickUp');
    return [...result, ...clicks].sort((a, b) => a.time - b.time);
  }

  /** Interpolated position at `time` via Catmull-Rom over neighbors. */
  positionAt(time: number, moves: CursorSample[]): Point {
    if (moves.length === 0) return { x: 0.5, y: 0.5 };
    if (time <= moves[0].time) return { x: moves[0].x, y: moves[0].y };
    const last = moves[moves.length - 1];
    if (time >= last.time) return { x: last.x, y: last.y };

    // Binary search surrounding pair.
    let lo = 0;
    let hi = moves.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (moves[mid].time <= time) lo = mid;
      else hi = mid;
    }
    const p1 = moves[lo];
    const p2 = moves[hi];
    const p0 = lo > 0 ? moves[lo - 1] : p1;
    const p3 = hi < moves.length - 1 ? moves[hi + 1] : p2;
    const span = p2.time - p1.time;
    const u = span > 0 ? (time - p1.time) / span : 0;
    return {
      x: catmullRom(p0.x, p1.x, p2.x, p3.x, u),
      y: catmullRom(p0.y, p1.y, p2.y, p3.y, u),
    };
  }
}

export function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
  );
}
