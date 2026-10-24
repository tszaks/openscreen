// Easing for 3D moves. Every curve maps u in 0..1 to a progress with f(0) = 0
// and f(1) = 1 exactly (a spring may overshoot in between). Everything is
// closed-form or uses fixed iteration counts, so the same input gives the
// same bits on every run (export, frames and the preview agree).

import { smootherstep } from '../easing';
import type { Easing } from './model';

const clamp01 = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u);

// ---------------------------------------------------------------------------
// Cubic bezier (CSS `cubic-bezier(x1, y1, x2, y2)`)

const bz = (a: number, b: number, t: number) => {
  // B(t) for control values 0, a, b, 1.
  const u = 1 - t;
  return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
};
const bzD = (a: number, b: number, t: number) => {
  const u = 1 - t;
  return 3 * u * u * a + 6 * u * t * (b - a) + 3 * t * t * (1 - b);
};

const NEWTON_STEPS = 8;
const BISECT_STEPS = 20;

/**
 * The CSS cubic-bezier curve at x = u: solves x(t) = u with 8 Newton steps,
 * falling back to 20 bisection steps when the slope gets flat (|x'| < 1e-6)
 * or Newton did not converge. Fixed counts keep it deterministic. x1 and x2
 * must be in 0..1 (x(t) is then monotone).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let t = u;
  let ok = true;
  for (let i = 0; i < NEWTON_STEPS; i++) {
    const dx = bzD(x1, x2, t);
    if (Math.abs(dx) < 1e-6) {
      ok = false;
      break;
    }
    t -= (bz(x1, x2, t) - u) / dx;
    if (t < 0 || t > 1) {
      ok = false;
      break;
    }
  }
  if (!ok || Math.abs(bz(x1, x2, t) - u) > 1e-7) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < BISECT_STEPS; i++) {
      t = (lo + hi) / 2;
      if (bz(x1, x2, t) < u) lo = t;
      else hi = t;
    }
    t = (lo + hi) / 2;
  }
  return bz(y1, y2, t);
}

/** The named curves' CSS control points. */
export const BEZIER_PRESETS = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  cinematic: [0.7, 0, 0.16, 1],
} as const;

// ---------------------------------------------------------------------------
// Spring (mass 1): ω = √k, ζ = c / (2√k)

const CRITICAL_EPS = 1e-4;

/** The spring's unit step response at τ seconds: 0 at τ = 0, settling at 1. */
export function springX(k: number, c: number, tau: number): number {
  if (tau <= 0) return 0;
  const w = Math.sqrt(k);
  const z = c / (2 * w);
  if (Math.abs(z - 1) < CRITICAL_EPS) return 1 - Math.exp(-w * tau) * (1 + w * tau);
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * tau) * (Math.cos(wd * tau) + ((z * w) / wd) * Math.sin(wd * tau));
  }
  const s = Math.sqrt(z * z - 1);
  const r1 = -w * (z - s);
  const r2 = -w * (z + s);
  return 1 + (r2 * Math.exp(r1 * tau) - r1 * Math.exp(r2 * tau)) / (r1 - r2);
}

/** The monotone bound the settle time is measured on (≥ |1 − x(τ)|). */
function springEnvelope(k: number, c: number, tau: number): number {
  const w = Math.sqrt(k);
  const z = c / (2 * w);
  if (Math.abs(z - 1) < CRITICAL_EPS) return Math.exp(-w * tau) * (1 + w * tau);
  if (z < 1) return Math.exp(-z * w * tau) / Math.sqrt(1 - z * z);
  return 1 - springX(k, c, tau);
}

const settleMemo = new Map<string, number>();

/**
 * Seconds until the spring stays within `tol` of its target: the smallest τ
 * where the monotone envelope is ≤ tol (e^{−ζωτ}/√(1−ζ²) under-damped,
 * e^{−ωτ}(1+ωτ) critical, 1−x over-damped). 60 fixed bisection steps;
 * memoized per (k, c, tol).
 */
export function springSettleTime(k: number, c: number, tol = 1e-3): number {
  const key = `${k}|${c}|${tol}`;
  const hit = settleMemo.get(key);
  if (hit !== undefined) return hit;
  let hi = 1;
  // Bracket by doubling (deterministic: the envelope is monotone decreasing).
  for (let i = 0; i < 64 && springEnvelope(k, c, hi) > tol; i++) hi *= 2;
  let lo = 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (springEnvelope(k, c, mid) > tol) lo = mid;
    else hi = mid;
  }
  if (settleMemo.size > 256) settleMemo.clear();
  settleMemo.set(key, hi);
  return hi;
}

/**
 * The spring fitted to a move of `durationSec`: L = max(D, settle time), and
 * ease(u) = x(u·L) + u·(1 − x(L)), so the end lands exactly. When D ≥ the
 * settle time the move is real physics in seconds (it settles, then holds);
 * a shorter move compresses the whole curve, keeping its shape (same peak
 * overshoot, no kink).
 */
export function springEase(k: number, c: number, u: number, durationSec: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const L = Math.max(Number.isFinite(durationSec) ? durationSec : 0, springSettleTime(k, c));
  return springX(k, c, u * L) + u * (1 - springX(k, c, L));
}

// ---------------------------------------------------------------------------

/**
 * Progress of a move with easing `e` at u (clamped to 0..1) of its
 * `durationSec`-long run. f(0) = 0 and f(1) = 1 exactly.
 */
export function ease(e: Easing, u: number, durationSec: number): number {
  const x = clamp01(Number.isFinite(u) ? u : 0);
  if (x === 0) return 0;
  if (x === 1) return 1;
  switch (e.kind) {
    case 'linear':
      return x;
    case 'smooth':
      return smootherstep(x);
    case 'easeIn':
    case 'easeOut':
    case 'cinematic': {
      const [a, b, c, d] = BEZIER_PRESETS[e.kind];
      return cubicBezier(a, b, c, d, x);
    }
    case 'bezier':
      return cubicBezier(e.x1, e.y1, e.x2, e.y2, x);
    case 'spring':
      return springEase(e.stiffness, e.damping, x, durationSec);
  }
}
