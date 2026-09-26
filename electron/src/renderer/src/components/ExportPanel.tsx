// The Export menu (this project's single export, plus a checklist of formats
// to export in one go) and the task-row card a multi-format export runs in.
//
// The task rows (progress ring, then a check badge or a failed badge with
// retry) are adapted from "06-task-rows.tsx" in Beautiful UI - Code Examples,
// MIT License, Copyright (c) 2026 Shane Levine. Rebuilt in plain CSS.

import React from 'react';
import type { ExportPreset, ExportWarning, PresetId } from '../../../shared/exportPresets';
import { shortName } from '../../../shared/exportJobs';
import { ExportProgress, type ExportProgressProps } from './ExportProgress';
import { Button } from '../ui';
import './ExportPanel.css';

// ───────────────────────── the Export menu ─────────────────────────

/** A preset's validateExport findings, in plain language, under its row. */
function Notes({ notes }: { notes: ExportWarning[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="xpanel-notes">
      {notes.map((w) => (
        <li key={w.code} className="xpanel-note" data-level={w.level}>
          {w.message}
        </li>
      ))}
    </ul>
  );
}

export interface ExportPanelProps {
  /** The project's layout preset, when one is set; the single export uses it. */
  layoutPreset: ExportPreset | null;
  /** Shown when there is no layout preset: today's resolution and fps pickers. */
  singleSettings: React.ReactNode;
  choices: ExportPreset[];
  selected: PresetId[];
  warnings: Partial<Record<PresetId, ExportWarning[]>>;
  disabled: boolean;
  onToggle: (id: PresetId, on: boolean) => void;
  onExportSingle: (gif: boolean) => void;
  onExportFormats: () => void;
}

export function ExportPanel({
  layoutPreset,
  singleSettings,
  choices,
  selected,
  warnings,
  disabled,
  onToggle,
  onExportSingle,
  onExportFormats,
}: ExportPanelProps) {
  const count = selected.length;
  return (
    <div className="menu xpanel" role="dialog" aria-label="Export options">
      <div className="xpanel-section">
        <span className="xpanel-heading">This project</span>
        {layoutPreset ? (
          <>
            <p className="hint">
              Uses the {layoutPreset.label} layout: {layoutPreset.width}x{layoutPreset.height}, {layoutPreset.fps} fps.
            </p>
            <div className="xpanel-flush">
              <Notes notes={warnings[layoutPreset.id] ?? []} />
            </div>
          </>
        ) : (
          singleSettings
        )}
        <div className="xpanel-actions">
          <Button disabled={disabled} onClick={() => onExportSingle(false)}>
            Export MP4
          </Button>
          <Button disabled={disabled} onClick={() => onExportSingle(true)}>
            Export GIF
          </Button>
        </div>
      </div>

      <div className="menu-sep" />

      <div className="xpanel-section">
        <span className="xpanel-heading">Formats</span>
        <ul className="xpanel-list">
          {choices.map((p) => {
            const on = selected.includes(p.id);
            const notes = on ? (warnings[p.id] ?? []) : [];
            return (
              <li key={p.id} className="xpanel-item">
                <label className="xpanel-row">
                  <input
                    type="checkbox"
                    className="check"
                    checked={on}
                    disabled={disabled}
                    onChange={(e) => onToggle(p.id, e.target.checked)}
                  />
                  <span className="xpanel-name">{p.label}</span>
                  <span className="xpanel-size tnum">
                    {p.width}x{p.height}
                    {p.containers.length > 1 ? ` · ${p.containers.join(' + ').toUpperCase()}` : ''}
                  </span>
                </label>
                <Notes notes={notes} />
              </li>
            );
          })}
        </ul>
        <p className="hint">Warnings never block an export. Each format goes into one folder you pick.</p>
        <Button variant="primary" disabled={disabled || count === 0} onClick={onExportFormats}>
          {count === 0 ? 'Pick formats to export' : `Export ${count} format${count === 1 ? '' : 's'}…`}
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────── task rows ─────────────────────────

export type TaskStatus = 'queued' | 'rendering' | 'encoding' | 'done' | 'failed' | 'cancelled' | 'skipped';

export interface TaskRowState {
  preset: ExportPreset;
  status: TaskStatus;
  /** 0..1 across render and encode. */
  progress: number;
  files: string[];
  error?: string;
}

const RING = 24;
const STROKE = 2;
const R = (RING - STROKE) / 2;
const C = 2 * Math.PI * R;

/** Determinate ring: the arc is the row's progress, with the percent inside.
 *  Queued, skipped and cancelled rows show an empty ring. */
function ProgressRing({ status, progress }: { status: TaskStatus; progress: number }) {
  const waiting = status === 'queued' || status === 'skipped' || status === 'cancelled';
  const pct = Math.floor(progress * 100);
  return (
    <span className="xt-ring" data-idle={waiting || undefined}>
      <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} aria-hidden>
        <circle className="xt-ring-track" cx={RING / 2} cy={RING / 2} r={R} />
        {!waiting && (
          <circle
            className="xt-ring-arc"
            cx={RING / 2}
            cy={RING / 2}
            r={R}
            strokeDasharray={`${C * Math.max(0.04, progress)} ${C}`}
          />
        )}
      </svg>
      {!waiting && <span className="xt-ring-pct tnum">{pct}</span>}
    </span>
  );
}

const CheckIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);
const XIcon = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" aria-hidden>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

const STATUS_TEXT: Record<TaskStatus, string> = {
  queued: 'Waiting',
  rendering: 'Rendering',
  encoding: 'Encoding',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

function TaskRow({
  row,
  index,
  busy,
  onReveal,
  onRetry,
}: {
  row: TaskRowState;
  index: number;
  busy: boolean;
  onReveal: () => void;
  onRetry: () => void;
}) {
  const { preset: p, status } = row;
  const ended = status === 'failed' || status === 'cancelled' || status === 'skipped';
  return (
    <li className="xt-row" data-status={status} style={{ animationDelay: `${index * 60}ms` }}>
      <div className="xt-main">
        <span className="xt-badge-slot">
          {status === 'done' ? (
            <span className="xt-badge is-done">{CheckIcon}</span>
          ) : status === 'failed' ? (
            <span className="xt-badge is-failed">{XIcon}</span>
          ) : (
            <ProgressRing status={status} progress={row.progress} />
          )}
        </span>
        <span className="xt-name" title={row.files[0]}>
          {shortName(p.id)}
        </span>
        <span className="xt-size tnum">
          {p.width}x{p.height}
        </span>
        {status === 'done' ? (
          <Button size="sm" variant="ghost" onClick={onReveal}>
            Show in Finder
          </Button>
        ) : ended ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRetry}>
            Retry
          </Button>
        ) : (
          <span className="xt-status">{STATUS_TEXT[status]}</span>
        )}
      </div>
      {status === 'failed' && row.error && <p className="xt-error">{row.error}</p>}
      {(status === 'skipped' || status === 'cancelled') && <p className="xt-error">{STATUS_TEXT[status]}</p>}
    </li>
  );
}

export interface ExportTasksProps {
  rows: TaskRowState[];
  /** The overall header: an ExportProgress over the whole batch. */
  progress: Omit<ExportProgressProps, 'onReveal' | 'onRetry'>;
  onReveal: (path: string) => void;
  onRetry: (ids: PresetId[]) => void;
}

/** A multi-format export: one overall progress card with a row per format. */
export function ExportTasks({ rows, progress, onReveal, onRetry }: ExportTasksProps) {
  const busy = progress.state === 'running';
  const retryable = rows.filter((r) => r.status === 'failed' || r.status === 'cancelled' || r.status === 'skipped');
  const firstFile = rows.find((r) => r.status === 'done')?.files[0];
  return (
    <div className="xt">
      <ExportProgress
        {...progress}
        onReveal={() => firstFile && onReveal(firstFile)}
        onRetry={() => onRetry(retryable.map((r) => r.preset.id))}
      />
      <ul className="xt-list" aria-label="Formats">
        {rows.map((row, i) => (
          <TaskRow
            key={row.preset.id}
            row={row}
            index={i}
            busy={busy}
            onReveal={() => onReveal(row.files[0])}
            onRetry={() => onRetry([row.preset.id])}
          />
        ))}
      </ul>
    </div>
  );
}
