// Number math for scrubbable inspector fields (ScrubField).
//
// Values are rounded to the precision of their step rather than to integers,
// so a 1.6x zoom at step 0.1 stays 1.6 and 0.35 at step 0.01 stays 0.35.
// Rounding goes through the decimal string form, which keeps 0.1 + 0.2 from
// surfacing as 0.30000000000000004.

export interface ScrubRange {
  min?: number;
  max?: number;
  step?: number;
}

export interface ScrubModifiers {
  shiftKey?: boolean;
  altKey?: boolean;
}

/** Number of decimal places in `n` as written: 0.1 -> 1, 0.25 -> 2, 1e-3 -> 3, 5 -> 0. */
export function decimalsOf(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const [mantissa, exponent = '0'] = String(Math.abs(n)).toLowerCase().split('e');
  const fraction = mantissa.split('.')[1]?.length ?? 0;
  return Math.max(0, fraction - Number(exponent));
}

/** Round to a fixed number of decimal places without binary float drift. */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const shift = (n: number, by: number) => {
    const [mantissa, exponent = '0'] = String(n).toLowerCase().split('e');
    return Number(`${mantissa}e${Number(exponent) + by}`);
  };
  const rounded = shift(Math.round(shift(value, decimals)), -decimals);
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function clamp(value: number, min = -Infinity, max = Infinity): number {
  return Math.min(max, Math.max(min, value));
}

/** Shift is 10x the step, Alt is 0.1x, Shift wins if both are held. */
export function stepMultiplier(mods: ScrubModifiers = {}): number {
  if (mods.shiftKey) return 10;
  if (mods.altKey) return 0.1;
  return 1;
}

/** The step after modifiers, itself rounded so 0.1 * 0.1 is 0.01, not 0.010000000000000002. */
export function effectiveStep(step = 1, mods: ScrubModifiers = {}): number {
  return roundTo(step * stepMultiplier(mods), decimalsOf(step) + 1);
}

/** Round to the step's precision (or a finer `precisionStep`), then clamp. */
export function normalizeValue(value: number, range: ScrubRange = {}, precisionStep = range.step ?? 1): number {
  if (!Number.isFinite(value)) return clamp(range.min ?? 0, range.min, range.max);
  const decimals = Math.max(decimalsOf(range.step ?? 1), decimalsOf(precisionStep));
  return clamp(roundTo(value, decimals), range.min, range.max);
}

/** One arrow-key press: `direction` is +1 or -1. */
export function nudgeValue(value: number, direction: 1 | -1, range: ScrubRange = {}, mods: ScrubModifiers = {}): number {
  const step = effectiveStep(range.step, mods);
  return normalizeValue(value + direction * step, range, step);
}

/**
 * Raw (unrounded) value change for a horizontal pointer movement of `dx` pixels.
 * `sensitivity` is steps per pixel; the default 0.5 moves one step every 2px.
 * Callers accumulate the raw value and pass it through normalizeValue for display,
 * so slow drags still add up instead of rounding away each tiny movement.
 */
export function scrubDelta(dx: number, step = 1, mods: ScrubModifiers = {}, sensitivity = 0.5): number {
  return dx * sensitivity * effectiveStep(step, mods);
}

/**
 * Default display: one decimal finer than the step (the Alt precision), trailing
 * zeros trimmed. At step 0.1: 1.6 -> "1.6", 1.63 -> "1.63", 2 -> "2".
 */
export function formatScrubValue(value: number, step = 1): string {
  return String(roundTo(value, decimalsOf(effectiveStep(step, { altKey: true }))));
}

const LEADING_NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i;

/** Parse what the user typed. Ignores a trailing unit ("24px", "1.6x", "80%") and thousands commas. */
export function parseScrubInput(text: string): number | null {
  const cleaned = text.replace(/,/g, '').replace(/−/g, '-').trim();
  const match = cleaned.match(LEADING_NUMBER);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}
