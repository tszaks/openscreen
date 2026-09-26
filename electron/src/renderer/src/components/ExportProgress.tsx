// Export progress card: animated dot grid, elapsed clock, frames, percent, ETA,
// then an Exported or failed ending with its own actions.
//
// The dot-grid wavefront and live elapsed timer are adapted from
// "01-loading-state.tsx" (LoaderGrid, useElapsed) in Beautiful UI - Code Examples,
// MIT License, Copyright (c) 2026 Shane Levine. Rebuilt in plain CSS.

import React, { useEffect, useRef, useState } from 'react';
import { estimateRemainingMs, formatClock, formatEta, percentDone } from '../../../shared/exportProgress';
import { Button } from '../ui';
import './components.css';

export type ExportProgressState = 'running' | 'done' | 'failed';

export interface ExportProgressProps {
  state: ExportProgressState;
  /** Frames rendered so far. */
  done: number;
  /** Frames in the whole export. */
  total: number;
  /** Date.now() when the export began; the clock counts from here. */
  startedAt: number;
  /** Failed: the error to show. Done: optional detail such as the file name. */
  message?: string;
  onCancel: () => void;
  onReveal: () => void;
  onRetry: () => void;
  onClose: () => void;
}

const SIZE = 5;
// Chevron wavefront: each dot's delay grows with its column and its distance from
// the middle row, so a > shape drives left to right. The 1000ms cycle is longer
// than the sweep, so one front has cleared before the next arrives.
const WAVE_DELAYS = Array.from({ length: SIZE * SIZE }, (_, i) => {
  const r = Math.floor(i / SIZE);
  const c = i % SIZE;
  return (c + Math.abs(r - 2)) * 90;
});
const cells = (points: [number, number][]) => new Set(points.map(([r, c]) => r * SIZE + c));
const CHECK = cells([[2, 0], [3, 1], [2, 2], [1, 3], [0, 4]]);
const CROSS = cells([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [0, 4], [1, 3], [3, 1], [4, 0]]);

function DotGrid({ state }: { state: ExportProgressState }) {
  const lit = state === 'done' ? CHECK : state === 'failed' ? CROSS : null;
  return (
    <span className="xp-grid" aria-hidden>
      {WAVE_DELAYS.map((delay, i) => (
        <span
          key={i}
          className={`xp-dot${lit?.has(i) ? ' is-on' : ''}`}
          // Running: the wave. Ending: lit dots arrive in a quick left-to-right stagger.
          style={
            state === 'running'
              ? { animationDelay: `${delay}ms` }
              : { transitionDelay: lit?.has(i) ? `${(i % SIZE) * 40}ms` : '0ms' }
          }
        />
      ))}
    </span>
  );
}

/** Milliseconds since `startedAt`, ticking while `running` and frozen once it stops. */
function useElapsed(startedAt: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  const endedAt = useRef<number | null>(running ? null : Date.now());
  if (running) endedAt.current = null;
  else if (endedAt.current === null) endedAt.current = Date.now();

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running, startedAt]);

  return Math.max(0, (endedAt.current ?? now) - startedAt);
}

const frames = new Intl.NumberFormat('en-US');

export function ExportProgress({
  state,
  done,
  total,
  startedAt,
  message,
  onCancel,
  onReveal,
  onRetry,
  onClose,
}: ExportProgressProps) {
  const running = state === 'running';
  const elapsed = useElapsed(startedAt, running);
  const percent = state === 'done' ? 100 : percentDone(done, total);
  const remaining = running ? estimateRemainingMs(done, total, elapsed) : null;
  const clock = formatClock(elapsed);

  let title: string;
  let sub: string;
  if (state === 'done') {
    title = 'Exported';
    sub = message ?? `${frames.format(total)} frames in ${clock}`;
  } else if (state === 'failed') {
    title = 'Export failed';
    sub = `Stopped at ${frames.format(done)} of ${frames.format(total)} frames`;
  } else {
    title = 'Exporting';
    sub = `${frames.format(done)} of ${frames.format(total)} frames`;
  }

  return (
    <section className="xp" data-state={state} aria-label="Export">
      {/* keyed so each state change replays the entrance */}
      <div className="xp-body" key={state}>
        <div className="xp-head">
          <DotGrid state={state} />
          <div className="xp-titles">
            <div className="xp-title" role="status">
              {title}
            </div>
            <div className="xp-sub">{sub}</div>
          </div>
          {state !== 'failed' && (
            <span className="xp-clock" aria-label={`Elapsed ${clock}`}>
              {clock}
            </span>
          )}
        </div>

        {running && (
          <div className="xp-meter">
            <div className="xp-figures">
              <span className="xp-percent">
                {percent}
                <span className="xp-percent-sign">%</span>
              </span>
              {remaining !== null && <span className="xp-eta">{formatEta(remaining)}</span>}
            </div>
            <div
              className="xp-track"
              role="progressbar"
              aria-label="Export progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <span className="xp-fill" style={{ transform: `scaleX(${total > 0 ? Math.min(1, done / total) : 0})` }} />
            </div>
          </div>
        )}

        {state === 'failed' && message && <p className="xp-message">{message}</p>}

        <div className="xp-actions">
          {state === 'running' && (
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {state === 'done' && (
            <>
              <Button variant="secondary" onClick={onReveal}>
                Show in Finder
              </Button>
              <Button variant="primary" onClick={onClose} autoFocus>
                Done
              </Button>
            </>
          )}
          {state === 'failed' && (
            <>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" onClick={onRetry} autoFocus>
                Retry
              </Button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
