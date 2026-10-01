import { describe, expect, it } from 'vitest';
import {
  DUCK_GAIN,
  MIN_ITEM,
  addItem,
  bundleRelative,
  duckRanges,
  effectiveFades,
  fileTimeAt,
  fitToVideo,
  itemExtent,
  itemGainAt,
  itemSpan,
  laneRows,
  musicInputs,
  newAudioItem,
  recordingGainAt,
  removeItem,
  trackProblems,
  trimItemEnd,
  trimItemStart,
  updateItem,
} from '../src/shared/audioTracks';
import { buildExportArgs, musicChain } from '../src/shared/exportArgs';
import { applyOps } from '../src/shared/agentOps';
import { defaultProject, normalizeProject, type AudioItem, type AudioTrack, type Project } from '../src/shared/types';

const item = (patch: Partial<AudioItem> = {}): AudioItem => ({ ...newAudioItem('a', 'audio/a.mp3', 'Song', 10, 2), ...patch });
const track = (items: AudioItem[], patch: Partial<AudioTrack> = {}): AudioTrack => ({ id: 't', kind: 'audio', name: 'Music', muted: false, volume: 1, duck: false, items, ...patch });
const project = (duration = 20): Project =>
  defaultProject({ screenVideoFile: 'screen.mov', sourceKind: 'display', sourceSize: { width: 1920, height: 1080 }, duration });

describe('placement on the output timeline', () => {
  it('plays from start for its trimmed length, cut at the video end', () => {
    expect(itemSpan(item({ sourceIn: 1, sourceOut: 5 }), 30)).toEqual({ start: 2, end: 6 });
    expect(itemSpan(item(), 8)).toEqual({ start: 2, end: 8 });
    // The lane still draws its own length past the end.
    expect(itemExtent(item(), 8)).toEqual({ start: 2, end: 12 });
  });

  it('maps output time to file time, null outside', () => {
    const it2 = item({ sourceIn: 3, sourceOut: 7 });
    expect(fileTimeAt(it2, 2, 30)).toBe(3);
    expect(fileTimeAt(it2, 4.5, 30)).toBe(5.5);
    expect(fileTimeAt(it2, 1.99, 30)).toBeNull();
    expect(fileTimeAt(it2, 6, 30)).toBeNull();
  });

  it('a looped item repeats its part until the video ends', () => {
    const looped = item({ sourceIn: 1, sourceOut: 3, loop: true });
    expect(itemSpan(looped, 9)).toEqual({ start: 2, end: 9 });
    expect(fileTimeAt(looped, 2.5, 9)).toBeCloseTo(1.5);
    expect(fileTimeAt(looped, 4.5, 9)).toBeCloseTo(1.5);
    expect(fileTimeAt(looped, 8.9, 9)).toBeCloseTo(1.9);
    expect(fileTimeAt(looped, 9, 9)).toBeNull();
  });
});

describe('volume, fades and ducking', () => {
  const faded = item({ start: 2, sourceOut: 4, fadeIn: 1, fadeOut: 0.5, gain: 0.8 });
  it('ramps in and out linearly, times track volume and gain', () => {
    const tr = track([faded], { volume: 0.5 });
    expect(itemGainAt(faded, tr, 1.9, 30)).toBe(0);
    expect(itemGainAt(faded, tr, 2, 30)).toBe(0);
    expect(itemGainAt(faded, tr, 2.5, 30)).toBeCloseTo(0.2);
    expect(itemGainAt(faded, tr, 3, 30)).toBeCloseTo(0.4);
    expect(itemGainAt(faded, tr, 5.75, 30)).toBeCloseTo(0.2);
    expect(itemGainAt(faded, tr, 6, 30)).toBe(0);
  });
  it('is silent when the track is muted', () => {
    expect(itemGainAt(faded, track([faded], { muted: true }), 3, 30)).toBe(0);
  });
  it('fades out at the video end when the video cuts the item short', () => {
    // 2s..4.5s plays; the 0.5s fade-out ends at the video end, not the file's.
    expect(effectiveFades(faded, 4.5)).toEqual({ fadeIn: 1, fadeOut: 0.5 });
    expect(itemGainAt(faded, track([faded]), 4.25, 4.5)).toBeCloseTo(0.4);
  });
  it('shrinks fades that would overlap', () => {
    expect(effectiveFades(item({ sourceOut: 1, fadeIn: 1, fadeOut: 1 }), 30)).toEqual({ fadeIn: 0.5, fadeOut: 0.5 });
  });
  it('ducks the recording only under audible items of ducking tracks', () => {
    const a = item({ id: 'a', start: 1, sourceOut: 2 });
    const b = item({ id: 'b', start: 2.5, sourceOut: 2 });
    const c = item({ id: 'c', start: 10, sourceOut: 1 });
    expect(duckRanges([track([a, b, c], { duck: true })], 30)).toEqual([{ start: 1, end: 4.5 }, { start: 10, end: 11 }]);
    expect(duckRanges([track([a], { duck: false })], 30)).toEqual([]);
    expect(duckRanges([track([a], { duck: true, muted: true })], 30)).toEqual([]);
    expect(recordingGainAt([track([a], { duck: true })], 2, 30)).toBe(DUCK_GAIN);
    expect(recordingGainAt([track([a], { duck: true })], 3, 30)).toBe(1);
  });
});

describe('edits', () => {
  it('left-edge trim keeps the sound under it in place', () => {
    const t = trimItemStart(item({ start: 2 }), 3.5);
    expect([t.start, t.sourceIn, t.sourceOut]).toEqual([3.5, 1.5, 10]);
    // can't reach before the file's start or before 0
    expect(trimItemStart(item({ start: 2 }), 0).start).toBe(2);
    expect(trimItemStart(item({ start: 2, sourceIn: 5 }), 0)).toMatchObject({ start: 0, sourceIn: 3 });
    // never shorter than MIN_ITEM
    expect(trimItemStart(item({ start: 2 }), 50)).toMatchObject({ start: 12 - MIN_ITEM });
  });
  it('right-edge trim clamps to the file end and MIN_ITEM', () => {
    expect(trimItemEnd(item({ start: 2 }), 6).sourceOut).toBe(4);
    expect(trimItemEnd(item({ start: 2 }), 60).sourceOut).toBe(10);
    expect(trimItemEnd(item({ start: 2 }), 0).sourceOut).toBe(MIN_ITEM);
  });
  it('fit to video cuts a long file and loops a short one', () => {
    expect(fitToVideo(item({ start: 4 }), 6)).toMatchObject({ start: 0, sourceIn: 0, sourceOut: 6, loop: false });
    expect(fitToVideo(item({ start: 4, sourceIn: 2 }), 6)).toMatchObject({ start: 0, sourceIn: 2, sourceOut: 8 });
    expect(fitToVideo(item({ start: 4, sourceOut: 3 }), 25)).toMatchObject({ start: 0, sourceOut: 10, loop: true });
  });
  it('adds to a music track (made on demand), updates and removes by id', () => {
    let p = project();
    p = addItem(p, item({ id: 'x' }), () => 'track-1');
    p = addItem(p, item({ id: 'y', start: 0 }), () => 'unused');
    expect(p.tracks).toHaveLength(1);
    expect(p.tracks[0].items.map((i) => i.id)).toEqual(['y', 'x']);
    p = updateItem(p, 'x', (i) => ({ ...i, gain: 0.3 }));
    expect(p.tracks[0].items[1].gain).toBe(0.3);
    p = removeItem(p, 'y');
    expect(p.tracks[0].items.map((i) => i.id)).toEqual(['x']);
  });
});

describe('migration', () => {
  it('gives old projects an empty track list', () => {
    const old = project() as Partial<Project>;
    delete old.tracks;
    expect(normalizeProject(old as Project).tracks).toEqual([]);
  });
  it('fills in and clamps track and item fields', () => {
    const p = normalizeProject({ ...project(), tracks: [{ items: [{ file: 'audio/x.wav', sourceOut: 4, gain: 3 }] }] } as unknown as Project);
    expect(p.tracks[0]).toMatchObject({ kind: 'audio', name: 'Music', muted: false, volume: 1, duck: false });
    expect(p.tracks[0].items[0]).toMatchObject({ file: 'audio/x.wav', name: 'x.wav', start: 0, sourceIn: 0, sourceOut: 4, fileDuration: 4, gain: 1, fadeIn: 0, fadeOut: 0, loop: false });
  });
  it('rejects files outside the bundle', () => {
    expect(bundleRelative('audio/a.mp3')).toBe(true);
    expect(bundleRelative('/etc/passwd')).toBe(false);
    expect(bundleRelative('audio/../../x.mp3')).toBe(false);
    expect(trackProblems([track([item({ file: '../x.mp3' })])])).toHaveLength(1);
  });
});

describe('musicInputs', () => {
  it('resolves files, combines volumes, skips muted and silent items', () => {
    const a = item({ id: 'a', gain: 0.5, fadeIn: 1 });
    const silent = item({ id: 'b', gain: 0 });
    expect(musicInputs([track([a, silent], { volume: 0.5 })], '/b/rec.openscreen/', 8)).toEqual([
      { path: '/b/rec.openscreen/audio/a.mp3', delay: 2, sourceIn: 0, sourceOut: 10, loop: false, length: 6, gain: 0.25, fadeIn: 1, fadeOut: 0 },
    ]);
    expect(musicInputs([track([a], { muted: true })], '/b', 8)).toEqual([]);
    // Starts after the video ends: nothing to mix.
    expect(musicInputs([track([item({ start: 9 })])], '/b', 8)).toEqual([]);
  });
});

describe('export filter graph with audio tracks', () => {
  const base = { outPath: '/o.mp4', w: 1920, h: 1080, fps: 30, duration: 8 };
  const song = { path: '/b/audio/a.mp3', delay: 2, sourceIn: 0, sourceOut: 10, loop: false, length: 6, gain: 1, fadeIn: 1, fadeOut: 0 };
  const filterOf = (argv: string[]) => argv[argv.indexOf('-filter_complex') + 1] ?? '';
  const inputsOf = (argv: string[]) => argv.filter((_, i) => argv[i - 1] === '-i');

  it('one music item over a recording with sound', () => {
    const argv = buildExportArgs({ ...base, audioIn: '/b/screen.mov', hasAudio: true, music: [song] });
    expect(inputsOf(argv)).toEqual(['pipe:0', '/b/screen.mov', '/b/audio/a.mp3']);
    expect(filterOf(argv)).toMatchInlineSnapshot(
      `"[2:a]atrim=start=0.000:end=6.000,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=in:st=0:d=1.000,adelay=delays=2000:all=1[m0];anullsrc=r=48000:cl=stereo:d=8.000[bed];[bed][1:a][m0]amix=inputs=3:duration=first:normalize=0[aout]"`,
    );
  });

  it('a recording with no audio track still exports the music', () => {
    const argv = buildExportArgs({ ...base, audioIn: '/b/screen.mov', hasAudio: false, music: [song] });
    expect(filterOf(argv)).toMatch(/\[bed\]\[m0\]amix=inputs=2:duration=first:normalize=0\[aout\]$/);
    expect(argv).toContain('[aout]');
  });

  it('cuts, speed, clicks, ducking and a looped item', () => {
    const argv = buildExportArgs({
      ...base,
      audioIn: '/b/screen.mov',
      hasAudio: true,
      audioClips: [
        { start: 0, end: 3, speed: 1 },
        { start: 5, end: 9, speed: 2 },
      ],
      clicks: [1],
      duck: [{ start: 2, end: 8 }],
      music: [{ ...song, sourceIn: 1, sourceOut: 3, loop: true, gain: 0.5, fadeOut: 0.5 }],
    });
    // pipe, recording, click tick, then the music
    expect(inputsOf(argv)).toEqual(['pipe:0', '/b/screen.mov', expect.stringContaining('aevalsrc'), '/b/audio/a.mp3']);
    expect(filterOf(argv).split(';')).toMatchInlineSnapshot(`
      [
        "[2:a]anull[sfxin]",
        "[sfxin]asplit=1[s0]",
        "[s0]adelay=1000|1000,volume=0.6[c0]",
        "[c0]amix=inputs=1:normalize=0[sfx]",
        "[1:a]atrim=start=0.000:end=3.000,asetpts=PTS-STARTPTS,atempo=1[a0]",
        "[1:a]atrim=start=5.000:end=9.000,asetpts=PTS-STARTPTS,atempo=2[a1]",
        "[a0][a1]concat=n=2:v=0:a=1[cat]",
        "[cat]volume=0.25:enable='between(t,2.000,8.000)'[prog]",
        "[3:a]atrim=start=1.000:end=3.000,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,aloop=loop=-1:size=96000,asetpts=N/SR/TB,atrim=end=6.000,volume=0.5,afade=t=in:st=0:d=1.000,afade=t=out:st=5.500:d=0.500,adelay=delays=2000:all=1[m0]",
        "anullsrc=r=48000:cl=stereo:d=8.000[bed]",
        "[bed][prog][sfx][m0]amix=inputs=4:duration=first:normalize=0[aout]",
      ]
    `);
  });

  it('ducks an identity-timeline recording too, after voice cleanup', () => {
    const argv = buildExportArgs({ ...base, audioIn: '/b/screen.mov', hasAudio: true, voiceCleanup: true, duck: [{ start: 1, end: 2 }], music: [song] });
    expect(filterOf(argv)).toMatch(/^\[1:a\]highpass=.*alimiter=limit=0\.891,volume=0\.25:enable='between\(t,1\.000,2\.000\)'\[prog\]/);
  });

  it('muted tracks never reach ffmpeg (nothing to mix leaves the file silent as before)', () => {
    const music = musicInputs([track([item()], { muted: true })], '/b', 8);
    const argv = buildExportArgs({ ...base, audioIn: '/b/screen.mov', hasAudio: false, music });
    expect(argv).not.toContain('-filter_complex');
  });

  it('a short item cut by the video end trims inside the part that plays', () => {
    expect(musicChain({ ...song, sourceIn: 4, length: 1.5 })).toContain('atrim=start=4.000:end=5.500');
  });
});

describe('agent ops for audio', () => {
  const ctx = { newId: (() => { let n = 0; return () => `id${++n}`; })(), audioFiles: { '/m/song.mp3': { file: 'audio/f1.mp3', name: 'song', duration: 12 } } };

  it('adds, moves, trims, edits, fits and removes', () => {
    let { project: p } = applyOps(project(10), [{ op: 'addAudio', file: '/m/song.mp3', start: 2, fadeIn: 1, volume: 0.6 }], ctx);
    expect(p.tracks).toHaveLength(1);
    expect(p.tracks[0].items[0]).toMatchObject({ file: 'audio/f1.mp3', name: 'song', start: 2, sourceIn: 0, sourceOut: 12, fileDuration: 12, gain: 0.6, fadeIn: 1 });
    p = applyOps(p, [
      { op: 'moveAudio', index: 0, start: 1 },
      { op: 'trimAudio', index: 0, sourceIn: 2, sourceOut: 6 },
      { op: 'editAudio', index: 0, fadeOut: 0.5, loop: true },
      { op: 'audioTrack', muted: true, duck: true, volume: 0.7 },
    ], ctx).project;
    expect(p.tracks[0]).toMatchObject({ muted: true, duck: true, volume: 0.7 });
    expect(p.tracks[0].items[0]).toMatchObject({ start: 1, sourceIn: 2, sourceOut: 6, fadeOut: 0.5, loop: true });
    p = applyOps(p, [{ op: 'fitAudio', index: 0 }], ctx).project;
    expect(p.tracks[0].items[0]).toMatchObject({ start: 0, sourceIn: 2, sourceOut: 12, loop: false });
    p = applyOps(p, [{ op: 'removeAudio', id: p.tracks[0].items[0].id }], ctx).project;
    expect(p.tracks[0].items).toEqual([]);
  });

  it('fails clearly', () => {
    expect(() => applyOps(project(), [{ op: 'addAudio', file: '/nope.mp3' }], ctx)).toThrow(/was not imported/);
    expect(() => applyOps(project(), [{ op: 'moveAudio', index: 0, start: 1 }], ctx)).toThrow(/no audio track 0/);
    const { project: p } = applyOps(project(), [{ op: 'addAudio', file: '/m/song.mp3' }], ctx);
    expect(() => applyOps(p, [{ op: 'trimAudio', index: 0, sourceOut: 30 }], ctx)).toThrow(/past the end/);
    expect(() => applyOps(p, [{ op: 'editAudio', index: 0, fadeIn: -1 }], ctx)).toThrow(/>= 0/);
  });
});

describe('laneRows', () => {
  it('stacks overlapping items and reuses free rows', () => {
    const a = item({ id: 'a', start: 0, sourceOut: 5 });
    const b = item({ id: 'b', start: 3, sourceOut: 3 });
    const c = item({ id: 'c', start: 5, sourceOut: 2 });
    expect(laneRows([a, b, c], 20)).toEqual({ row: { a: 0, b: 1, c: 0 }, count: 2 });
    expect(laneRows([a], 20).count).toBe(1);
    expect(laneRows([], 20).count).toBe(1);
  });
});
