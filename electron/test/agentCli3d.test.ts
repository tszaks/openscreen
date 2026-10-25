// The agent CLI's 3D commands without spawning the app: `frames` argument
// parsing and time planning, its default folder (never the bundle, D10), the
// pose report, `direct`'s flag mapping, needsScenes, and the cursor.json
// reader shared with the app.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultFramesDir, framesCmd, parseFramesArgs, planFrameTimes, poseInfo } from '../src/node/framesCmd';
import { exportGuard, parseDirectArgs } from '../src/node/agentCli';
import { projectWarnings } from '../src/node/phone3dPlan';
import { needsScenes } from '../src/node/phone3dPlan';
import { readCursorSamples } from '../src/node/bundleFiles';
import { CliError } from '../src/node/cliKit';
import { MAX_FRAMES } from '../src/shared/headless';
import { FRONT } from '../src/shared/phone3d/model';
import { move, phoneProject, with3d } from './helpers/phone3dFixtures';

const scratch = mkdtempSync(join(tmpdir(), 'os3d-wp3-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The CliError a call throws (and its exit code). */
function usage(f: () => unknown): { message: string; code: number } {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return { message: (e as CliError).message, code: (e as CliError).code };
  }
  throw new Error('expected a CliError');
}

describe('frames arguments', () => {
  it('parses each selection and the options', () => {
    expect(parseFramesArgs(['b', '--at', '0.5,2,4.25s'])).toEqual({ bundle: 'b', select: { kind: 'at', times: [0.5, 2, 4.25] }, scale: 1, sheet: false, draft: false });
    expect(parseFramesArgs(['latest', '--every', '0.5s', '--out', '/x', '--scale', '0.5', '--sheet', '--draft', '--timeout', '90', '--app', '/A.app'])).toEqual({
      bundle: 'latest',
      select: { kind: 'every', step: 0.5 },
      out: '/x',
      scale: 0.5,
      sheet: true,
      draft: true,
      timeout: 90,
      app: '/A.app',
    });
    expect(parseFramesArgs(['--moves', 'b']).select).toEqual({ kind: 'moves' });
  });

  it('needs exactly one of --at, --every, --moves (exit 2)', () => {
    expect(usage(() => parseFramesArgs(['b'])).code).toBe(2);
    expect(usage(() => parseFramesArgs(['b', '--at', '1', '--moves'])).code).toBe(2);
    expect(usage(() => parseFramesArgs(['b', '--at', '1', '--every', '2'])).code).toBe(2);
  });

  it('refuses bad values and unknown options (exit 2)', () => {
    for (const argv of [
      ['b', '--at', '1,abc'],
      ['b', '--at', '-1'],
      ['b', '--every', '0'],
      ['b', '--at', '1', '--scale', '2'],
      ['b', '--at', '1', '--scale', '0'],
      ['b', '--at', '1', '--timeout', '-5'],
      ['b', '--at', '1', '--gif'],
      ['b', 'extra', '--at', '1'],
    ]) {
      expect(usage(() => parseFramesArgs(argv)).code, argv.join(' ')).toBe(2);
    }
  });
});

describe('frames times', () => {
  // 10 s take, cut to 8 s of output (2..4 s removed).
  const cut = () => {
    const p = phoneProject({ presetId: 'social-9x16' });
    p.clips = [
      { id: 'a', sourceStart: 0, sourceEnd: 2, speed: 1 },
      { id: 'b', sourceStart: 4, sourceEnd: 10, speed: 1 },
    ];
    return p;
  };

  // social-9x16 exports at 30 fps; 8 s of output = frames 0 … 239 at i / 30.
  const f = (t: number, frame: number) => ({ t, frame, at: frame / 30 });

  it('--at: each time snaps to its export frame round(t·30), drawn at frame / 30; one still per frame; at or past the end is reported, not rendered', () => {
    expect(planFrameTimes(cut(), { kind: 'at', times: [4.25, 2, 2.0001, 0.5, 8, 99] })).toEqual({
      frames: [f(0.5, 15), f(2, 60), f(4.25, 128)],
      past: [8, 99],
      fps: 30,
    });
  });

  it('--at: an off-grid time renders the export frame that shows it, never a picture between frames', () => {
    const { frames } = planFrameTimes(cut(), { kind: 'at', times: [4.25, 4.733, 4.75, 4.7333333333] });
    // 4.25 s is 127.5 frames: frame 128, drawn at 128 / 30 = 4.2667 s (not 4.25).
    expect(frames[0]).toEqual({ t: 4.25, frame: 128, at: 128 / 30 });
    expect(frames[0].at).not.toBe(4.25);
    // A millisecond-rounded frame time still reaches its frame exactly (4.733 → 142 / 30).
    expect(frames[1]).toEqual({ t: 4.733, frame: 142, at: 142 / 30 });
    expect(frames[2]).toEqual({ t: 4.75, frame: 143, at: 143 / 30 });
    expect(frames).toHaveLength(3);
    // The time sent to the app is the export's own double for that frame.
    for (const x of frames) expect(Number(String(x.at))).toBe(x.frame / 30);
  });

  it('--at: a time between the last frame and the end shows the last frame', () => {
    expect(planFrameTimes(cut(), { kind: 'at', times: [7.99] })).toEqual({ frames: [f(7.99, 239)], past: [], fps: 30 });
  });

  it('snaps to the project frame rate when there is no layout preset (outputFPS)', () => {
    const p = cut();
    p.layout.presetId = 'none';
    p.outputFPS = 60;
    expect(planFrameTimes(p, { kind: 'at', times: [4.25, 4.26] })).toEqual({ frames: [{ t: 4.25, frame: 255, at: 255 / 60 }, { t: 4.26, frame: 256, at: 256 / 60 }], past: [], fps: 60 });
  });

  it('--every: from 0 while inside the output, in output seconds', () => {
    expect(planFrameTimes(cut(), { kind: 'every', step: 3 })).toEqual({ frames: [f(0, 0), f(3, 90), f(6, 180)], past: [], fps: 30 });
    expect(planFrameTimes(cut(), { kind: 'every', step: 0.5 }).frames).toHaveLength(16);
    expect(usage(() => planFrameTimes(cut(), { kind: 'every', step: 8 / (MAX_FRAMES + 1) })).code).toBe(2);
  });

  it('--moves: start, middle and end of every move plus every tap, in output time, on the export frames', () => {
    const p = with3d(cut(), { transitions: [move('m1', 1, 2, { turn: 30 }), move('m2', 5, 7.5, { turn: 0 })] });
    p.taps = [
      { id: 't1', t: 1.5, x: 0.5, y: 0.5, kind: 'tap', confidence: 1 },
      { id: 't2', t: 3, x: 0.5, y: 0.5, kind: 'tap', confidence: 1 }, // in the cut: dropped
      { id: 't3', t: 6, x: 0.5, y: 0.5, kind: 'tap', confidence: 1 }, // source 6 = output 4
    ] as typeof p.taps;
    expect(planFrameTimes(p, { kind: 'moves' })).toEqual({
      // The middle of m2 (6.25 s = 187.5 frames) is frame 188.
      frames: [f(1, 30), f(1.5, 45), f(2, 60), f(4, 120), f(5, 150), f(6.25, 188), f(7.5, 225)],
      past: [],
      fps: 30,
    });
  });

  it('--moves on a project with no moves and no taps is a usage error', () => {
    expect(usage(() => planFrameTimes(cut(), { kind: 'moves' })).code).toBe(2);
  });
});

describe('framesCmd with a stand-in app', () => {
  // A fake `OpenScreen --export … --frames …`: records its argv and draws
  // nothing; it reports each time it was sent and the 30 fps frame it falls on.
  const app = join(scratch, 'fake-openscreen');
  const seen = join(scratch, 'fake-argv.json');
  writeFileSync(
    app,
    `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(argv));
const out = argv[argv.indexOf('--out') + 1];
const times = argv[argv.indexOf('--frames') + 1].split(',').map(Number);
const stills = times.map((t) => { const frame = Math.round(t * 30); return { t, frame, at: frame / 30, path: out + '/f-' + frame + '.png' }; });
console.log(JSON.stringify({ ok: true, out, stills, size: { w: 1080, h: 1920 }, gpu: null }));
`,
  );
  chmodSync(app, 0o755);

  it('sends the exact export frame times and reports each still with the time asked, its frame and the frame time', async () => {
    const p = phoneProject({ presetId: 'social-9x16' });
    const dir = join(scratch, 'fc.openscreen');
    mkdirSync(dir, { recursive: true });
    const r = await framesCmd(['b', '--at', '4.75,4.25,1,99', '--out', join(scratch, 'fc-out'), '--app', app], { resolveBundle: () => ({ dir, project: p }) });
    const argv = JSON.parse(readFileSync(seen, 'utf8')) as string[];
    // 1 s → frame 30; 4.25 s → frame 128 (4.2667 s); 4.75 s → frame 143 (4.7667 s); every digit of i / 30.
    expect(argv[argv.indexOf('--frames') + 1]).toBe([30 / 30, 128 / 30, 143 / 30].map(String).join(','));
    expect(r.fps).toBe(30);
    expect(r.files).toEqual([
      { t: 1, frame: 30, at: 1, path: join(scratch, 'fc-out', 'f-30.png'), pose: null, facing: null },
      { t: 4.25, frame: 128, at: 4.266667, path: join(scratch, 'fc-out', 'f-128.png'), pose: null, facing: null },
      { t: 4.75, frame: 143, at: 4.766667, path: join(scratch, 'fc-out', 'f-143.png'), pose: null, facing: null },
      { t: 99, error: 'past the end' },
    ]);
  });
});

describe('frames output folder (D10)', () => {
  it('defaults to <tmp>/openscreen-frames/<bundle>-<stamp>, never the bundle, and never reuses a folder', () => {
    const root = join(scratch, 'openscreen-frames');
    const at = new Date(2026, 9, 24, 15, 30, 5);
    const a = defaultFramesDir('/Users/x/Movies/OpenScreen/rec-17.openscreen', at, root);
    expect(a).toBe(join(root, 'rec-17-20261024-153005'));
    mkdirSync(a, { recursive: true });
    expect(defaultFramesDir('/Users/x/Movies/OpenScreen/rec-17.openscreen', at, root)).toBe(join(root, 'rec-17-20261024-153005-2'));
    expect(defaultFramesDir('/b/My Demo!.openscreen', at, root)).toBe(join(root, 'My-Demo--20261024-153005'));
    expect(defaultFramesDir('/b/x.openscreen', at)).toContain(join(tmpdir(), 'openscreen-frames'));
  });
});

describe('frames pose report', () => {
  it('is null when the phone draws flat', () => {
    expect(poseInfo(phoneProject({ presetId: 'social-9x16' }), 1)).toEqual({ pose: null, facing: null });
    const appStore = with3d(phoneProject({ presetId: 'appstore' }));
    expect(poseInfo(appStore, 1)).toEqual({ pose: null, facing: null });
  });

  it('reports the drawn pose and the facing (1 at FRONT, about cos 60° at a 60° turn)', () => {
    const p = with3d(phoneProject({ presetId: 'social-9x16' }), { transitions: [move('m', 1, 2, { turn: 60 })] });
    p.device.frame = true;
    const front = poseInfo(p, 0.5);
    expect(front.pose).toEqual(FRONT);
    expect(front.facing).toBeCloseTo(1, 2);
    const turned = poseInfo(p, 3);
    expect(turned.pose?.turn).toBe(60);
    expect(turned.facing!).toBeGreaterThan(0.4);
    expect(turned.facing!).toBeLessThan(0.6);
  });
});

describe('direct arguments', () => {
  it('maps --keep and --no-scenes to replace:false and scenes:false (the op and the editor options)', () => {
    expect(parseDirectArgs(['b'])).toEqual({ bundle: 'b', style: 'hero', replace: true, scenes: true, dryRun: false });
    expect(parseDirectArgs(['b', '--keep'])).toMatchObject({ replace: false, scenes: true });
    expect(parseDirectArgs(['b', '--no-scenes'])).toMatchObject({ replace: true, scenes: false });
    expect(parseDirectArgs(['--style', 'bold', 'b', '--keep', '--no-scenes', '--dry-run'])).toEqual({ bundle: 'b', style: 'bold', replace: false, scenes: false, dryRun: true });
    expect(parseDirectArgs(['b', '--style=subtle']).style).toBe('subtle');
  });

  it('refuses an unknown style or option (exit 2)', () => {
    expect(usage(() => parseDirectArgs(['b', '--style', 'wild'])).code).toBe(2);
    expect(usage(() => parseDirectArgs(['b', '--replace'])).code).toBe(2);
  });

  it('needs scene analysis only for a direct op without scenes:false', () => {
    expect(needsScenes([{ op: 'direct', style: 'hero' }])).toBe(true);
    expect(needsScenes([{ op: 'direct', scenes: true }])).toBe(true);
    expect(needsScenes([{ op: 'direct', scenes: false }])).toBe(false);
    expect(needsScenes([{ op: 'phone3d', enabled: true }, { op: 'shot', recipe: 'settle', at: 1 }])).toBe(false);
  });
});

describe('cursor.json (the same samples as the editor, D5)', () => {
  it('reads .samples, and [] for a missing, broken or sample-less file', () => {
    const dir = join(scratch, 'b.openscreen');
    mkdirSync(dir, { recursive: true });
    expect(readCursorSamples(dir)).toEqual([]);
    const samples = [{ t: 0.5, x: 0.2, y: 0.3, kind: 'clickDown' }];
    writeFileSync(join(dir, 'cursor.json'), JSON.stringify({ samples }));
    expect(readCursorSamples(dir)).toEqual(samples);
    writeFileSync(join(dir, 'cursor.json'), '{not json');
    expect(readCursorSamples(dir)).toEqual([]);
    writeFileSync(join(dir, 'cursor.json'), JSON.stringify({ samples: 'nope' }));
    expect(readCursorSamples(dir)).toEqual([]);
  });
});

describe('export guard', () => {
  /** A 9:16 take with a tap at 5 s and the 3D phone turned to its back over 4..5 s. */
  const backAtTap = () => {
    const p = with3d(phoneProject({ presetId: 'social-9x16' }), { transitions: [move('m', 4, 5, { turn: 180 })] });
    p.device.frame = true;
    p.taps = [{ id: 't', t: 5, x: 0.5, y: 0.5, kind: 'tap', confidence: 1 }];
    return p;
  };

  it('refuses an export while a tap is unreadable, with the warnings and their fixes; --force exports anyway', () => {
    const warnings = projectWarnings(backAtTap());
    expect(warnings.some((w) => w.code === 'tap-back')).toBe(true);
    let thrown: (CliError & { extra?: { warnings: unknown[] } }) | null = null;
    try {
      exportGuard(warnings, false);
    } catch (e) {
      thrown = e as CliError & { extra?: { warnings: unknown[] } };
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect(thrown!.code).toBe(1);
    expect(thrown!.message).toMatch(/^export refused: The phone shows its back/);
    expect(thrown!.extra!.warnings).toEqual(warnings.filter((w) => w.code === 'tap-back'));
    expect(() => exportGuard(warnings, true)).not.toThrow();
  });

  it('other warnings never block', () => {
    expect(() => exportGuard([{ code: 'too-fast', message: 'fast' }, { code: 'off-canvas', message: 'out' }], false)).not.toThrow();
    const ok = with3d(phoneProject({ presetId: 'social-9x16' }), { transitions: [move('m', 7, 8, { turn: 180 })] });
    ok.device.frame = true;
    ok.taps = [{ id: 't', t: 5, x: 0.5, y: 0.5, kind: 'tap', confidence: 1 }];
    expect(() => exportGuard(projectWarnings(ok), false)).not.toThrow();
  });
});
