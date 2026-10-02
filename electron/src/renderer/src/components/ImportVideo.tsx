// Import Video…: the progress sheet (copying, converting, Cancel; or why it
// failed) and the overlay shown while a file is dragged over the window.

import React, { useEffect, useState } from 'react';
import { Button, Sheet } from '../ui';
import './import-video.css';

export type ImportState =
  | { file: string; stage: 'starting' | 'copy' | 'convert'; fraction: number }
  | { file: string; error: string };

// A clone on the same disk finishes at once: no sheet flashes for it.
const SHOW_AFTER_MS = 300;

export function ImportSheet({ state, onCancel, onClose }: { state: ImportState; onCancel: () => void; onClose: () => void }) {
  const failed = 'error' in state;
  const [shown, setShown] = useState(failed);
  useEffect(() => {
    if (shown) return;
    const t = setTimeout(() => setShown(true), SHOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [shown]);
  useEffect(() => {
    if (failed) setShown(true);
  }, [failed]);
  if (!shown) return null;

  if ('error' in state) {
    return (
      <Sheet
        title={`Couldn't import ${state.file}`}
        onCancel={onClose}
        actions={
          <>
            <div className="spacer" />
            <Button variant="primary" autoFocus onClick={onClose}>
              OK
            </Button>
          </>
        }
      >
        <p>{state.error}</p>
      </Sheet>
    );
  }

  const pct = Math.round(state.fraction * 100);
  const what =
    state.stage === 'convert'
      ? "Converting it to a format the editor can play. The original file isn't changed."
      : state.stage === 'copy'
        ? "Copying it into your recordings folder. The original file isn't changed."
        : 'Reading the video…';
  return (
    <Sheet
      title={`Importing ${state.file}`}
      onCancel={onCancel}
      actions={
        <>
          <div className="spacer" />
          <Button onClick={onCancel}>Cancel</Button>
        </>
      }
    >
      <p>{what}</p>
      <div className="import-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="progress import-bar">
          <span style={{ width: `${state.stage === 'starting' ? 0 : pct}%` }} />
        </div>
        <span className="import-pct tnum">{state.stage === 'starting' ? '' : `${pct}%`}</span>
      </div>
    </Sheet>
  );
}

/** "Drop to import" over the whole window while a file is dragged over it. */
export function DropOverlay({ hint }: { hint: string }) {
  return (
    <div className="drop-overlay" aria-hidden>
      <div className="drop-target">
        <span className="drop-hint">{hint}</span>
      </div>
    </div>
  );
}
