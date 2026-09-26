import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IosCaptureError,
  IosHelperClient,
  createLineSplitter,
  parseDeviceList,
  parseHelperLine,
} from '../src/shared/iosCapture';

describe('parseHelperLine', () => {
  it('parses each event the helper emits', () => {
    expect(parseHelperLine('{"event":"started","width":1179,"height":2556}')).toEqual({
      event: 'started',
      width: 1179,
      height: 2556,
    });
    expect(
      parseHelperLine('{"duration":3.5,"event":"finished","height":2556,"path":"/r/screen.mov","width":1179}'),
    ).toEqual({ event: 'finished', path: '/r/screen.mov', width: 1179, height: 2556, duration: 3.5 });
    expect(parseHelperLine('{"event":"error","message":"Device X not found."}')).toEqual({
      event: 'error',
      message: 'Device X not found.',
    });
    expect(
      parseHelperLine('{"devices":[{"id":"abc","modelID":"iOS Device","name":"Tyler\'s iPhone"}],"event":"devices"}'),
    ).toEqual({ event: 'devices', devices: [{ id: 'abc', name: "Tyler's iPhone", modelID: 'iOS Device' }] });
  });

  it('parses error codes and warnings', () => {
    expect(parseHelperLine('{"code":"no-frames","event":"error","message":"No picture from your iPhone."}')).toEqual({
      event: 'error',
      message: 'No picture from your iPhone.',
      code: 'no-frames',
    });
    expect(parseHelperLine('{"code":"stalled","event":"warning","message":"Your iPhone may be locked."}')).toEqual({
      event: 'warning',
      code: 'stalled',
      message: 'Your iPhone may be locked.',
    });
    expect(parseHelperLine('{"code":"resumed","event":"warning"}')).toEqual({ event: 'warning', code: 'resumed' });
    expect(parseHelperLine('{"event":"warning","message":"no code"}')).toBeNull();
    expect(parseHelperLine('{"code":7,"event":"error","message":"x"}')).toEqual({ event: 'error', message: 'x' });
  });

  it('rejects junk, partial and malformed lines', () => {
    expect(parseHelperLine('')).toBeNull();
    expect(parseHelperLine('ios-capture: CMIO opt-in failed (-1)')).toBeNull();
    expect(parseHelperLine('{"event":"started","width":1179')).toBeNull();
    expect(parseHelperLine('{"event":"started","width":"1179","height":2556}')).toBeNull();
    expect(parseHelperLine('{"event":"finished"}')).toBeNull();
    expect(parseHelperLine('{"event":"nope"}')).toBeNull();
  });

  it('drops devices without an id and names unnamed ones', () => {
    const ev = parseHelperLine('{"event":"devices","devices":[{"name":"x"},{"id":"a"},7]}');
    expect(ev).toEqual({ event: 'devices', devices: [{ id: 'a', name: 'iOS device', modelID: '' }] });
  });
});

describe('parseDeviceList', () => {
  it('parses list output and tolerates garbage', () => {
    expect(parseDeviceList('[]\n')).toEqual([]);
    expect(parseDeviceList('[{"id":"a","name":"iPad","modelID":"iOS Device"}]')).toEqual([
      { id: 'a', name: 'iPad', modelID: 'iOS Device' },
    ]);
    expect(parseDeviceList('not json')).toEqual([]);
    expect(parseDeviceList('{"id":"a"}')).toEqual([]);
  });
});

describe('createLineSplitter', () => {
  it('reassembles lines split across chunks and skips blanks', () => {
    const lines: string[] = [];
    const push = createLineSplitter((l) => lines.push(l));
    push('{"event":"sta');
    push('rted","width":1,"height":2}\n\n{"event":"err');
    expect(lines).toEqual(['{"event":"started","width":1,"height":2}']);
    push('or","message":"x"}\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('{"event":"error","message":"x"}');
  });
});

describe('IosHelperClient', () => {
  afterEach(() => vi.useRealTimers());

  const make = (timeouts = { startMs: 1000, stopMs: 1000 }) => {
    const written: string[] = [];
    const kill = vi.fn();
    const client = new IosHelperClient({ write: (l) => written.push(l), kill }, timeouts);
    return { client, written, kill };
  };

  it('tracks the device list pushed by the helper', () => {
    const { client } = make();
    expect(client.ready).toBe(false);
    client.handleLine('{"event":"devices","devices":[{"id":"a","name":"iPhone","modelID":"iOS Device"}]}');
    expect(client.ready).toBe(true);
    expect(client.devices.map((d) => d.id)).toEqual(['a']);
  });

  it('runs a full take: record command, started, stop command, finished', async () => {
    const { client, written } = make();
    const started = client.start('dev-1', '/r/rec-1.openscreen/screen.mov');
    expect(JSON.parse(written[0])).toEqual({ cmd: 'record', id: 'dev-1', path: '/r/rec-1.openscreen/screen.mov' });
    client.handleLine('{"event":"started","width":1179,"height":2556}');
    await expect(started).resolves.toEqual({ width: 1179, height: 2556 });
    expect(client.busy).toBe(true);

    const finished = client.stop();
    expect(JSON.parse(written[1])).toEqual({ cmd: 'stop' });
    client.handleLine('{"event":"finished","path":"/r/rec-1.openscreen/screen.mov","width":1179,"height":2556,"duration":4}');
    await expect(finished).resolves.toEqual({
      path: '/r/rec-1.openscreen/screen.mov',
      width: 1179,
      height: 2556,
      duration: 4,
    });
    expect(client.busy).toBe(false);
  });

  it('rejects start with the helper error (bogus device, permission denied)', async () => {
    const { client } = make();
    const started = client.start('bogus', '/tmp/x.mov');
    client.handleLine('{"event":"error","message":"Device bogus not found."}');
    await expect(started).rejects.toThrow('Device bogus not found.');
    expect(client.busy).toBe(false);
    expect(client.lastError).toBeNull();
  });

  it('refuses a second take while one is running', async () => {
    const { client, written } = make();
    void client.start('a', '/tmp/a.mov');
    await expect(client.start('b', '/tmp/b.mov')).rejects.toThrow(/already running/);
    expect(written).toHaveLength(1);
  });

  it('returns a take that ended on its own (cable pulled) from the next stop()', async () => {
    const { client, written } = make();
    const started = client.start('a', '/tmp/a.mov');
    client.handleLine('{"event":"started","width":10,"height":20}');
    await started;
    client.handleLine('{"event":"finished","path":"/tmp/a.mov","duration":2}');
    expect(client.busy).toBe(false);
    await expect(client.stop()).resolves.toEqual({ path: '/tmp/a.mov', width: undefined, height: undefined, duration: 2 });
    expect(written).toHaveLength(1); // no stop command needed
    await expect(client.stop()).rejects.toThrow(/No iPhone recording/);
  });

  it('fails pending calls when the helper exits', async () => {
    const { client } = make();
    const started = client.start('a', '/tmp/a.mov');
    client.handleExit('ios-capture exited (code 1)');
    await expect(started).rejects.toThrow('ios-capture exited (code 1)');
    expect(client.ready).toBe(false);
    expect(client.lastError).toBe('ios-capture exited (code 1)');
  });

  it('reports a crash mid-take on the next stop()', async () => {
    const { client } = make();
    const started = client.start('a', '/tmp/a.mov');
    client.handleLine('{"event":"started","width":10,"height":20}');
    await started;
    client.handleExit('ios-capture crashed');
    await expect(client.stop()).rejects.toThrow('ios-capture crashed');
  });

  it('kills a helper that never starts sending video', async () => {
    vi.useFakeTimers();
    const { client, kill } = make({ startMs: 50, stopMs: 50 });
    const started = client.start('a', '/tmp/a.mov');
    const check = expect(started).rejects.toThrow(/did not start/);
    await vi.advanceTimersByTimeAsync(60);
    await check;
    expect(kill).toHaveBeenCalledOnce();
    expect(client.busy).toBe(false);
  });

  it('kills a helper that never finishes writing', async () => {
    vi.useFakeTimers();
    const { client, kill } = make({ startMs: 50, stopMs: 50 });
    const started = client.start('a', '/tmp/a.mov');
    client.handleLine('{"event":"started","width":10,"height":20}');
    await started;
    const stopped = client.stop();
    const check = expect(stopped).rejects.toThrow(/did not finish/);
    await vi.advanceTimersByTimeAsync(60);
    await check;
    expect(kill).toHaveBeenCalledOnce();
    expect(client.busy).toBe(false);
  });

  it('rejects start with the no-frames code when the phone sends no picture', async () => {
    const { client } = make();
    const started = client.start('a', '/tmp/a.mov');
    client.handleLine('{"code":"no-frames","event":"error","message":"No picture from your iPhone."}');
    const err = await started.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IosCaptureError);
    expect(err).toMatchObject({ message: 'No picture from your iPhone.', code: 'no-frames' });
    expect(client.busy).toBe(false);
  });

  it('tracks stalled/resumed warnings without ending the take', async () => {
    const { client } = make();
    const started = client.start('a', '/tmp/a.mov');
    client.handleLine('{"event":"started","width":10,"height":20}');
    await started;
    client.handleLine('{"code":"stalled","event":"warning","message":"Your iPhone may be locked."}');
    expect(client.warning).toEqual({ code: 'stalled', message: 'Your iPhone may be locked.' });
    expect(client.busy).toBe(true);
    client.handleLine('{"code":"resumed","event":"warning"}');
    expect(client.warning).toBeNull();

    client.handleLine('{"code":"stalled","event":"warning","message":"m"}');
    const stopped = client.stop();
    client.handleLine('{"event":"finished","path":"/tmp/a.mov","duration":9}');
    await expect(stopped).resolves.toMatchObject({ path: '/tmp/a.mov', duration: 9 });
    expect(client.warning).toBeNull();
  });

  it('keeps stray idle errors as lastError', () => {
    const { client } = make();
    client.handleLine('{"event":"error","message":"Unknown command: x"}');
    expect(client.lastError).toBe('Unknown command: x');
  });
});

describe('IosHelperClient early end notification (BH-19)', () => {
  const setup = () => {
    const onEnded = vi.fn();
    const client = new IosHelperClient({ write: () => {}, kill: vi.fn(), onEnded });
    return { client, onEnded };
  };
  const recording = async (client: IosHelperClient) => {
    const started = client.start('a', '/tmp/a.mov');
    client.handleLine('{"event":"started","width":10,"height":20}');
    await started;
  };

  it('reports a helper crash mid-take right away, and stop() still returns it', async () => {
    const { client, onEnded } = setup();
    await recording(client);
    client.handleExit('iPhone capture helper exited (SIGKILL)');
    expect(onEnded).toHaveBeenCalledWith({ err: 'iPhone capture helper exited (SIGKILL)' });
    await expect(client.stop()).rejects.toThrow(/SIGKILL/);
  });

  it('reports a take the helper finished on its own (cable pulled)', async () => {
    const { client, onEnded } = setup();
    await recording(client);
    client.handleLine('{"event":"finished","path":"/tmp/a.mov","duration":4.2}');
    expect(onEnded).toHaveBeenCalledWith({ ok: { path: '/tmp/a.mov', width: undefined, height: undefined, duration: 4.2 } });
    await expect(client.stop()).resolves.toMatchObject({ duration: 4.2 });
  });

  it('reports a device error mid-take', async () => {
    const { client, onEnded } = setup();
    await recording(client);
    client.handleLine('{"event":"error","message":"Device disconnected."}');
    expect(onEnded).toHaveBeenCalledWith({ err: 'Device disconnected.' });
  });

  it('does not report a normal stop', async () => {
    const { client, onEnded } = setup();
    await recording(client);
    const stopped = client.stop();
    client.handleLine('{"event":"finished","path":"/tmp/a.mov"}');
    await stopped;
    client.handleExit('quit');
    expect(onEnded).not.toHaveBeenCalled();
  });
});
