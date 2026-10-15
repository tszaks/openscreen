import { useEffect, useSyncExternalStore } from 'react';
import type { ToastQueue } from '../../../shared/toasts';
import './toasts.css';

/**
 * The editor's toast stack, bottom centre. One polite live region; the timer
 * pauses while the pointer is over the stack or focus is inside it; Esc
 * dismisses the newest toast (an edit stays done: Esc never undoes).
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !queue.items.length) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      queue.dismissNewest();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
          {t.action && (!t.action.canRun || t.action.canRun()) && (
            <button type="button" className="toast-action" onClick={() => queue.runAction(t.id)}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
