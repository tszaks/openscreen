import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addToLibrary, inLibrary, libraryLabel, listLibrary, removeFromLibrary } from '../src/node/imageLibrary';
import { backgroundAfterLibraryRemoval } from '../src/shared/imageLibrary';

const coast = readFileSync(new URL('../resources/wallpapers/coast.jpg', import.meta.url));
const azure = readFileSync(new URL('../resources/wallpapers/azure.jpg', import.meta.url));

let root: string;
let lib: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'os-lib-'));
  lib = join(root, 'Images');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = (name: string, bytes: string | Buffer = coast) => {
  const p = join(root, name);
  writeFileSync(p, bytes);
  return p;
};

describe('Your images library', () => {
  it('copies an upload in, so the background survives the original being deleted', () => {
    const src = file('Sunset at the beach.JPG');
    const img = addToLibrary(src, lib);
    expect(img.name).toMatch(/^Sunset at the beach-[0-9a-f]{8}\.jpg$/);
    expect(img.label).toBe('Sunset at the beach');
    rmSync(src);
    expect(listLibrary(lib).map((i) => i.path)).toEqual([img.path]);
    expect(inLibrary(img.path, lib)).toBe(true);
  });

  it('keeps the same picture once, and different pictures with the same name apart', () => {
    const a = addToLibrary(file('a.png'), lib);
    const again = addToLibrary(file('copy of a.png'), lib);
    expect(again.path).toBe(a.path);
    addToLibrary(file('a2.png', azure), lib);
    expect(listLibrary(lib)).toHaveLength(2);
  });

  it('returns a library file as it is instead of copying it again', () => {
    const a = addToLibrary(file('x.webp'), lib);
    expect(addToLibrary(a.path, lib).path).toBe(a.path);
    expect(readdirSync(lib)).toHaveLength(1);
  });

  it('refuses files that are not images, and lists only images', () => {
    expect(() => addToLibrary(file('notes.txt'), lib)).toThrow(/not an image/);
    addToLibrary(file('ok.heic'), lib);
    writeFileSync(join(lib, '.ok.heic.part'), 'x');
    writeFileSync(join(lib, 'readme.md'), 'x');
    expect(listLibrary(lib).map((i) => i.label)).toEqual(['ok']);
  });

  it('removes by name, and only names inside the library', () => {
    const a = addToLibrary(file('gone.png'), lib);
    expect(() => removeFromLibrary('../gone.png', lib)).toThrow(/not a library image name/);
    removeFromLibrary(a.name, lib);
    expect(listLibrary(lib)).toEqual([]);
    expect(() => removeFromLibrary(a.name, lib)).toThrow(/no image/);
  });

  it('labels strip only the hash', () => {
    expect(libraryLabel('Team-photo-2026-1a2b3c4d.png')).toBe('Team-photo-2026');
    expect(libraryLabel('plain.jpg')).toBe('plain');
  });

  it('is empty when the folder does not exist yet', () => {
    expect(listLibrary(join(root, 'nope'))).toEqual([]);
  });

  it('rejects corrupt uploads before publishing any library entry', () => {
    const source = file('bad.png', 'not an image');
    expect(() => addToLibrary(source, lib)).toThrow(/cannot be read/);
    expect(listLibrary(lib)).toEqual([]);
    expect(readFileSync(source, 'utf8')).toBe('not an image');
    const valid = addToLibrary(file('good.jpg'), lib);
    expect(() => addToLibrary(source, lib)).toThrow(/cannot be read/);
    expect(listLibrary(lib).map(i => i.path)).toEqual([valid.path]);
  });

  it('rejects path aliases and only unlinks a symlink, leaving its target intact', () => {
    const outside = file('outside.png');
    addToLibrary(file('inside.jpg'), lib);
    for (const name of ['../outside.png', outside, 'a/../../outside.png', './outside.png']) {
      expect(() => removeFromLibrary(name, lib)).toThrow(/not a library image name/);
      expect(existsSync(outside)).toBe(true);
    }
    symlinkSync(outside, join(lib, 'link.png'));
    removeFromLibrary('link.png', lib);
    expect(existsSync(outside)).toBe(true);
  });

  it('replaces only the removed selected background with a persistent solid fallback', () => {
    expect(backgroundAfterLibraryRemoval({ kind: 'imageFile', path: '/removed.jpg' }, '/removed.jpg')).toEqual({ kind: 'solid', hex: '#17171c' });
    const other = { kind: 'imageFile' as const, path: '/kept.jpg' };
    expect(backgroundAfterLibraryRemoval(other, '/removed.jpg')).toBe(other);
  });
});
