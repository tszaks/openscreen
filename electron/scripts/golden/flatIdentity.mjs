#!/usr/bin/env node
// Flat-identity gate, pixel half (SPEC §6.1, D11): exports every golden
// fixture with main's build and with the branch's build, through each
// checkout's own agent CLI and Electron, and requires the decoded frames and
// audio to be identical (`ffmpeg -f framemd5`). It compares exports, not
// `frames`, because main has no `frames` command.
//
//   node scripts/golden/flatIdentity.mjs --main <checkout> [--branch <checkout>]
//        [--out DIR] [--only a,b] [--jobs N] [--timeout s] [--keep] [--threaded-x264]
//
// <checkout> is a repo root (the folder holding electron/); each must be built
// (`npm run build` in its electron/). --branch defaults to the checkout this
// script is in. Both sides export their own clone of the same bundles
// (makeFixtures, whose manifest proves the inputs are byte-identical), with
// OPENSCREEN_RECORDINGS_DIR pointed at the scratch folder and OPENSCREEN_APP
// unset, so each side runs its own dev Electron. Run it with --main and
// --branch both set to main to prove the gate is deterministic.
//
// x264 is pinned to one thread on both sides. The app's preset transcode
// (single-pass ABR + VBV) is not bit-reproducible with frame threads: three
// transcodes of the same file give three different decodes, so main against
// itself would fail on every layout-preset fixture. Both sides therefore run
// ffmpeg through a small wrapper (FFMPEG_BIN, which ffmpeg-static and so the
// app's main process honour; OPENSCREEN_FFMPEG for the CLI) that adds
// `-threads 1` after every `-c:v libx264`. Same encoder settings on both
// sides, now deterministic, so any difference left is in the rendered pixels.
// --threaded-x264 turns the wrapper off (to see the encoder noise).
//
// Prints one JSON object: { ok, identical, fixtures: [...] }. Exit 0 when every
// fixture is identical, 1 when any differs or fails, 2 on bad usage.
import { spawn, execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELECTRON_DIR, findFfmpeg, fixtureNames, makeFixtures } from './makeFixtures.mjs';

const REPO_DIR = resolve(ELECTRON_DIR, '..');

class UsageError extends Error {}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} needs a value`);
  args.splice(i, 2);
  return v;
}

function bool(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

/** A checkout's agent script, after checking it is built. */
function agentScript(checkout, label) {
  const root = resolve(checkout);
  const script = join(root, 'electron', 'scripts', 'openscreen-agent.mjs');
  if (!existsSync(script)) throw new UsageError(`${label}: ${root} is not an OpenScreen checkout (no electron/scripts/openscreen-agent.mjs)`);
  if (!existsSync(join(root, 'electron', 'dist', 'main', 'index.js')) || !existsSync(join(root, 'electron', 'dist', 'node', 'agentCli.js'))) {
    throw new UsageError(`${label}: ${root} is not built: run \`npm run build\` in ${join(root, 'electron')}`);
  }
  return script;
}

/** Writes the single-thread-x264 ffmpeg wrapper (see the header) and returns its path. */
export function deterministicFfmpeg(dir, real) {
  const file = join(dir, 'ffmpeg-x264-1thread');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      '# flatIdentity.mjs: the real ffmpeg, with -threads 1 after every "-c:v libx264"',
      '# (threaded x264 with VBV is not bit-reproducible).',
      `real='${real.replace(/'/g, "'\\''")}'`,
      'n=$#',
      'i=0',
      'prev=',
      'while [ "$i" -lt "$n" ]; do',
      '  a=$1',
      '  shift',
      '  set -- "$@" "$a"',
      '  if [ "$prev" = "-c:v" ] && [ "$a" = "libx264" ]; then set -- "$@" -threads 1; fi',
      '  prev=$a',
      '  i=$((i + 1))',
      'done',
      'exec "$real" "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return file;
}

/** Runs the agent's export; resolves with its final JSON (or a failure object). */
function exportWith(script, bundle, out, { timeout, recordings, ffmpegWrapper }) {
  return new Promise((resolveP) => {
    const env = { ...process.env, OPENSCREEN_RECORDINGS_DIR: recordings };
    delete env.OPENSCREEN_APP;
    if (ffmpegWrapper) {
      env.FFMPEG_BIN = ffmpegWrapper;
      env.OPENSCREEN_FFMPEG = ffmpegWrapper;
    } else {
      delete env.FFMPEG_BIN;
      delete env.OPENSCREEN_FFMPEG;
    }
    const args = [script, 'export', bundle, '--out', out, ...(timeout ? ['--timeout', String(timeout)] : [])];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.on('error', (e) => resolveP({ ok: false, error: `could not run the agent: ${e.message}` }));
    child.on('close', (code) => {
      // The agent prints exactly one JSON object (possibly pretty-printed).
      const text = stdout.trim();
      if (!text) return resolveP({ ok: false, error: `agent exited ${code} with no result`, stderr: stderr.trim().split('\n').slice(-5) });
      try {
        resolveP(JSON.parse(text));
      } catch {
        resolveP({ ok: false, error: `agent printed bad JSON: ${text.slice(0, 500)}` });
      }
    });
  });
}

/** `ffmpeg -f framemd5` of every decoded stream, one line per frame/packet. */
function framemd5(ffmpeg, file) {
  return new Promise((resolveP, reject) => {
    execFile(ffmpeg, ['-v', 'error', '-i', file, '-map', '0', '-f', 'framemd5', '-'], { maxBuffer: 1 << 28 }, (e, so, se) =>
      e ? reject(new Error(`framemd5 of ${file} failed: ${String(se || e.message).trim()}`)) : resolveP(String(so).trimEnd().split('\n')),
    );
  });
}

/** Header (#…) and per-stream frame counts of a framemd5 listing. */
function summarize(lines) {
  const streams = {};
  for (const l of lines) {
    if (l.startsWith('#')) continue;
    const s = l.split(',')[0].trim();
    streams[s] = (streams[s] ?? 0) + 1;
  }
  return { header: lines.filter((l) => l.startsWith('#')), frames: streams };
}

function compare(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return { line: i + 1, main: a[i] ?? '(end)', branch: b[i] ?? '(end)' };
  }
  return null;
}

/** Runs `tasks` (functions returning promises) at most `jobs` at a time. */
async function pool(tasks, jobs) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, tasks.length)) }, worker));
  return results;
}

export async function flatIdentity({ main, branch = REPO_DIR, out, only, jobs = 2, timeout, keep = false, threadedX264 = false, log = () => {} }) {
  const sides = { main: agentScript(main, '--main'), branch: agentScript(branch, '--branch') };
  const work = resolve(out ?? join(tmpdir(), 'openscreen-golden', `flat-identity-${process.pid}`));
  const ffmpeg = findFfmpeg();
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  log({ stage: 'fixtures', out: work });
  const manifest = makeFixtures({ out: join(work, 'fixtures'), only });
  const recordings = join(work, 'recordings');
  mkdirSync(recordings, { recursive: true });
  const ffmpegWrapper = threadedX264 ? null : deterministicFfmpeg(work, ffmpeg);

  // Each side exports its own clone of each bundle, so neither can see the other's files.
  const jobsList = [];
  for (const b of manifest.bundles) {
    for (const side of ['main', 'branch']) {
      const dir = join(work, side);
      const bundle = join(dir, basename(b.bundle));
      mkdirSync(dir, { recursive: true });
      cpSync(b.bundle, bundle, { recursive: true });
      jobsList.push({ name: b.name, side, bundle, out: join(dir, `${b.name}.mp4`) });
    }
  }
  const exported = await pool(
    jobsList.map((j) => async () => {
      log({ stage: 'export', fixture: j.name, side: j.side });
      const t0 = Date.now();
      const r = await exportWith(sides[j.side], j.bundle, j.out, { timeout, recordings, ffmpegWrapper });
      log({ stage: 'exported', fixture: j.name, side: j.side, ok: !!r.ok, seconds: (Date.now() - t0) / 1000 });
      return { ...j, result: r, seconds: (Date.now() - t0) / 1000 };
    }),
    jobs,
  );

  const fixtures = [];
  for (const b of manifest.bundles) {
    const m = exported.find((e) => e.name === b.name && e.side === 'main');
    const br = exported.find((e) => e.name === b.name && e.side === 'branch');
    const entry = { name: b.name, main: { file: m.out, seconds: m.seconds }, branch: { file: br.out, seconds: br.seconds } };
    if (!m.result.ok || !br.result.ok) {
      fixtures.push({ ...entry, identical: false, error: !m.result.ok ? `main export failed: ${m.result.error}` : `branch export failed: ${br.result.error}`, details: !m.result.ok ? m.result : br.result });
      continue;
    }
    const [a, c] = await Promise.all([framemd5(ffmpeg, m.out), framemd5(ffmpeg, br.out)]);
    const diff = compare(a, c);
    const sum = summarize(a);
    fixtures.push({ ...entry, identical: !diff, frames: sum.frames, size: m.result.probe ? `${m.result.probe.width}x${m.result.probe.height}` : undefined, ...(diff ? { firstDifference: diff } : {}) });
  }
  const identical = fixtures.length > 0 && fixtures.every((f) => f.identical);
  const result = { ok: identical, identical, main: resolve(main), branch: resolve(branch), work, x264: threadedX264 ? 'threaded' : 'one thread', inputs: manifest.bundles.map((b) => ({ name: b.name, files: b.files })), fixtures };
  writeFileSync(join(work, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  if (identical && !keep) {
    for (const d of ['main', 'branch', 'fixtures', 'recordings']) rmSync(join(work, d), { recursive: true, force: true });
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--help') || args.includes('-h')) {
      process.stdout.write(JSON.stringify({ ok: true, usage: 'flatIdentity.mjs --main <checkout> [--branch <checkout>] [--out DIR] [--only a,b] [--jobs N] [--timeout s] [--keep] [--threaded-x264]', fixtures: fixtureNames() }) + '\n');
      process.exit(0);
    }
    const main = flag(args, '--main');
    const branch = flag(args, '--branch');
    const out = flag(args, '--out');
    const only = flag(args, '--only')?.split(',').filter(Boolean);
    const jobs = Number(flag(args, '--jobs') ?? 2);
    const timeout = flag(args, '--timeout');
    const keep = bool(args, '--keep');
    const threadedX264 = bool(args, '--threaded-x264');
    if (args.length) throw new UsageError(`unknown argument(s): ${args.join(' ')}`);
    if (!main) throw new UsageError('--main <checkout> is required (a repo root with a built electron/)');
    if (!(Number.isInteger(jobs) && jobs >= 1)) throw new UsageError('--jobs must be a whole number >= 1');
    const r = await flatIdentity({
      main,
      branch: branch ?? REPO_DIR,
      out,
      only,
      jobs,
      timeout,
      keep,
      threadedX264,
      log: (o) => process.stderr.write(JSON.stringify(o) + '\n'),
    });
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exitCode = r.identical ? 0 : 1;
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}
