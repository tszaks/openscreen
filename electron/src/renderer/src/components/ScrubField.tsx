// Figma-style number field: drag the label or value sideways to scrub, click to
// type an exact value, arrow keys to step (Shift 10x, Alt 0.1x).
//
// Look and interaction adapted from "19-fine-tune-card.tsx" (ScrubField) in
// Beautiful UI - Code Examples, MIT License, Copyright (c) 2026 Shane Levine.
// Rebuilt in plain CSS; its integer Math.round clamp is replaced by step-precision
// rounding in shared/scrub.ts so fractional values like a 1.6x zoom survive.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  clamp,
  effectiveStep,
  formatScrubValue,
  normalizeValue,
  nudgeValue,
  parseScrubInput,
  scrubDelta,
  type ScrubModifiers,
} from '../../../shared/scrub';
import './components.css';

export interface ScrubFieldProps {
  value: number;
  /** Fires on every change while scrubbing, stepping or typing. */
  onChange: (value: number) => void;
  /** Fires once per gesture (pointer-up, key-up, Enter, blur) so undo can coalesce a whole drag. */
  onCommit?: (value: number) => void;
  label: React.ReactNode;
  min?: number;
  max?: number;
  step?: number;
  /** Display text for the value; defaults to the step precision with trailing zeros trimmed. */
  format?: (value: number) => string;
  /** Shown after the value in a quieter colour, e.g. "px", "%", "×". */
  unit?: string;
  /** Steps per pixel dragged. Default 0.5, one step every 2px. */
  sensitivity?: number;
  disabled?: boolean;
  /** Accessible name when `label` is not plain text. */
  ariaLabel?: string;
  className?: string;
}

type Mode = 'idle' | 'scrubbing' | 'editing';

const DRAG_THRESHOLD_PX = 3;
const STEP_KEYS: Record<string, 1 | -1> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };

function mods(e: { shiftKey: boolean; altKey: boolean }): ScrubModifiers {
  return { shiftKey: e.shiftKey, altKey: e.altKey };
}

export function ScrubField({
  value,
  onChange,
  onCommit,
  label,
  min,
  max,
  step = 1,
  format,
  unit,
  sensitivity = 0.5,
  disabled = false,
  ariaLabel,
  className = '',
}: ScrubFieldProps) {
  const range = { min, max, step };
  const [mode, setMode] = useState<Mode>('idle');
  const [draft, setDraft] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The newest value, including ones emitted before the parent re-renders.
  const current = useRef(value);
  useLayoutEffect(() => {
    current.current = value;
  }, [value]);

  const drag = useRef<{ id: number; x: number; raw: number; start: number; moved: boolean } | null>(null);
  const keyStart = useRef<number | null>(null);
  // Refs rather than state so Enter-then-blur cannot finish the same edit twice.
  const editing = useRef(false);
  const selectOnEdit = useRef(false);

  const emit = (next: number) => {
    if (next === current.current) return;
    current.current = next;
    onChange(next);
  };
  const commit = (from: number) => {
    if (current.current !== from) onCommit?.(current.current);
  };

  const display = (v: number) => (format ? format(v) : formatScrubValue(v, step));
  const text = display(value);
  const name = ariaLabel ?? (typeof label === 'string' ? label : undefined);

  // ── pointer: drag to scrub, click to edit ──

  const endScrub = () => {
    document.documentElement.classList.remove('is-scrubbing');
    if (document.pointerLockElement === rootRef.current) document.exitPointerLock();
  };
  useEffect(() => endScrub, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || mode === 'editing' || e.button !== 0) return;
    e.preventDefault(); // no text selection; focus is set by hand below
    rootRef.current?.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, raw: current.current, start: current.current, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    let dx = e.movementX;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x) < DRAG_THRESHOLD_PX) return;
      d.moved = true;
      dx = e.clientX - d.x;
      setMode('scrubbing');
      document.documentElement.classList.add('is-scrubbing');
      // Pointer lock lets a drag run past the screen edge; the capture above is the fallback.
      try {
        const lock = e.currentTarget.requestPointerLock() as unknown;
        if (lock instanceof Promise) lock.catch(() => undefined);
      } catch {
        // not available: keep the pointer capture
      }
    }
    const m = mods(e);
    d.raw = clamp(d.raw + scrubDelta(dx, step, m, sensitivity), min, max);
    emit(normalizeValue(d.raw, range, effectiveStep(step, m)));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved) {
      endScrub();
      setMode('idle');
      commit(d.start);
    } else if (e.type === 'pointerup') {
      startEditing(text);
    }
  };

  // ── typing an exact value ──

  // A click or Enter selects the whole value; typing a digit starts fresh with the caret after it.
  const startEditing = (initial: string, selectAll = true) => {
    if (disabled) return;
    keyStart.current = current.current;
    editing.current = true;
    selectOnEdit.current = selectAll;
    setDraft(initial);
    setMode('editing');
  };

  useLayoutEffect(() => {
    if (mode !== 'editing') return;
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    if (selectOnEdit.current) input?.select();
  }, [mode]);

  const finishEditing = (accept: boolean) => {
    if (!editing.current) return;
    editing.current = false;
    const from = keyStart.current ?? value;
    keyStart.current = null;
    const parsed = accept ? parseScrubInput(draft) : null;
    if (parsed !== null) emit(normalizeValue(parsed, range, effectiveStep(step, { altKey: true })));
    else if (!accept) emit(from);
    setMode('idle');
    commit(from);
    rootRef.current?.focus({ preventScroll: true });
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishEditing(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finishEditing(false);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = nudgeValue(parseScrubInput(draft) ?? current.current, e.key === 'ArrowUp' ? 1 : -1, range, mods(e));
      emit(next);
      setDraft(display(next));
    }
  };

  // ── keyboard on the focused field ──

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || mode !== 'idle' || e.metaKey || e.ctrlKey) return;
    const dir = STEP_KEYS[e.key];
    const edge =
      e.key === 'Home' && min !== undefined ? min : e.key === 'End' && max !== undefined ? max : null;
    if (dir || edge !== null || e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      if (keyStart.current === null) keyStart.current = current.current;
      if (dir) emit(nudgeValue(current.current, dir, range, mods(e)));
      else if (edge !== null) emit(edge);
      else emit(nudgeValue(current.current, e.key === 'PageUp' ? 1 : -1, range, { shiftKey: true }));
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startEditing(text);
    } else if (/^[\d.\-+]$/.test(e.key)) {
      e.preventDefault();
      startEditing(e.key, false);
    }
  };

  const onKeyUp = () => {
    if (mode !== 'idle' || keyStart.current === null) return;
    const from = keyStart.current;
    keyStart.current = null;
    commit(from);
  };

  const hasRange = min !== undefined && max !== undefined && max > min;
  const fraction = hasRange ? clamp((value - min) / (max - min), 0, 1) : 0;

  return (
    <div
      ref={rootRef}
      className={`scrub ${className}`}
      data-state={mode}
      role="spinbutton"
      tabIndex={disabled ? -1 : mode === 'editing' ? -1 : 0}
      aria-label={name}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={unit ? `${text} ${unit}` : text}
      aria-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      {hasRange && <span className="scrub-fill" style={{ transform: `scaleX(${fraction})` }} aria-hidden />}
      <span className="scrub-label">{label}</span>
      {mode === 'editing' ? (
        <input
          ref={inputRef}
          className="scrub-input"
          value={draft}
          inputMode="decimal"
          spellCheck={false}
          aria-label={name ? `${name} value` : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onInputKeyDown}
          onBlur={() => finishEditing(true)}
        />
      ) : (
        <span className="scrub-value" aria-hidden>
          {text}
          {unit && <span className="scrub-unit">{unit}</span>}
        </span>
      )}
    </div>
  );
}
