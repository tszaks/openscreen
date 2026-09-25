import type { CursorSample, Point } from './types';
import { Timeline } from './timeline';

export interface Ripple {
  position: Point;
  /** 0 = just clicked … 1 = fully expanded/faded. */
  progress: number;
}

/** Click-down events remapped to output time via the timeline. */
export function clickEvents(samples: CursorSample[], timeline: Timeline) {
  return samples
    .filter((s) => s.kind === 'clickDown')
    .flatMap((s) => {
      const t = timeline.outputTime(s.time);
      return t === null ? [] : [{ time: t, position: { x: s.x, y: s.y } }];
    });
}

/** Active ripples at output time — each lives `lifetime` seconds. */
export function ripplesAt(
  outTime: number,
  events: { time: number; position: Point }[],
  lifetime = 0.7,
): Ripple[] {
  return events.flatMap((ev) => {
    const progress = (outTime - ev.time) / lifetime;
    return progress >= 0 && progress <= 1 ? [{ position: ev.position, progress }] : [];
  });
}
