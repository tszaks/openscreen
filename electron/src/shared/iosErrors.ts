// Electron's IPC keeps only an error's message, so the helper's error code
// (e.g. "no-frames") would be lost between main and the renderer. Main
// folds the code into the message; the renderer unfolds it.

const CODE_PREFIX = /^\[ios:([a-z0-9-]+)\] /;

/** Main side: carry `code` across IPC inside the message. */
export function encodeIosError(message: string, code?: string): string {
  return code ? `[ios:${code}] ${message}` : message;
}

/** Renderer side: split a (possibly encoded) message back into code and text. */
export function decodeIosError(message: string): { code?: string; message: string } {
  const m = message.match(CODE_PREFIX);
  return m ? { code: m[1], message: message.slice(m[0].length) } : { message };
}
