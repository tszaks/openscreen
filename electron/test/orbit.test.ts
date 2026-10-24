import { describe, expect, it } from 'vitest';
import { FRONT, POSE_RANGE } from '../src/shared/phone3d/model';
import { ORBIT_DEG_PER_PT, orbitDrag, orbitLock, orbitPose } from '../src/shared/phone3d/orbit';

const start = { ...FRONT, turn: 10, tilt: 5, x: 0.1, y: -0.05 };

describe('orbitPose', () => {
  it('maps 0.45° per point: dx → turn, drag up → +tilt (top away)', () => {
    const p = orbitPose(start, 100, -20);
    expect(p.turn).toBeCloseTo(10 + 100 * ORBIT_DEG_PER_PT, 12);
    expect(p.tilt).toBeCloseTo(5 + 20 * ORBIT_DEG_PER_PT, 12);
    expect(p).toMatchObject({ rotate: 0, size: 1, x: 0.1, y: -0.05, light: 0, focus: 1 });
  });

  it('is absolute: the same drag from the same start gives the same pose', () => {
    expect(orbitPose(start, 37, 12)).toEqual(orbitPose(start, 37, 12));
  });

  it('Shift keeps the drag-start pose stable on the locked axis', () => {
    const d = orbitDrag(start);
    // Under 4 pt: not decided, nothing moves.
    expect(d.move(2, 1, { shift: true })).toEqual(start);
    expect(d.lock).toBeNull();
    // Decided once (x dominant)...
    const a = d.move(30, 6, { shift: true });
    expect(d.lock).toBe('x');
    expect(a.tilt).toBe(start.tilt);
    // ...and it stays x even when the pointer later moves mostly vertically.
    const b = d.move(31, 200, { shift: true });
    expect(b.tilt).toBe(start.tilt);
    expect(b.turn).toBeCloseTo(start.turn + 31 * ORBIT_DEG_PER_PT, 12);
    // A y lock keeps turn.
    const v = orbitDrag(start);
    v.move(1, 9, { shift: true });
    expect(v.lock).toBe('y');
    expect(v.move(300, 9, { shift: true }).turn).toBe(start.turn);
    expect(orbitLock(3, 2)).toBeNull();
  });

  it('Alt pans x/y and does not rotate', () => {
    const p = orbitPose(start, 50, -100, { alt: true, view: { width: 500, height: 1000 } });
    expect(p.turn).toBe(start.turn);
    expect(p.tilt).toBe(start.tilt);
    expect(p.x).toBeCloseTo(0.2, 12);
    expect(p.y).toBeCloseTo(-0.15, 12);
    expect(orbitPose(start, 1e6, 1e6, { alt: true }).x).toBe(POSE_RANGE.x[1]);
  });

  it('clamps tilt to ±85 and turn to POSE_RANGE on long drags', () => {
    expect(orbitPose(start, 0, -10000).tilt).toBe(85);
    expect(orbitPose(start, 0, 10000).tilt).toBe(-85);
    expect(orbitPose(start, 1e6, 0).turn).toBe(POSE_RANGE.turn[1]);
    expect(orbitPose(start, -1e6, 0).turn).toBe(POSE_RANGE.turn[0]);
  });
});
