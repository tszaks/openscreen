// Lazy loading of the 3D phone engine (SPEC §3.1, D9). three.js and the
// engine live in their own chunk, imported only when a project's 3D phone is
// active, so a flat project never loads them. The preview draws flat until
// the engine is ready and then redraws (onEngineReady); export and frames
// wait for ensurePhone3d() before frame 0.
//
// This file must not import three or anything that does: the compositor
// imports it on every project.
import type { Engine } from './engine';

let engine: Engine | null = null;
let pending: Promise<Engine> | null = null;
let failure: string | null = null;
const listeners = new Set<(e: Engine) => void>();

/** Loads three and creates the engine once; later calls return the same promise. A failed load can be retried. */
export function ensurePhone3d(): Promise<Engine> {
  if (engine) return Promise.resolve(engine);
  pending ??= import('./engine').then(
    (m) => {
      const e = m.getEngine();
      engine = e;
      failure = null;
      for (const cb of [...listeners]) cb(e);
      return e;
    },
    (err: unknown) => {
      pending = null;
      failure = err instanceof Error ? err.message : String(err);
      throw err;
    },
  );
  return pending;
}

/** The engine if it has loaded, else null (never starts a load). */
export function engineSync(): Engine | null {
  return engine;
}

/** Calls `cb` when the engine finishes loading (not when it already has: nothing is waiting then). Returns an
 *  unsubscribe. */
export function onEngineReady(cb: (e: Engine) => void): () => void {
  if (engine) return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Why the last load failed (no WebGL 2, …), or null. */
export function phone3dLoadError(): string | null {
  return failure;
}

/** Whether the engine (and so three) has been loaded in this process. */
export function phone3dLoaded(): boolean {
  return engine !== null || pending !== null;
}
