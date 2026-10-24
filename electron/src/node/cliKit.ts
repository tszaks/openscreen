// Pieces every agent CLI command shares: the error type that carries the exit
// code, JSON output on stdout / progress on stderr, flag parsing, and running
// the app headless (`export`, `frames`) through this checkout's Electron or
// a given OpenScreen.app.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createLineSplitter } from '../shared/iosCapture';

/** A command failure; `code` is the process exit code (1 failed, 2 bad usage). */
export class CliError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

export const out = (o: unknown) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
export const progress = (o: Record<string, unknown>) => process.stderr.write(JSON.stringify(o) + '\n');

/** Take `--name value` / `--name=value` out of `args`; undefined when absent. */
export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new CliError(`${name} needs a value`, 2);
    args.splice(i, 2);
    return v;
  }
  const eq = args.findIndex((a) => a.startsWith(`${name}=`));
  if (eq >= 0) {
    const v = args[eq].slice(name.length + 1);
    args.splice(eq, 1);
    return v;
  }
  return undefined;
}

/** Take a bare `--name` out of `args`. */
export function bool(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

/** A positive duration like `2`, `0.5` or `2s`. */
export const seconds = (v: string) => {
  const n = parseFloat(v.replace(/s$/, ''));
  if (!(n > 0)) throw new CliError(`not a duration: ${v}`, 2);
  return n;
};

export const r2 = (n: number) => Math.round(n * 100) / 100;

/** The app that renders: --app, $OPENSCREEN_APP, else this checkout's dev Electron. */
export function appCommand(appFlag?: string): { cmd: string; pre: string[]; kind: string } {
  const appArg = appFlag ?? process.env.OPENSCREEN_APP;
  if (appArg) {
    const p = resolve(appArg);
    const bin = p.endsWith('.app') ? join(p, 'Contents', 'MacOS', 'OpenScreen') : p;
    if (!existsSync(bin)) throw new CliError(`app binary not found: ${bin}`);
    return { cmd: bin, pre: [], kind: 'app' };
  }
  // Dev: this repo's Electron with the electron/ folder as the app.
  const electronDir = resolve(__dirname, '..', '..');
  const electronBin = join(electronDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  if (!existsSync(electronBin)) throw new CliError('no app to export with: pass --app /path/OpenScreen.app or set OPENSCREEN_APP');
  if (!existsSync(join(electronDir, 'dist', 'main', 'index.js'))) throw new CliError('the app is not built: run `npm run build` in electron/');
  return { cmd: electronBin, pre: [electronDir], kind: 'dev' };
}

/**
 * Run the app headless with `argv` (after the app's own `pre` args), forward
 * its `{"progress":…}` lines to stderr, and resolve its final `{"ok":…}`
 * line (or a failure with the tail of its stderr).
 */
export function runHeadless(app: { cmd: string; pre: string[] }, argv: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolveP) => {
    const child = spawn(app.cmd, [...app.pre, ...argv], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: undefined } as NodeJS.ProcessEnv });
    let final: Record<string, unknown> | null = null;
    let errTail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', createLineSplitter((line) => {
      const t = line.trim();
      if (!t.startsWith('{')) return;
      try {
        const o = JSON.parse(t);
        if ('progress' in o) progress(o);
        else if ('ok' in o) final = o;
      } catch {}
    }));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (errTail = (errTail + d).slice(-4000)));
    child.on('error', (e) => resolveP({ ok: false, error: `could not start the app: ${e.message}` }));
    child.on('close', (code) => resolveP(final ?? { ok: false, error: `the app exited (${code}) without a result`, stderr: errTail.trim().split('\n').slice(-5) }));
  });
}
