import { app, nativeTheme } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAppearance, serializeAppearance, type Appearance } from '../shared/appearance';

// View > Appearance, remembered in the profile. nativeTheme.themeSource
// drives prefers-color-scheme in every window and the native menus/vibrancy.

const file = () => join(app.getPath('userData'), 'appearance.json');

export function loadAppearance(): Appearance {
  try {
    return parseAppearance(readFileSync(file(), 'utf8'));
  } catch {
    return 'system';
  }
}

export function applyAppearance(a: Appearance, save = false) {
  nativeTheme.themeSource = a;
  if (!save) return;
  try {
    writeFileSync(file(), serializeAppearance(a));
  } catch (e) {
    console.error('could not save the appearance:', e);
  }
}
