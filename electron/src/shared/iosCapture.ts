// Protocol for the native ios-capture helper (electron/native/ios-capture).
// Pure: the main process owns the child process and feeds lines in here, so
// the event routing is unit-testable without spawning anything.

/** A wired iPhone/iPad screen, as reported by the helper. */
export interface IosDevice {
  id: string;
  name: string;
  modelID: string;
  manufacturer?: string;
}

export interface IosStarted {
  width: number;
  height: number;
  /** Epoch ms the movie's first frame was captured (helpers since 1.5). Lines a
   *  Mac + iPhone take's two clocks up. */
  startedAtMs?: number;
}

export interface IosFinished {
  path: string;
  width?: number;
  height?: number;
  duration?: number;
}

/**
 * A mid-take problem that doesn't end the recording. The helper sends
 * "stalled" (no new frame for 5s, usually a locked phone) and "resumed".
 */
export interface IosWarning {
  code: string;
  message?: string;
}

export type IosPreviewState = 'connecting' | 'live' | 'stopped' | 'error';

/**
 * The live preview of one device. "connecting" until the first frame,
 * "live" (with that frame's size) after, "error" when it can't run: `code`
 * is "no-frames" when the phone sent no picture within 3s.
 */
export interface IosPreview {
  id: string;
  state: IosPreviewState;
  width?: number;
  height?: number;
  message?: string;
  code?: string;
}

/** An error from the helper. `code` is "no-frames" when the phone never sent a picture. */
export class IosCaptureError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'IosCaptureError';
  }
}

export type HelperEvent =
  | { event: 'devices'; devices: IosDevice[] }
  | ({ event: 'started' } & IosStarted)
  | ({ event: 'finished' } & IosFinished)
  | { event: 'error'; message: string; code?: string }
  | ({ event: 'warning' } & IosWarning)
  | ({ event: 'preview' } & IosPreview);

const PREVIEW_STATES: readonly string[] = ['connecting', 'live', 'stopped', 'error'];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optNum = (v: unknown) => (isNum(v) ? v : undefined);

function parseDevice(v: unknown): IosDevice | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  if (typeof d.id !== 'string' || !d.id) return null;
  return {
    id: d.id,
    name: typeof d.name === 'string' && d.name ? d.name : 'iOS device',
    modelID: typeof d.modelID === 'string' ? d.modelID : '',
    ...(typeof d.manufacturer === 'string' ? { manufacturer: d.manufacturer } : {}),
  };
}

/** Parse the `list` subcommand's stdout (a JSON array of devices). */
export function parseDeviceList(text: string): IosDevice[] {
  try {
    const arr = JSON.parse(text.trim());
    if (!Array.isArray(arr)) return [];
    return arr.map(parseDevice).filter((d): d is IosDevice => d !== null);
  } catch {
    return [];
  }
}

/** Parse one stdout line into an event; null for blank or unrecognised lines. */
export function parseHelperLine(line: string): HelperEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(trimmed);
  } catch {
    return null;
  }
  switch (o.event) {
    case 'devices':
      return {
        event: 'devices',
        devices: Array.isArray(o.devices)
          ? o.devices.map(parseDevice).filter((d): d is IosDevice => d !== null)
          : [],
      };
    case 'started':
      if (!isNum(o.width) || !isNum(o.height)) return null;
      return { event: 'started', width: o.width, height: o.height, ...(isNum(o.startedAtMs) && o.startedAtMs > 0 ? { startedAtMs: o.startedAtMs } : {}) };
    case 'finished':
      if (typeof o.path !== 'string' || !o.path) return null;
      return {
        event: 'finished',
        path: o.path,
        width: optNum(o.width),
        height: optNum(o.height),
        duration: optNum(o.duration),
      };
    case 'error':
      return {
        event: 'error',
        message: typeof o.message === 'string' ? o.message : 'unknown error',
        ...(typeof o.code === 'string' && o.code ? { code: o.code } : {}),
      };
    case 'warning':
      if (typeof o.code !== 'string' || !o.code) return null;
      return {
        event: 'warning',
        code: o.code,
        ...(typeof o.message === 'string' ? { message: o.message } : {}),
      };
    case 'preview':
      if (typeof o.id !== 'string' || !o.id || typeof o.state !== 'string' || !PREVIEW_STATES.includes(o.state)) {
        return null;
      }
      return {
        event: 'preview',
        id: o.id,
        state: o.state as IosPreviewState,
        ...(isNum(o.width) && isNum(o.height) ? { width: o.width, height: o.height } : {}),
        ...(typeof o.message === 'string' ? { message: o.message } : {}),
        ...(typeof o.code === 'string' && o.code ? { code: o.code } : {}),
      };
    default:
      return null;
  }
}

/** Reassemble stdout chunks into whole lines. */
export function createLineSplitter(onLine: (line: string) => void) {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  };
}

/** Longest preview frame accepted; anything bigger means the pipe is out of step. */
export const MAX_PREVIEW_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Split the helper's preview pipe (fd 3) into frames: each is a 4-byte
 * big-endian length, then that many bytes of JPEG. Chunks can end anywhere.
 * A length of zero or over `maxBytes` means the stream is corrupt: the
 * parser calls `onCorrupt` once and ignores everything after it.
 */
export function createFrameParser(
  onFrame: (jpeg: Uint8Array) => void,
  opts: { maxBytes?: number; onCorrupt?: (reason: string) => void } = {},
) {
  const maxBytes = opts.maxBytes ?? MAX_PREVIEW_FRAME_BYTES;
  let buf: Uint8Array = new Uint8Array(0);
  let broken = false;
  return (chunk: Uint8Array) => {
    if (broken) return;
    if (buf.length === 0) {
      buf = chunk;
    } else {
      const joined = new Uint8Array(buf.length + chunk.length);
      joined.set(buf);
      joined.set(chunk, buf.length);
      buf = joined;
    }
    let off = 0;
    while (buf.length - off >= 4) {
      const len = ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
      if (len === 0 || len > maxBytes) {
        broken = true;
        buf = new Uint8Array(0);
        opts.onCorrupt?.(`bad preview frame length ${len}`);
        return;
      }
      if (buf.length - off - 4 < len) break;
      // A copy, so the frame doesn't pin the whole chunk it came in.
      onFrame(buf.slice(off + 4, off + 4 + len));
      off += 4 + len;
    }
    buf = off === 0 ? buf : buf.slice(off);
  };
}

/**
 * Pass on only the newest value, at most once per `intervalMs`. A value
 * that arrives too soon waits for the rest of the interval, and is replaced
 * by any newer one in the meantime (latest wins; nothing queues up).
 */
export function createLatestThrottle<T>(
  send: (value: T) => void,
  intervalMs: number,
  clock: {
    now: () => number;
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (t: unknown) => void;
  } = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
) {
  let lastSent = -Infinity;
  let pending: { value: T } | null = null;
  let timer: unknown = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    lastSent = clock.now();
    send(value);
  };
  return {
    push(value: T) {
      pending = { value };
      if (timer !== null) return;
      const wait = lastSent + intervalMs - clock.now();
      if (wait <= 0) flush();
      else timer = clock.setTimeout(flush, wait);
    },
    /** Drop anything waiting. */
    cancel() {
      pending = null;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}

interface Deferred<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Talks to one long-lived `ios-capture serve` process. The owner writes
 * helper stdout lines into `handleLine`, reports process exit through
 * `handleExit`, and supplies `write` (stdin) and `kill`.
 *
 * One take at a time: start() resolves on "started", stop() on "finished".
 * A take that ends on its own (cable pulled) is remembered so the next
 * stop() returns it instead of hanging. `warning` holds the current
 * mid-take warning ("stalled"), cleared when frames resume or the take ends.
 *
 * The live preview runs alongside: startPreview()/stopPreview() send the
 * commands and `preview` follows the helper's reports for that device. A
 * take on the previewed device reuses its session (the helper sees to it),
 * and stopPreview() during a take only closes the session once it ends.
 */
export class IosHelperClient {
  devices: IosDevice[] = [];
  /** True once the helper has reported its first device list. */
  ready = false;
  /** Last error not tied to a pending call (helper crash, stray error). */
  lastError: string | null = null;
  warning: IosWarning | null = null;
  /** The preview asked for, and how it's going; null when none is wanted. */
  preview: IosPreview | null = null;

  private starting: Deferred<IosStarted> | null = null;
  private stopping: Deferred<IosFinished> | null = null;
  private recording = false;
  private endedEarly: { ok: IosFinished } | { err: string } | null = null;

  constructor(
    private io: {
      write: (line: string) => void;
      kill: () => void;
      /** A take ended without stop() (cable pulled, helper died). */
      onEnded?: (ended: { ok: IosFinished } | { err: string }) => void;
      /** `preview` changed. */
      onPreview?: (preview: IosPreview | null) => void;
    },
    private timeouts = { startMs: 20_000, stopMs: 30_000 },
  ) {}

  get busy() {
    return this.starting !== null || this.recording || this.stopping !== null;
  }

  start(id: string, path: string): Promise<IosStarted> {
    if (this.busy) return Promise.reject(new Error('An iPhone recording is already running.'));
    this.endedEarly = null;
    this.warning = null;
    return new Promise<IosStarted>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.starting = null;
        // A take stuck before its first frame can't be stopped cleanly.
        this.io.kill();
        reject(new Error('The device did not start sending video. Unlock it and try again.'));
      }, this.timeouts.startMs);
      this.starting = { resolve, reject, timer };
      this.io.write(JSON.stringify({ cmd: 'record', id, path }));
    });
  }

  stop(): Promise<IosFinished> {
    if (this.endedEarly) {
      const e = this.endedEarly;
      this.endedEarly = null;
      return 'ok' in e ? Promise.resolve(e.ok) : Promise.reject(new IosCaptureError(e.err));
    }
    if (!this.recording) return Promise.reject(new Error('No iPhone recording is running.'));
    if (this.stopping) return Promise.reject(new Error('Already stopping.'));
    return new Promise<IosFinished>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stopping = null;
        this.recording = false;
        this.io.kill();
        reject(new Error('The recording did not finish writing in time.'));
      }, this.timeouts.stopMs);
      this.stopping = { resolve, reject, timer };
      this.io.write(JSON.stringify({ cmd: 'stop' }));
    });
  }

  /** Show `id` live. Options are passed to the helper (fps, maxEdge, quality). */
  startPreview(id: string, opts: { fps?: number; maxEdge?: number; quality?: number } = {}) {
    if (this.preview?.id === id && this.preview.state !== 'error' && this.preview.state !== 'stopped') return;
    this.setPreview({ id, state: 'connecting' });
    this.io.write(JSON.stringify({ cmd: 'preview', id, ...opts }));
  }

  stopPreview() {
    if (!this.preview) return;
    this.setPreview(null);
    this.io.write(JSON.stringify({ cmd: 'unpreview' }));
  }

  private setPreview(p: IosPreview | null) {
    this.preview = p;
    this.io.onPreview?.(p);
  }

  handleLine(line: string) {
    const ev = parseHelperLine(line);
    if (ev) this.handleEvent(ev);
  }

  handleEvent(ev: HelperEvent) {
    switch (ev.event) {
      case 'devices':
        this.devices = ev.devices;
        this.ready = true;
        this.lastError = null;
        return;
      case 'started': {
        const p = this.starting;
        this.starting = null;
        this.recording = true;
        if (p) {
          clearTimeout(p.timer);
          p.resolve({ width: ev.width, height: ev.height, ...(ev.startedAtMs ? { startedAtMs: ev.startedAtMs } : {}) });
        }
        return;
      }
      case 'finished': {
        const { event: _e, ...done } = ev;
        this.recording = false;
        this.warning = null;
        const p = this.stopping;
        this.stopping = null;
        if (p) {
          clearTimeout(p.timer);
          p.resolve(done);
        } else {
          this.endEarly({ ok: done });
        }
        return;
      }
      case 'warning':
        this.warning = ev.code === 'resumed' ? null : { code: ev.code, ...(ev.message ? { message: ev.message } : {}) };
        return;
      case 'preview': {
        // Reports for a device we no longer want (switched or stopped) are stale.
        if (this.preview?.id !== ev.id) return;
        const { event: _e, ...p } = ev;
        // "stopped" while still wanted (the helper closed it, e.g. for a
        // take on another device) is not an error, but it isn't live either.
        this.setPreview(p);
        return;
      }
      case 'error': {
        const err = new IosCaptureError(ev.message, ev.code);
        if (this.starting) {
          const p = this.starting;
          this.starting = null;
          clearTimeout(p.timer);
          p.reject(err);
        } else if (this.stopping) {
          const p = this.stopping;
          this.stopping = null;
          this.recording = false;
          clearTimeout(p.timer);
          p.reject(err);
        } else if (this.recording) {
          this.recording = false;
          this.warning = null;
          this.endEarly({ err: ev.message });
        } else {
          this.lastError = ev.message;
        }
        return;
      }
    }
  }

  /** The helper process went away; fail anything in flight. */
  handleExit(reason: string) {
    this.ready = false;
    this.devices = [];
    this.lastError = reason;
    this.warning = null;
    const err = new IosCaptureError(reason);
    for (const p of [this.starting, this.stopping]) {
      if (!p) continue;
      clearTimeout(p.timer);
      p.reject(err);
    }
    if (this.preview) this.setPreview({ id: this.preview.id, state: 'error', message: reason });
    const wasRecording = this.recording && !this.stopping;
    this.starting = null;
    this.stopping = null;
    this.recording = false;
    if (wasRecording) this.endEarly({ err: reason });
  }

  private endEarly(ended: { ok: IosFinished } | { err: string }) {
    this.endedEarly = ended;
    this.io.onEnded?.(ended);
  }
}
