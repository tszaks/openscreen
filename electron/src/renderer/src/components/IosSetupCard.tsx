import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../ui';
import { IOS_SETUP_STEPS } from './iosSetup';
import './recording-ux.css';

// The iPhone setup checklist: one calm step at a time, sliding vertically
// between steps while the card's height follows. The layout and motion
// (sliding step stack, rolling step counter, quiet/solid pill actions) are
// adapted from "Approval Card" in Beautiful UI - Code Examples
// (04-approval-card.tsx, MIT), rebuilt in plain CSS.

const LAST = IOS_SETUP_STEPS.length - 1;

const Chevron = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

export function IosSetupCard({
  initialStep = 0,
  message,
  dialog = false,
  onClose,
  onHide,
}: {
  initialStep?: number;
  /** The helper's error, shown above the steps after a failed start. */
  message?: string | null;
  /** Shown over the picker (Escape closes, focus moves in). */
  dialog?: boolean;
  onClose: () => void;
  /** "Don't show again". */
  onHide: () => void;
}) {
  const [step, setStep] = useState(() => Math.min(Math.max(initialStep, 0), LAST));
  const [dir, setDir] = useState<'up' | 'down'>('up');
  const [box, setBox] = useState<{ h: number; y: number } | null>(null);
  // Placed without motion first; only later step changes slide.
  const [animate, setAnimate] = useState(false);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);
  const trackRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const stepNow = useRef(step);
  stepNow.current = step;
  const measure = useCallback(() => {
    const el = stepRefs.current[stepNow.current];
    if (!el) return;
    const next = { h: el.offsetHeight, y: el.offsetTop };
    setBox((prev) => (prev && prev.h === next.h && prev.y === next.y ? prev : next));
  }, []);
  useLayoutEffect(measure, [step, message, measure]);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setAnimate(true));
    // A narrower card rewraps the text, so every step's height can change.
    const ro = new ResizeObserver(measure);
    if (trackRef.current) ro.observe(trackRef.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [measure]);

  const goTo = (next: number) => {
    const clamped = Math.min(Math.max(next, 0), LAST);
    if (clamped === step) return;
    setDir(clamped < step ? 'down' : 'up');
    setStep(clamped);
  };
  const next = () => (step === LAST ? onClose() : goTo(step + 1));

  useEffect(() => {
    if (!dialog) return;
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      goTo(step - 1);
    }
  };

  const card = (
    <div
      ref={cardRef}
      className={`setup-card${dialog ? ' is-dialog' : ''}`}
      role={dialog ? 'dialog' : 'region'}
      aria-modal={dialog || undefined}
      aria-label="iPhone setup"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <button type="button" className="setup-close" aria-label="Close" onClick={onClose}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
      <div className="setup-pad">
        <p className="setup-eyebrow">iPhone setup</p>
        {message && (
          <div className="setup-alert" role="alert">
            <span className="setup-alert-dot" />
            <p>{message}</p>
          </div>
        )}
        <div
          className="setup-viewport"
          style={{ height: box?.h, transition: animate ? undefined : 'none' }}
          aria-live="polite"
        >
          <div
            ref={trackRef}
            className="setup-track"
            style={{ transform: `translate3d(0, ${-(box?.y ?? 0)}px, 0)`, transition: animate ? undefined : 'none' }}
          >
            {IOS_SETUP_STEPS.map((s, i) => {
              const active = i === step;
              return (
                <div
                  key={s.id}
                  ref={(el) => {
                    stepRefs.current[i] = el;
                  }}
                  className={`setup-step${active ? ' active' : ''}`}
                  aria-hidden={active ? undefined : true}
                >
                  <span className="setup-num">{i + 1}</span>
                  <div>
                    <h3 className="setup-title">{s.title}</h3>
                    <p className="setup-body">{s.body}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="setup-foot">
        <div className="setup-nav">
          <button type="button" className="setup-chev" aria-label="Previous step" disabled={step === 0} onClick={() => goTo(step - 1)}>
            <Chevron d="M18 15l-6-6-6 6" />
          </button>
          <span className="setup-count" aria-label={`Step ${step + 1} of ${IOS_SETUP_STEPS.length}`}>
            <span className="setup-count-roll">
              <span key={step} className={`setup-count-num roll-${dir}`}>
                {step + 1}
              </span>
            </span>
            &nbsp;/ {IOS_SETUP_STEPS.length}
          </span>
          <button type="button" className="setup-chev" aria-label="Next step" disabled={step === LAST} onClick={() => goTo(step + 1)}>
            <Chevron d="M6 9l6 6 6-6" />
          </button>
        </div>
        <div className="setup-actions">
          <Button variant="ghost" size="sm" onClick={onHide}>
            Don't show again
          </Button>
          {step > 0 && (
            <Button size="sm" onClick={() => goTo(step - 1)}>
              Back
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={next}>
            {step === LAST ? 'Done' : 'Next'}
          </Button>
        </div>
      </div>
    </div>
  );

  if (!dialog) return card;
  return (
    <div className="setup-overlay">
      <div className="setup-scrim" onClick={onClose} />
      {card}
    </div>
  );
}
