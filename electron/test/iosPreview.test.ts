import { describe, expect, it, vi } from 'vitest';
import {
  IosHelperClient,
  createFrameParser,
  createLatestThrottle,
  parseHelperLine,
  type IosPreview,
} from '../src/shared/iosCapture';

/** One wire frame: 4-byte big-endian length, then the bytes. */
const wire = (...payloads: number[][]) => {
  const out: number[] = [];
  for (const p of payloads) out.push((p.length >>> 24) & 255, (p.length >>> 16) & 255, (p.length >>> 8) & 255, p.length & 255, ...p);
  return new Uint8Array(out);
};

describe('createFrameParser (fd 3)', () => {
  it('splits back-to-back frames out of one chunk', () => {
    const frames: number[][] = [];
    const push = createFrameParser((f) => frames.push([...f]));
    push(wire([0xff, 0xd8, 1, 0xff, 0xd9], [0xff, 0xd8, 2, 2, 0xff, 0xd9]));
    expect(frames).toEqual([
      [0xff, 0xd8, 1, 0xff, 0xd9],
      [0xff, 0xd8, 2, 2, 0xff, 0xd9],
    ]);
  });

  it('reassembles frames split anywhere, including inside the length', () => {
    const bytes = wire([1, 2, 3], [4, 5, 6, 7, 8], [9]);
    for (let cut = 1; cut < bytes.length; cut++) {
      const frames: number[][] = [];
      const push = createFrameParser((f) => frames.push([...f]));
      push(bytes.slice(0, cut));
      push(bytes.slice(cut));
      expect(frames, `cut at ${cut}`).toEqual([[1, 2, 3], [4, 5, 6, 7, 8], [9]]);
    }
    // One byte at a time.
    const frames: number[][] = [];
    const push = createFrameParser((f) => frames.push([...f]));
    for (const b of bytes) push(new Uint8Array([b]));
    expect(frames).toEqual([[1, 2, 3], [4, 5, 6, 7, 8], [9]]);
  });

  it('hands out copies that do not change when the chunk is reused', () => {
    const frames: Uint8Array[] = [];
    const push = createFrameParser((f) => frames.push(f));
    const chunk = wire([7, 7, 7]);
    push(chunk);
    chunk.fill(0);
    expect([...frames[0]]).toEqual([7, 7, 7]);
  });

  it('stops at a corrupt length and reports it once', () => {
    const frames: number[][] = [];
    const onCorrupt = vi.fn();
    const push = createFrameParser((f) => frames.push([...f]), { maxBytes: 16, onCorrupt });
    push(wire([1]));
    push(new Uint8Array([0, 0, 1, 0, 9, 9])); // 256 > maxBytes
    push(wire([2]));
    expect(frames).toEqual([[1]]);
    expect(onCorrupt).toHaveBeenCalledOnce();
    expect(onCorrupt.mock.calls[0][0]).toMatch(/256/);
  });

  it('treats a zero length as corrupt', () => {
    const onCorrupt = vi.fn();
    const push = createFrameParser(() => {}, { onCorrupt });
    push(new Uint8Array([0, 0, 0, 0]));
    expect(onCorrupt).toHaveBeenCalledOnce();
  });
});

describe('createLatestThrottle', () => {
  const fakeClock = () => {
    let now = 0;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let nextId = 1;
    return {
      clock: {
        now: () => now,
        setTimeout: (fn: () => void, ms: number) => {
          const id = nextId++;
          timers.push({ at: now + ms, fn, id });
          return id;
        },
        clearTimeout: (id: unknown) => {
          const i = timers.findIndex((t) => t.id === id);
          if (i >= 0) timers.splice(i, 1);
        },
      },
      advance(ms: number) {
        now += ms;
        for (const t of [...timers].sort((a, b) => a.at - b.at)) {
          if (t.at <= now) {
            timers.splice(timers.indexOf(t), 1);
            t.fn();
          }
        }
      },
      pending: () => timers.length,
    };
  };

  it('sends the first value at once, then at most one per interval, newest wins', () => {
    const c = fakeClock();
    const sent: number[] = [];
    const t = createLatestThrottle<number>((v) => sent.push(v), 80, c.clock);
    t.push(1);
    expect(sent).toEqual([1]);
    t.push(2);
    t.push(3);
    t.push(4);
    expect(sent).toEqual([1]);
    expect(c.pending()).toBe(1);
    c.advance(79);
    expect(sent).toEqual([1]);
    c.advance(1);
    expect(sent).toEqual([1, 4]);
    // Quiet long enough: the next goes straight out.
    c.advance(200);
    t.push(5);
    expect(sent).toEqual([1, 4, 5]);
  });

  it('keeps a steady ~12 fps out of a 60 fps stream', () => {
    const c = fakeClock();
    let sent = 0;
    const t = createLatestThrottle<number>(() => sent++, 1000 / 12, c.clock);
    for (let i = 0; i < 60; i++) {
      t.push(i);
      c.advance(1000 / 60);
    }
    expect(sent).toBeGreaterThanOrEqual(11);
    expect(sent).toBeLessThanOrEqual(13);
  });

  it('cancel drops the waiting value', () => {
    const c = fakeClock();
    const sent: number[] = [];
    const t = createLatestThrottle<number>((v) => sent.push(v), 80, c.clock);
    t.push(1);
    t.push(2);
    t.cancel();
    c.advance(500);
    expect(sent).toEqual([1]);
  });
});

describe('preview events', () => {
  it('parses each preview state', () => {
    expect(parseHelperLine('{"event":"preview","id":"a","state":"connecting"}')).toEqual({
      event: 'preview',
      id: 'a',
      state: 'connecting',
    });
    expect(parseHelperLine('{"event":"preview","height":2556,"id":"a","state":"live","width":1179}')).toEqual({
      event: 'preview',
      id: 'a',
      state: 'live',
      width: 1179,
      height: 2556,
    });
    expect(
      parseHelperLine('{"code":"no-frames","event":"preview","id":"a","message":"No picture.","state":"error"}'),
    ).toEqual({ event: 'preview', id: 'a', state: 'error', message: 'No picture.', code: 'no-frames' });
    expect(parseHelperLine('{"event":"preview","id":"a","state":"stopped"}')).toMatchObject({ state: 'stopped' });
  });

  it('rejects preview events without an id or with an unknown state', () => {
    expect(parseHelperLine('{"event":"preview","state":"live"}')).toBeNull();
    expect(parseHelperLine('{"event":"preview","id":"a","state":"dancing"}')).toBeNull();
    expect(parseHelperLine('{"event":"preview","id":"a"}')).toBeNull();
  });
});

describe('IosHelperClient preview', () => {
  const make = () => {
    const written: string[] = [];
    const seen: (IosPreview | null)[] = [];
    const client = new IosHelperClient(
      { write: (l) => written.push(l), kill: vi.fn(), onPreview: (p) => seen.push(p) },
      { startMs: 1000, stopMs: 1000 },
    );
    return { client, written, seen, cmds: () => written.map((l) => JSON.parse(l)) };
  };

  it('connecting -> live -> unpreview', () => {
    const { client, cmds, seen } = make();
    client.startPreview('dev', { fps: 12, maxEdge: 360 });
    expect(cmds()).toEqual([{ cmd: 'preview', id: 'dev', fps: 12, maxEdge: 360 }]);
    expect(client.preview).toEqual({ id: 'dev', state: 'connecting' });
    client.handleLine('{"event":"preview","height":2556,"id":"dev","state":"live","width":1179}');
    expect(client.preview).toEqual({ id: 'dev', state: 'live', width: 1179, height: 2556 });
    client.stopPreview();
    expect(cmds()[1]).toEqual({ cmd: 'unpreview' });
    expect(client.preview).toBeNull();
    expect(seen.map((p) => p?.state ?? null)).toEqual(['connecting', 'live', null]);
    // Stopping again sends nothing.
    client.stopPreview();
    expect(cmds()).toHaveLength(2);
  });

  it('asking again for the same live device sends nothing; a failed one is retried', () => {
    const { client, cmds } = make();
    client.startPreview('dev');
    client.startPreview('dev');
    expect(cmds()).toHaveLength(1);
    client.handleLine('{"code":"no-frames","event":"preview","id":"dev","message":"No picture.","state":"error"}');
    expect(client.preview).toMatchObject({ state: 'error', code: 'no-frames' });
    client.startPreview('dev');
    expect(cmds()).toHaveLength(2);
    expect(client.preview).toEqual({ id: 'dev', state: 'connecting' });
  });

  it('ignores reports about a device it no longer previews', () => {
    const { client } = make();
    client.startPreview('a');
    client.startPreview('b');
    client.handleLine('{"event":"preview","id":"a","state":"stopped"}');
    client.handleLine('{"event":"preview","id":"a","state":"live","width":1,"height":2}');
    expect(client.preview).toEqual({ id: 'b', state: 'connecting' });
    client.stopPreview();
    client.handleLine('{"event":"preview","id":"b","state":"stopped"}');
    expect(client.preview).toBeNull();
  });

  it('a take on the previewed device leaves the preview running, before, during and after', async () => {
    const { client, cmds } = make();
    client.startPreview('dev');
    client.handleLine('{"event":"preview","height":20,"id":"dev","state":"live","width":10}');
    const started = client.start('dev', '/r/screen.mov');
    // Reuse is the helper's job: the client sends a plain record, no unpreview.
    expect(cmds().map((c) => c.cmd)).toEqual(['preview', 'record']);
    client.handleLine('{"event":"started","width":10,"height":20}');
    await started;
    expect(client.preview?.state).toBe('live');
    const stopped = client.stop();
    client.handleLine('{"event":"finished","path":"/r/screen.mov","duration":3}');
    await stopped;
    expect(client.preview?.state).toBe('live');
  });

  it('unpreview during a take is sent at once (the helper defers it) and the take carries on', async () => {
    const { client, cmds } = make();
    client.startPreview('dev');
    const started = client.start('dev', '/r/screen.mov');
    client.handleLine('{"event":"started","width":10,"height":20}');
    await started;
    client.stopPreview();
    expect(cmds().map((c) => c.cmd)).toEqual(['preview', 'record', 'unpreview']);
    expect(client.busy).toBe(true);
    const stopped = client.stop();
    client.handleLine('{"event":"finished","path":"/r/screen.mov","duration":3}');
    await expect(stopped).resolves.toMatchObject({ duration: 3 });
  });

  it('a preview error does not touch a running take', async () => {
    const { client } = make();
    client.startPreview('dev');
    const started = client.start('dev', '/r/screen.mov');
    client.handleLine('{"event":"started","width":10,"height":20}');
    await started;
    client.handleLine('{"event":"preview","id":"dev","message":"The device disconnected.","state":"error"}');
    expect(client.busy).toBe(true);
    expect(client.preview).toMatchObject({ state: 'error' });
  });

  it('the helper exiting turns the preview into an error', () => {
    const { client, seen } = make();
    client.startPreview('dev');
    client.handleExit('iPhone capture helper exited (SIGKILL)');
    expect(client.preview).toEqual({ id: 'dev', state: 'error', message: 'iPhone capture helper exited (SIGKILL)' });
    expect(seen.at(-1)?.state).toBe('error');
  });
});
