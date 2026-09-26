import React, { useLayoutEffect, useRef, useState } from 'react';

// Presentational primitives. No app state lives here: every component is
// controlled by its caller, and styling comes from styles.css.

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'record';

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <button type="button" className={`btn btn-${variant} btn-${size} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className = '',
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/** Measures the active child of a row so one indicator can glide between
 *  options instead of each option fading its own highlight. */
function useGlide(activeIndex: number, count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const el = root.querySelectorAll<HTMLElement>('[data-glide]')[activeIndex];
      setBox(el ? { x: el.offsetLeft, w: el.offsetWidth } : null);
    };
    measure();
    // Placed without motion first; only later changes animate.
    const raf = requestAnimationFrame(() => setReady(true));
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    root.querySelectorAll('[data-glide]').forEach((el) => ro.observe(el));
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [activeIndex, count]);
  const style = box
    ? ({ transform: `translateX(${box.x}px)`, width: box.w } as React.CSSProperties)
    : { opacity: 0 };
  return { ref, style, ready };
}

/** A checkbox styled as a switch. Stays a real <input> so the editor's
 *  keyboard shortcuts keep ignoring it while it has focus. */
export function Switch({
  checked,
  onChange,
  label,
  hint,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  hint?: React.ReactNode;
  title?: string;
}) {
  return (
    <label className="row switch-row" title={title}>
      <span className="row-text">
        <span className="row-label">{label}</span>
        {hint && <span className="row-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/** Range input with its label and live value on one line above the track. */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  title,
}: {
  label: React.ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  title?: string;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <label className="slider" title={title}>
      <span className="slider-head">
        <span className="row-label">{label}</span>
        <span className="slider-value">{format ? format(value) : value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--fill': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(+e.target.value)}
      />
    </label>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = 'md',
  columns,
  label,
  disabled,
}: {
  value: T;
  options: readonly { value: T; label: React.ReactNode; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  columns?: number;
  label?: string;
  disabled?: boolean;
}) {
  const active = options.findIndex((o) => o.value === value);
  const glide = useGlide(columns ? -1 : active, options.length);
  return (
    <div
      ref={glide.ref}
      className={`segmented segmented-${size}${columns ? ' segmented-grid' : ''}${glide.ready ? ' ready' : ''}`}
      role="radiogroup"
      aria-label={label}
      style={columns ? { gridTemplateColumns: `repeat(${columns}, 1fr)` } : undefined}
    >
      {!columns && <span className="segment-thumb" style={glide.style} aria-hidden="true" />}
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          data-glide
          aria-checked={o.value === value}
          className={`segment${o.value === value ? ' on' : ''}`}
          disabled={disabled || o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
}: {
  value: T;
  tabs: readonly { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
}) {
  const glide = useGlide(tabs.findIndex((t) => t.value === value), tabs.length);
  return (
    <div ref={glide.ref} className={`tabs${glide.ready ? ' ready' : ''}`} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          data-glide
          aria-selected={t.value === value}
          className={`tab${t.value === value ? ' on' : ''}`}
          onClick={() => onChange(t.value)}
        >
          {t.label}
        </button>
      ))}
      <span className="tab-indicator" style={glide.style} aria-hidden="true" />
    </div>
  );
}

/** Inspector group: a small heading, optional trailing actions, then content. */
export function Section({
  title,
  actions,
  children,
}: {
  title: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="section">
      <header className="section-head">
        <h3>{title}</h3>
        {actions && <div className="section-actions">{actions}</div>}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function EmptyState({
  title,
  children,
  actions,
  art,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  art?: React.ReactNode;
}) {
  return (
    <div className="empty">
      {art && <div className="empty-art">{art}</div>}
      <p className="empty-title">{title}</p>
      {children && <p className="empty-body">{children}</p>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}

// Small inline icons, used only where a glyph reads faster than a word.
const svg = (d: React.ReactNode, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    {d}
  </svg>
);

export const Icon = {
  play: (s?: number) => svg(<path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.2-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5Z" fill="currentColor" />, s),
  pause: (s?: number) =>
    svg(
      <>
        <rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
        <rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
      </>,
      s,
    ),
  undo: (s?: number) => svg(<path d="M6 3 2.75 6.25 6 9.5M3.25 6.25H10a3.25 3.25 0 0 1 0 6.5H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />, s),
  redo: (s?: number) => svg(<path d="M10 3l3.25 3.25L10 9.5M12.75 6.25H6a3.25 3.25 0 0 0 0 6.5h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />, s),
  chevronDown: (s?: number) => svg(<path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />, s),
  close: (s?: number) => svg(<path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />, s),
  scissors: (s?: number) =>
    svg(
      <>
        <circle cx="4.5" cy="11.5" r="2" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="11.5" cy="11.5" r="2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.8 10 11 2.5M10.2 10 5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </>,
      s,
    ),
};
