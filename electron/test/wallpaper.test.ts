import { describe, expect, it } from 'vitest';
import { planWallpaper } from '../src/shared/wallpaper';

const plan = (path: string, video = '', isDirectory = false) => planWallpaper({ path, video, isDirectory });

describe('planWallpaper', () => {
  it('an Aerial wins over the default still NSWorkspace reports for it', () => {
    expect(plan('/System/Library/CoreServices/DefaultDesktop.heic', '/A/aerials/videos/X.mov')).toEqual({
      kind: 'frame',
      video: '/A/aerials/videos/X.mov',
    });
  });

  it('still images (HEIC included) are used as they are', () => {
    expect(plan('/System/Library/Desktop Pictures/iMac Blue.heic')).toEqual({
      kind: 'image',
      path: '/System/Library/Desktop Pictures/iMac Blue.heic',
    });
    expect(plan('/Users/t/Pictures/beach.JPG').kind).toBe('image');
  });

  it('a dynamic .madesktop uses its still thumbnail', () => {
    expect(plan('/System/Library/Desktop Pictures/Big Sur Coastline.madesktop')).toEqual({
      kind: 'image',
      path: '/System/Library/Desktop Pictures/.thumbnails/Big Sur Coastline.heic',
    });
  });

  it('a video wallpaper becomes a frame grab', () => {
    expect(plan('/Users/t/Movies/loop.mov')).toEqual({ kind: 'frame', video: '/Users/t/Movies/loop.mov' });
  });

  it('nothing, a folder, or an unknown file is unusable', () => {
    expect(plan('')).toEqual({ kind: 'none' });
    expect(plan('/Users/t/Pictures/Rotating', '', true)).toEqual({ kind: 'none' });
    expect(plan('/Users/t/thing.pdf')).toEqual({ kind: 'none' });
  });
});
