import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { createLineSplitter, IosCaptureError, IosHelperClient, type IosFinished } from '../shared/iosCapture';
import { encodeIosError } from '../shared/iosErrors';

// Owns the one long-lived `ios-capture serve` process. It is started on the
// first device query and kept alive: the CMIO opt-in costs up to ~5s per
// process, so spawning per poll or per recording would stall the picker.

const helperPath = () =>
  app.isPackaged
    ? join(process.resourcesPath, 'native', 'ios-capture')
    : join(__dirname, '../native/ios-capture');

// Don't respawn a helper that keeps dying more often than this.
const RESPAWN_BACKOFF_MS = 10_000;

let child: ChildProcessWithoutNullStreams | null = null;
let lastExitAt = 0;
let endedListener: ((ended: { ok: IosFinished } | { err: string }) => void) | null = null;

const client = new IosHelperClient({
  write: (line) => {
    if (child?.stdin.writable) child.stdin.write(line + '\n');
  },
  kill: () => child?.kill('SIGKILL'),
  onEnded: (ended) => endedListener?.(ended),
});

/** Called when a take ends without a stop (cable pulled, helper died). */
export function onIosEnded(cb: typeof endedListener) {
  endedListener = cb;
}

function ensureHelper() {
  if (child || Date.now() - lastExitAt < RESPAWN_BACKOFF_MS) return;
  const proc = spawn(helperPath(), ['serve'], { stdio: 'pipe' });
  child = proc;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', createLineSplitter((line) => client.handleLine(line)));
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d: string) => console.error('[ios-capture]', d.trim()));
  proc.stdin.on('error', () => {});
  let gone = false;
  const onGone = (reason: string) => {
    if (gone) return;
    gone = true;
    if (child === proc) child = null;
    lastExitAt = Date.now();
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

export function startIosRecording(deviceId: string, outPath: string) {
  ensureHelper();
  if (!child) return Promise.reject(new Error(client.lastError ?? 'iPhone capture helper is not running.'));
  // IPC drops everything but the message, so the code (e.g. "no-frames",
  // which opens the setup checklist) rides inside it.
  return client.start(deviceId, outPath).catch((e: unknown) => {
    if (e instanceof IosCaptureError && e.code) throw new Error(encodeIosError(e.message, e.code));
    throw e;
  });
}

export function stopIosRecording() {
  return client.stop();
}

/** On quit: SIGTERM lets the helper finalize an in-flight take, then exit. */
export function disposeIosHelper() {
  child?.kill('SIGTERM');
  child = null;
}
