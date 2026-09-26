import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  createFrameParser,
  createLatestThrottle,
  createLineSplitter,
  IosCaptureError,
  IosHelperClient,
  type IosFinished,
  type IosPreview,
} from '../shared/iosCapture';
import { encodeIosError } from '../shared/iosErrors';

// Owns the one long-lived `ios-capture serve` process. It is started on the
// first device query and kept alive: the CMIO opt-in costs up to ~5s per
// process, so spawning per poll or per recording would stall the picker.
//
// Live preview frames arrive on the helper's fd 3 (stdout stays JSON only).
// Only the newest frame is kept, and it goes to the renderer at most
// PREVIEW_FPS times a second.

// OPENSCREEN_IOS_HELPER swaps in a stand-in helper, so the app can be
// driven end to end without a phone.
const helperPath = () =>
  process.env.OPENSCREEN_IOS_HELPER ||
  (app.isPackaged
    ? join(process.resourcesPath, 'native', 'ios-capture')
    : join(__dirname, '../native/ios-capture'));

// Don't respawn a helper that keeps dying more often than this.
const RESPAWN_BACKOFF_MS = 10_000;
const PREVIEW_FPS = 12;
const PREVIEW_MAX_EDGE = 360;

let child: ChildProcess | null = null;
let lastExitAt = 0;
let endedListener: ((ended: { ok: IosFinished } | { err: string }) => void) | null = null;
let previewListener: ((preview: IosPreview | null) => void) | null = null;
let frameListener: ((frame: { id: string; jpeg: Uint8Array }) => void) | null = null;
// The stop in flight, so a quit or a closed window can wait on the same one.
let stopping: Promise<IosFinished> | null = null;
// The device of the latest take: its frames still reach the recording card
// if no preview was asked for.
let takeDeviceId: string | null = null;

const stdin = () => child?.stdio[0] as Writable | null | undefined;

const client = new IosHelperClient({
  write: (line) => {
    const s = stdin();
    if (s?.writable) s.write(line + '\n');
  },
  kill: () => child?.kill('SIGKILL'),
  onEnded: (ended) => endedListener?.(ended),
  onPreview: (preview) => {
    if (!preview || preview.state === 'error' || preview.state === 'stopped') frames.cancel();
    previewListener?.(preview);
  },
});

const frames = createLatestThrottle<Uint8Array>((jpeg) => {
  const id = client.preview?.id ?? takeDeviceId;
  if (id) frameListener?.({ id, jpeg });
}, 1000 / PREVIEW_FPS);

/** Called when a take ends without a stop (cable pulled, helper died). */
export function onIosEnded(cb: typeof endedListener) {
  endedListener = cb;
}

/** Preview state changes, and preview frames (JPEG), for the renderer. */
export function onIosPreview(state: typeof previewListener, frame: typeof frameListener) {
  previewListener = state;
  frameListener = frame;
}

function ensureHelper() {
  if (child || Date.now() - lastExitAt < RESPAWN_BACKOFF_MS) return;
  const proc = spawn(helperPath(), ['serve', '--preview-fd', '3'], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  child = proc;
  const [input, out, err, preview] = proc.stdio as unknown as [Writable, Readable, Readable, Readable];
  out.setEncoding('utf8');
  out.on('data', createLineSplitter((line) => client.handleLine(line)));
  err.setEncoding('utf8');
  err.on('data', (d: string) => console.error('[ios-capture]', d.trim()));
  input.on('error', () => {});
  preview.on('error', () => {});
  preview.on(
    'data',
    createFrameParser((jpeg) => frames.push(jpeg), {
      onCorrupt: (reason) => console.error('[ios-capture] preview pipe:', reason),
    }),
  );
  let gone = false;
  const onGone = (reason: string) => {
    if (gone) return;
    gone = true;
    if (child === proc) child = null;
    lastExitAt = Date.now();
    frames.cancel();
    client.handleExit(reason);
  };
  proc.on('error', (e) => onGone(`iPhone capture helper failed to start: ${e.message}`));
  proc.on('exit', (code, signal) =>
    onGone(`iPhone capture helper exited (${signal ?? `code ${code}`})`),
  );
}

export function listIosDevices() {
  ensureHelper();
  return {
    devices: client.devices,
    ready: client.ready,
    error: client.ready ? null : client.lastError,
    /** Mid-take warning, e.g. "stalled" when the phone may be locked. */
    warning: client.warning,
  };
}

/** Show a device live. State changes and frames arrive via onIosPreview. */
export function startIosPreview(deviceId: string) {
  ensureHelper();
  if (!child) throw new Error(client.lastError ?? 'iPhone capture helper is not running.');
  client.startPreview(deviceId, { fps: PREVIEW_FPS, maxEdge: PREVIEW_MAX_EDGE });
  return client.preview;
}

/** Stop the preview. During a take the helper keeps the session until it ends. */
export function stopIosPreview() {
  client.stopPreview();
}

export function startIosRecording(deviceId: string, outPath: string) {
  ensureHelper();
  if (!child) return Promise.reject(new Error(client.lastError ?? 'iPhone capture helper is not running.'));
  takeDeviceId = deviceId;
  // IPC drops everything but the message, so the code (e.g. "no-frames",
  // which opens the setup checklist) rides inside it.
  return client.start(deviceId, outPath).catch((e: unknown) => {
    if (e instanceof IosCaptureError && e.code) throw new Error(encodeIosError(e.message, e.code));
    throw e;
  });
}

/** Stop the take. A second call while one is in flight gets the same result. */
export function stopIosRecording() {
  if (stopping) return stopping;
  const p = client.stop();
  stopping = p;
  const clear = () => {
    if (stopping === p) stopping = null;
  };
  p.then(clear, clear);
  return p;
}

/**
 * On quit: finish any take (waiting up to `timeoutMs` for the file to be
 * written, so quitting mid-take keeps it), then let the helper go. SIGTERM
 * also makes the helper finish a take it is still writing before it exits.
 */
export async function shutdownIosHelper(timeoutMs = 3000) {
  if (child && client.busy) {
    const finished = stopIosRecording().catch(() => {});
    await Promise.race([finished, new Promise((r) => setTimeout(r, timeoutMs))]);
  }
  disposeIosHelper();
}

export function disposeIosHelper() {
  frames.cancel();
  child?.kill('SIGTERM');
  child = null;
}
