// Minimal CanvasRenderingContext2D stand-in for node tests: records calls,
// tracks save/restore depth and transform, returns gradient stubs.
//
// With `options` (the compositor harness, test/helpers/compositorHarness.ts)
// the context is faithful enough for a draw-call golden log: every call and
// property set also goes to the shared `record` sink, each gradient and
// pattern is its own object (its addColorStop calls are recorded against
// it), createImageData and getImageData return ImageData-shaped objects, the
// current transform is tracked through save/restore, and `ctx.canvas` points
// back at its canvas. Without options it behaves exactly as it always has.
export interface MockCtx {
  ctx: CanvasRenderingContext2D;
  calls: Array<{ name: string; args: unknown[] }>;
  depth: () => number;
  count: (name: string) => number;
}

export interface MockCanvasOptions {
  /** Every call and property set, in order, from this context and the
   *  gradients it makes. `self` is the object the call was made on. */
  record: (self: object, name: string, args: unknown[]) => void;
  /** The canvas this context belongs to (`ctx.canvas`). */
  canvas?: object;
}

/** A 2D affine matrix in DOMMatrix's a..f layout. */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** m · n (n applies first), as DOMMatrix.multiply and ctx.transform do. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/** A recorded gradient: its own identity, so a log can tell gradients apart. */
export class MockGradient {
  readonly stops: Array<[number, string]> = [];
  constructor(
    readonly kind: 'linear' | 'radial' | 'conic',
    readonly args: number[],
    private readonly record?: MockCanvasOptions['record'],
  ) {}
  addColorStop(offset: number, color: string) {
    this.stops.push([offset, color]);
    this.record?.(this, 'addColorStop', [offset, color]);
  }
}

/** A recorded pattern made from `source`. */
export class MockPattern {
  constructor(
    readonly source: unknown,
    readonly repetition: string | null,
  ) {}
  setTransform() {}
}

/** ImageData's shape (node has no ImageData). */
export class MockImageData {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(Math.max(0, width * height * 4));
  }
}

export function mockCanvas(options?: MockCanvasOptions): MockCtx {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  let depth = 0;
  const gradient = { addColorStop: () => undefined };
  const state: Record<string, unknown> = {};
  const faithful = !!options;
  let transform: Matrix = { ...IDENTITY };
  const stack: Matrix[] = [];
  const apply = (n: Matrix) => {
    transform = multiply(transform, n);
  };
  const target: Record<string, unknown> = {
    save: () => {
      depth++;
      stack.push({ ...transform });
    },
    restore: () => {
      depth--;
      const top = stack.pop();
      if (top) transform = top;
    },
    getTransform: () => (faithful ? { ...transform } : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    createLinearGradient: (...a: number[]) => (faithful ? new MockGradient('linear', a, options.record) : gradient),
    createRadialGradient: (...a: number[]) => (faithful ? new MockGradient('radial', a, options.record) : gradient),
    // Glyphs are half the font size wide, so text layout can be tested.
    measureText: (s: string) => {
      const px = Number(String(state.font ?? '10px').match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 10);
      return { width: s.length * px * 0.5, actualBoundingBoxAscent: px * 0.8, actualBoundingBoxDescent: px * 0.2 };
    },
  };
  if (options) {
    Object.assign(target, {
      createConicGradient: (...a: number[]) => new MockGradient('conic', a, options.record),
      createPattern: (source: unknown, repetition: string | null) => new MockPattern(source, repetition),
      createImageData: (w: number | { width: number; height: number }, h?: number) =>
        typeof w === 'number' ? new MockImageData(w, h ?? 0) : new MockImageData(w.width, w.height),
      getImageData: (_x: number, _y: number, w: number, h: number) => new MockImageData(w, h),
      isPointInPath: () => false,
      isPointInStroke: () => false,
      translate: (x: number, y: number) => apply({ a: 1, b: 0, c: 0, d: 1, e: x, f: y }),
      scale: (x: number, y: number) => apply({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 }),
      rotate: (r: number) => apply({ a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), e: 0, f: 0 }),
      transform: (a: number, b: number, c: number, d: number, e: number, f: number) => apply({ a, b, c, d, e, f }),
      setTransform: (a?: number | Partial<Matrix>, b = 0, c = 0, d = 1, e = 0, f = 0) => {
        if (a === undefined) transform = { ...IDENTITY };
        else if (typeof a === 'object') transform = { ...IDENTITY, ...a };
        else transform = { a, b, c, d, e, f };
      },
      resetTransform: () => {
        transform = { ...IDENTITY };
      },
    });
    if (options.canvas) state.canvas = options.canvas;
  }
  const record = (name: string, args: unknown[]) => {
    calls.push({ name, args });
    options?.record(ctx, name, args);
  };
  const ctx = new Proxy(target, {
    get(t, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined;
      if (prop in t) {
        const v = t[prop];
        if (typeof v === 'function') {
          return (...args: unknown[]) => {
            record(prop, args);
            return (v as (...a: unknown[]) => unknown)(...args);
          };
        }
        return v;
      }
      if (prop in state) return state[prop];
      return (...args: unknown[]) => {
        record(prop, args);
      };
    },
    set(_t, prop: string | symbol, value) {
      if (typeof prop === 'symbol') return false;
      state[prop] = value;
      record(`set:${prop}`, [value]);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, depth: () => depth, count: (n) => calls.filter((c) => c.name === n).length };
}
