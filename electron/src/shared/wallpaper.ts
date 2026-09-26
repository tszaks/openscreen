// Turning "what's on the desktop" into an image the compositor can draw.
// macOS can report a still image, a dynamic .madesktop bundle, a video, or an
// Aerial (a video that NSWorkspace hides behind the default wallpaper).

/**
 * JXA run by `osascript -l JavaScript`; needs no Automation permission.
 * Prints JSON: `path` from NSWorkspace for the main screen, and `video`, the
 * local Aerial .mov when the desktop is set to an Aerial.
 */
export const WALLPAPER_JXA = `
ObjC.import('AppKit');
const url = $.NSWorkspace.sharedWorkspace.desktopImageURLForScreen($.NSScreen.mainScreen);
const path = url.isNil() ? '' : url.path.js;
let video = '';
try {
  const base = $.NSHomeDirectory().js + '/Library/Application Support/com.apple.wallpaper';
  const store = $.NSDictionary.dictionaryWithContentsOfFile(base + '/Store/Index.plist');
  const choice = store.objectForKey('AllSpacesAndDisplays').objectForKey('Desktop')
    .objectForKey('Content').objectForKey('Choices').objectAtIndex(0);
  if (choice.objectForKey('Provider').js === 'com.apple.wallpaper.choice.aerials') {
    const conf = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(
      choice.objectForKey('Configuration'), 0, null, null);
    const f = base + '/aerials/videos/' + conf.objectForKey('assetID').js + '.mov';
    if ($.NSFileManager.defaultManager.fileExistsAtPath(f)) video = f;
  }
} catch (e) {}
JSON.stringify({ path, video });
`;

export type WallpaperPlan =
  /** Draw this image file (HEIC still goes through the JPEG conversion). */
  | { kind: 'image'; path: string }
  /** Grab a still frame from this video. */
  | { kind: 'frame'; video: string }
  | { kind: 'none' };

const STILL = /\.(heic|heif|jpe?g|png|webp|gif|tiff?|bmp)$/i;
const VIDEO = /\.(mov|mp4|m4v)$/i;

/** Decide where the wallpaper image comes from. `isDirectory` is whether
 *  `path` is a folder (a rotating-folder wallpaper, or a bundle). */
export function planWallpaper(found: { path: string; video: string; isDirectory: boolean }): WallpaperPlan {
  // An Aerial wins: NSWorkspace reports the default still in its place.
  if (found.video) return { kind: 'frame', video: found.video };
  const { path } = found;
  if (!path) return { kind: 'none' };
  // Dynamic wallpapers ship a still thumbnail next to the bundle.
  const dyn = path.match(/^(.*)\/([^/]+)\.madesktop$/i);
  if (dyn) return { kind: 'image', path: `${dyn[1]}/.thumbnails/${dyn[2]}.heic` };
  if (found.isDirectory) return { kind: 'none' };
  if (VIDEO.test(path)) return { kind: 'frame', video: path };
  if (STILL.test(path)) return { kind: 'image', path };
  return { kind: 'none' };
}
