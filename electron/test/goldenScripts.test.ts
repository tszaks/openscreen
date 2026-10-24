// The flat-identity gate (scripts/golden/flatIdentity.mjs, SPEC §6.1) is run by
// several packages and on every merge, often with --out set to a shared
// scratch folder. It must never write or delete anything in --out outside its
// own fresh run folder. These tests drive the real CLI against a fake built
// checkout whose "agent" copies the bundle's screen video as its export, so no
// Electron runs, but fixtures, the ffmpeg wrapper, framemd5 and the clean-up
// all do.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'golden', 'flatIdentity.mjs');

const FAKE_AGENT = `#!/usr/bin/env node
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
const a = process.argv.slice(2);
const bundle = a[1];
const out = a[a.indexOf('--out') + 1];
copyFileSync(join(bundle, 'screen.mp4'), out);
process.stdout.write(JSON.stringify({ ok: true, out }) + '\\n');
`;

/** Runs the CLI; resolves with exit code and parsed stdout (never rejects on a non-zero exit). */
function run(args: string[]): Promise<{ code: number; result: Record<string, unknown> }> {
  return new Promise((resolveP, reject) => {
    execFile(process.execPath, [SCRIPT, ...args], { maxBuffer: 1 << 24 }, (e, stdout) => {
      const code = e ? (typeof e.code === 'number' ? e.code : -1) : 0;
      try {
        resolveP({ code, result: JSON.parse(String(stdout).trim()) });
      } catch {
        reject(new Error(`flatIdentity printed no JSON (exit ${code}): ${String(stdout).slice(0, 500)} ${e?.message ?? ''}`));
      }
    });
  });
}

let root: string;
let fake: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'openscreen-golden-scripts-'));
  fake = join(root, 'fake-checkout');
  mkdirSync(join(fake, 'electron', 'scripts'), { recursive: true });
  mkdirSync(join(fake, 'electron', 'dist', 'main'), { recursive: true });
  mkdirSync(join(fake, 'electron', 'dist', 'node'), { recursive: true });
  writeFileSync(join(fake, 'electron', 'scripts', 'openscreen-agent.mjs'), FAKE_AGENT);
  writeFileSync(join(fake, 'electron', 'dist', 'main', 'index.js'), '');
  writeFileSync(join(fake, 'electron', 'dist', 'node', 'agentCli.js'), '');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('flatIdentity --out', () => {
  it('never touches anything in a shared --out folder outside its own run folder', async () => {
    const shared = join(root, 'shared');
    // Someone else's files, including names the gate itself uses inside its run folder.
    const theirs: Record<string, string> = {
      'notes.txt': 'notes',
      'sub/keep.txt': 'keep',
      'main/mine.txt': 'main',
      'branch/mine.txt': 'branch',
      'fixtures/mine.txt': 'fixtures',
      'recordings/mine.txt': 'recordings',
      'result.json': '{"theirs":true}',
      'ffmpeg-x264-1thread': 'not the wrapper',
    };
    for (const [rel, body] of Object.entries(theirs)) {
      mkdirSync(join(shared, rel, '..'), { recursive: true });
      writeFileSync(join(shared, rel), body);
    }

    const args = ['--main', fake, '--branch', fake, '--only', 'display', '--jobs', '1', '--out', shared];
    const first = await run(args);
    const second = await run(args);

    for (const r of [first, second]) {
      expect(r.result.error).toBeUndefined();
      expect(r.code).toBe(0);
      expect(r.result.identical).toBe(true);
      const work = String(r.result.work);
      expect(work.startsWith(join(shared, 'flat-identity-'))).toBe(true);
      // Clean-up after an identical run keeps only its own result and wrapper.
      expect(readdirSync(work).sort()).toEqual(['ffmpeg-x264-1thread', 'result.json']);
      expect(JSON.parse(readFileSync(join(work, 'result.json'), 'utf8')).identical).toBe(true);
    }
    expect(first.result.work).not.toBe(second.result.work);

    for (const [rel, body] of Object.entries(theirs)) expect(readFileSync(join(shared, rel), 'utf8')).toBe(body);
    const runDirs = readdirSync(shared).filter((n) => n.startsWith('flat-identity-'));
    expect(runDirs.sort()).toEqual([first.result.work, second.result.work].map((w) => String(w).slice(shared.length + 1)).sort());
  }, 120_000);

  it('refuses an --out that is a file, and leaves the file alone', async () => {
    const file = join(root, 'not-a-folder.txt');
    writeFileSync(file, 'precious');
    const r = await run(['--main', fake, '--branch', fake, '--only', 'display', '--out', file]);
    expect(r.code).toBe(2);
    expect(r.result.ok).toBe(false);
    expect(String(r.result.error)).toContain('not a folder');
    expect(statSync(file).isFile()).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('precious');
  }, 30_000);
});
