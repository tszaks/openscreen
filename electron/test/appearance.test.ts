import { describe, expect, it } from 'vitest';
import { APPEARANCES, parseAppearance, serializeAppearance } from '../src/shared/appearance';

describe('appearance setting', () => {
  it('round-trips each choice', () => {
    for (const { value } of APPEARANCES) expect(parseAppearance(serializeAppearance(value))).toBe(value);
  });

  it('falls back to the system setting for anything unreadable', () => {
    for (const text of [null, undefined, '', '{', 'null', '{"appearance":"blue"}', '{"appearance":1}', '[]']) {
      expect(parseAppearance(text)).toBe('system');
    }
  });

  it('lists System first, as the menu shows it', () => {
    expect(APPEARANCES.map((a) => a.value)).toEqual(['system', 'light', 'dark']);
  });
});
