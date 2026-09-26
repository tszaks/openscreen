/**
 * Undo/redo stacks with coalescing: a burst of changes (a slider drag, a
 * crop drag, typing) becomes one undo step. A change within `windowMs` of the
 * previous one joins its step; `seal()` (on pointer-up) ends a step early.
 */
export class History<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private lastChange = -Infinity;

  constructor(
    private windowMs = 400,
    private cap = 60,
  ) {}

  /** `prev` is being replaced by an edit made at `now` (ms). */
  record(prev: T, now: number) {
    if (now - this.lastChange > this.windowMs) {
      this.undoStack.push(prev);
      if (this.undoStack.length > this.cap) this.undoStack.shift();
    }
    this.lastChange = now;
    this.redoStack = [];
  }

  /** Close the current step so the next change starts a new one. */
  seal() {
    this.lastChange = -Infinity;
  }

  /** The state to restore, given what's showing now; undefined if none. */
  undo(current: T): T | undefined {
    const prev = this.undoStack.pop();
    if (prev === undefined) return undefined;
    this.redoStack.push(current);
    this.seal();
    return prev;
  }

  redo(current: T): T | undefined {
    const next = this.redoStack.pop();
    if (next === undefined) return undefined;
    this.undoStack.push(current);
    this.seal();
    return next;
  }
}
