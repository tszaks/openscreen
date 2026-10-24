// Scene changes: the moments the picture changes a lot (ffmpeg's scene score
// above 0.25), in SOURCE seconds. One function for every caller: the CLI's
// `review` (which also saves a keyframe JPEG per change), `direct` and the
// `direct` op's context, and the editor's Auto 3D through main's
// `analyze:scenes` IPC. A bundle's result is cached in
// <bundle>/analysis/scenes.json, keyed by the video's size and mtime, so the
// CLI and the editor share one analysis. The bundle watcher reacts only to
// project.json, so writing the cache never reloads an open editor.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ffmpegPath } from './media';

/** ffmpeg's scene-change score above which a frame counts as a new scene. */
export const SCENE_THRESHOLD = 0.25;
const CACHE_VERSION = 1;

export interface SceneCache {
  version: number;
  /** The video file name inside the bundle. */
  video: string;
  size: number;
  mtimeMs: number;
  threshold: number;
  /** Source seconds, ascending. */
  times: number[];
}

/** Scene keyframes to save as JPEGs while detecting (review's scene-NNN.jpg). */
export interface SceneKeyframes {
  /** Folder for scene-%03d.jpg. */
  dir: string;
  /** JPEG height in px. */
  height: number;
}

export const sceneCachePath = (bundle: string) => join(bundle, 'analysis', 'scenes.json');

/** The ffmpeg arguments: detection only, or detection plus a JPEG per change. */
export function sceneArgs(video: string, keyframes?: SceneKeyframes): string[] {
  const select = `select='gt(scene,${SCENE_THRESHOLD})'`;
  return keyframes
    ? ['-hide_banner', '-i', video, '-an', '-vf', `${select},scale=-2:${keyframes.height},showinfo`, '-vsync', 'vfr', '-q:v', '4', join(keyframes.dir, 'scene-%03d.jpg')]
    : ['-hide_banner', '-i', video, '-an', '-vf', `${select},showinfo`, '-f', 'null', '-'];
}

/** Source seconds from showinfo's `pts_time:` lines, ascending, finite only. */
export function parseSceneTimes(stderr: string): number[] {
  return [...stderr.matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => parseFloat(m[1])).filter((t) => Number.isFinite(t));
}

/** The cached times when the cache matches this video exactly, else null. */
export function readSceneCache(bundle: string, video: string): number[] | null {
  try {
    const c = JSON.parse(readFileSync(sceneCachePath(bundle), 'utf8')) as SceneCache;
    const st = statSync(video);
    const fresh =
      c.version === CACHE_VERSION &&
      c.video === basename(video) &&
      c.size === st.size &&
      c.mtimeMs === st.mtimeMs &&
      c.threshold === SCENE_THRESHOLD &&
      Array.isArray(c.times) &&
      c.times.every((t) => typeof t === 'number' && Number.isFinite(t));
    return fresh ? c.times : null;
  } catch {
    return null;
  }
}

function writeSceneCache(bundle: string, video: string, times: number[]) {
  const st = statSync(video);
  const cache: SceneCache = { version: CACHE_VERSION, video: basename(video), size: st.size, mtimeMs: st.mtimeMs, threshold: SCENE_THRESHOLD, times };
  const file = sceneCachePath(bundle);
  mkdirSync(join(bundle, 'analysis'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, file);
}

export interface SceneOptions {
  /** The bundle `video` belongs to: its analysis/scenes.json cache is used and refreshed. */
  bundle?: string | null;
  bin?: string;
  /** Also save a JPEG per change (review); ffmpeg then always runs. */
  keyframes?: SceneKeyframes;
  /** Save a fresh analysis into the bundle's cache (default true; false for dry runs, which write nothing). */
  writeCache?: boolean;
}

/** ffmpeg's stderr and whether it exited cleanly. */
function runFfmpeg(args: string[], bin: string): Promise<{ stderr: string; ok: boolean; error?: string }> {
  return new Promise((resolve) =>
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024 }, (e, _so, se) => {
      const stderr = String(se ?? '');
      resolve(e ? { stderr, ok: false, error: stderr.trim().split('\n').slice(-2).join(' | ') || e.message } : { stderr, ok: true });
    }),
  );
}

/**
 * Scene-change times of `video` in source seconds. With a `bundle`, a cache
 * that matches the video is used, and a fresh analysis is saved to it unless
 * `writeCache` is false. With `keyframes`, ffmpeg always runs (the JPEGs are
 * needed). Only a clean ffmpeg run is cached: a failed one throws (for
 * keyframes, review's best effort, it returns what ffmpeg printed). A failed
 * cache write never fails the analysis.
 */
export async function sceneTimes(video: string, opts: SceneOptions = {}): Promise<number[]> {
  const { bundle, keyframes, writeCache = true } = opts;
  if (bundle && !keyframes) {
    const cached = readSceneCache(bundle, video);
    if (cached) return cached;
  }
  if (!existsSync(video)) throw new Error(`missing video: ${video}`);
  const run = await runFfmpeg(sceneArgs(video, keyframes), opts.bin ?? ffmpegPath());
  if (!run.ok && !keyframes) throw new Error(`scene detection failed: ${run.error}`);
  const times = parseSceneTimes(run.stderr);
  if (run.ok && bundle && writeCache) {
    try {
      writeSceneCache(bundle, video, times);
    } catch {}
  }
  return times;
}
