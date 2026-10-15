import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ToastQueue } from '../../../shared/toasts';
import './toasts.css';

/**
 * The editor's toast stack, bottom centre. One polite live region; the timer
 * pauses while the pointer is over the stack or focus is inside it; Esc,
 * in that state only, dismisses the newest toast (an edit stays done: Esc
 * never undoes). While `blocked` (a modal sheet is open) the stack is hidden,
 * inert and its timers are held, so Undo cannot act behind the sheet.
 */
export function Toasts({ queue, blocked = false }: { queue: ToastQueue; blocked?: boolean }) {
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
  // let go of the pointer and focus holds or the next toast would never expire.
  useEffect(() => {
    if (!items.length) {
      queue.release('pointer', performance.now());
      queue.release('focus', performance.now());
    }
  }, [items, queue]);

  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  useEffect(() => {
    if (blocked) queue.hold('modal', performance.now());
    else queue.release('modal', performance.now());
    return () => queue.release('modal', performance.now());
  }, [blocked, queue]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only while the pointer is over the stack or focus is inside it. Any
      // other Esc belongs to the editor (or to the sheet that is open).
      if (e.key !== 'Escape' || blockedRef.current || !queue.items.length) return;
      if (!queue.isHeld('pointer') && !queue.isHeld('focus')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      queue.dismissNewest();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [queue]);

  return (
    <div
      className="toasts"
      role="status"
      aria-live="polite"
      inert={blocked}
      data-blocked={blocked || undefined}
      onPointerEnter={() => queue.hold('pointer', performance.now())}
      onPointerLeave={() => queue.release('pointer', performance.now())}
      onFocus={() => queue.hold('focus', performance.now())}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) queue.release('focus', performance.now());
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
