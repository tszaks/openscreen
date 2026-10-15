/**
 * The toast queue behind the editor's Undo toasts. No DOM and no timers of
 * its own: the caller passes the clock in, so the rules are testable.
 *
 * - A toast with an action (Undo) is never dropped to make room. Toasts
 *   without one are dropped oldest first, so the list stays at `max` unless
 *   every toast carries an action.
 * - One timer for the whole stack: pause() on hover or focus, resume() after.
 *   A paused toast keeps the time it had left.
 */

export interface ToastAction {
  label: string;
  run: () => void;
  /** False once running the action would do the wrong thing (stale Undo). */
  canRun?: () => boolean;
}

export interface ToastSpec {
  message: string;
  action?: ToastAction;
  /** Milliseconds on screen. Default 6000 with an action, 3000 without. */
  duration?: number;
}

export interface Toast extends ToastSpec {
  id: number;
  /** Time left when paused, or while running: `expiresAt - now`. */
  remaining: number;
  expiresAt: number;
}

export class ToastQueue {
  private list: Toast[] = [];
  private nextId = 1;
  private pausedAt: number | null = null;
  private listeners = new Set<() => void>();

  constructor(private max = 3) {}

  get items(): readonly Toast[] {
    return this.list;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    // A new array each time, so a React snapshot sees the change.
    this.list = [...this.list];
    for (const fn of this.listeners) fn();
  }

  add(spec: ToastSpec, now: number): number {
    const duration = spec.duration ?? (spec.action ? 6000 : 3000);
    const toast: Toast = { ...spec, id: this.nextId++, remaining: duration, expiresAt: now + duration };
    // Make room by dropping plain toasts, oldest first. Never an action.
    while (this.list.length >= this.max) {
      const plain = this.list.findIndex((t) => !t.action);
      if (plain === -1) break;
      this.list.splice(plain, 1);
    }
    this.list.push(toast);
    this.emit();
    return toast.id;
  }

  dismiss(id: number) {
    const i = this.list.findIndex((t) => t.id === id);
    if (i === -1) return;
    this.list.splice(i, 1);
    this.emit();
  }

  dismissNewest() {
    const last = this.list[this.list.length - 1];
    if (last) this.dismiss(last.id);
  }

  /** Run a toast's action once and remove the toast. False if it could not run. */
  runAction(id: number): boolean {
    const t = this.list.find((x) => x.id === id);
    if (!t?.action) return false;
    if (t.action.canRun && !t.action.canRun()) return false;
    this.dismiss(id);
    t.action.run();
    return true;
  }

  get paused() {
    return this.pausedAt !== null;
  }

  pause(now: number) {
    if (this.pausedAt !== null) return;
    this.pausedAt = now;
    for (const t of this.list) t.remaining = Math.max(0, t.expiresAt - now);
  }

  resume(now: number) {
    if (this.pausedAt === null) return;
    this.pausedAt = null;
    for (const t of this.list) t.expiresAt = now + t.remaining;
  }

  /** Drop toasts whose time is up. Nothing expires while paused. */
  tick(now: number) {
    if (this.pausedAt !== null) return;
    const keep = this.list.filter((t) => t.expiresAt > now);
    if (keep.length !== this.list.length) {
      this.list = keep;
      this.emit();
    }
  }
}
