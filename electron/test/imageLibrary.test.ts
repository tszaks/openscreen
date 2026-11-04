import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addToLibrary, inLibrary, libraryLabel, listLibrary, removeFromLibrary } from '../src/node/imageLibrary';

let root: string;
let lib: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'os-lib-'));
  lib = join(root, 'Images');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = (name: string, bytes = name) => {
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
    const a = addToLibrary(file('a.png', 'one'), lib);
    const again = addToLibrary(file('copy of a.png', 'one'), lib);
    expect(again.path).toBe(a.path);
    addToLibrary(file('b/../a2.png', 'two'), lib);
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
});
