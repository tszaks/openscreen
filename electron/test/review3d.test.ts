// scripts/review3d.mjs: the 3D review page, the blinded pairs and the tally
// (SPEC §6.4, docs/EQUAL_TEST.md). The pure parts are tested directly; the
// commands run in a child process against a fake agent CLI (canned JSON,
// tiny PNGs), so no Electron runs and nothing outside a temp folder is
// written.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { createRequire } from 'node:module';
// @ts-expect-error plain .mjs script without types
import { AXES, blindPairs, bundleTaps, compareTimes, esc, matchRefs, mediaSize, nearestShapePreset, pairCanvas, pairFilter, parseArgs, planSvg, prng, quietWindow, sourceToOutput, tallyEqual, tallyLook } from '../scripts/review3d.mjs';

const SCRIPT = join(__dirname, '..', 'scripts', 'review3d.mjs');

const allAxes = (n: number) => Object.fromEntries(AXES.map((a: string) => [a, n]));
const vote = (judge: string, picks: Record<string, string>, ours: Record<string, number> = {}, other = 3) => ({
  judge,
  pairs: Object.fromEntries(Object.entries(picks).map(([id, pick]) => [id, { pick, scores: { L: allAxes(ours[id] ?? 4), R: allAxes(other) } }])),
});

describe('review3d: blinding', () => {
  it('prng is deterministic per seed', () => {
    const a = prng(42);
    const b = prng(42);
    const c = prng(43);
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect(c()).not.toBe(xs[0]);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('blindPairs: same seed, same pages and key; sides vary; the page never names a label', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ a: { label: 'ref', file: `/r/${i}.jpg` }, b: { label: 'ours', file: `/o/${i}.png` } }));
    const one = blindPairs(items, 7);
    expect(blindPairs(items, 7)).toEqual(one);
    expect(blindPairs(items, 8)).not.toEqual(one);
    expect(one.pairs.map((p: any) => p.id)).toEqual(Array.from({ length: 20 }, (_, i) => `pair-${String(i + 1).padStart(2, '0')}`));
    const oursLeft = Object.values(one.key).filter((k: any) => k.L === 'ours').length;
    expect(oursLeft).toBeGreaterThan(3);
    expect(oursLeft).toBeLessThan(17);
    for (const p of one.pairs) {
      const k = one.key[p.id];
      // The key matches the files on each side.
      expect(p[k.L === 'ours' ? 'L' : 'R']).toMatch(/^\/o\//);
      expect(JSON.stringify(p)).not.toMatch(/ours|ref"/);
    }
  });
});

describe('review3d: time and windows', () => {
  const clips = [
    { sourceStart: 2, sourceEnd: 6, speed: 1, outputStart: 0, outputEnd: 4 },
    { sourceStart: 10, sourceEnd: 16, speed: 3, outputStart: 4, outputEnd: 6 },
  ];
  it('sourceToOutput follows cuts and speed; a cut moment is null', () => {
    expect(sourceToOutput(clips, 3)).toBe(1);
    expect(sourceToOutput(clips, 13)).toBe(5);
    expect(sourceToOutput(clips, 8)).toBeNull();
  });

  it('quietWindow prefers a tap-free window inside a wait, else falls back', () => {
    const taps = [1, 2, 9, 10];
    const waits = [{ start: 4, end: 8.5 }];
    expect(quietWindow(taps, waits, 3, 0, 12)).toEqual({ start: 4, free: true });
    expect(quietWindow([0.5, 2, 3.5, 5], [], 3, 0, 6)).toEqual({ start: 0, free: false });
  });

  it('quietWindow accepts a window that starts right after a padded tap (no wait needed)', () => {
    // 0.7..3.7 and 10.5..13.5 are tap-free; the earliest wins.
    expect(quietWindow([0.2, 10], [], 3, 0, 20)).toEqual({ start: 0.7, free: true });
    expect(quietWindow([1, 10], [], 3, 0, 20)).toEqual({ start: 1.5, free: true });
    // Exactly one free start, right after the second tap's pad.
    expect(quietWindow([0.4, 2], [], 3, 0, 5.5)).toEqual({ start: 2.5, free: true });
  });

  it('quietWindow counts a swipe or long press for its whole duration', () => {
    // A 4 s long press at 1 s covers 0.5..5.5: the window starts after it, not at 1.5.
    expect(quietWindow([{ t: 1, duration: 4 }], [], 3, 0, 20)).toEqual({ start: 5.5, free: true });
    expect(quietWindow([{ t: 1, duration: 4 }], [], 3, 0, 8)).toEqual({ start: 0, free: false });
  });

  it('bundleTaps reads every tap from project.json (info lists at most 100), with durations', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ t: i, kind: 'tap', ...(i === 3 ? { duration: 2 } : {}) }));
    const taps = bundleTaps({ taps: many }, many.slice(0, 100));
    expect(taps).toHaveLength(150);
    expect(taps[3]).toEqual({ t: 3, duration: 2 });
    expect(taps[149]).toEqual({ t: 149, duration: 0 });
    expect(bundleTaps({}, [{ t: 4 }])).toEqual([{ t: 4, duration: 0 }]);
  });

  it('compareTimes: shot start/middle/end then taps, deduped, capped, inside the video', () => {
    const t = compareTimes([{ start: 1, end: 2 }], [1.02, 3, 50], 10, 12);
    expect(t).toEqual([1, 1.5, 2, 3]);
    expect(compareTimes([], Array.from({ length: 40 }, (_, i) => i * 0.2), 10, 12)).toHaveLength(12);
  });

  it('matchRefs pairs a reference named after a recipe with it, others round-robin', () => {
    expect(matchRefs(['/x/turn-to-back-rotato.mp4', '/x/a.jpg', '/x/b.jpg'], ['spin-in', 'turn-to-back'])).toEqual([
      { ref: '/x/turn-to-back-rotato.mp4', recipe: 'turn-to-back' },
      { ref: '/x/a.jpg', recipe: 'spin-in' },
      { ref: '/x/b.jpg', recipe: 'turn-to-back' },
    ]);
  });
});

describe('review3d: the pair canvas', () => {
  it('near shapes are centre-cropped to the narrower one; far shapes are padded and flagged as a leak', () => {
    expect(pairCanvas({ w: 1100, h: 1093 }, { w: 1080, h: 1080 })).toEqual({ w: 1080, h: 1080, aspect: 1, diff: 0.006, mode: 'crop', leak: false });
    const far = pairCanvas({ w: 1100, h: 1093 }, { w: 1080, h: 1920 });
    expect(far).toMatchObject({ w: 1080, h: 1920, mode: 'pad', leak: true });
    // Both orders give the same canvas (the side does not change it).
    expect(pairCanvas({ w: 1080, h: 1920 }, { w: 1100, h: 1093 })).toEqual(far);
    expect(pairCanvas({ w: 1080, h: 1920 }, { w: 720, h: 1280 })).toMatchObject({ w: 1080, h: 1920, diff: 0, mode: 'crop' });
    expect(pairFilter(far)).toContain('pad=1080:1920');
    expect(pairFilter(pairCanvas({ w: 100, h: 100 }, { w: 100, h: 104 }))).toMatch(/^crop=.*scale=1080:1124/);
  });

  it('nearestShapePreset picks the 3D layout preset nearest a reference shape', () => {
    expect(nearestShapePreset({ w: 1100, h: 1093 })).toBe('square');
    expect(nearestShapePreset({ w: 1080, h: 1920 })).toBe('social-9x16');
    expect(nearestShapePreset({ w: 1080, h: 1350 })).toBe('feed-4x5');
    expect(nearestShapePreset({ w: 1920, h: 1080 })).toBe('landscape-16x9');
  });
});

describe('review3d: tally', () => {
  const key = { ours: 'ours', pairs: { 'pair-01': { L: 'ours', R: 'ref' }, 'pair-02': { L: 'ours', R: 'ref' }, 'pair-03': { L: 'ours', R: 'ref' } } };
  const judges = ['tyler', 'm1', 'm2', 'm3'];

  it('passes at ≥ 60% preferred-or-tied with every axis ≥ 3 and 4 judges', () => {
    const votes = judges.map((j) => vote(j, { 'pair-01': 'L', 'pair-02': 'tie', 'pair-03': 'R' }));
    const r = tallyLook(key, votes);
    expect(r.preferOrTie).toBe(0.67);
    expect(r.pass).toBe(true);
  });

  it('fails under 60%, with an axis under 3, with too few judges, or with a pair not voted', () => {
    expect(tallyLook(key, judges.map((j) => vote(j, { 'pair-01': 'L', 'pair-02': 'R', 'pair-03': 'R' }))).pass).toBe(false);
    const low = tallyLook(key, judges.map((j) => vote(j, { 'pair-01': 'L', 'pair-02': 'L', 'pair-03': 'L' }, { 'pair-01': 2, 'pair-02': 2, 'pair-03': 3 })));
    expect(low.pass).toBe(false);
    expect(low.lowAxes).toEqual(AXES);
    expect(tallyLook(key, judges.slice(0, 3).map((j) => vote(j, { 'pair-01': 'L', 'pair-02': 'L', 'pair-03': 'L' }))).pass).toBe(false);
    const gap = tallyLook(key, judges.map((j) => vote(j, { 'pair-01': 'L', 'pair-02': 'L' })));
    expect(gap.pass).toBe(false);
    expect(gap.missing).toHaveLength(4);
  });

  it('scores the side the key says is ours, and ignores scores outside 1..5', () => {
    const k = { ours: 'ours', pairs: { 'pair-01': { L: 'ref', R: 'ours' } } };
    const v = { judge: 'x', pairs: { 'pair-01': { pick: 'R', scores: { L: allAxes(1), R: { ...allAxes(5), metal: 9 } } } } };
    const r = tallyLook(k, [v]);
    expect(r.axisMean.glass).toBe(5);
    expect(r.axisMean.metal).toBeNull();
    expect(r.unscoredAxes).toEqual(['metal']);
  });

  it('equal test: agent within 0.5 of the person passes; 0.6 below fails', () => {
    const k = { pairs: { 'pair-01': { L: 'agent', R: 'person' } } };
    // `threes` axes at 3 and the rest at 4: 5 → 3.5, 6 → 3.4 (scores are whole numbers).
    const mix = (threes: number) => Object.fromEntries(AXES.map((a: string, i: number) => [a, i < threes ? 3 : 4]));
    const v = (agent: Record<string, number>) => [{ judge: 'j', pairs: { 'pair-01': { pick: 'R', scores: { L: agent, R: allAxes(4) } } } }];
    expect(tallyEqual(k, v(mix(5)), 'person', 'agent')).toMatchObject({ pass: true, difference: -0.5 });
    expect(tallyEqual(k, v(mix(6)), 'person', 'agent')).toMatchObject({ pass: false, difference: -0.6 });
    expect(tallyEqual(k, v(allAxes(5)), 'person', 'agent').pass).toBe(true);
    expect(tallyEqual(k, [{ judge: 'j', pairs: { 'pair-01': { pick: 'R', scores: { L: allAxes(3.5), R: allAxes(4) } } } }], 'person', 'agent').difference).toBeNull();
  });
});

describe('review3d: page parts and arguments', () => {
  it('planSvg escapes text from the project and places marks inside the axis', () => {
    const svg = planSvg({ D: 10, taps: [5], waits: [{ start: 2, end: 4 }], moves: [{ start: 1, end: 2, label: '<b>x</b>', reason: 'a&b' }], warnings: [{ code: 'tap-back', message: '"hi"', at: 5 }] });
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(svg).toContain('a&amp;b');
    expect(svg).toContain('&quot;hi&quot;');
    expect(esc(`<'&">`)).toBe('&lt;&#39;&amp;&quot;&gt;');
  });

  it('parseArgs: build is the default; bad usage throws', () => {
    expect(parseArgs(['b.openscreen', '--seed', '3', '--no-clips'])).toMatchObject({ sub: 'build', bundle: 'b.openscreen', seed: 3, clips: false, style: 'hero' });
    expect(parseArgs(['tally', '/x', '--equal', 'person,agent'])).toMatchObject({ sub: 'tally', equal: ['person', 'agent'] });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(['b', '--style', 'loud'])).toThrow(/style/);
    expect(() => parseArgs(['pairs', '--a', 'x', '--b', 'y'])).toThrow(/usage/);
    expect(() => parseArgs(['pairs', '--a', 'x', '--b', 'y', '--out', 'o', '--labels', 'a,a'])).toThrow(/labels/);
    expect(() => parseArgs(['b', 'extra'])).toThrow(/unexpected/);
  });
});

// ---------------------------------------------------------------------------
// The commands, end to end, against a fake agent CLI.

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5b0000000049454e44ae426082', 'hex');

const FAKE_AGENT = `#!/usr/bin/env node
import { mkdirSync, writeFileSync, appendFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
const PNG = Buffer.from('${PNG.toString('hex')}', 'hex');
const [cmd, ...a] = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify([cmd, ...a]) + '\\n');
const flag = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
const out = (o) => process.stdout.write(JSON.stringify(o));
const recipes = [['spin-in',1.6],['turn-to-back',3.2],['hero-layback',1.4],['float',0],['settle',1]].map(([name, duration]) => ({ name, duration, summary: '', use: '' }));
if (cmd === 'info') out({ ok: true, source: { kind: process.env.FAKE_KIND || 'iosDevice', duration: 30 }, outputDuration: 20,
  clips: [{ sourceStart: 0, sourceEnd: 20, speed: 1, outputStart: 0, outputEnd: 20 }],
  taps: { items: [{ t: 2 }, { t: 9 }] }, waits: [{ start: 12, end: 18 }], shotRecipes: recipes,
  transitions: [{ start: 13, end: 14.4, recipe: 'hero-layback', easing: { kind: 'cinematic' } }] });
else if (cmd === 'apply') out({ ok: true, warnings: a[1].includes('turn-to-back') ? [{ code: 'tap-back', message: 'm', at: 1 }] : [] });
else if (cmd === 'direct') out({ ok: true, shots: [{ recipe: 'hero-layback', start: 13, end: 14.4, reason: 'middle; quiet wait' }], warnings: [] });
else if (cmd === 'validate') out({ ok: true, problems: [], warnings: [{ code: 'over-zoom', message: '<zoom>', at: 13.5 }] });
else if (cmd === 'frames') {
  const dir = flag('--out'); mkdirSync(dir, { recursive: true });
  const ts = flag('--at') ? flag('--at').split(',').map(Number) : Array.from({ length: 12 }, (_, i) => i * Number(flag('--every')));
  const files = ts.map((t) => { const p = join(dir, 'f-' + t.toFixed(3) + '.png'); copyFileSync(process.env.FAKE_PNG, p); return { t, path: p, facing: 1 }; });
  let sheet = null; if (a.includes('--sheet')) { sheet = join(dir, 'sheet.png'); writeFileSync(sheet, PNG); }
  out({ ok: true, files, sheet, gpu: 'Fake GPU' });
} else if (cmd === 'export') { const f = flag('--out'); mkdirSync(dirname(f), { recursive: true }); copyFileSync(process.env.FAKE_MP4, f); out({ ok: true, wallSeconds: 1, probe: { file: f } }); }
else if (cmd === 'review') { const d = a[0] + '.review'; mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'sheet-01.png'), PNG); out({ ok: true, sheets: [{ path: join(d, 'sheet-01.png') }] }); }
else { out({ ok: false, error: 'fake: unknown ' + cmd }); process.exit(1); }
`;

let root: string;
let agent: string;
let bundle: string;
let logFile: string;

// Real media (ffmpeg-static, as the app bundles it): our frames are 108x192 PNGs and our clips 108x192 mp4s;
// the references are a 110x109 JPEG (a near-square capture) and other shapes, so the pair files must be re-encoded.
const FFMPEG: string = createRequire(__filename)('ffmpeg-static');
function makeMedia(file: string, w: number, h: number, video = false) {
  const src = ['-f', 'lavfi', '-i', `testsrc=size=${w}x${h}:rate=30:duration=${video ? 0.5 : 0.04}`];
  const enc = video ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] : ['-frames:v', '1'];
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...src, ...enc, file]);
  if (r.status !== 0) throw new Error(`ffmpeg could not make ${file}: ${r.stderr}`);
  return file;
}
let fakePng: string;
let fakeMp4: string;

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, FAKE_LOG: logFile, FAKE_PNG: fakePng, FAKE_MP4: fakeMp4, ...env }, encoding: 'utf8' });
  return { code: r.status ?? -1, out: JSON.parse(r.stdout), stderr: r.stderr };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'openscreen-review3d-'));
  agent = join(root, 'agent.mjs');
  writeFileSync(agent, FAKE_AGENT);
  logFile = join(root, 'calls.log');
  bundle = join(root, 'src', 'take.openscreen');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'project.json'), '{"name":"take"}');
  fakePng = makeMedia(join(root, 'ours.png'), 108, 192);
  fakeMp4 = makeMedia(join(root, 'ours.mp4'), 108, 192, true);
  mkdirSync(join(root, 'refs'));
  makeMedia(join(root, 'refs', 'a.jpg'), 110, 109);
  makeMedia(join(root, 'refs', 'spin-in-rotato.png'), 90, 160);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Both sides of every pair: one extension, one pixel size, and nothing else (a judge cannot tell them apart by the file). */
async function expectSameShape(dir: string, ids: string[]) {
  for (const id of ids) {
    const [L, R] = ['L', 'R'].map((side) => readdirSync(dir).find((f) => f.startsWith(`${id}-${side}.`) && !f.endsWith('.review'))!);
    expect(extname(L), id).toBe(extname(R));
    const [sl, sr] = await Promise.all([mediaSize(join(dir, L)), mediaSize(join(dir, R))]);
    expect(sl, id).not.toBeNull();
    expect(sl, id).toEqual(sr);
  }
}

// Each build spawns ~25 child processes: on a busy machine that takes far longer than vitest's 5 s default.
describe('review3d: commands (fake agent)', { timeout: 120_000 }, () => {
  it('build: works on clones only, writes the page, the key and the judge files; never renders the original', async () => {
    writeFileSync(logFile, '');
    const out = join(root, 'run1');
    const { code, out: r } = run([bundle, '--out', out, '--agent', agent, '--refs', join(root, 'refs'), '--seed', '5', '--draft']);
    expect(code, JSON.stringify(r)).toBe(0);
    expect(r).toMatchObject({ ok: true, compare: 5, pairs: 2, gpu: 'Fake GPU', warnings: 1 });
    expect(r.recipes.map((x: any) => x.recipe)).toEqual(['spin-in', 'turn-to-back', 'hero-layback', 'settle', 'float']);
    expect(r.recipes.every((x: any) => x.frames === 12 && x.clip)).toBe(true);
    const calls = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // Only `info` reads the original; every edit and render targets a clone in the run folder.
    for (const c of calls.filter((c) => c[0] !== 'info' && c[0] !== 'review')) expect(c[1].startsWith(join(out, 'work'))).toBe(true);
    expect(calls.filter((c) => c[1] === bundle).map((c) => c[0])).toEqual(['info']);
    // Recipe takes: a tap-free window inside the wait, the shot at 0.3 s, frames at --draft.
    const setup = calls.find((c) => c[0] === 'apply' && c[2].includes('"recipe":"hero-layback"'));
    expect(JSON.parse(setup[2])[0]).toEqual({ op: 'trim', start: 12, end: 15 });
    // --draft is for the review stills; the blinded pairs are always at export quality (checked below).
    expect(calls.filter((c) => c[0] === 'frames' && !c[1].includes('/pair-')).every((c) => c.includes('--draft'))).toBe(true);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    for (const s of ['Flat vs 3D', 'Auto 3D plan over the taps', 'Recipes', 'Warnings', 'Timings', 'Blinded pairs', 'middle; quiet wait', '&lt;zoom&gt;', 'data-theme']) expect(html).toContain(s);
    expect(html).not.toMatch(/\bours\b|refs\/|rotato/); // nothing in the page gives the sides away
    const key = JSON.parse(readFileSync(join(out, 'key.json'), 'utf8'));
    expect(Object.keys(key.pairs)).toEqual(['pair-01', 'pair-02']);
    const placed = readdirSync(join(out, 'pairs')).filter((f) => !f.endsWith('.review'));
    expect(placed.sort()).toEqual(['pair-01-L.png', 'pair-01-R.png', 'pair-02-L.png', 'pair-02-R.png']);
    // Ours is rendered again per pair, on the 3D layout preset nearest the reference's shape, at export quality.
    const pairSetups = calls.filter((c) => c[0] === 'apply' && c[2].startsWith('[{"op":"layout"'));
    expect(pairSetups.map((c) => JSON.parse(c[2])[0].presetId).sort()).toEqual(['social-9x16', 'square']);
    const pairStills = calls.filter((c) => c[0] === 'frames' && c.includes('--at') && c[1].includes('/pair-'));
    expect(pairStills).toHaveLength(2);
    for (const c of pairStills) expect(c).not.toContain('--draft');
    await expectSameShape(join(out, 'pairs'), ['pair-01', 'pair-02']);
    expect(r.pairShapes.map((x: any) => x.id)).toEqual(['pair-01', 'pair-02']);
    const tpl = JSON.parse(readFileSync(join(out, 'judge-template.json'), 'utf8'));
    expect(Object.keys(tpl.pairs)).toEqual(['pair-01', 'pair-02']);
    expect(readFileSync(join(out, 'judge-brief.md'), 'utf8')).toContain('pairs/pair-01-L');
  });

  it('build refuses a take that is not an iPhone take, and a folder that is not a bundle', () => {
    expect(run([bundle, '--out', join(root, 'run2'), '--agent', agent], { FAKE_KIND: 'display' }).code).toBe(2);
    expect(run([join(root, 'refs'), '--out', join(root, 'run3'), '--agent', agent]).code).toBe(2);
  });

  it('pairs + tally --equal: the equal test end to end', async () => {
    const out = join(root, 'equal');
    mkdirSync(join(root, 'person'));
    mkdirSync(join(root, 'agentclip'));
    makeMedia(join(root, 'person', 'out.mp4'), 108, 192, true);
    makeMedia(join(root, 'agentclip', 'out.mp4'), 72, 128, true);
    const made = run(['pairs', '--a', join(root, 'person', 'out.mp4'), '--b', join(root, 'agentclip', 'out.mp4'), '--labels', 'person,agent', '--out', out, '--seed', '1', '--agent', agent]);
    expect(made.code, JSON.stringify(made.out)).toBe(0);
    expect(readdirSync(join(out, 'pairs')).filter((f) => !f.endsWith('.review')).sort()).toEqual(['pair-01-L.mp4', 'pair-01-R.mp4']);
    await expectSameShape(join(out, 'pairs'), ['pair-01']);
    expect(made.out.pairShapes[0]).toMatchObject({ w: 1080, h: 1920, mode: 'crop', leak: false });
    const key = JSON.parse(readFileSync(join(out, 'key.json'), 'utf8'));
    const side = key.pairs['pair-01'].L === 'agent' ? 'L' : 'R';
    const other = side === 'L' ? 'R' : 'L';
    // Without the key, tally refuses.
    renameSync(join(out, 'key.json'), join(root, 'key.json'));
    expect(run(['tally', out, '--equal', 'person,agent']).code).toBe(2);
    renameSync(join(root, 'key.json'), join(out, 'key.json'));
    for (const [j, agentScore] of [['j1', 4], ['j2', 3]] as const) {
      writeFileSync(join(out, 'votes', `${j}.json`), JSON.stringify({ judge: j, pairs: { 'pair-01': { pick: other, scores: { [side]: allAxes(agentScore), [other]: allAxes(4) } } } }));
    }
    const t = run(['tally', out, '--equal', 'person,agent']);
    expect(t.out).toMatchObject({ ok: true, judges: 2, mean: { person: 4, agent: 3.5 }, difference: -0.5, pass: true });
    writeFileSync(join(out, 'votes', 'j3.json'), JSON.stringify({ judge: 'j3', pairs: { 'pair-01': { pick: other, scores: { [side]: allAxes(1), [other]: allAxes(5) } } } }));
    expect(run(['tally', out, '--equal', 'person,agent']).out.pass).toBe(false);
  });

  it('pairs refuses a clip paired with a still (the kind alone gives the side away)', () => {
    mkdirSync(join(root, 'mixA'));
    mkdirSync(join(root, 'mixB'));
    makeMedia(join(root, 'mixA', 'x.mp4'), 108, 192, true);
    makeMedia(join(root, 'mixB', 'x.png'), 108, 192);
    const r = run(['pairs', '--a', join(root, 'mixA'), '--b', join(root, 'mixB'), '--out', join(root, 'mix'), '--seed', '1', '--agent', agent]);
    expect(r.code).toBe(2);
    expect(r.out.error).toMatch(/one side is a clip and the other a still/);
  });

  it('build with a clip reference and --no-clips reports it and leaves that pair out', () => {
    const refs = join(root, 'cliprefs');
    mkdirSync(refs);
    makeMedia(join(refs, 'turn-to-back-rotato.mp4'), 108, 192, true);
    makeMedia(join(refs, 'b.jpg'), 108, 192);
    const out = join(root, 'run5');
    const r = run([bundle, '--out', out, '--agent', agent, '--refs', refs, '--no-clips', '--seed', '2']);
    expect(r.code).toBe(1);
    expect(r.out.pairs).toBe(1);
    expect(r.out.failures.map((f: any) => f.error).join(' ')).toMatch(/a clip and a still cannot be blinded/);
    expect(readdirSync(join(out, 'pairs')).filter((f) => !f.endsWith('.review')).sort()).toEqual(['pair-01-L.png', 'pair-01-R.png']);
  });

  it('a failing CLI step is reported (exit 1), and the page still gets written', () => {
    const broken = join(root, 'broken.mjs');
    cpSync(agent, broken);
    writeFileSync(broken, readFileSync(agent, 'utf8').replace("else if (cmd === 'direct')", "else if (cmd === 'direct' && false)"));
    const out = join(root, 'run4');
    const r = run([bundle, '--out', out, '--agent', broken, '--no-clips']);
    expect(r.code).toBe(1);
    expect(r.out.failures.map((f: any) => f.step)).toContain('auto 3D (hero)');
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('step(s) failed');
  });
});
