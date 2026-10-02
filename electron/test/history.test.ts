import { describe, expect, it } from 'vitest';
import { History } from '../src/shared/history';

describe('History coalescing (BH-21)', () => {
  it('a slider drag (one change per frame) is one undo step', () => {
    const h = new History<number>(400);
    let state = 0;
    for (let i = 1; i <= 100; i++) {
      h.record(state, i * 16); // 100 ticks, 16ms apart
      state = i;
    }
    expect(h.undo(state)).toBe(0);
    expect(h.undo(0)).toBeUndefined();
  });

  it('changes further apart than the window are separate steps', () => {
    const h = new History<string>(400);
    h.record('a', 0);
    h.record('b', 1000);
    expect(h.undo('c')).toBe('b');
    expect(h.undo('b')).toBe('a');
  });

  it('seal (pointer-up) ends a step even inside the window', () => {
    const h = new History<string>(400);
    h.record('a', 0);
    h.seal();
    h.record('b', 100);
    expect(h.undo('c')).toBe('b');
  });

  it('a held gesture (a camera drag with pauses) is one step until sealed', () => {
    const h = new History<string>(400);
    h.hold();
    h.record('start', 0);
    h.record('m1', 2000); // held still for 2 s mid-drag
    h.record('m2', 5000);
    h.seal(); // pointer-up
    h.record('after', 5100);
    expect(h.undo('now')).toBe('after');
    expect(h.undo('after')).toBe('start');
    expect(h.undo('start')).toBeUndefined();
  });

  it('redo restores, and a new edit after undo clears redo', () => {
    const h = new History<string>(400);
    h.record('a', 0);
    expect(h.undo('b')).toBe('a');
    expect(h.redo('a')).toBe('b');
    expect(h.undo('b')).toBe('a');
    h.record('a', 5000);
    expect(h.redo('x')).toBeUndefined();
  });

  it('caps the stack', () => {
    const h = new History<number>(0, 3);
    for (let i = 0; i < 10; i++) h.record(i, i * 10);
    expect([h.undo(10), h.undo(9), h.undo(8), h.undo(7)]).toEqual([9, 8, 7, undefined]);
  });
});
