// Easing curves — the "butter" of the autofocus feature. Screen Studio's
// zoom feels weighty because transitions have zero velocity AND zero
// acceleration at both ends, i.e. smootherstep, optionally with a soft
// critically-damped-spring settle.

/** Classic smoothstep: zero velocity at both ends. */
export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** 5th-order smootherstep: zero velocity AND acceleration at both ends.
 *  This is the curve that makes zooms feel hydraulic. */
export const smootherstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** Critically damped spring approach: fast start, exponential settle.
 *  `stiffness` ~6..12; higher = snappier settle. Slightly overshoot-free. */
export const springSettle = (t: number, stiffness = 8): number => {
  const x = clamp01(t);
  const s = stiffness * x;
  return 1 - Math.exp(-s) * (1 + s);
};

/** Normalized blend of two easing flavors — lets us dial "weight" later. */
export const butterEase = (t: number): number => smootherstep(t);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
