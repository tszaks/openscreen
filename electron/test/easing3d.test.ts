import { describe, expect, it } from 'vitest';
import { cubicBezier, ease, springEase, springSettleTime, springX } from '../src/shared/phone3d/easing3d';
import type { Easing } from '../src/shared/phone3d/model';
import { SPRING_DEFAULT } from '../src/shared/phone3d/model';

// Reference values captured from Chromium itself (Electron 41 / Chrome 146,
// Web Animations getComputedTiming().progress with the given easing) on
// 2026-10-24: /tmp/openscreen-3d/wf/wp1/chromium/main.js.
const CHROMIUM: Record<string, { curve: [number, number, number, number]; pts: [number, number][] }> = {
  easeIn: {
    curve: [0.42, 0, 1, 1],
    pts: [[0.05, 0.0044746153], [0.1, 0.0170266318], [0.2, 0.062282006], [0.3, 0.1295767607], [0.4, 0.2148609387], [0.5, 0.3153567343], [0.6, 0.4291197693], [0.7, 0.5548140325], [0.8, 0.6916339333], [0.9, 0.8394278445], [0.95, 0.9177577844]],
  },
  easeOut: {
    curve: [0, 0, 0.58, 1],
    pts: [[0.05, 0.0822422156], [0.1, 0.1605721555], [0.2, 0.3083660667], [0.3, 0.4451859675], [0.4, 0.5708802307], [0.5, 0.6846432657], [0.6, 0.7851390613], [0.7, 0.8704232393], [0.8, 0.937717994], [0.9, 0.9829733682], [0.95, 0.9955253847]],
  },
  cinematic: {
    curve: [0.7, 0, 0.16, 1],
    pts: [[0.05, 0.0018273316], [0.1, 0.0079146898], [0.2, 0.0383419332], [0.3, 0.1124214248], [0.4, 0.3079343298], [0.5, 0.6862191795], [0.6, 0.8576580421], [0.7, 0.9358636566], [0.8, 0.9758451622], [0.9, 0.9947149856], [0.95, 0.9987535472]],
  },
  custom: {
    curve: [0.25, -0.5, 0.5, 1.6],
    pts: [[0.05, -0.0668514591], [0.1, -0.0741237162], [0.2, 0.0452502051], [0.3, 0.2686854093], [0.4, 0.5219535651], [0.5, 0.7547825136], [0.6, 0.9380523515], [0.7, 1.057349108], [0.8, 1.107245801], [0.9, 1.0873708384], [0.95, 1.051919775]],
  },
};

const KINDS: Easing[] = [
  { kind: 'smooth' },
  { kind: 'linear' },
  { kind: 'easeIn' },
  { kind: 'easeOut' },
  { kind: 'cinematic' },
  { kind: 'spring', ...SPRING_DEFAULT },
  { kind: 'spring', stiffness: 400, damping: 40 },
  { kind: 'spring', stiffness: 50, damping: 100 },
  { kind: 'bezier', x1: 0.3, y1: -0.4, x2: 0.6, y2: 1.5 },
];

const peak = (e: Easing, D: number) => {
  let m = -Infinity;
  for (let i = 0; i <= 2000; i++) m = Math.max(m, ease(e, i / 2000, D));
  return m;
};

describe('ease', () => {
  it('has exact endpoints for every kind (and clamps u)', () => {
    for (const e of KINDS) {
      for (const D of [0.1, 0.5, 2, 10]) {
        expect(ease(e, 0, D)).toBe(0);
        expect(ease(e, 1, D)).toBe(1);
        expect(ease(e, -3, D)).toBe(0);
        expect(ease(e, 7, D)).toBe(1);
      }
    }
  });

  it('is monotone for the non-spring kinds with x/y in 0..1', () => {
    for (const e of KINDS.filter((k) => k.kind !== 'spring' && k.kind !== 'bezier')) {
      let prev = 0;
      for (let i = 1; i <= 1000; i++) {
        const v = ease(e, i / 1000, 1);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = v;
      }
    }
  });

  it('cubic-bezier matches Chromium at 11 points per curve within 1e-4', () => {
    for (const { curve, pts } of Object.values(CHROMIUM)) {
      for (const [x, y] of pts) expect(Math.abs(cubicBezier(...curve, x) - y)).toBeLessThan(1e-4);
    }
    // The named easings are those curves.
    for (const name of ['easeIn', 'easeOut', 'cinematic'] as const) {
      for (const [x, y] of CHROMIUM[name].pts) expect(Math.abs(ease({ kind: name }, x, 1) - y)).toBeLessThan(1e-4);
    }
  });

  it('solves flat-slope curves through the bisection fallback', () => {
    // x'(t) = 0 at t = 0 and 1 when x1 = 0, x2 = 1: Newton alone stalls near the ends.
    const v = cubicBezier(0, 0, 1, 1, 0.001);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(0.01);
    expect(cubicBezier(0, 0, 1, 1, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('spring 180/18 overshoots 2–12%', () => {
    const p = peak({ kind: 'spring', ...SPRING_DEFAULT }, 3);
    expect(p).toBeGreaterThan(1.02);
    expect(p).toBeLessThan(1.12);
  });

  it('a spring with ζ ≥ 1 never goes over 1', () => {
    for (const [k, c] of [[100, 20], [100, 20.0001], [100, 60], [1, 200], [1000, 63.25]]) {
      expect(peak({ kind: 'spring', stiffness: k, damping: c }, 1)).toBeLessThanOrEqual(1 + 1e-12);
      expect(peak({ kind: 'spring', stiffness: k, damping: c }, 0.2)).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it('a short move keeps the same peak overshoot as a long one (the curve is compressed, not cut)', () => {
    const e: Easing = { kind: 'spring', ...SPRING_DEFAULT };
    const T = springSettleTime(SPRING_DEFAULT.stiffness, SPRING_DEFAULT.damping);
    const long = peak(e, T * 2);
    const short = peak(e, T / 4);
    expect(Math.abs(long - short)).toBeLessThan(2e-3);
    // Short: exactly the settle curve squeezed into D (shape kept).
    for (const u of [0.1, 0.3, 0.5, 0.8]) expect(springEase(180, 18, u, T / 4)).toBeCloseTo(springEase(180, 18, u, T), 12);
  });

  it('a long spring is real physics in seconds, then holds', () => {
    const T = springSettleTime(180, 18);
    const D = T * 3;
    // While it moves, x(τ) up to the tiny end residual (≤ 1e-3·u).
    for (const tau of [0.05, 0.2, T * 0.5]) expect(Math.abs(springEase(180, 18, tau / D, D) - springX(180, 18, tau))).toBeLessThan(1.5e-3);
    // After the settle time it is within tolerance of 1.
    for (const u of [0.5, 0.8, 0.99]) expect(Math.abs(springEase(180, 18, u, D) - 1)).toBeLessThan(2e-3);
  });

  it('springSettleTime is the smallest time the envelope is within tol', () => {
    const k = 180;
    const c = 18;
    const T = springSettleTime(k, c);
    const w = Math.sqrt(k);
    const z = c / (2 * w);
    const env = (tau: number) => Math.exp(-z * w * tau) / Math.sqrt(1 - z * z);
    expect(env(T)).toBeLessThanOrEqual(1e-3);
    expect(env(T * 0.999)).toBeGreaterThan(1e-3);
    // Over-damped and critical are finite and positive too.
    expect(springSettleTime(1, 200)).toBeGreaterThan(100);
    expect(springSettleTime(100, 20)).toBeGreaterThan(0);
  });

  it('1000 repeat calls are bit-identical', () => {
    for (const e of KINDS) {
      const ref = ease(e, 0.37, 1.3);
      for (let i = 0; i < 1000; i++) expect(Object.is(ease(e, 0.37, 1.3), ref)).toBe(true);
    }
  });

  it('smooth and cinematic have zero end velocity', () => {
    const h = 1e-4;
    for (const e of [{ kind: 'smooth' }, { kind: 'cinematic' }] as Easing[]) {
      expect(ease(e, h, 1) / h).toBeLessThan(0.01);
      expect((1 - ease(e, 1 - h, 1)) / h).toBeLessThan(0.01);
    }
    // ...and linear does not (the check can fail).
    expect(ease({ kind: 'linear' }, h, 1) / h).toBeCloseTo(1, 6);
  });
});
