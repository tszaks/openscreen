import { useEffect, useSyncExternalStore } from 'react';
import type { ToastQueue } from '../../../shared/toasts';
import './toasts.css';

/**
 * The editor's toast stack, bottom centre. One polite live region; the timer
 * pauses while the pointer is over the stack or focus is inside it; Esc,
 * in that state only, dismisses the newest toast (an edit stays done: Esc
 * never undoes).
 */
export function Toasts({ queue }: { queue: ToastQueue }) {
  const items = useSyncExternalStore(
    (fn) => queue.subscribe(fn),
    () => queue.items,
  );

  useEffect(() => {
    const id = window.setInterval(() => queue.tick(performance.now()), 200);
    return () => window.clearInterval(id);
  }, [queue]);

  // A stale Undo takes its toast with it. The editor re-renders on every
  // change to the project, which is when a step can go stale.
  useEffect(() => {
    queue.prune();
  });

  // A removed node fires no pointerleave or blur, so an emptied stack must
  // un-pause itself or the next toast would never expire.
  useEffect(() => {
    if (!items.length) queue.resume(performance.now());
  }, [items, queue]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only while the pointer is over the stack or focus is inside it (the
      // queue is paused exactly then). Any other Esc belongs to the editor.
      if (e.key !== 'Escape' || !queue.paused || !queue.items.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      queue.dismissNewest();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [queue]);

  const pause = () => queue.pause(performance.now());
  const resume = () => queue.resume(performance.now());

  return (
    <div
      className="toasts"
      role="status"
      aria-live="polite"
      onPointerEnter={pause}
      onPointerLeave={resume}
      onFocus={pause}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume();
      }}
    >
      {items.map((t) => (
        <div className="toast" key={t.id}>
          <span className="toast-text">{t.message}</span>
          {t.action && (
            <button type="button" className="toast-action" onClick={() => queue.runAction(t.id)}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
