import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Sheets sit visually under the toolbar, but their overlay must cover the
// whole window: otherwise Save, Export and Undo stay clickable while a
// Reset / Save changes / disk-change question is still open.
const css = (file: string) => readFileSync(join(__dirname, '../src/renderer/src', file), 'utf8');
const block = (text: string, selector: string) => {
  const start = text.indexOf(`${selector} {`);
  expect(start, `${selector} exists`).toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf('}', start));
};

describe('modal overlays cover the toolbar', () => {
  it.each([
    ['styles.css', '.modal-scrim'],
    ['components/recording-ux.css', '.setup-overlay'],
    ['components/ExportPanel.css', '.xp-overlay'],
  ])('%s %s spans the full window', (file, selector) => {
    const b = block(css(file), selector);
    expect(b).toMatch(/position:\s*fixed/);
    expect(b).toMatch(/inset:\s*0;/);
  });
});
