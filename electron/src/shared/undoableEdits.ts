import type { History } from './history';
import type { ToastQueue } from './toasts';

/**
 * Ties an edit, its undo step and its toast together.
 *
 * `run(message, edit)` makes the edit exactly one history step and shows a
 * toast with Undo. The Undo restores that step through the same history the
 * Cmd+Z key uses, and only while the step is still the newest one: if the
 * user already pressed Cmd+Z, or edited something else since, the toast's
 * Undo refuses (and the toast hides it) instead of undoing something else.
 */
export class UndoableEdits<T> {
  constructor(
    private io: {
      history: History<T>;
      toasts: ToastQueue;
      current: () => T;
      /** Put a state back without recording it as a new edit. */
      restore: (prev: T) => void;
      now: () => number;
    },
  ) {}

  run(message: string, edit: () => void) {
    const { history, toasts, current, restore, now } = this.io;
    const step = history.beginStep();
    edit();
    toasts.add(
      {
        message,
        action: {
          label: 'Undo',
          canRun: () => history.stepIsLatest(step),
          run: () => {
            const prev = history.undoStep(step, current());
            if (prev !== undefined) restore(prev);
          },
        },
      },
      now(),
    );
  }
}
