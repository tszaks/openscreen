// One control per value on the 3D tab: the app's ScrubField (drag sideways
// anywhere, click to type, arrows to step) in a track whose fill runs from
// the field's default to the value, with a 1 px tick at the default when it
// sits inside the field and a 2 px handle line at the value. So a fill never
// reads as a share of a field it is not. While you drag, fill and handle
// turn accent (phone3d.css).

import React, { useRef } from 'react';
import { ScrubField } from '../components/ScrubField';
import { minus } from './panelModel';

export interface TrackProps {
  label: string;
  value: number;
  unit?: string;
  /** What the value may be (typing and dragging both stay inside). */
  min: number;
  max: number;
  step?: number;
  /** The part of the range the fill spans (default min..max). */
  soft?: readonly [number, number];
  /** Where the fill starts: the default (default: 0 when the range crosses 0, else the low end). */
  origin?: number;
  /** Digits shown (default: from the step). */
  digits?: number;
  /** Many moves whose values differ: "–", no fill; a drag changes each by the same amount. */
  mixed?: boolean;
  /** Shown instead of the value (e.g. "Auto"), in the placeholder colour. */
  placeholder?: string;
  /** No fill (a length in seconds is not a share of anything). */
  plain?: boolean;
  disabled?: boolean;
  title?: string;
  /** Every change while dragging, stepping or typing. `delta` is the change from where the gesture began. */
  onChange: (value: number, info: { delta: number; typed: boolean }) => void;
  /** The first change of a gesture (the editor holds one undo step). */
  onBegin?: () => void;
  /** The gesture ended (the editor seals the undo step). */
  onCommit?: () => void;
}

const at = (q: number) => `calc(${(q * 100).toFixed(2)}% - ${(q * 2).toFixed(2)}px)`;

export function Track({ label, value, unit, min, max, step = 1, soft, origin, digits, mixed, placeholder, plain, disabled, title, onChange, onBegin, onCommit }: TrackProps) {
  const [lo, hi] = soft ?? [min, max];
  const ref = origin ?? (lo < 0 && hi > 0 ? 0 : lo);
  const pos = (v: number) => (hi > lo ? (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) : 0);
  const f = pos(value);
  const z = pos(ref);
  const a = Math.min(f, z) * 100;
  const b = Math.max(f, z) * 100;
  const tight = unit === '°' || unit === '%';
  const gesture = useRef<{ start: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const dp = digits ?? (step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step) - 1e-9)));
  const showFill = !mixed && !placeholder && !plain;
  return (
    <div
      ref={root}
      className={`p3-track${tight ? ' tight' : ''}${mixed ? ' is-mixed' : ''}${placeholder ? ' is-placeholder' : ''}${disabled ? ' is-off' : ''}`}
      title={title}
      // ScrubField commits only a gesture that changed the value; a new press always starts afresh.
      onPointerDownCapture={() => {
        gesture.current = null;
      }}
    >
      {showFill && (
        <>
          {z > 0.001 && z < 0.999 && <span className="p3-ref" style={{ left: at(z) }} />}
          <span className="p3-fill" style={{ left: `${a.toFixed(2)}%`, width: `${(b - a).toFixed(2)}%` }} />
          <span className="p3-handle" style={{ left: at(f) }} />
        </>
      )}
      <ScrubField
        label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        unit={mixed || placeholder ? undefined : unit}
        disabled={disabled}
        format={(v) => (mixed ? '–' : placeholder ?? minus(v.toFixed(dp)))}
        onChange={(v) => {
          if (!gesture.current) {
            gesture.current = { start: value };
            onBegin?.();
          }
          // A typed value arrives while the field still shows its text input.
          const typed = !!root.current?.querySelector('.scrub-input');
          onChange(v, { delta: v - gesture.current.start, typed });
        }}
        onCommit={() => {
          gesture.current = null;
          onCommit?.();
        }}
      />
    </div>
  );
}

/** A read-only value in the same shape (a fitted spring's "Settles 0.80 s"). */
export function DerivedTrack({ label, text, unit, title, onDoubleClick }: { label: string; text: string; unit?: string; title?: string; onDoubleClick?: () => void }) {
  return (
    <div className="p3-track is-derived" title={title} onDoubleClick={onDoubleClick}>
      <div className="p3-derived">
        <span className="scrub-label">{label}</span>
        <span className="scrub-value">
          {text}
          {unit && <span className="scrub-unit">&thinsp;{unit}</span>}
        </span>
      </div>
    </div>
  );
}
