// Shared by the editor and node/imageLibrary.ts ("Your images").

export interface LibraryImage {
  /** File name in the library folder, e.g. `Sunset-3f9a1c2b.jpg`. */
  name: string;
  /** What to show under the tile: the original file name without the hash. */
  label: string;
  path: string;
  added: number;
}
