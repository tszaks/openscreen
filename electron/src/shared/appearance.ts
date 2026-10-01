// The window's appearance: follow the system, or pin light or dark
// (View > Appearance). Main applies it through nativeTheme, which is what the
// renderer's prefers-color-scheme follows.

export type Appearance = 'system' | 'light' | 'dark';

export const APPEARANCES: readonly { value: Appearance; label: string }[] = [
  { value: 'system', label: 'Use System Setting' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** The saved choice in appearance.json; anything unreadable means System. */
export function parseAppearance(text: string | null | undefined): Appearance {
  try {
    const v = JSON.parse(text ?? '')?.appearance;
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function serializeAppearance(a: Appearance): string {
  return JSON.stringify({ appearance: a }) + '\n';
}
