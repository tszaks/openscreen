import { describe, expect, it, vi } from 'vitest';
import { ToastQueue } from '../src/shared/toasts';

const undo = () => ({ label: 'Undo', run: vi.fn() });

describe('ToastQueue', () => {
  it('shows a toast, then drops it when its time is up', () => {
    const q = new ToastQueue();
    q.add({ message: 'Clip deleted', action: undo() }, 0);
    expect(q.items.map((t) => t.message)).toEqual(['Clip deleted']);
    q.tick(5_999);
    expect(q.items).toHaveLength(1);
    q.tick(6_000);
    expect(q.items).toHaveLength(0);
  });

  it('keeps at most 3 toasts that carry no Undo, dropping the oldest', () => {
    const q = new ToastQueue();
    for (const m of ['a', 'b', 'c', 'd']) q.add({ message: m }, 0);
    expect(q.items.map((t) => t.message)).toEqual(['b', 'c', 'd']);
  });

  it('a new toast never removes a pending Undo', () => {
    const q = new ToastQueue();
    q.add({ message: 'Clip deleted', action: undo() }, 0);
    q.add({ message: 'Reset', action: undo() }, 0);
    q.add({ message: 'plain' }, 0);
    q.add({ message: 'newest plain' }, 0);
    const msgs = q.items.map((t) => t.message);
    expect(msgs).toContain('Clip deleted');
    expect(msgs).toContain('Reset');
    expect(msgs).not.toContain('plain');
    expect(q.items.length).toBeLessThanOrEqual(3);
  });

  it('when every toast has an Undo, a new one still keeps all of them', () => {
    const q = new ToastQueue();
    for (const m of ['a', 'b', 'c', 'd']) q.add({ message: m, action: undo() }, 0);
    expect(q.items.map((t) => t.message)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('hover pauses the timer and resume gives back only the time that was left', () => {
    const q = new ToastQueue();
    q.add({ message: 'Reset', action: undo() }, 0);
    q.pause(4_000); // 2 s left
    q.tick(60_000);
    expect(q.items).toHaveLength(1);
    q.resume(60_000);
    q.tick(61_999);
    expect(q.items).toHaveLength(1);
    q.tick(62_000);
    expect(q.items).toHaveLength(0);
  });

  it('a toast added while paused starts paused', () => {
    const q = new ToastQueue();
    q.pause(0);
    q.add({ message: 'x', action: undo() }, 0);
    q.tick(100_000);
    expect(q.items).toHaveLength(1);
    q.resume(100_000);
    q.tick(105_999);
    expect(q.items).toHaveLength(1);
    q.tick(106_000);
    expect(q.items).toHaveLength(0);
  });

  it('dismiss removes one toast without running its action', () => {
    const q = new ToastQueue();
    const a = undo();
    const id = q.add({ message: 'x', action: a }, 0);
    q.dismiss(id);
    expect(q.items).toHaveLength(0);
    expect(a.run).not.toHaveBeenCalled();
  });

  it('runAction runs once, then removes the toast', () => {
    const q = new ToastQueue();
    const a = undo();
    const id = q.add({ message: 'x', action: a }, 0);
    expect(q.runAction(id)).toBe(true);
    expect(q.runAction(id)).toBe(false);
    expect(a.run).toHaveBeenCalledTimes(1);
    expect(q.items).toHaveLength(0);
  });

  it('runAction refuses when the action says it is no longer valid', () => {
    const q = new ToastQueue();
    const a = { ...undo(), canRun: () => false };
    const id = q.add({ message: 'x', action: a }, 0);
    expect(q.runAction(id)).toBe(false);
    expect(a.run).not.toHaveBeenCalled();
  });

  it('tells subscribers about every change', () => {
    const q = new ToastQueue();
    const seen = vi.fn();
    q.subscribe(seen);
    const id = q.add({ message: 'x' }, 0);
    q.dismiss(id);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('dismissNewest takes the latest toast only', () => {
    const q = new ToastQueue();
    q.add({ message: 'a' }, 0);
    q.add({ message: 'b' }, 0);
    q.dismissNewest();
    expect(q.items.map((t) => t.message)).toEqual(['a']);
  });

  it('prune removes toasts whose action can no longer run, and keeps the rest', () => {
    const q = new ToastQueue();
    let stale = false;
    q.add({ message: 'Clip deleted', action: { ...undo(), canRun: () => !stale } }, 0);
    q.add({ message: 'plain' }, 0);
    q.add({ message: 'Reset', action: undo() }, 0);
    q.prune();
    expect(q.items).toHaveLength(3);
    stale = true;
    q.prune();
    expect(q.items.map((t) => t.message)).toEqual(['plain', 'Reset']);
  });

  it('prune works while the stack is paused', () => {
    const q = new ToastQueue();
    q.add({ message: 'x', action: { ...undo(), canRun: () => false } }, 0);
    q.pause(0);
    q.prune();
    expect(q.items).toHaveLength(0);
  });
});
