// Fixtures for the 3D phone tests (WP1). Plain projects built from the app's
// own defaults, so they track the real model.
import { defaultPhone3D, type Phone3D, type PoseTransition } from '../../src/shared/phone3d/model';
import { defaultProject, type Project } from '../../src/shared/types';
import { DEVICES } from '../../src/shared/devices';

/** An iPhone take of `size` (default: an iPhone 17 Pro capture), 10 s. */
export function phoneProject(opts: { width?: number; height?: number; duration?: number; presetId?: string; modelId?: string } = {}): Project {
  const width = opts.width ?? 1206;
  const height = opts.height ?? 2622;
  const p = defaultProject({ screenVideoFile: 'screen.mov', sourceKind: 'iosDevice', sourceSize: { width, height }, duration: opts.duration ?? 10 });
  p.clips[0].id = 'clip-1';
  if (opts.presetId !== undefined) p.layout.presetId = opts.presetId;
  if (opts.modelId) p.device.modelId = opts.modelId;
  return p;
}

/** The project with 3D on (defaults merged with `patch`). */
export function with3d(p: Project, patch: Partial<Phone3D> = {}): Project {
  return { ...p, phone3d: { ...defaultPhone3D(), ...patch } };
}

/** A move with full poses. */
export function move(id: string, start: number, end: number, to: Partial<PoseTransition['to']>, extra: Partial<PoseTransition> = {}): PoseTransition {
  return {
    id,
    start,
    end,
    to: { turn: 0, tilt: 0, rotate: 0, size: 1, x: 0, y: 0, light: 0, focus: 1, ...to },
    easing: { kind: 'smooth' },
    ...extra,
  };
}

/** Every iPhone in the registry, portrait capture size. */
export const IPHONES = DEVICES.filter((d) => d.family === 'iphone');
export const IPADS = DEVICES.filter((d) => d.family === 'ipad');

/** Deterministic LCG for property tests (test-only randomness). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
