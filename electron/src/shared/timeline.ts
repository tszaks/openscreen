import type { Clip } from './types';

/** Ordered clip list mapping between source (recorded) and output time. */
export class Timeline {
  constructor(
    public sourceDuration: number,
    public clips: Clip[] = [],
  ) {
    if (this.clips.length === 0) {
      this.clips = [{ id: crypto.randomUUID(), sourceStart: 0, sourceEnd: sourceDuration, speed: 1 }];
    }
  }

  get outputDuration(): number {
    return this.clips.reduce((s, c) => s + (c.sourceEnd - c.sourceStart) / Math.max(c.speed, 1e-9), 0);
  }

  /** Map output time back to source time; null past the end. */
  sourceTime(atOutputTime: number): number | null {
    let cursor = 0;
    for (const clip of this.clips) {
      const clipDur = (clip.sourceEnd - clip.sourceStart) / Math.max(clip.speed, 1e-9);
      if (atOutputTime < cursor + clipDur) {
        return clip.sourceStart + (atOutputTime - cursor) * clip.speed;
      }
      cursor += clipDur;
    }
    return null;
  }

  /** Inverse: source time → output time; null if trimmed away. */
  outputTime(forSourceTime: number): number | null {
    let cursor = 0;
    for (const clip of this.clips) {
      if (forSourceTime >= clip.sourceStart && forSourceTime <= clip.sourceEnd) {
        return cursor + (forSourceTime - clip.sourceStart) / clip.speed;
      }
      cursor += (clip.sourceEnd - clip.sourceStart) / Math.max(clip.speed, 1e-9);
    }
    return null;
  }

  /** True when the timeline maps source 1:1 (single clip, full range, speed 1). */
  get isIdentity(): boolean {
    if (this.clips.length !== 1) return false;
    const c = this.clips[0];
    return (
      c.sourceStart <= 0.001 &&
      Math.abs(c.sourceEnd - this.sourceDuration) <= 0.001 &&
      c.speed === 1
    );
  }

  /** Remove source-time ranges; kept portions keep their speed. Returns removed seconds. */
  cutRanges(ranges: { start: number; end: number }[]): number {
    const sorted = ranges
      .map((r) => ({
        start: Math.max(0, r.start),
        end: Math.min(this.sourceDuration, r.end),
      }))
      .filter((r) => r.end > r.start)
      .sort((a, b) => a.start - b.start);
    if (!sorted.length) return 0;
    const removed = sorted.reduce((s, r) => s + (r.end - r.start), 0);
    const kept: Clip[] = [];
    for (const clip of this.clips) {
      let cursor = clip.sourceStart;
      for (const r of sorted) {
        if (r.end <= clip.sourceStart || r.start >= clip.sourceEnd) continue;
        if (r.start > cursor) {
          kept.push({
            id: crypto.randomUUID(),
            sourceStart: cursor,
            sourceEnd: Math.min(r.start, clip.sourceEnd),
            speed: clip.speed,
          });
        }
        cursor = Math.max(cursor, Math.min(r.end, clip.sourceEnd));
      }
      if (cursor < clip.sourceEnd) {
        kept.push({
          id: crypto.randomUUID(),
          sourceStart: cursor,
          sourceEnd: clip.sourceEnd,
          speed: clip.speed,
        });
      }
    }
    // Never produce an empty timeline — keep a stub clip at the start.
    this.clips = kept.length
      ? kept
      : [
          {
            id: crypto.randomUUID(),
            sourceStart: 0,
            sourceEnd: Math.min(0.05, this.sourceDuration),
            speed: 1,
          },
        ];
    return removed;
  }

  /** Move the clip at index `from` to index `to`. */
  reorder(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.clips.length || to >= this.clips.length) {
      return;
    }
    const [c] = this.clips.splice(from, 1);
    this.clips.splice(to, 0, c);
  }

  split(atOutputTime: number): boolean {
    const src = this.sourceTime(atOutputTime);
    if (src === null) return false;
    const i = this.clips.findIndex((c) => src > c.sourceStart && src < c.sourceEnd);
    if (i < 0) return false;
    const clip = this.clips[i];
    this.clips.splice(
      i,
      1,
      { id: crypto.randomUUID(), sourceStart: clip.sourceStart, sourceEnd: src, speed: clip.speed },
      { id: crypto.randomUUID(), sourceStart: src, sourceEnd: clip.sourceEnd, speed: clip.speed },
    );
    return true;
  }
}
