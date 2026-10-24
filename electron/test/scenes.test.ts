// Scene changes (node/scenes.ts): one detection for the CLI's review and
// direct and the editor's Auto 3D IPC, cached per bundle in
// analysis/scenes.json and keyed by the video's size and mtime.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSceneTimes, readSceneCache, sceneArgs, sceneCachePath, sceneTimes, SCENE_THRESHOLD } from '../src/node/scenes';
import { ffmpegPath } from '../src/node/media';

const scratch = mkdtempSync(join(tmpdir(), 'os3d-wp3-scenes-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
/** An ffmpeg that cannot run: any call that reaches ffmpeg fails. */
const NO_FFMPEG = join(scratch, 'no-such-ffmpeg');

describe('scene detection arguments and parsing', () => {
  it('runs the review command: scene score above 0.25, showinfo, with or without JPEGs', () => {
    expect(SCENE_THRESHOLD).toBe(0.25);
    expect(sceneArgs('/v.mov')).toEqual(['-hide_banner', '-i', '/v.mov', '-an', '-vf', "select='gt(scene,0.25)',showinfo", '-f', 'null', '-']);
    expect(sceneArgs('/v.mov', { dir: '/r', height: 640 })).toEqual([
      '-hide_banner', '-i', '/v.mov', '-an', '-vf', "select='gt(scene,0.25)',scale=-2:640,showinfo", '-vsync', 'vfr', '-q:v', '4', '/r/scene-%03d.jpg',
    ]);
  });

  it('reads pts_time from showinfo lines', () => {
    const err = '[Parsed_showinfo_1 @ 0x1] n:   0 pts:  30720 pts_time:1.000   duration:512\n[Parsed_showinfo_1 @ 0x1] n:   1 pts: 64000 pts_time:2.0833 x\nframe=  2';
    expect(parseSceneTimes(err)).toEqual([1, 2.0833]);
    expect(parseSceneTimes('no scenes here')).toEqual([]);
  });
});

describe('the bundle cache', () => {
  const bundle = join(scratch, 'cache.openscreen');
  const video = join(bundle, 'screen.mov');
  beforeAll(() => {
    mkdirSync(bundle, { recursive: true });
    writeFileSync(video, 'not really a movie');
  });

  it('is used only while it matches the video (name, size, mtime, threshold, version)', async () => {
    expect(readSceneCache(bundle, video)).toBeNull();
    // Nothing cached and ffmpeg fails: an error, and nothing is cached.
    await expect(sceneTimes(video, { bundle, bin: NO_FFMPEG })).rejects.toThrow('scene detection failed');
    expect(existsSync(sceneCachePath(bundle))).toBe(false);
    // A cache that matches (e.g. written by the editor's IPC) is read, with no ffmpeg run.
    const st = statSync(video);
    const cache = { version: 1, video: 'screen.mov', size: st.size, mtimeMs: st.mtimeMs, threshold: 0.25, times: [1.5, 4] };
    mkdirSync(join(bundle, 'analysis'), { recursive: true });
    writeFileSync(sceneCachePath(bundle), JSON.stringify(cache));
    expect(await sceneTimes(video, { bundle, bin: NO_FFMPEG })).toEqual([1.5, 4]);
    // Any key that does not match makes it stale.
    for (const patch of [{ video: 'other.mov' }, { size: st.size + 1 }, { threshold: 0.3 }, { version: 2 }, { times: ['x'] }]) {
      writeFileSync(sceneCachePath(bundle), JSON.stringify({ ...cache, ...patch }));
      expect(readSceneCache(bundle, video), JSON.stringify(patch)).toBeNull();
    }
    writeFileSync(sceneCachePath(bundle), JSON.stringify(cache));
    expect(readSceneCache(bundle, video)).toEqual([1.5, 4]);
    // The video changes (new mtime): stale.
    utimesSync(video, new Date(2001, 1, 1), new Date(2001, 1, 1));
    expect(readSceneCache(bundle, video)).toBeNull();
    writeFileSync(sceneCachePath(bundle), '{');
    expect(readSceneCache(bundle, video)).toBeNull();
  });

  it('review mode (keyframes) is best effort: a failed ffmpeg gives no times and caches nothing', async () => {
    rmSync(join(bundle, 'analysis'), { recursive: true, force: true });
    expect(await sceneTimes(video, { bundle, bin: NO_FFMPEG, keyframes: { dir: scratch, height: 64 } })).toEqual([]);
    expect(existsSync(join(bundle, 'analysis'))).toBe(false);
  });

});

describe('real detection with the bundled ffmpeg', () => {
  it('finds a hard cut, caches it, and review mode also writes the keyframe JPEG', async () => {
    const bin = ffmpegPath();
    const bundle = join(scratch, 'cut.openscreen');
    mkdirSync(bundle, { recursive: true });
    const video = join(bundle, 'screen.mp4');
    // 1 s of red, then 1 s of blue: one scene change at 1.0 s.
    execFileSync(bin, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x320:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=160x320:r=30:d=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', video]);
    // A dry run analyses but writes nothing into the bundle.
    expect(await sceneTimes(video, { bundle, bin, writeCache: false })).toHaveLength(1);
    expect(existsSync(join(bundle, 'analysis'))).toBe(false);
    const times = await sceneTimes(video, { bundle, bin });
    expect(times).toHaveLength(1);
    expect(times[0]).toBeCloseTo(1, 1);
    expect(readSceneCache(bundle, video)).toEqual(times);
    const jpgs = join(scratch, 'review');
    mkdirSync(jpgs, { recursive: true });
    expect(await sceneTimes(video, { bundle, bin, keyframes: { dir: jpgs, height: 64 } })).toEqual(times);
    expect(readdirSync(jpgs)).toEqual(['scene-001.jpg']);
  }, 30000);
});
