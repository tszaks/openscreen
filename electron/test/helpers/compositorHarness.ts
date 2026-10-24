// Compositor harness: builds the real CanvasCompositor (renderer/src/compositor.ts)
// in vitest's node environment, with no DOM, and records every draw call it
// makes as text. The golden test (test/compositorGolden.test.ts) compares that
// log with the one captured from main's compositor, so a refactor that changes
// nothing draws exactly the same calls; placement tests read the compositor's
// boxes (contentRect, layers, ...) after a render.
//
// compositor.ts can't be imported in node as it is:
// - it imports ./api, which reads `window.openscreen` at load;
// - its constructor calls document.createElement('canvas');
// - the blurred backdrop and the backdrop grain make scratch canvases
//   (OffscreenCanvas when defined, else document.createElement);
// - image backgrounds use `new Image`.
// So, in this order: ./api is mocked, then a global `document` whose canvases
// hand out recording mockCanvas contexts is stubbed (OffscreenCanvas is left
// undefined, so every scratch canvas comes through `document` and is logged),
// and `Image` is stubbed (never loads: `complete` stays false). Each harness
// re-imports the compositor with fresh module state, so module caches (the
// grain tile, the blur scratch canvas, background images) never leak between
// fixtures and a log depends only on its own renders.
//
// Log format, one line per event, in call order:
//   canvas#0 = createElement(canvas)        a canvas is made
//   canvas#0.width = 1080                   a property set on a canvas
//   canvas#0.fillRect(0,0,1080,1920)        a context call (on canvas#0's context)
//   canvas#0.fillStyle = "#111"             a context property set
//   gradient#2.addColorStop(0,"#3a1c71")    a call on a gradient
//   # render t=1.5                          one render() begins
//   # state {...}                           the compositor's boxes after it
// Numbers print at full precision (shortest round-trip form), so the log
// proves the exact same geometry, not just a similar one.
import { vi } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanvasCompositor, FrameInputs } from '../../src/renderer/src/compositor';
import type { FocusSegment, AutofocusOptions } from '../../src/shared/autofocus';
import { normalizeProject, type CursorSample, type KeystrokeSample, type Project, type Size } from '../../src/shared/types';
import { mockCanvas, MockGradient, MockImageData, MockPattern } from './mockCanvas';

vi.mock('../../src/renderer/src/api', () => ({ api: { prepareBackground: async (p: string) => p } }));

/** A video element as the compositor sees it: only its size is read. */
export interface FakeVideo {
  readonly label: string;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly readyState: number;
}

/** The per-frame inputs, with fake videos in place of real elements. */
export type HarnessInputs = Omit<FrameInputs, 'frame' | 'cameraFrame' | 'phoneFrame'> & {
  frame: FakeVideo;
  cameraFrame?: FakeVideo;
  phoneFrame?: FakeVideo;
};

export interface Harness {
  /** Every canvas call, property set and render marker so far, in order. */
  readonly log: string[];
  /** A fake video of the given pixel size, named `label` in the log. */
  video(label: string, width: number, height: number): FakeVideo;
  /** The real compositor, built exactly as the editor builds it. */
  compositor(project: Project, canvasSize: Size, segments?: FocusSegment[], autofocusOpts?: AutofocusOptions): CanvasCompositor;
  /** compositor.render(t, inputs), framed in the log by a `# render` line and
   *  followed by a `# state` line with the boxes the render reported. */
  render(compositor: CanvasCompositor, t: number, inputs: HarnessInputs): void;
  /** Format any value the way the log does (for tests' own messages). */
  format(v: unknown): string;
  /** Put the globals back as they were. */
  dispose(): void;
}

const GLOBALS = ['document', 'Image', 'OffscreenCanvas'] as const;

/** FNV-1a over bytes: a short, stable fingerprint for pixel data in the log. */
function fnv1a(bytes: Uint8ClampedArray | Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// The stubs are globals, so one harness owns them at a time: the next
// createHarness() waits until the current one is disposed.
let released: Promise<void> = Promise.resolve();

/** Builds a harness: stubs the globals and imports a fresh compositor module.
 *  Only one harness is live at a time; dispose() it (in a finally) to let the
 *  next one start. */
export async function createHarness(): Promise<Harness> {
  const previous = released;
  let release!: () => void;
  released = new Promise<void>((r) => (release = r));
  await previous;
  const log: string[] = [];
  const names = new WeakMap<object, string>();
  const counters = new Map<string, number>();
  const name = (obj: object, kind: string) => {
    let n = names.get(obj);
    if (!n) {
      const i = counters.get(kind) ?? 0;
      counters.set(kind, i + 1);
      n = `${kind}#${i}`;
      names.set(obj, n);
    }
    return n;
  };

  const format = (v: unknown): string => {
    if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (v === null || v === undefined || typeof v === 'boolean') return String(v);
    if (typeof v === 'function') return '<function>';
    if (typeof v !== 'object') return String(v);
    const known = names.get(v);
    if (known) return known;
    if (v instanceof MockGradient) return `${name(v, 'gradient')}<${v.kind}(${v.args.map(format).join(',')})>`;
    if (v instanceof MockPattern) return `${name(v, 'pattern')}<${format(v.source)},${format(v.repetition)}>`;
    if (v instanceof MockImageData) return `imageData<${v.width}x${v.height},fnv1a:${fnv1a(v.data)}>`;
    if (Array.isArray(v)) return `[${v.map(format).join(',')}]`;
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}:${format(x)}`)
      .join(',')}}`;
  };

  // The context of each canvas reports through here; `self` is the context
  // (named after its canvas) or a gradient it made.
  const record = (self: object, method: string, args: unknown[]) => {
    const who = names.get(self) ?? format(self);
    if (method.startsWith('set:')) log.push(`${who}.${method.slice(4)} = ${format(args[0])}`);
    else log.push(`${who}.${method}(${args.map(format).join(',')})`);
  };

  const makeCanvas = () => {
    const id = name({}, 'canvas'); // reserve the next number
    let width = 300;
    let height = 150;
    let ctx: CanvasRenderingContext2D | null = null;
    const canvas = {
      get width() {
        return width;
      },
      set width(v: number) {
        width = v;
        log.push(`${id}.width = ${format(v)}`);
      },
      get height() {
        return height;
      },
      set height(v: number) {
        height = v;
        log.push(`${id}.height = ${format(v)}`);
      },
      getContext(type: string) {
        if (type !== '2d') return null;
        if (!ctx) {
          ctx = mockCanvas({ record, canvas }).ctx;
          names.set(ctx as unknown as object, id);
        }
        return ctx;
      },
    };
    names.set(canvas, id);
    log.push(`${id} = createElement(canvas)`);
    return canvas;
  };

  class StubImage {
    complete = false;
    naturalWidth = 0;
    naturalHeight = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = '';
    constructor() {
      name(this, 'image');
    }
  }

  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const g of GLOBALS) saved.set(g, Object.getOwnPropertyDescriptor(globalThis, g));
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true, enumerable: false });
  define('document', {
    createElement(tag: string) {
      if (tag === 'canvas') return makeCanvas();
      throw new Error(`compositor harness: document.createElement('${tag}') is not stubbed`);
    },
  });
  define('Image', StubImage);
  // Left undefined on purpose: every scratch canvas then comes from `document`.
  delete (globalThis as Record<string, unknown>).OffscreenCanvas;

  let disposed = false;
  let CanvasCompositor: typeof import('../../src/renderer/src/compositor').CanvasCompositor;
  try {
    vi.resetModules();
    ({ CanvasCompositor } = await import('../../src/renderer/src/compositor'));
  } catch (e) {
    for (const [g, d] of saved) {
      if (d) Object.defineProperty(globalThis, g, d);
      else delete (globalThis as Record<string, unknown>)[g];
    }
    release();
    throw e;
  }

  const state = (c: CanvasCompositor) => ({
    contentRect: c.contentRect,
    contentBase: c.contentBase,
    screenMap: c.screenMap,
    cameraRect: c.cameraRect,
    cameraBasis: c.cameraBasis,
    phoneRect: c.phoneRect,
    phoneBase: c.phoneBase,
    phoneLayout: c.phoneLayout,
    layers: c.layers,
  });

  return {
    log,
    format,
    video(label, width, height) {
      const v: FakeVideo = { label, videoWidth: width, videoHeight: height, readyState: 4 };
      names.set(v, `video:${label}`);
      return v;
    },
    compositor(project, canvasSize, segments = [], autofocusOpts) {
      return new CanvasCompositor(project, canvasSize, segments, autofocusOpts);
    },
    render(c, t, inputs) {
      log.push(`# render t=${format(t)}`);
      c.render(t, inputs as unknown as FrameInputs);
      log.push(`# state ${format(state(c))}`);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [g, d] of saved) {
        if (d) Object.defineProperty(globalThis, g, d);
        else delete (globalThis as Record<string, unknown>)[g];
      }
      release();
    },
  };
}

// ---------------------------------------------------------------------------
// The golden fixtures (test/fixtures/3d-golden/<name>): handmade projects that
// scripts/golden/makeFixtures.mjs also turns into real bundles for exports.

export const GOLDEN_DIR = join(__dirname, '..', 'fixtures', '3d-golden');

/** Golden fixture names, sorted. */
export function goldenFixtureNames(): string[] {
  return readdirSync(GOLDEN_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(GOLDEN_DIR, d.name, 'project.json')))
    .map((d) => d.name)
    .sort();
}

export interface GoldenFixture {
  /** project.json as the app loads it (normalizeProject). */
  project: Project;
  /** cursor.json samples (empty for iPhone takes). */
  cursor: CursorSample[];
  /** keystrokes.json keys. */
  keys: KeystrokeSample[];
}

const readJson = <T>(file: string, fallback: T): T => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback);

/** One golden fixture, loaded the way the app loads a bundle. */
export function loadGoldenFixture(name: string): GoldenFixture {
  const dir = join(GOLDEN_DIR, name);
  if (!existsSync(join(dir, 'project.json'))) throw new Error(`no golden fixture "${name}" (have: ${goldenFixtureNames().join(', ')})`);
  return {
    project: normalizeProject(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as Project),
    cursor: readJson<{ samples?: CursorSample[] }>(join(dir, 'cursor.json'), {}).samples ?? [],
    keys: readJson<{ keys?: KeystrokeSample[] }>(join(dir, 'keystrokes.json'), {}).keys ?? [],
  };
}
