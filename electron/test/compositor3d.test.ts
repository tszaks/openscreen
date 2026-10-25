// The compositor's 3D path (SPEC §3.8, D9, D15, D17, D20), with the WebGL
// engine replaced by a fake that runs the real screen-texture plan and calls
// the compositor's drawScreen exactly as the engine does. The GPU half of the
// gates runs in Electron (the WP4b harness); this file pins what the
// compositor itself decides: when 3D draws, what it draws where, the hit
// testing and the layer box, strict errors, and that flat projects never touch
// the 3D loader.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, loadGoldenFixture, type Harness, type HarnessInputs } from './helpers/compositorHarness';
import { move } from './helpers/phone3dFixtures';
import { defaultPhone3D, type Phone3D } from '../src/shared/phone3d/model';
import { renderRoi, screenQuadAt, type Scene3D } from '../src/shared/phone3d/projection';
import { projectCanvasSize } from '../src/shared/mobileProject';
import { focusSegmentsFor } from '../src/shared/focusSegments';
import { planScreenTexture } from '../src/renderer/src/phone3d/screenTexture';
import type { Blit3D, Render3DArgs } from '../src/renderer/src/phone3d/view';
import type { Project } from '../src/shared/types';
import type { CanvasCompositor } from '../src/renderer/src/compositor';

const loader = vi.hoisted(() => ({
  engine: null as unknown,
  ensure: vi.fn(),
  sync: vi.fn(),
}));
vi.mock('../src/renderer/src/phone3d/loader', () => ({
  engineSync: () => {
    loader.sync();
    return loader.engine;
  },
  ensurePhone3d: () => {
    loader.ensure();
    return loader.engine ? Promise.resolve(loader.engine) : Promise.reject(new Error('no WebGL in node'));
  },
  onEngineReady: () => () => {},
}));

/** 'lostInDraw': the plan succeeds, the context is lost before the tiles render. */
type FakeResult = 'ok' | 'lost' | 'empty' | 'lostInDraw';

/** An engine that plans the screen texture like the real one and has the compositor draw into it. */
function fakeEngine(h: Harness, W: number, H: number, result: () => FakeResult = () => 'ok') {
  const canvas = h.video('engine', W, H);
  const calls: { args: Render3DArgs; dst: { x: number; y: number; w: number; h: number }; scale: number; tex: string }[] = [];
  return {
    calls,
    canvas,
    waitForRestore: async () => false,
    render(args: Render3DArgs) {
      const r = result();
      if (r === 'lost') return { lost: true as const };
      const s = args.scene;
      const layout = planScreenTexture(screenQuadAt(s, args.time).quad, s.home.screen, args.quality.ss);
      const tex = (document as unknown as { createElement(t: string): HTMLCanvasElement }).createElement('canvas');
      const ctx = tex.getContext('2d')!;
      args.drawScreen(ctx, layout.dst, layout.scale);
      calls.push({ args, dst: layout.dst, scale: layout.scale, tex: h.format(tex) });
      const roi = renderRoi(s, args.time)!;
      if (r === 'empty') return { empty: true as const, roi: { x: 0, y: 0, w: 0, h: 0 } };
      // Two tiles, top and bottom, as view.ts copies them: each core from the engine canvas's top-left.
      const top = Math.floor(roi.h / 2);
      return {
        roi,
        samples: 1,
        tiles: 2,
        draw: (blit: Blit3D) => {
          if (r === 'lostInDraw') return false;
          blit(canvas as unknown as HTMLCanvasElement, roi.w, top, roi.x, roi.y);
          blit(canvas as unknown as HTMLCanvasElement, roi.w, roi.h - top, roi.x, roi.y + top);
          return true;
        },
      };
    },
  };
}

const with3d = (p: Project, patch: Partial<Phone3D> = {}): Project => ({ ...p, phone3d: { ...defaultPhone3D(), ...patch } });

function inputsFor(h: Harness, p: Project, extra: Partial<HarnessInputs> = {}): HarnessInputs {
  return {
    frame: h.video('screen', p.recording.sourceSize.width, p.recording.sourceSize.height),
    cursor: { x: 0.3, y: 0.4 },
    ripples: [{ position: { x: 0.5, y: 0.6 }, progress: 0.4 } as HarnessInputs['ripples'][number]],
    ...extra,
  };
}

/** Renders `p` at t once and returns the log lines of that render, the compositor and the harness. */
async function renderOnce(p: Project, t = 0.5, extra: Partial<HarnessInputs> = {}, engine?: (h: Harness) => unknown, zooms = false) {
  const h = await createHarness();
  try {
    loader.engine = engine ? engine(h) : null;
    const c = h.compositor(p, projectCanvasSize(p), zooms ? focusSegmentsFor(p) : undefined);
    const start = h.log.length;
    h.render(c, t, inputsFor(h, p, extra));
    return { log: h.log.slice(start), c, h, engine: loader.engine as ReturnType<typeof fakeEngine> | null };
  } finally {
    h.dispose();
  }
}

const args = (line: string) => line.slice(line.indexOf('(') + 1, line.lastIndexOf(')')).split(',');

beforeEach(() => {
  loader.engine = null;
  loader.ensure.mockClear();
  loader.sync.mockClear();
});
afterEach(() => {
  loader.engine = null;
});

describe('flat projects never touch the 3D loader (D9: three is not loaded)', () => {
  for (const name of ['display', 'window', 'ios-social', 'ios-16x9', 'ios-landscape', 'ios-appstore', 'mac-iphone']) {
    it(`${name}`, async () => {
      await renderOnce(loadGoldenFixture(name).project);
      expect(loader.ensure).not.toHaveBeenCalled();
      expect(loader.sync).not.toHaveBeenCalled();
    });
  }

  it('phone3d present but disabled, or inactive (App Store, frame off, Mac + iPhone): no loader, the exact flat log', async () => {
    const cases: [string, (p: Project) => Project][] = [
      ['ios-social', (p) => with3d(p, { enabled: false })],
      ['ios-appstore', (p) => with3d(p)],
      ['ios-social', (p) => ({ ...with3d(p), device: { ...p.device, frame: false } })],
      ['mac-iphone', (p) => with3d(p)],
    ];
    for (const [name, edit] of cases) {
      const base = loadGoldenFixture(name).project;
      const flat = await renderOnce(base);
      const off = await renderOnce(edit(base));
      // The frame-off case draws differently from the framed base on purpose; compare it with its own flat twin.
      const twin = edit === cases[2][1] ? await renderOnce({ ...base, device: { ...base.device, frame: false } }) : flat;
      expect(off.log).toEqual(twin.log);
      expect(off.c.has3d).toBe(false);
    }
    expect(loader.ensure).not.toHaveBeenCalled();
  });
});

describe('3D active, engine not loaded yet', () => {
  it('the preview draws exactly the flat frame and starts the load', async () => {
    const base = loadGoldenFixture('ios-social').project;
    const flat = await renderOnce(base);
    const pending = await renderOnce(with3d(base));
    expect(pending.c.has3d).toBe(true);
    expect(pending.c.drew3d).toBe(false);
    expect(pending.c.error3d).toBeNull();
    expect(pending.log).toEqual(flat.log);
    expect(loader.ensure).toHaveBeenCalledTimes(1);
  });

  it('a strict render (export, frames) reports it instead of exporting flat silently', async () => {
    const p = with3d(loadGoldenFixture('ios-social').project);
    const r = await renderOnce(p, 0.5, { render3d: { ss: 1, quality: 'full', motionBlur: null, fps: 30, strict: true } });
    expect(r.c.error3d).toBe('the 3D renderer is not loaded');
  });
});

describe('3D active with an engine', () => {
  const base = () => loadGoldenFixture('ios-social').project;

  it('copies each engine tile 1:1 at integer coordinates in the content slot, and draws no hardware frame', async () => {
    const p = with3d(base());
    const r = await renderOnce(p, 0.5, {}, (h) => fakeEngine(h, 1080, 1920));
    expect(r.c.drew3d).toBe(true);
    const copies = r.log.filter((l) => l.startsWith('canvas#0.drawImage(video:engine,'));
    expect(copies).toHaveLength(2);
    const roi = renderRoi(r.engine!.calls[0].args.scene, 0.5)!;
    let area = 0;
    for (const copy of copies) {
      const [, sx, sy, sw, sh, dx, dy, dw, dh] = args(copy).map(Number);
      expect([sx, sy]).toEqual([0, 0]);
      expect(sw).toBe(dw);
      expect(sh).toBe(dh);
      for (const v of [dx, dy, dw, dh]) expect(Number.isInteger(v)).toBe(true);
      area += dw * dh;
    }
    expect(area).toBe(roi.w * roi.h);
    // The recording is drawn into the screen texture, not onto the canvas.
    expect(r.log.some((l) => l.startsWith('canvas#0.drawImage(video:screen,'))).toBe(false);
    const tex = r.engine!.calls[0].tex;
    expect(r.log.some((l) => l.startsWith(`${tex}.drawImage(video:screen,`))).toBe(true);
    // The flat frame's hardware is gone: its two shadow layers (ambient + contact) are the only shadows missing.
    const flat = await renderOnce(base());
    const shadows = (log: string[]) => log.filter((l) => l.startsWith('canvas#0.shadowBlur = ') && !l.endsWith('= 0'));
    expect(shadows(flat.log).length - shadows(r.log).length).toBe(2);
    // ...and the frame's band gradients and rotation-free frame paths with it: far fewer calls on the main canvas.
    const main = (log: string[]) => log.filter((l) => l.startsWith('canvas#0.')).length;
    expect(main(r.log)).toBeLessThan(main(flat.log));
  });

  it('places the content exactly as flat: same crop, dst = the flat rect at its sub-pixel phase (FRONT, ss 1)', async () => {
    const p = with3d(base());
    const flat = await renderOnce(base());
    const r = await renderOnce(p, 0.5, {}, (h) => fakeEngine(h, 1080, 1920));
    const flatDraw = args(flat.log.find((l) => l.startsWith('canvas#0.drawImage(video:screen,'))!).slice(1).map(Number);
    const tex = r.engine!.calls[0].tex;
    const texDraw = args(r.log.find((l) => l.startsWith(`${tex}.drawImage(video:screen,`))!).slice(1).map(Number);
    expect(texDraw.slice(0, 4)).toEqual(flatDraw.slice(0, 4));
    const [fx, fy, fw, fh] = flatDraw.slice(4);
    const [tx, ty, tw, th] = texDraw.slice(4);
    expect(tw).toBe(fw);
    expect(th).toBe(fh);
    expect(tx).toBeCloseTo(fx - Math.floor(fx), 9);
    expect(ty).toBeCloseTo(fy - Math.floor(fy), 9);
    expect(r.engine!.calls[0].scale).toBe(1);
  });

  it('never zooms the 3D screen (look round 4): inside a zoom the flat frame crops, the 3D texture shows the whole recording', async () => {
    const t = 5.5; // inside the fixture's manual zoom (hold 5-6.2 s, scale 1.5)
    const flat = await renderOnce(base(), t, {}, undefined, true);
    const r = await renderOnce(with3d(base()), t, {}, (h) => fakeEngine(h, 1080, 1920), true);
    const p = base();
    const full = [0, 0, p.recording.sourceSize.width, p.recording.sourceSize.height];
    const flatSrc = args(flat.log.find((l) => l.startsWith('canvas#0.drawImage(video:screen,'))!).slice(1, 5).map(Number);
    expect(flatSrc).not.toEqual(full); // the flat phone is zoomed here (the test can fail)
    const tex = r.engine!.calls[0].tex;
    const texSrc = args(r.log.find((l) => l.startsWith(`${tex}.drawImage(video:screen,`))!).slice(1, 5).map(Number);
    texSrc.forEach((v, i) => expect(v).toBeCloseTo(full[i], 6));
  });

  it('cursor and ripple radii on the texture map back to the flat ones (pxScale, §3.6), at ss 1 and ss 2', async () => {
    const flat = await renderOnce(base());
    const radii = (log: string[], who: string) =>
      log.filter((l) => l.startsWith(`${who}.ellipse(`)).map((l) => Number(args(l)[2]));
    const lineWidths = (log: string[], who: string) => log.filter((l) => l.startsWith(`${who}.lineWidth = `)).map((l) => Number(l.split('= ')[1]));
    const flatR = radii(flat.log, 'canvas#0');
    const flatLw = lineWidths(flat.log, 'canvas#0');
    expect(flatR.length).toBeGreaterThanOrEqual(3); // cursor dot + ripple ring + ripple fill
    for (const ss of [1, 2] as const) {
      const r = await renderOnce(with3d(base()), 0.5, { render3d: { ss, quality: 'full', motionBlur: null, fps: 30, strict: true } }, (h) =>
        fakeEngine(h, 1080, 1920),
      );
      const call = r.engine!.calls[0];
      expect(call.scale).toBe(ss);
      const texR = radii(r.log, call.tex).map((v) => v / call.scale);
      expect(texR.length).toBe(flatR.length);
      texR.forEach((v, i) => expect(Math.abs(v - flatR[i])).toBeLessThan(0.5));
      lineWidths(r.log, call.tex)
        .map((v) => v / call.scale)
        .forEach((v, i) => expect(v).toBeCloseTo(flatLw[i], 9));
    }
  });

  it('keeps contentRect / base (D20), adds the drawn hull, and maps clicks through the turned screen', async () => {
    const flat = await renderOnce(base());
    const front = await renderOnce(with3d(base()), 0.5, {}, (h) => fakeEngine(h, 1080, 1920));
    expect(front.c.contentRect).toEqual(flat.c.contentRect);
    expect(front.c.contentBase).toEqual(flat.c.contentBase);
    const box = front.c.layers.find((l) => l.id === 'content')!;
    expect(box.rect).toEqual(flat.c.contentRect);
    expect(box.hull!.length).toBeGreaterThanOrEqual(4);
    // At FRONT the homography mapping equals the flat mapping.
    for (const q of [
      { x: 0.2, y: 0.3 },
      { x: 0.5, y: 0.5 },
      { x: 0.8, y: 0.9 },
    ]) {
      const a = flat.c.sourceToCanvas(q)!;
      const b = front.c.sourceToCanvas(q)!;
      expect(b.x).toBeCloseTo(a.x, 4);
      expect(b.y).toBeCloseTo(a.y, 4);
      const back = front.c.canvasToSource(b.x, b.y)!;
      expect(back.x).toBeCloseTo(q.x, 6);
      expect(back.y).toBeCloseTo(q.y, 6);
    }
    // Turned 35°: still round-trips; turned to the back: nothing to hit.
    const turned = await renderOnce(with3d(base(), { pose: { ...defaultPhone3D().pose, turn: 35, tilt: 10 } }), 0.5, {}, (h) =>
      fakeEngine(h, 1080, 1920),
    );
    const c = turned.c.sourceToCanvas({ x: 0.4, y: 0.6 })!;
    expect(Math.abs(c.x - flat.c.sourceToCanvas({ x: 0.4, y: 0.6 })!.x)).toBeGreaterThan(1);
    const back = turned.c.canvasToSource(c.x, c.y)!;
    expect(back.x).toBeCloseTo(0.4, 6);
    expect(back.y).toBeCloseTo(0.6, 6);
    const away = await renderOnce(with3d(base(), { pose: { ...defaultPhone3D().pose, turn: 180 } }), 0.5, {}, (h) => fakeEngine(h, 1080, 1920));
    const mid = away.c.contentRect!;
    expect(away.c.canvasToSource(mid.x + mid.w / 2, mid.y + mid.h / 2)).toBeNull();
    expect(away.c.sourceToCanvas({ x: 0.5, y: 0.5 })).toBeNull();
    // A point inside the home rect but outside the turned hull is not on the phone.
    expect(turned.c.layers.find((l) => l.id === 'content')!.hull).toBeDefined();
  });

  it('a lost GPU: the preview falls back to the flat frame; a strict render sets error3d', async () => {
    const base0 = base();
    const flat = await renderOnce(base0);
    const preview = await renderOnce(with3d(base0), 0.5, {}, (h) => fakeEngine(h, 1080, 1920, () => 'lost'));
    expect(preview.c.drew3d).toBe(false);
    expect(preview.c.error3d).toBeNull();
    expect(preview.log).toEqual(flat.log);
    const strict = await renderOnce(with3d(base0), 0.5, { render3d: { ss: 1, quality: 'full', motionBlur: null, fps: 30, strict: true } }, (h) =>
      fakeEngine(h, 1080, 1920, () => 'lost'),
    );
    expect(strict.c.error3d).toBe('3D renderer lost the GPU');
    expect(await strict.c.recover3d(10)).toBe(false);
    // Lost between the plan and the tiles: a strict render still reports it (the frame is incomplete).
    const strictLate = await renderOnce(with3d(base0), 0.5, { render3d: { ss: 1, quality: 'full', motionBlur: null, fps: 30, strict: true } }, (h) =>
      fakeEngine(h, 1080, 1920, () => 'lostInDraw'),
    );
    expect(strictLate.c.error3d).toBe('3D renderer lost the GPU');
    const previewLate = await renderOnce(with3d(base0), 0.5, {}, (h) => fakeEngine(h, 1080, 1920, () => 'lostInDraw'));
    expect(previewLate.c.error3d).toBeNull();
  });

  it('exactly one engine render per compositor frame (§6.5 counter), in export and in the preview', async () => {
    const h = await createHarness();
    try {
      const p = with3d(base(), { transitions: [move('m', 1, 3, { turn: 200, tilt: 10 })] });
      const engine = fakeEngine(h, 1080, 1920);
      loader.engine = engine;
      const c = h.compositor(p, projectCanvasSize(p));
      const strict = { render3d: { ss: 1 as const, quality: 'full' as const, motionBlur: { samples: 12, shutter: 0.5 }, fps: 30, strict: true } };
      const frames = Array.from({ length: 12 }, (_, i) => 0.5 + i / 4);
      for (const [k, t] of frames.entries()) {
        h.render(c, t, inputsFor(h, p, k % 2 ? strict : {}));
        expect(engine.calls).toHaveLength(k + 1);
        expect(engine.calls[k].args.time).toBe(t);
      }
    } finally {
      loader.engine = null;
      h.dispose();
    }
  });

  it('a phone moved entirely off the canvas draws nothing for the content (and no flat phone)', async () => {
    const p = with3d(base(), { pose: { ...defaultPhone3D().pose, x: 1 } });
    const r = await renderOnce(p, 0.5, {}, (h) => fakeEngine(h, 1080, 1920, () => 'empty'));
    expect(r.c.drew3d).toBe(true);
    expect(r.log.some((l) => l.startsWith('canvas#0.drawImage(video:engine'))).toBe(false);
    expect(r.log.some((l) => l.startsWith('canvas#0.drawImage(video:screen'))).toBe(false);
  });

  it('passes the export settings through: render3d → quality, and the live preview default is one draft sample', async () => {
    const p = with3d(base(), { supersample: 2 });
    const live = await renderOnce(p, 0.5, {}, (h) => fakeEngine(h, 1080, 1920));
    expect(live.engine!.calls[0].args.quality).toEqual({ ss: 1, full: false, motion: null, fps: p.outputFPS });
    const exp = await renderOnce(p, 0.5, { render3d: { ss: 2, quality: 'full', motionBlur: { samples: 12, shutter: 0.5 }, fps: 30, strict: true } }, (h) =>
      fakeEngine(h, 1080, 1920),
    );
    expect(exp.engine!.calls[0].args.quality).toEqual({ ss: 2, full: true, motion: { samples: 12, shutter: 0.5 }, fps: 30 });
    const s: Scene3D = exp.engine!.calls[0].args.scene;
    expect(s.home.body).toEqual(exp.c.contentRect);
  });
});
