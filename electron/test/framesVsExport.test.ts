// Frames = export (scripts/golden/framesVsExport.mjs, SPEC §6.3): the parts
// that do not need the app. The ffmpeg wrapper that copies export frames out
// of the raw pipe is run for real, in front of a fake ffmpeg, so a byte lost,
// a frame cut at a chunk boundary or a swallowed exit code fails here.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { DEFAULT_MIN_DB, FIXTURE_3D_OPS, FrameTap, rawPipeInput, rgbaToRgb, writeWrapper } from '../scripts/golden/framesVsExport.mjs';
import { applyOps, validateProject } from '../src/shared/agentOps';
import { phone3dActive } from '../src/shared/phone3d/placement';
import { loadGoldenFixture } from './helpers/compositorHarness';

const EXPORT_ARGS = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '2x2', '-r', '30', '-i', 'pipe:0', '-c:v', 'libx264', 'out.mov'];

describe('rawPipeInput', () => {
  it("finds the export's raw RGBA pipe and its size (exportArgs' command line)", () => {
    expect(rawPipeInput(EXPORT_ARGS)).toEqual({ w: 2, h: 2 });
    expect(rawPipeInput(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1080x1920', '-r', '30', '-i', 'pipe:0', '-i', 'audio.wav', 'o.mp4'])).toEqual({ w: 1080, h: 1920 });
  });

  it('passes every other command through: probes, transcodes, other pixel formats, options after the -i', () => {
    expect(rawPipeInput(['-i', '/x/master.mov', '-c:v', 'libx264', 'o.mp4'])).toBeNull();
    expect(rawPipeInput(['-i', '/x/in.mp4'])).toBeNull();
    expect(rawPipeInput(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '2x2', '-i', 'pipe:0', 'o.mp4'])).toBeNull();
    expect(rawPipeInput(['-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '2x2', 'o.raw'])).toBeNull();
    expect(rawPipeInput(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', 'big', '-i', 'pipe:0', 'o.mp4'])).toBeNull();
  });
});

describe('FrameTap', () => {
  it('hands over exactly the wanted frames, whole, whatever the chunk boundaries', () => {
    const frameBytes = 5;
    const stream = Buffer.from(Array.from({ length: frameBytes * 6 }, (_, i) => i));
    for (const chunkSize of [1, 2, 3, 5, 7, 30]) {
      const got: [number, number[]][] = [];
      const tap = new FrameTap(frameBytes, [0, 2, 5], (i: number, b: Buffer) => got.push([i, [...b]]));
      for (let p = 0; p < stream.length; p += chunkSize) tap.push(stream.subarray(p, p + chunkSize));
      expect(got, `chunks of ${chunkSize}`).toEqual([
        [0, [0, 1, 2, 3, 4]],
        [2, [10, 11, 12, 13, 14]],
        [5, [25, 26, 27, 28, 29]],
      ]);
    }
  });

  it('never hands over a frame the stream ended inside', () => {
    const got: number[] = [];
    const tap = new FrameTap(4, [1], (i: number) => got.push(i));
    tap.push(Buffer.alloc(7));
    expect(got).toEqual([]);
  });
});

describe('rgbaToRgb', () => {
  it('drops alpha, keeping order', () => {
    expect([...rgbaToRgb(Buffer.from([1, 2, 3, 255, 4, 5, 6, 128]))]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('the ffmpeg wrapper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fve-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // A stand-in ffmpeg: records its arguments and every stdin byte, exits with $FAKE_EXIT.
  const fake = join(dir, 'fake-ffmpeg.mjs');
  writeFileSync(
    fake,
    `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(join(dir, 'seen.json'))}, JSON.stringify({ args: process.argv.slice(2), bytes: [...Buffer.concat(chunks)] }));
  process.exit(Number(process.env.FAKE_EXIT ?? 0));
});
`,
    { mode: 0o755 },
  );

  const run = (args: string[], stdin: Buffer, exit = 0) =>
    new Promise<number | null>((resolve) => {
      const wrapper = writeWrapper(dir, fake, [1, 2]);
      const child = spawn(wrapper, args, { env: { ...process.env, FAKE_EXIT: String(exit) }, stdio: ['pipe', 'ignore', 'inherit'] });
      child.on('exit', (code) => resolve(code));
      child.stdin.end(stdin);
    });

  it('passes the raw pipe through byte for byte and copies the wanted frames out', async () => {
    // Three 2x2 RGBA frames (16 bytes each), every byte different.
    const stream = Buffer.from(Array.from({ length: 48 }, (_, i) => i + 1));
    expect(await run(EXPORT_ARGS, stream)).toBe(0);
    const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
    expect(seen.args).toEqual(EXPORT_ARGS);
    expect(seen.bytes).toEqual([...stream]);
    expect([...readFileSync(join(dir, 'export-1.rgba'))]).toEqual([...stream.subarray(16, 32)]);
    expect([...readFileSync(join(dir, 'export-2.rgba'))]).toEqual([...stream.subarray(32, 48)]);
  });

  it("returns ffmpeg's exit code, and runs any other command unchanged", async () => {
    expect(await run(['-i', '/x/master.mov', 'o.mp4'], Buffer.from('abc'), 3)).toBe(3);
    const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
    expect(seen.args).toEqual(['-i', '/x/master.mov', 'o.mp4']);
    expect(seen.bytes).toEqual([...Buffer.from('abc')]);
  });
});

describe('the default 3D bundle', () => {
  it('is the ios-social golden fixture with 3D on and two valid moves, at the 50 dB gate', () => {
    const { project } = loadGoldenFixture('ios-social');
    const { project: p } = applyOps(project, FIXTURE_3D_OPS);
    expect(validateProject(p)).toEqual([]);
    expect(phone3dActive(p).active).toBe(true);
    expect(p.phone3d!.transitions.map((t) => [t.start, t.end, t.to.turn])).toEqual([
      [0.4, 2.2, 35],
      [4.6, 6, 0],
    ]);
    expect(DEFAULT_MIN_DB).toBe(50);
  });
});
