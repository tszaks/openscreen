// scripts/bench3d.mjs: the 3D performance bench (SPEC §6.5, owner decision
// 10). The app runs are measured on real hardware by a person; these tests pin
// the parts that decide pass or fail: percentiles, the GPU process lookup, the
// footprint parse, every budget check (including "not measured", which is
// never a pass), the page-side stats hook, the CDP client and the arguments.
import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
// @ts-expect-error plain .mjs script without types
import { BUDGETS, Cdp, check, checksFrom, gpuPid, INJECT, median, parseArgs, parseFootprint, pct, stats } from '../scripts/bench3d.mjs';

const run = (ms: number[], samples = 12, extra: Record<string, unknown> = {}) => ({
  ok: true,
  frames: ms.length,
  renders: ms.length,
  passMs: ms,
  frames3d: ms.map((m) => ({ ms: m, samples, tiles: 1 })),
  contexts: 1,
  canvas: { w: 1080, h: 1920 },
  baseSamples: 12,
  ...extra,
});
const byName = (cs: any[], name: string) => cs.find((c) => c.name === name);

describe('bench3d: numbers', () => {
  it('pct is nearest-rank; median and stats agree', () => {
    const xs = [5, 1, 4, 2, 3];
    expect(pct(xs, 0.5)).toBe(3);
    expect(pct(xs, 0.95)).toBe(5);
    expect(pct(xs, 0)).toBe(1);
    expect(pct([], 0.5)).toBeNull();
    expect(median([10, 20])).toBe(10);
    expect(stats(Array.from({ length: 100 }, (_, i) => i + 1))).toEqual({ n: 100, p50: 50, p95: 95, max: 100 });
  });

  it('parseFootprint reads the total from footprint -f bytes', () => {
    expect(parseFootprint('====\nElectron Helper [123]: 64-bit    Footprint: 419430400 B (16384 bytes per page)\n====')).toBe(419430400);
    expect(parseFootprint('no such process')).toBeNull();
  });

  it('gpuPid finds the GPU process among the descendants of the app, not another app', () => {
    const ps = [
      '100 1 /x/Electron /e --export b',
      '101 100 /x/Electron Helper --type=utility',
      '102 101 /x/Electron Helper --type=renderer',
      '103 100 /x/Electron Helper --type=gpu-process --foo',
      '200 1 /y/Other',
      '201 200 /y/Other Helper --type=gpu-process',
    ].join('\n');
    expect(gpuPid(ps, 100)).toBe(103);
    expect(gpuPid(ps, 200)).toBe(201);
    expect(gpuPid(ps, 999)).toBeNull();
  });
});

describe('bench3d: checks', () => {
  it('a value that could not be measured is null, never a pass', () => {
    expect(check('x', null, '≤ 1', true).pass).toBeNull();
    expect(check('x', 0, '≤ 1', true).pass).toBe(true);
  });

  it('export budgets: p50 for still, p95 for moving, 4K canvas size, one render and one context per frame', () => {
    const m = {
      e1080still: run(Array(20).fill(BUDGETS.export1080StillMs - 1)),
      e1080moving: run([...Array(19).fill(10), BUDGETS.export1080MovingP95Ms + 50]),
      e4kstill: run(Array(10).fill(30), 12, { canvas: { w: 1080, h: 1920 } }),
      e4kmoving: run([...Array(18).fill(100), 390, 399], 12),
    };
    const cs = checksFrom(m);
    expect(byName(cs, 'export 1080p still 3D pass p50').pass).toBe(true);
    // One slow frame in 20 is the p100, not the p95.
    expect(byName(cs, 'export 1080p moving 3D pass p95').value).toBe(10);
    expect(byName(cs, 'export 4K still canvas')).toMatchObject({ value: '1080×1920', pass: false });
    expect(byName(cs, 'e1080still: engine renders per exported frame').pass).toBe(true);
    const twice = checksFrom({ e1080still: run([5, 5], 12, { renders: 4 }) });
    expect(byName(twice, 'e1080still: engine renders per exported frame')).toMatchObject({ value: 2, pass: false });
    const ctx = checksFrom({ e1080still: run([5], 12, { contexts: 2 }) });
    expect(byName(ctx, 'e1080still: WebGL contexts').pass).toBe(false);
  });

  it('4K moving: p95 over all frames against its budget, and adaptive-N frames (more samples than the base) against theirs (owner decision 16: 800 / 1500 ms)', () => {
    expect([BUDGETS.export4kMovingP95Ms, BUDGETS.export4kAdaptiveMaxMs]).toEqual([800, 1500]);
    const ok = checksFrom({ e4kmoving: run([...Array(19).fill(BUDGETS.export4kMovingP95Ms - 50), BUDGETS.export4kAdaptiveMaxMs - 20], 12) });
    expect(byName(ok, 'export 4K moving (all frames) 3D pass p95').pass).toBe(true);
    const over = checksFrom({ e4kmoving: run(Array(20).fill(BUDGETS.export4kMovingP95Ms + 1), 12) });
    expect(byName(over, 'export 4K moving (all frames) 3D pass p95').pass).toBe(false);
    const slow = run([...Array(19).fill(150), BUDGETS.export4kAdaptiveMaxMs + 50], 12);
    slow.frames3d[19].samples = 40;
    const cs = checksFrom({ e4kmoving: slow });
    expect(byName(cs, 'export 4K moving, adaptive-N frames max')).toMatchObject({ value: BUDGETS.export4kAdaptiveMaxMs + 50, pass: false });
  });

  it('the flat check needs the detector control to have seen the chunk on a 3D export', () => {
    const cs = checksFrom({ e1080still: run([5], 12, { engineLoaded: true }), flat1080: { engineLoaded: false } });
    expect(byName(cs, '3D export: 3D engine chunk loaded (detector control)').pass).toBe(true);
    expect(byName(cs, 'flat project: 3D engine chunk not loaded').pass).toBe(true);
    const leak = checksFrom({ flat1080: { engineLoaded: true } });
    expect(byName(leak, 'flat project: 3D engine chunk not loaded').pass).toBe(false);
    expect(byName(checksFrom({ flat1080: { engineLoaded: null } }), 'flat project: 3D engine chunk not loaded').pass).toBeNull();
  });

  it('GPU memory: 3D peak minus flat peak, median of runs, in MiB', () => {
    const MiB = 1024 * 1024;
    expect([BUDGETS.gpu4kMiB, BUDGETS.gpu4kSs2MiB]).toEqual([400, 700]); // owner decision 16
    const cs = checksFrom({ memory: { flat: [500 * MiB, 520 * MiB, 510 * MiB], defaults: [900 * MiB, 905 * MiB, 2000 * MiB], ss2: [1300 * MiB] } });
    expect(byName(cs, 'GPU memory, 4K defaults')).toMatchObject({ value: 395, pass: true });
    expect(byName(cs, 'GPU memory, 4K supersample 2')).toMatchObject({ value: 790, pass: false });
    expect(byName(checksFrom({ memory: { flat: [510 * MiB], defaults: [900 * MiB], ss2: [1200 * MiB] } }), 'GPU memory, 4K supersample 2')).toMatchObject({ value: 690, pass: true });
    expect(byName(checksFrom({ memory: { flat: [], defaults: [1], ss2: [] } }), 'GPU memory, 4K defaults').pass).toBeNull();
  });

  it('preview: fps is "not measured" when the window itself runs under 55 fps; the pass budget uses live frames', () => {
    expect(BUDGETS.previewPassMs).toBe(8); // owner decision 16
    const capped = checksFrom({ preview: { dof: { fps: 30, idleFps: 30, pass: { p95: 6 } }, plain: { fps: 60, idleFps: 60, pass: { p95: 9 } } } });
    expect(byName(capped, 'preview 1080×1920 frame rate (DoF on)')).toMatchObject({ value: null, pass: null });
    expect(byName(capped, 'preview 1080×1920 frame rate (DoF on)').note).toMatch(/30 fps/);
    expect(byName(capped, 'preview 1080×1920 frame rate (DoF off)').pass).toBe(true);
    expect(byName(capped, 'preview 3D pass p95 (DoF on)').pass).toBe(true);
    expect(byName(capped, 'preview 3D pass p95 (DoF off)').pass).toBe(false);
  });

  it('frames: cold, 1080p draft and 4K full per PNG', () => {
    const cs = checksFrom({ frames: { coldS: 5.9, draft1080S: 0.3, full4kS: 1.2 } });
    expect(cs.map((c: { pass: boolean | null }) => c.pass)).toEqual([true, false, true]);
  });
});

describe('bench3d: page hook and CDP', () => {
  it('INJECT turns stats on, reports every engine render once, and counts each WebGL context once', () => {
    const lines: string[] = [];
    class Canvas {
      ctx: Record<string, object> = {};
      getContext(type: string) {
        return (this.ctx[type] ??= { type });
      }
    }
    // The page script runs in a sandbox whose global has a canvas class and a console.
    const sandbox: Record<string, any> = { HTMLCanvasElement: Canvas, console: { debug: (s: string) => lines.push(s) } };
    sandbox.globalThis = sandbox;
    runInNewContext(INJECT, sandbox);
    expect(sandbox.__p3dStatsOn).toBe(true);
    // What view.ts does per render: n++, ms.push, then last = {...}.
    const rec = (sandbox.__p3d ??= { n: 0, ms: [], last: null });
    rec.n++;
    rec.ms.push(7);
    rec.last = { lastMs: 7, samples: 8, nMotion: 1, tiles: 1, W: 1080, H: 1920, ss: 1, gpuBytes: 1, gpu: 'X' };
    const c = new Canvas();
    c.getContext('webgl2');
    c.getContext('webgl2');
    c.getContext('2d');
    new Canvas().getContext('webgl2');
    expect(lines.filter((l) => l.startsWith('__p3d '))).toHaveLength(1);
    expect(JSON.parse(lines[0].slice(6))).toMatchObject({ ms: 7, samples: 8, W: 1080 });
    expect(lines.filter((l) => l.startsWith('__p3dctx '))).toEqual(['__p3dctx 1', '__p3dctx 2']);
  });

  it('Cdp matches replies to requests, rejects errors, and passes events to handlers', async () => {
    const sent: any[] = [];
    const ws: any = { send: (s: string) => sent.push(JSON.parse(s)), close() {} };
    const cdp = new Cdp(ws);
    const events: string[] = [];
    cdp.on((m: any) => events.push(m.method));
    const a = cdp.send('Runtime.evaluate', { expression: '1' }, 'S1');
    const b = cdp.send('Bad.method');
    expect(sent[0]).toMatchObject({ id: 1, method: 'Runtime.evaluate', sessionId: 'S1' });
    ws.onmessage({ data: JSON.stringify({ id: 2, error: { message: 'nope' } }) });
    ws.onmessage({ data: JSON.stringify({ method: 'Runtime.consoleAPICalled', params: {} }) });
    ws.onmessage({ data: JSON.stringify({ id: 1, result: { value: 1 } }) });
    await expect(a).resolves.toEqual({ value: 1 });
    await expect(b).rejects.toThrow('nope');
    expect(events).toEqual(['Runtime.consoleAPICalled']);
  });

  it('parseArgs: defaults and refusals', () => {
    expect(parseArgs(['b.openscreen'])).toMatchObject({ bundle: 'b.openscreen', seconds: 4, runs: 3, k4: true, preview: true, memory: true });
    expect(parseArgs(['b', '--no-preview', '--runs', '1', '--seconds', '6'])).toMatchObject({ preview: false, runs: 1, seconds: 6 });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(['b', '--seconds', '2'])).toThrow(/seconds/);
    expect(() => parseArgs(['b', '--runs', '0'])).toThrow(/runs/);
    expect(() => parseArgs(['b', 'c'])).toThrow(/unexpected/);
  });
});
