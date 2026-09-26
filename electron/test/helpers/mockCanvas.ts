// Minimal CanvasRenderingContext2D stand-in for node tests: records calls,
// tracks save/restore depth and transform, returns gradient stubs.
export interface MockCtx {
  ctx: CanvasRenderingContext2D;
  calls: Array<{ name: string; args: unknown[] }>;
  depth: () => number;
  count: (name: string) => number;
}

export function mockCanvas(): MockCtx {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  let depth = 0;
  const gradient = { addColorStop: () => undefined };
  const state: Record<string, unknown> = {};
  const target: Record<string, unknown> = {
    save: () => { depth++; },
    restore: () => { depth--; },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    // Glyphs are half the font size wide, so text layout can be tested.
    measureText: (s: string) => {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font ?? '10px'))?.[1] ?? 10);
      return { width: s.length * px * 0.5, actualBoundingBoxAscent: px * 0.8, actualBoundingBoxDescent: px * 0.2 };
    },
  };
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) {
        const v = t[prop];
        if (typeof v === 'function') {
          return (...args: unknown[]) => {
            calls.push({ name: prop, args });
            return (v as (...a: unknown[]) => unknown)(...args);
          };
        }
        return v;
      }
      if (prop in state) return state[prop];
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
      };
    },
    set(_t, prop: string, value) {
      state[prop] = value;
      calls.push({ name: `set:${prop}`, args: [value] });
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, depth: () => depth, count: (n) => calls.filter((c) => c.name === n).length };
}
