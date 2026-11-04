// "Your images": backgrounds the user uploaded, kept so they can be used again.
//
// Upload… copies the picked image into one folder. A project stores the copy's
// path, so the background still opens when the original is moved or deleted.
// The folder does not depend on the app's userData (headless exports use a
// throwaway one), so the editor and the agent CLI see the same images.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import type { LibraryImage } from '../shared/imageLibrary';

export type { LibraryImage };

export const LIBRARY_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif'];

export const imageLibraryDir = () =>
  process.env.OPENSCREEN_LIBRARY_DIR || join(homedir(), 'Library', 'Application Support', 'OpenScreen', 'Images');

const isImage = (file: string) => LIBRARY_EXTENSIONS.includes(extname(file).slice(1).toLowerCase());

/** `Sunset-3f9a1c2b.jpg` → `Sunset`. */
export const libraryLabel = (name: string) => basename(name, extname(name)).replace(/-[0-9a-f]{8}$/, '');

/** A safe file stem from an original name: letters, digits, spaces, `-` and `_`. */
const safeStem = (file: string) =>
  basename(file, extname(file)).replace(/[^\p{L}\p{N} _-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Image';

/** Every image in the library, newest first. */
export function listLibrary(dir = imageLibraryDir()): LibraryImage[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && isImage(e.name))
    .map((e) => {
      const path = join(dir, e.name);
      return { name: e.name, label: libraryLabel(e.name), path, added: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.added - a.added);
}

/**
 * Copy `source` into the library and return the copy. The same picture added
 * twice is kept once (the name carries a hash of its bytes); a file already in
 * the library is returned as it is.
 */
export function addToLibrary(source: string, dir = imageLibraryDir()): LibraryImage {
  const src = resolve(source);
  if (!isImage(src)) throw new Error(`not an image OpenScreen can use (${LIBRARY_EXTENSIONS.join(', ')}): ${src}`);
  if (!existsSync(src)) throw new Error(`no such file: ${src}`);
  mkdirSync(dir, { recursive: true });
  if (resolve(dir) === resolve(src, '..')) {
    const name = basename(src);
    return { name, label: libraryLabel(name), path: src, added: statSync(src).mtimeMs };
  }
  const hash = createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 8);
  const ext = extname(src).toLowerCase();
  const existing = listLibrary(dir).find((i) => i.name.endsWith(`-${hash}${ext}`));
  if (existing) return existing;
  const name = `${safeStem(src)}-${hash}${ext}`;
  const path = join(dir, name);
  // Copy to a hidden name first, so a half-written file never shows as a tile.
  const temp = join(dir, `.${name}.part`);
  copyFileSync(src, temp);
  renameSync(temp, path);
  return { name, label: libraryLabel(name), path, added: statSync(path).mtimeMs };
}

/** Delete one image from the library. Projects that use it lose that background. */
export function removeFromLibrary(name: string, dir = imageLibraryDir()): void {
  if (name !== basename(name) || name.startsWith('.') || !isImage(name)) throw new Error(`not a library image name: ${name}`);
  const path = join(dir, name);
  if (!existsSync(path)) throw new Error(`no image "${name}" in the library`);
  rmSync(path);
}

/** True when `path` is a file inside the library folder. */
export const inLibrary = (path: string, dir = imageLibraryDir()) => resolve(path, '..') === resolve(dir);
