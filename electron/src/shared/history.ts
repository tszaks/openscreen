/**
 * Undo/redo stacks with coalescing: a burst of changes (a slider drag, a
 * crop drag, typing) becomes one undo step. A change within `windowMs` of the
 * previous one joins its step; `seal()` (on pointer-up) ends a step early.
 */
export class History<T> {
  private undoStack: T[] = [];
  // One identity per undo step, parallel to undoStack. A toast's Undo holds
  // an identity and only fires while that step is still the newest one.
  private undoIds: number[] = [];
  private nextId = 1;
  private sealAfterNext = false;
  private listeners = new Set<() => void>();
  private redoStack: T[] = [];
  private lastChange = -Infinity;
  // A gesture in progress (hold() until seal()): one step however slow it is.
  private held = false;

  constructor(
    private windowMs = 400,
    private cap = 60,
  ) {}

  /** `prev` is being replaced by an edit made at `now` (ms). */
  record(prev: T, now: number) {
    const joins = this.held ? this.lastChange !== -Infinity : now - this.lastChange <= this.windowMs;
    if (!joins) {
      this.push(prev);
    }
    this.lastChange = now;
    this.redoStack = [];
    if (this.sealAfterNext) {
      this.sealAfterNext = false;
      this.seal();
    }
    this.notify();
  }

  /** Told after every change to the stacks (record, undo, redo). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  private push(prev: T) {
    this.undoStack.push(prev);
    this.undoIds.push(this.nextId++);
    if (this.undoStack.length > this.cap) {
      this.undoStack.shift();
      this.undoIds.shift();
    }
  }

  /** Call just before an edit that gets its own Undo (a toast). The edit
   *  becomes exactly one step: it never joins the change before it, and the
   *  change after it never joins it. Returns the step's identity, valid
   *  before the edit lands. */
  beginStep(): number {
    this.seal();
    this.sealAfterNext = true;
    return this.nextId;
  }

  /** True while the step is the newest one (or has not landed yet). */
  stepIsLatest(id: number): boolean {
    return this.undoIds[this.undoIds.length - 1] === id || this.nextId === id;
  }

  /** Undo, but only that step, and only if nothing came after it. */
  undoStep(id: number, current: T): T | undefined {
    if (this.undoIds[this.undoIds.length - 1] !== id) return undefined;
    return this.undo(current);
  }

  /** Close the current step so the next change starts a new one. */
  seal() {
    this.lastChange = -Infinity;
    this.held = false;
  }

  /** Every change until the next seal() joins one step, however long the
   *  pauses between them (a drag held still, then moved again). */
  hold() {
    this.seal();
    this.held = true;
  }

  /** The state to restore, given what's showing now; undefined if none. */
  undo(current: T): T | undefined {
    const prev = this.undoStack.pop();
    if (prev === undefined) return undefined;
    this.undoIds.pop();
    this.redoStack.push(current);
    this.seal();
    this.notify();
    return prev;
  }

  redo(current: T): T | undefined {
    const next = this.redoStack.pop();
    if (next === undefined) return undefined;
    this.push(current);
    this.seal();
    this.notify();
    return next;
  }
}
