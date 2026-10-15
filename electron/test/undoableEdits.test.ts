import { beforeEach, describe, expect, it } from 'vitest';
import { History } from '../src/shared/history';
import { ToastQueue } from '../src/shared/toasts';
import { UndoableEdits } from '../src/shared/undoableEdits';
import { cutSource, withClips } from '../src/shared/agentOps';
import { defaultProject, resetProject, type Project } from '../src/shared/types';

/** The editor's project state, history and toast queue wired the way
 *  Editor.tsx wires them: every change records the previous project. */
class Harness {
  proj: Project;
  history = new History<Project>();
  toasts = new ToastQueue();
  clock = 0;
  edits: UndoableEdits<Project>;
  constructor(p: Project) {
    this.proj = p;
    this.edits = new UndoableEdits({
      history: this.history,
      toasts: this.toasts,
      current: () => this.proj,
      restore: (prev) => {
        this.proj = prev; // history applies without recording
      },
      now: () => this.clock,
    });
  }
  /** A normal edit (not announced). */
  set(next: Project) {
    this.history.record(this.proj, (this.clock += 1000));
    this.proj = next;
  }
  /** An announced edit: the toast and the history step are one thing. */
  announce(message: string, next: Project) {
    this.edits.run(message, () => {
      this.history.record(this.proj, (this.clock += 1000));
      this.proj = next;
    });
  }
  cmdZ() {
    const prev = this.history.undo(this.proj);
    if (prev) this.proj = prev;
  }
  toastUndo() {
    return this.toasts.runAction(this.toasts.items[this.toasts.items.length - 1].id);
  }
}

const base = (): Project => {
  const p = defaultProject({ screenVideoFile: 's.mov', sourceKind: 'iosDevice', sourceSize: { width: 1206, height: 2622 }, duration: 20 });
  p.clips = [
    { id: 'a', sourceStart: 0, sourceEnd: 8, speed: 1 },
    { id: 'b', sourceStart: 8, sourceEnd: 20, speed: 1 },
  ];
  p.annotations = [{ id: 't1', text: 'Hello', start: 0, end: 3 } as Project['annotations'][number]];
  return p;
};

let h: Harness;
beforeEach(() => {
  h = new Harness(base());
});

const sameJson = (a: unknown, b: unknown) => expect(JSON.stringify(a)).toBe(JSON.stringify(b));

describe('every destructive edit gets a toast whose Undo restores exactly once', () => {
  const cases: [string, string, (p: Project) => Project][] = [
    ['delete clip', 'Clip deleted', (p) => withClips(p, p.clips.filter((c) => c.id !== 'a'))],
    ['smart cuts', '2 cuts', (p) => cutSource(p, [{ start: 1, end: 2 }, { start: 10, end: 12 }]).project],
    ['wait cuts', '1 pause cut', (p) => cutSource(p, [{ start: 4, end: 6 }]).project],
    ['text delete', 'Text deleted', (p) => ({ ...p, annotations: p.annotations.filter((a) => a.id !== 't1') })],
    ['reset', 'Reset', (p) => resetProject({ ...p, layout: { ...p.layout, titleCard: { title: 'x', subtitle: '' } } })],
  ];
  for (const [name, message, edit] of cases) {
    it(name, () => {
      const before = structuredClone(h.proj);
      h.announce(message, edit(h.proj));
      expect(JSON.stringify(h.proj)).not.toBe(JSON.stringify(before));
      expect(h.toasts.items.map((t) => t.message)).toEqual([message]);
      expect(h.toastUndo()).toBe(true);
      sameJson(h.proj, before);
      // once only: the toast is gone and nothing else is undone
      expect(h.toasts.items).toHaveLength(0);
      expect(h.history.undo(h.proj)).toBeUndefined();
    });
  }

  it('the edit is one history step, not merged with the edit just before it', () => {
    const start = structuredClone(h.proj);
    h.history.record(h.proj, 0); // a quick earlier edit, 10 ms ago
    h.proj = { ...h.proj, annotations: [] };
    h.clock = -990;
    const mid = structuredClone(h.proj);
    h.announce('Clip deleted', withClips(h.proj, h.proj.clips.slice(1)));
    h.toastUndo();
    sameJson(h.proj, mid);
    h.cmdZ();
    sameJson(h.proj, start);
  });
});

describe('toast Undo versus the user pressing Cmd+Z first', () => {
  it('does nothing after the same change was already undone', () => {
    const before = structuredClone(h.proj);
    h.announce('Clip deleted', withClips(h.proj, h.proj.clips.slice(1)));
    h.cmdZ();
    sameJson(h.proj, before);
    expect(h.toasts.items[0].action?.canRun?.()).toBe(false);
    expect(h.toastUndo()).toBe(false);
    sameJson(h.proj, before);
    h.toasts.prune(); // the toast would say "Clip deleted" about a clip that is back
    expect(h.toasts.items).toHaveLength(0);
  });

  it('the toast is removed once an unrelated later edit lands', () => {
    h.announce('Clip deleted', withClips(h.proj, h.proj.clips.slice(0, 1)));
    h.toasts.prune();
    expect(h.toasts.items).toHaveLength(1); // still the newest step: stays
    h.set({ ...h.proj, annotations: [] });
    h.toasts.prune();
    expect(h.toasts.items).toHaveLength(0);
  });

  it('does not undo a second, unrelated change after Cmd+Z and a new edit', () => {
    h.announce('Clip deleted', withClips(h.proj, h.proj.clips.slice(1)));
    h.cmdZ();
    h.set({ ...h.proj, annotations: [] }); // unrelated edit
    const after = structuredClone(h.proj);
    expect(h.toastUndo()).toBe(false);
    sameJson(h.proj, after);
    h.cmdZ();
    expect(h.proj.annotations).toHaveLength(1); // only the unrelated change came back
  });

  it('does not undo a newer edit made after the announced one', () => {
    h.announce('Clip deleted', withClips(h.proj, h.proj.clips.slice(1)));
    h.set({ ...h.proj, annotations: [] });
    const after = structuredClone(h.proj);
    expect(h.toastUndo()).toBe(false);
    sameJson(h.proj, after);
  });

  it('two toasts stay independent: the older one refuses once the newer one landed', () => {
    h.announce('Clip deleted', withClips(h.proj, h.proj.clips.slice(0, 1)));
    const first = h.toasts.items[0];
    h.announce('Text deleted', { ...h.proj, annotations: [] });
    expect(h.toasts.runAction(first.id)).toBe(false);
    expect(h.toasts.items).toHaveLength(2);
    expect(h.toastUndo()).toBe(true); // newest still works
    expect(h.proj.annotations).toHaveLength(1);
    expect(h.proj.clips).toHaveLength(1);
  });
});
