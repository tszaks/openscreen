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
  | ({ event: 'warning' } & IosWarning);

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
      return { event: 'started', width: o.width, height: o.height };
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
 */
export class IosHelperClient {
  devices: IosDevice[] = [];
  /** True once the helper has reported its first device list. */
  ready = false;
  /** Last error not tied to a pending call (helper crash, stray error). */
  lastError: string | null = null;
  warning: IosWarning | null = null;

  private starting: Deferred<IosStarted> | null = null;
  private stopping: Deferred<IosFinished> | null = null;
  private recording = false;
  private endedEarly: { ok: IosFinished } | { err: IosCaptureError } | null = null;

  constructor(
    private io: { write: (line: string) => void; kill: () => void },
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
      return 'ok' in e ? Promise.resolve(e.ok) : Promise.reject(e.err);
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
          p.resolve({ width: ev.width, height: ev.height });
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
          this.endedEarly = { ok: done };
        }
        return;
      }
      case 'warning':
        this.warning = ev.code === 'resumed' ? null : { code: ev.code, ...(ev.message ? { message: ev.message } : {}) };
        return;
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
          this.endedEarly = { err };
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
    if (this.recording && !this.stopping) this.endedEarly = { err };
    this.starting = null;
    this.stopping = null;
    this.recording = false;
  }
}
