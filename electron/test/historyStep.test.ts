import { describe, expect, it } from 'vitest';
import { History } from '../src/shared/history';

describe('History steps (compare-and-set)', () => {
  it('beginStep makes the next change its own step, even inside the coalescing window', () => {
    const h = new History<string>(400);
    h.record('a', 0);
    const token = h.beginStep();
    h.record('b', 10); // 10 ms later: would have joined, must not
    expect(h.stepIsLatest(token)).toBe(true);
    expect(h.undoStep(token, 'c')).toBe('b');
    expect(h.undo('b')).toBe('a');
  });

  it('a change after the step does not join the step', () => {
    const h = new History<string>(400);
    const token = h.beginStep();
    h.record('a', 0);
    h.record('b', 10);
    expect(h.undoStep(token, 'c')).toBeUndefined(); // 'b' is newer: refuse
    expect(h.undo('c')).toBe('b');
  });

  it('refuses after the step was already undone by the normal undo', () => {
    const h = new History<string>(400);
    h.record('a', 0);
    h.seal();
    const token = h.beginStep();
    h.record('b', 1000);
    expect(h.undo('c')).toBe('b'); // user pressed Cmd+Z
    h.record('c', 5000); // then made an unrelated change
    expect(h.stepIsLatest(token)).toBe(false);
    expect(h.undoStep(token, 'd')).toBeUndefined();
    expect(h.undo('d')).toBe('c');
  });

  it('refuses a second time', () => {
    const h = new History<string>(400);
    const token = h.beginStep();
    h.record('a', 0);
    expect(h.undoStep(token, 'b')).toBe('a');
    expect(h.undoStep(token, 'a')).toBeUndefined();
  });

  it('is valid before the change lands and invalid once something else lands first', () => {
    const h = new History<string>(400);
    const token = h.beginStep();
    expect(h.stepIsLatest(token)).toBe(true); // pending
    h.record('a', 0);
    h.seal();
    h.record('b', 1000);
    expect(h.stepIsLatest(token)).toBe(false);
  });

  it('a redo of the step gets a new identity, so the old toast stays refused', () => {
    const h = new History<string>(400);
    const token = h.beginStep();
    h.record('a', 0);
    expect(h.undo('b')).toBe('a');
    expect(h.redo('a')).toBe('b');
    expect(h.undoStep(token, 'b')).toBeUndefined();
  });

  it('survives the history cap', () => {
    const h = new History<number>(0, 3);
    const token = h.beginStep();
    h.record(0, 0);
    expect(h.undoStep(token, 1)).toBe(0);
  });
});
