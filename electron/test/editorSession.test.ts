import { describe, expect, it } from 'vitest';
import { SaveTracker, isTextEntry } from '../src/shared/editorSession';

describe('SaveTracker', () => {
  it('starts clean and goes dirty only when the contents change', () => {
    const a = { v: 1 };
    const t = new SaveTracker(a);
    expect(t.isDirty(a)).toBe(false);
    // A no-op state update (new object, same contents) must not prompt to save.
    expect(t.isDirty({ v: 1 })).toBe(false);
    expect(t.isDirty({ v: 9 })).toBe(true);
  });

  it('is clean again once the current snapshot is saved', () => {
    const b = { v: 2 };
    const t = new SaveTracker({ v: 1 });
    t.markSaved(b);
    expect(t.isDirty(b)).toBe(false);
  });

  it('stays dirty for edits made while a save was in flight', () => {
    const a = { v: 1 };
    const b = { v: 2 };
    const c = { v: 3 };
    const t = new SaveTracker(a);
    // Save of b starts, the user edits to c, then the save of b lands.
    t.markSaved(b);
    expect(t.isDirty(c)).toBe(true);
  });

  it('counts undoing back to the saved snapshot as clean', () => {
    const a = { v: 1 };
    const t = new SaveTracker(a);
    expect(t.isDirty({ v: 2 })).toBe(true);
    expect(t.isDirty(a)).toBe(false);
  });
});

describe('isTextEntry', () => {
  it('accepts text fields', () => {
    expect(isTextEntry({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTextEntry({ tagName: 'input', type: '' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT' })).toBe(true);
    expect(isTextEntry({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('rejects controls with no text to undo', () => {
    expect(isTextEntry({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTextEntry({ tagName: 'INPUT', type: 'range' })).toBe(false);
    expect(isTextEntry({ tagName: 'INPUT', type: 'color' })).toBe(false);
    expect(isTextEntry({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextEntry({ tagName: 'BODY' })).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});
