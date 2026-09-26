// Small pieces of editor-session logic, kept free of React and the DOM so
// they can be tested.

/**
 * Tracks whether the project has changes that are not on disk. A save
 * records the exact snapshot it wrote, so edits made while a save is in
 * flight still count as unsaved, and undoing back to the saved snapshot
 * counts as clean.
 */
export class SaveTracker<T> {
  private saved: T;

  constructor(initial: T) {
    this.saved = initial;
  }

  markSaved(snapshot: T) {
    this.saved = snapshot;
  }

  isDirty(current: T) {
    return current !== this.saved;
  }
}

/** True when the focused element takes typed text, so Undo/Redo belong to
 *  it rather than to the project history. Checkboxes and sliders are
 *  inputs too, but have no text to undo. */
export function isTextEntry(
  el: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return ['text', 'search', 'url', 'email', 'tel', 'password', 'number'].includes(
    (el.type || 'text').toLowerCase(),
  );
}
