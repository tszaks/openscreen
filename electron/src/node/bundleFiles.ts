// Bundle side files read the same way by the app (main's loadBundle) and the
// agent CLI, so both see the same data.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CursorSample } from '../shared/types';

/**
 * The bundle's cursor samples (cursor.json `.samples`). The editor gets them
 * from loadBundle and the CLI reads them for zooms, warnings and the Auto 3D
 * plan, so both compute the same focus segments (D5). A missing or unreadable
 * file, or one without a samples list, is [] (iPhone takes have no cursor).
 */
export function readCursorSamples(dir: string): CursorSample[] {
  try {
    const samples = JSON.parse(readFileSync(join(dir, 'cursor.json'), 'utf8'))?.samples;
    return Array.isArray(samples) ? samples : [];
  } catch {
    return [];
  }
}
