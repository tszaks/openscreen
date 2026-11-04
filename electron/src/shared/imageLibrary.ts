// Shared by the editor and node/imageLibrary.ts ("Your images").
import type { Background } from './types';

/** A removed image cannot remain selected or appear only from a bitmap cache. */
export function backgroundAfterLibraryRemoval(background: Background, removedPath: string): Background {
  return background.kind === 'imageFile' && background.path === removedPath
    ? { kind: 'solid', hex: '#17171c' }
    : background;
}

export interface LibraryImage {
  /** File name in the library folder, e.g. `Sunset-3f9a1c2b.jpg`. */
  name: string;
  /** What to show under the tile: the original file name without the hash. */
  label: string;
  path: string;
  added: number;
}
