// The agent CLI's 3D commands without spawning the app: `frames` argument
// parsing and time planning, its default folder (never the bundle, D10), the
// pose report, `direct`'s flag mapping, needsScenes, and the cursor.json
// reader shared with the app.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultFramesDir, parseFramesArgs, planFrameTimes, poseInfo } from '../src/node/framesCmd';
import { parseDirectArgs } from '../src/node/agentCli';
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

  it('--at: sorted, unique to the millisecond; times at or past the output end are reported, not rendered', () => {
    expect(planFrameTimes(cut(), { kind: 'at', times: [4.25, 2, 2.0001, 0.5, 8, 99] })).toEqual({ times: [0.5, 2, 4.25], past: [8, 99] });
  });

  it('--every: from 0 while inside the output, in output seconds', () => {
    expect(planFrameTimes(cut(), { kind: 'every', step: 3 })).toEqual({ times: [0, 3, 6], past: [] });
    expect(planFrameTimes(cut(), { kind: 'every', step: 0.5 }).times).toHaveLength(16);
    expect(usage(() => planFrameTimes(cut(), { kind: 'every', step: 8 / (MAX_FRAMES + 1) })).code).toBe(2);
  });

  it('--moves: start, middle and end of every move plus every tap, in output time', () => {
    const p = with3d(cut(), { transitions: [move('m1', 1, 2, { turn: 30 }), move('m2', 5, 7.5, { turn: 0 })] });
    p.taps = [
      { id: 't1', t: 1.5, x: 0.5, y: 0.5, kind: 'tap', confidence: 1 },
      { id: 't2', t: 3, x: 0.5, y: 0.5, kind: 'tap', confidence: 1 }, // in the cut: dropped
      { id: 't3', t: 6, x: 0.5, y: 0.5, kind: 'tap', confidence: 1 }, // source 6 = output 4
    ] as typeof p.taps;
    expect(planFrameTimes(p, { kind: 'moves' })).toEqual({ times: [1, 1.5, 2, 4, 5, 6.25, 7.5], past: [] });
  });

  it('--moves on a project with no moves and no taps is a usage error', () => {
    expect(usage(() => planFrameTimes(cut(), { kind: 'moves' })).code).toBe(2);
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
