// Wallpapers that ship with the app (electron/resources/wallpapers/<id>.jpg).
// A project stores one as an image background whose path is `builtin:<id>`,
// so the project file stays the same on every Mac; the main process turns
// the id into the real file when the image is drawn.

export interface LibraryWallpaper {
  id: string;
  name: string;
  group: 'flow' | 'glass' | 'scenes';
}

export const WALLPAPERS: LibraryWallpaper[] = [
  { id: 'azure', name: 'Azure', group: 'flow' },
  { id: 'orchid', name: 'Orchid', group: 'flow' },
  { id: 'ember', name: 'Ember', group: 'flow' },
  { id: 'blush', name: 'Blush', group: 'flow' },
  { id: 'lime', name: 'Lime', group: 'flow' },
  { id: 'tide', name: 'Tide', group: 'flow' },
  { id: 'saffron', name: 'Saffron', group: 'flow' },
  { id: 'crimson', name: 'Crimson', group: 'flow' },
  { id: 'chrome', name: 'Chrome', group: 'glass' },
  { id: 'jade', name: 'Jade', group: 'glass' },
  { id: 'amethyst', name: 'Amethyst', group: 'glass' },
  { id: 'amber', name: 'Amber', group: 'glass' },
  { id: 'rose', name: 'Rose', group: 'glass' },
  { id: 'sapphire', name: 'Sapphire', group: 'glass' },
  { id: 'canyon', name: 'Canyon', group: 'scenes' },
  { id: 'alpine', name: 'Alpine', group: 'scenes' },
  { id: 'coast', name: 'Coast', group: 'scenes' },
  { id: 'grove', name: 'Grove', group: 'scenes' },
  { id: 'dune', name: 'Dune', group: 'scenes' },
  { id: 'lagoon', name: 'Lagoon', group: 'scenes' },
];

const PREFIX = 'builtin:';

export const builtinWallpaperPath = (id: string) => `${PREFIX}${id}`;

/** The library id when `path` names a built-in wallpaper that exists, else null. */
export function builtinWallpaperId(path: string): string | null {
  if (!path.startsWith(PREFIX)) return null;
  const id = path.slice(PREFIX.length);
  return WALLPAPERS.some((w) => w.id === id) ? id : null;
}
