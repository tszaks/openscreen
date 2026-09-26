import { describe, expect, it } from 'vitest';
import { interruptedBundles, recoveredProject, recoveryNotice, RECOVERY_QUIET_MS } from '../src/shared/recovery';

const now = 1_800_000_000_000;
const old = now - RECOVERY_QUIET_MS - 1;

describe('interruptedBundles', () => {
  it('finds bundles with screen.mov and no project.json, oldest first', () => {
    const dirs = interruptedBundles(
      [
        { dir: '/r/b.openscreen', files: ['screen.mov'], videoMtimeMs: old },
        { dir: '/r/saved.openscreen', files: ['screen.mov', 'project.json', 'cursor.json'], videoMtimeMs: old },
        { dir: '/r/a.openscreen', files: ['screen.mov', 'audio.wav'], videoMtimeMs: old - 5000 },
        { dir: '/r/webm.openscreen', files: ['screen.webm'] },
        { dir: '/r/empty.openscreen', files: [] },
      ],
      null,
      now,
    );
    expect(dirs).toEqual(['/r/a.openscreen', '/r/b.openscreen']);
  });

  it('skips the take in flight and any movie still being written', () => {
    const dirs = interruptedBundles(
      [
        { dir: '/r/live.openscreen', files: ['screen.mov'], videoMtimeMs: old },
        { dir: '/r/fresh.openscreen', files: ['screen.mov'], videoMtimeMs: now - 2000 },
        { dir: '/r/done.openscreen', files: ['screen.mov'], videoMtimeMs: old },
      ],
      '/r/live.openscreen',
      now,
    );
    expect(dirs).toEqual(['/r/done.openscreen']);
  });

  it('ignores folders that are not bundles and movies with no mtime', () => {
    expect(
      interruptedBundles(
        [
          { dir: '/r/notes', files: ['screen.mov'], videoMtimeMs: old },
          { dir: '/r/x.openscreen', files: ['screen.mov'] },
        ],
        null,
        now,
      ),
    ).toEqual([]);
  });
});

describe('recoveredProject', () => {
  it('makes an iPhone project from what ffmpeg read of the file', () => {
    const p = recoveredProject({ duration: 6.1, size: { width: 1178, height: 2556 } });
    expect(p).not.toBeNull();
    expect(p!.recording).toMatchObject({
      screenVideoFile: 'screen.mov',
      sourceKind: 'iosDevice',
      sourceSize: { width: 1178, height: 2556 },
      duration: 6.1,
    });
    expect(p!.clips).toHaveLength(1);
    expect(p!.clips[0]).toMatchObject({ sourceStart: 0, sourceEnd: 6.1 });
    expect(p!.cameraOverlay.enabled).toBe(false);
  });

  it('refuses a movie that does not play', () => {
    expect(recoveredProject({ duration: null, size: { width: 10, height: 20 } })).toBeNull();
    expect(recoveredProject({ duration: 0, size: { width: 10, height: 20 } })).toBeNull();
    expect(recoveredProject({ duration: 4, size: null })).toBeNull();
    expect(recoveredProject({ duration: 4, size: { width: 0, height: 20 } })).toBeNull();
  });
});

describe('recoveryNotice', () => {
  it('says how many were recovered', () => {
    expect(recoveryNotice(0)).toBeNull();
    expect(recoveryNotice(1)).toBe('Recovered an interrupted recording.');
    expect(recoveryNotice(3)).toBe('Recovered 3 interrupted recordings.');
  });
});
