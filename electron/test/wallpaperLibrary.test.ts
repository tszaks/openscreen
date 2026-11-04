import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinWallpaperId, builtinWallpaperPath, WALLPAPERS } from '../src/shared/wallpaperLibrary';

describe('wallpaper library', () => {
  it('stores a wallpaper by id and resolves only ids it ships', () => {
    expect(builtinWallpaperId(builtinWallpaperPath('azure'))).toBe('azure');
    expect(builtinWallpaperId('builtin:nope')).toBeNull();
    expect(builtinWallpaperId('/Users/me/pic.jpg')).toBeNull();
  });

  it('ships an image for every wallpaper, with unique ids', () => {
    const ids = WALLPAPERS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(existsSync(join(__dirname, '../resources/wallpapers', `${id}.jpg`)), id).toBe(true);
  });
});
