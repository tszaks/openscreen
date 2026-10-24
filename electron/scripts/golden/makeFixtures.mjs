#!/usr/bin/env node
// Builds the golden fixture bundles (SPEC §6.1) from the handmade projects in
// electron/test/fixtures/3d-golden/<name>/: each becomes <out>/<name>.openscreen
// with its project.json (plus cursor.json / keystrokes.json when present) and
// the videos the project names, made with ffmpeg's test sources:
//   screen  recording.screenVideoFile  testsrc2 at recording.sourceSize, 30 fps,
//           recording.duration long, with a 440 Hz tone (the app mixes it)
//   camera  recording.cameraVideoFile  testsrc 640x480
//   phone   recording.phoneVideoFile   rgbtestsrc at recording.phoneSize,
//           recording.phoneDuration long
// Encodes are bit-exact (no timestamps or encoder tags), so the same ffmpeg
// makes byte-identical files every time; manifest.json lists every file's
// sha256 so two runs (and both sides of flatIdentity) can prove they used
// the same inputs. The videos are never committed.
//
//   node scripts/golden/makeFixtures.mjs [--out DIR] [--only a,b] [--ffmpeg PATH]
// Prints one JSON object: { ok, out, bundles: [{ name, bundle, files }] }.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ELECTRON_DIR = resolve(here, '..', '..');
export const FIXTURES_DIR = join(ELECTRON_DIR, 'test', 'fixtures', '3d-golden');
export const DEFAULT_OUT = join(tmpdir(), 'openscreen-golden', 'fixtures');
const SIDE_FILES = ['project.json', 'cursor.json', 'keystrokes.json'];
const FPS = 30;

/** The bundled ffmpeg (the one the app uses), else OPENSCREEN_FFMPEG, else PATH. */
export function findFfmpeg(explicit) {
  if (explicit) return explicit;
  if (process.env.OPENSCREEN_FFMPEG) return process.env.OPENSCREEN_FFMPEG;
  try {
    const p = createRequire(join(ELECTRON_DIR, 'package.json'))('ffmpeg-static');
    if (p && existsSync(p)) return p;
  } catch {}
  return 'ffmpeg';
}

/** Fixture names, sorted. */
export function fixtureNames() {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(FIXTURES_DIR, d.name, 'project.json')))
    .map((d) => d.name)
    .sort();
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const even = (n, what) => {
  if (!Number.isInteger(n) || n <= 0 || n % 2) throw new Error(`${what} must be a positive even integer (yuv420p), got ${n}`);
  return n;
};

/** One test-source video: `source` is a lavfi source name. */
function makeVideo(ffmpeg, file, { source, width, height, duration, tone }) {
  const size = `${even(width, `${file} width`)}x${even(height, `${file} height`)}`;
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${source}=size=${size}:rate=${FPS}:duration=${duration}`];
  if (tone) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`);
  args.push(
    '-map_metadata', '-1',
    '-fflags', '+bitexact',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-bf', '0',
    '-flags:v', '+bitexact',
  );
  if (tone) args.push('-c:a', 'aac', '-b:a', '128k', '-flags:a', '+bitexact');
  args.push('-movflags', '+faststart', '-t', String(duration), file);
  execFileSync(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Builds every fixture (or `only`) into `out`. Returns the manifest. */
export function makeFixtures({ out = DEFAULT_OUT, only, ffmpeg } = {}) {
  const bin = findFfmpeg(ffmpeg);
  const names = fixtureNames().filter((n) => !only?.length || only.includes(n));
  if (only?.length) {
    const unknown = only.filter((n) => !fixtureNames().includes(n));
    if (unknown.length) throw new Error(`unknown fixture(s): ${unknown.join(', ')} (have: ${fixtureNames().join(', ')})`);
  }
  mkdirSync(out, { recursive: true });
  const bundles = [];
  for (const name of names) {
    const src = join(FIXTURES_DIR, name);
    const bundle = join(out, `${name}.openscreen`);
    rmSync(bundle, { recursive: true, force: true });
    mkdirSync(bundle, { recursive: true });
    for (const f of SIDE_FILES) if (existsSync(join(src, f))) copyFileSync(join(src, f), join(bundle, f));
    const rec = JSON.parse(readFileSync(join(src, 'project.json'), 'utf8')).recording;
    makeVideo(bin, join(bundle, rec.screenVideoFile), {
      source: 'testsrc2', width: rec.sourceSize.width, height: rec.sourceSize.height, duration: rec.duration, tone: true,
    });
    if (rec.cameraVideoFile) {
      makeVideo(bin, join(bundle, rec.cameraVideoFile), { source: 'testsrc', width: 640, height: 480, duration: rec.duration });
    }
    if (rec.phoneVideoFile) {
      if (!rec.phoneSize) throw new Error(`${name}: recording.phoneSize is required with phoneVideoFile`);
      makeVideo(bin, join(bundle, rec.phoneVideoFile), {
        source: 'rgbtestsrc', width: rec.phoneSize.width, height: rec.phoneSize.height, duration: rec.phoneDuration ?? rec.duration,
      });
    }
    const files = Object.fromEntries(readdirSync(bundle).sort().map((f) => [f, sha256(join(bundle, f))]));
    bundles.push({ name, bundle, files });
  }
  const manifest = { ffmpeg: bin, bundles };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { out, ...manifest };
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw Object.assign(new Error(`${name} needs a value`), { usage: true });
  args.splice(i, 2);
  return v;
}

/**
 * True when this file is the script node was started with. Compares real paths:
 * import.meta.url is already the real path, but argv[1] may go through a symlink
 * (on macOS /tmp is a link to /private/tmp), and path.resolve does not follow links.
 */
function runAsScript() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runAsScript()) {
  const args = process.argv.slice(2);
  try {
    const out = resolve(flag(args, '--out') ?? DEFAULT_OUT);
    const only = flag(args, '--only')?.split(',').filter(Boolean);
    const ffmpeg = flag(args, '--ffmpeg');
    if (args.length) throw Object.assign(new Error(`unknown argument(s): ${args.join(' ')}`), { usage: true });
    const r = makeFixtures({ out, only, ffmpeg });
    process.stdout.write(JSON.stringify({ ok: true, ...r }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e.stderr ?? '').trim() || e.message }) + '\n');
    process.exitCode = e.usage ? 2 : 1;
  }
}
