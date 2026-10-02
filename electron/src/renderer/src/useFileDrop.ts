import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { dropHint, routeDrop, type DropAction } from '../../shared/importVideo';

type Where = 'picker' | 'editor' | 'recording';

/** A drag that carries files from Finder (not the timeline's own clip drags). */
const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');

/**
 * Files dragged onto the window from Finder: the overlay's words while one
 * is over the window (null otherwise), and `onDrop` with what the first
 * usable file is for. Listens at the window in the capture phase, so a file
 * dropped on the timeline never reaches its clip drag-and-drop, and an
 * unhandled drop never opens the file in place of the app.
 */
export function useFileDrop(where: Where, enabled: boolean, onDrop: (action: DropAction, path: string | null) => void): string | null {
  const [hint, setHint] = useState<string | null>(null);
  const handler = useRef(onDrop);
  handler.current = onDrop;
  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const hide = () => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
      setHint(null);
    };
    const over = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const types = Array.from(e.dataTransfer?.items ?? []).filter((i) => i.kind === 'file').map((i) => i.type);
      const next = enabled ? dropHint(types, where) : null;
      if (e.dataTransfer) e.dataTransfer.dropEffect = next ? 'copy' : 'none';
      setHint(next);
      // dragover repeats while the pointer is over the window; when it stops
      // (Escape, or the drag left without a dragleave), the overlay goes.
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 250);
    };
    const leave = (e: DragEvent) => {
      if (carriesFiles(e) && !e.relatedTarget) hide();
    };
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      hide();
      if (!enabled) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      const paths = files.map((f) => {
        try {
          return api.pathForFile(f) || f.name;
        } catch {
          return f.name;
        }
      });
      const { action, index } = routeDrop(paths, where);
      handler.current(action, index >= 0 ? paths[index] : null);
    };
    window.addEventListener('dragenter', over, true);
    window.addEventListener('dragover', over, true);
    window.addEventListener('dragleave', leave, true);
    window.addEventListener('drop', drop, true);
    return () => {
      if (hideTimer) clearTimeout(hideTimer);
      window.removeEventListener('dragenter', over, true);
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('dragleave', leave, true);
      window.removeEventListener('drop', drop, true);
    };
  }, [where, enabled]);
  return hint;
}
