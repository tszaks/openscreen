// renderPhone3D's frame loop (SPEC §3.7), run in node with the real Passes,
// ShadowPass and ScreenTexture on a renderer that records its calls instead
// of drawing. It pins what the loop asks the GPU to do: shadow masks once per
// frame whatever the tile count (§3.7 step 8: "the shadow targets are per
// frame, not per tile"), every sample's catcher pointing at the masks of the
// pose it belongs to, N scene renders per tile, a screen texture that
// never outgrows the GPU's size limit (§3.6) and fills in bands, and the
// §3.9 GPU memory budgets at 4K (ss 1 ≤ 340 MB, ss 2 ≤ 440 MB) counted the
// way Engine.gpuBytes counts them, at the heaviest frame of a turn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { grownSize, Passes } from '../src/renderer/src/phone3d/passes';
import { ShadowPass, SHADOW_SLOTS } from '../src/renderer/src/phone3d/shadow';
import { MAX_SCREEN_TEXTURE, obliqueScaleCap, planBands, planScreenTexture, SCREEN_BAND_PX, ScreenTexture, screenCanvasSize, screenRoom, textureSide } from '../src/renderer/src/phone3d/screenTexture';
import { planShadowSlots, renderPhone3D, type Blit3D, type Render3DArgs, type Render3DQuality } from '../src/renderer/src/phone3d/view';
import type { Engine } from '../src/renderer/src/phone3d/engine';
import { scene3d, screenQuadAt, type Scene3D } from '../src/shared/phone3d/projection';
import { defaultPhone3D, FRONT, type Phone3D } from '../src/shared/phone3d/model';
import { normalizeProject, type Project } from '../src/shared/types';
import { move, phoneProject, with3d } from './helpers/phone3dFixtures';
import { projectCanvasSize } from '../src/shared/mobileProject';

/** A 2D canvas that accepts every call (the screen texture's canvas; the compositor's drawScreen is stubbed). */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<string, unknown>, { get: (o, k) => (k in o ? o[k as string] : () => undefined), set: (o, k, v) => ((o[k as string] = v), true) });
  return { width: 0, height: 0, getContext: () => ctx };
}

type Call = { kind: 'scene' | 'shadow' | 'pass'; target: THREE.WebGLRenderTarget | null; contact?: unknown; corners?: number[] };
/** One band upload into the screen texture: the band canvas's size, where it lands (GL rows, flipped) and whether it made the mips. */
type Upload = { w: number; h: number; x: number; y: number; dstW: number; dstH: number; mips: boolean; flipY: boolean };

/** An Engine whose renderer records draws: the real passes, shadow and screen texture objects, no GL. */
function fakeEngine(maxSide = 8192) {
  const calls: Call[] = [];
  const uploads: Upload[] = [];
  /** The engine canvas as the real Engine.sizeCanvas would hold it (grownSize). */
  const held: { canvas: { w: number; h: number } | null } = { canvas: null };
  const canvasSizes: { w: number; h: number }[] = [];
  let target: THREE.WebGLRenderTarget | null = null;
  const scene = new THREE.Scene();
  const renderer = {
    getContext: () => ({ isContextLost: () => false }),
    initTexture: () => undefined,
    copyTextureToTexture: (src: THREE.Texture, dst: THREE.DataTexture, region: unknown, at: THREE.Vector2) => {
      const img = src.image as { width: number; height: number };
      expect(region).toBeNull(); // whole band canvases only: no partial (sub-rectangle) uploads
      uploads.push({ w: img.width, h: img.height, x: at.x, y: at.y, dstW: dst.image.width, dstH: dst.image.height, mips: dst.generateMipmaps, flipY: dst.flipY });
    },
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => void (target = t),
    getRenderTarget: () => target,
    setClearColor: () => undefined,
    clear: () => undefined,
    setViewport: () => undefined,
    setScissor: () => undefined,
    setScissorTest: () => undefined,
    render: (sc: THREE.Scene) => {
      if (sc === scene) {
        const u = shadow.catcher.material as THREE.ShaderMaterial;
        const pos = shadow.catcher.geometry.getAttribute('position') as THREE.BufferAttribute;
        calls.push({ kind: 'scene', target, contact: u.uniforms.uContact.value, corners: Array.from(pos.array as Float32Array) });
      } else calls.push({ kind: sc.overrideMaterial ? 'shadow' : 'pass', target });
    },
  } as unknown as THREE.WebGLRenderer;
  const shadow = new ShadowPass(renderer);
  const passes = new Passes(renderer);
  const screen = new ScreenTexture(renderer, 1);
  const poseGroup = new THREE.Group();
  const inner = new THREE.Group();
  poseGroup.add(inner);
  poseGroup.rotation.order = 'ZXY';
  scene.add(poseGroup);
  scene.add(shadow.catcher);
  const cache = () => {
    const m = new Map<string, unknown>();
    return { get: <V>(k: string, make: () => V): V => (m.has(k) ? (m.get(k) as V) : (m.set(k, make()), m.get(k) as V)) };
  };
  const engine = {
    canvas: fakeCanvas(),
    renderer,
    generation: 0,
    lost: false,
    scene,
    poseGroup,
    inner,
    camera: new THREE.PerspectiveCamera(22, 1, 1, 2),
    passes,
    screen,
    shadow,
    kit: {
      phone: () => ({ root: new THREE.Group(), screen: new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()), dispose() {} }),
      lights: () => new THREE.Group(),
      placeLights: () => {},
      environment: () => null,
      envStrength: () => 1,
    },
    phones: cache(),
    envs: cache(),
    rigs: cache(),
    current: { phone: null, rig: null },
    stats: { renders: 0, lastMs: 0, samples: 0, tiles: 0, roi: { x: 0, y: 0, w: 0, h: 0 }, texture: { w: 0, h: 0 }, gpuBytes: 0 },
    maxSide: () => maxSide,
    sizeCanvas: (w: number, h: number) => {
      canvasSizes.push({ w, h });
      held.canvas = grownSize(held.canvas, w, h);
      return held.canvas;
    },
    gpuBytes: () => 0,
    gpuName: () => 'fake',
  };
    /** What the 3D path holds on the GPU now, bytes, as Engine.gpuBytes counts it (no environment: the fake kit has none). */
  const bytes = () => ({
    passes: passes.bytes(),
    shadow: shadow.bytes(),
    texture: screen.bytes(),
    canvas2d: screen.canvasBytes(),
    engineCanvas: held.canvas ? held.canvas.w * held.canvas.h * 4 * 2 : 0,
  });
  return { engine: engine as unknown as Engine, calls, shadow, passes, screen, canvasSizes, uploads, bytes };
}

/** One frame: plan it, then draw its tiles with a blit that records each copy. */
function frame(engine: Engine, a: Render3DArgs) {
  const out = renderPhone3D(engine, a);
  if (!('draw' in out)) throw new Error('expected a rendered frame');
  const blits: { w: number; h: number; x: number; y: number }[] = [];
  const blit: Blit3D = (_src, w, h, x, y) => void blits.push({ w, h, x, y });
  const ok = out.draw(blit);
  return { out, blits, ok };
}

const moving = (patch: Partial<Phone3D> = {}): Partial<Phone3D> => ({ transitions: [move('m', 1, 3, { turn: 200, tilt: 10 }, { easing: { kind: 'cinematic' } })], ...patch });

/** The golden-size iPhone project with 3D on: 1080×1920 social, or the phone filling a 2160×3840 canvas (the GPU harness's 4K case). */
function sceneFor(patch: Partial<Phone3D>, k4: boolean): Scene3D {
  let p: Project = with3d(phoneProject(), patch);
  if (k4) p = normalizeProject({ ...p, layout: { ...p.layout, presetId: 'none' } });
  return scene3d(p, k4 ? { width: 2160, height: 3840 } : projectCanvasSize(p))!;
}

function args(s: Scene3D, t: number, quality: Partial<Render3DQuality> = {}): Render3DArgs {
  const mb = s.p3.motionBlur;
  return {
    scene: s,
    time: t,
    look: { hex: '#333333', back: s.p3.back, glass: s.p3.glass },
    bgMean: [0.5, 0.5, 0.5],
    drawScreen: () => undefined,
    quality: { ss: s.p3.supersample, full: true, motion: mb.on ? { samples: mb.samples, shutter: mb.shutter } : null, fps: 30, ...quality },
  };
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => fakeCanvas() });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shadow slots (§3.7 steps 5 and 8)', () => {
  it('still: one slot at sample 0; moving: min(SHADOW_SLOTS, N) slots, each cast from the middle of its samples', () => {
    expect(planShadowSlots({ n: 8, nMotion: 1 })).toEqual({ count: 1, at: [0], of: Array(8).fill(0) });
    for (const n of [2, 5, 6, 7, 12, 36, 64]) {
      const p = planShadowSlots({ n, nMotion: n });
      expect(p.count).toBe(Math.min(SHADOW_SLOTS, n));
      expect(p.of).toHaveLength(n);
      // Every slot serves a contiguous run of samples, in order, and is cast from a sample inside its own run.
      for (let k = 1; k < n; k++) expect(p.of[k] - p.of[k - 1]).toBeGreaterThanOrEqual(0);
      expect(new Set(p.of).size).toBe(p.count);
      p.at.forEach((k, i) => expect(p.of[k]).toBe(i));
    }
  });
});

describe('renderPhone3D frame loop', () => {
  it('a moving 4K frame renders each shadow slot once, before the tiles, whatever the tile count', () => {
    const s = sceneFor(moving(), true);
    const { engine, calls, shadow } = fakeEngine();
    let checkedTiles = 0;
    for (const t of [1.6, 1.8, 2.0]) {
      calls.length = 0;
      const before = shadow.maskRenders;
      const { out } = frame(engine, args(s, t));
      const plan = planShadowSlots({ n: out.samples, nMotion: out.samples });
      expect(out.samples).toBeGreaterThan(SHADOW_SLOTS); // a real moving frame: more samples than slots
      expect(shadow.maskRenders - before).toBe(Math.min(SHADOW_SLOTS, out.samples));
      // Silhouettes all come before the first scene draw (no tile re-renders a mask).
      const firstScene = calls.findIndex((c) => c.kind === 'scene');
      expect(calls.filter((c) => c.kind === 'shadow')).toHaveLength(plan.count);
      expect(calls.slice(firstScene).some((c) => c.kind === 'shadow')).toBe(false);
      // N scene draws per tile.
      const scenes = calls.filter((c) => c.kind === 'scene');
      expect(scenes).toHaveLength(out.samples * out.tiles);
      checkedTiles = Math.max(checkedTiles, out.tiles);
    }
    expect(checkedTiles).toBeGreaterThan(1); // the case the bug lived in: several tiles
  });

  it('each sample of every tile draws the catcher with its own slot’s masks, placed at that slot’s pose', () => {
    const s = sceneFor(moving(), true);
    const { engine, calls } = fakeEngine();
    const { out } = frame(engine, args(s, 1.8));
    const slots = planShadowSlots({ n: out.samples, nMotion: out.samples });
    const scenes = calls.filter((c) => c.kind === 'scene');
    // Slot textures by first use in tile 0 (sample order), then every tile must repeat the same sequence.
    const slotTex = slots.at.map((k) => scenes[k].contact);
    expect(new Set(slotTex).size).toBe(slots.count);
    for (let tile = 0; tile < out.tiles; tile++) {
      for (let k = 0; k < out.samples; k++) {
        const c = scenes[tile * out.samples + k];
        expect(c.contact).toBe(slotTex[slots.of[k]]);
        expect(c.corners).toEqual(scenes[slots.at[slots.of[k]]].corners);
      }
    }
    // Different slots are cast at different poses (the catcher moves with the phone).
    expect(scenes[slots.at[0]].corners).not.toEqual(scenes[slots.at[slots.count - 1]].corners);
  });

  it('a still frame renders its shadow once, and a repeat of the same frame (paused preview) reuses it', () => {
    for (const k4 of [false, true]) {
      const s = sceneFor({}, k4);
      const { engine, shadow } = fakeEngine();
      const { out: a } = frame(engine, args(s, 0.5));
      expect(a.samples).toBe(8);
      expect(shadow.maskRenders).toBe(1);
      expect(shadow.slotCount).toBe(1); // a still phone never makes the moving-frame slots
      frame(engine, args(s, 0.5));
      expect(shadow.maskRenders).toBe(1);
    }
  });

  it('tiles are copied one by one: the cores cover the ROI exactly once, 1:1 at integer coordinates, and the engine canvas holds one core', () => {
    for (const [patch, k4, t] of [
      [moving(), true, 1.8],
      [{}, true, 0.5],
      [{}, false, 0.5],
      [{ supersample: 2 }, false, 0.5],
    ] as const) {
      const s = sceneFor(patch as Partial<Phone3D>, k4);
      const { engine, canvasSizes } = fakeEngine();
      const { out, blits, ok } = frame(engine, args(s, t));
      expect(ok).toBe(true);
      expect(blits).toHaveLength(out.tiles);
      const canvas = canvasSizes.at(-1)!;
      const roi = out.roi;
      let area = 0;
      for (const b of blits) {
        for (const v of [b.w, b.h, b.x, b.y]) expect(Number.isInteger(v)).toBe(true);
        expect(b.w).toBeLessThanOrEqual(canvas.w);
        expect(b.h).toBeLessThanOrEqual(canvas.h);
        expect(b.x).toBeGreaterThanOrEqual(roi.x);
        expect(b.y).toBeGreaterThanOrEqual(roi.y);
        expect(b.x + b.w).toBeLessThanOrEqual(roi.x + roi.w);
        expect(b.y + b.h).toBeLessThanOrEqual(roi.y + roi.h);
        area += b.w * b.h;
      }
      // Inside the ROI, pairwise disjoint, and their areas add up to it: an exact cover.
      for (let i = 0; i < blits.length; i++)
        for (let j = i + 1; j < blits.length; j++) {
          const a = blits[i];
          const b = blits[j];
          expect(a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h).toBe(true);
        }
      expect(area).toBe(roi.w * roi.h);
      // The canvas is one core, not the ROI, when there are several tiles.
      if (out.tiles > 1) expect(canvas.w * canvas.h).toBeLessThan(roi.w * roi.h);
    }
  });

  it('draw runs once, for the latest frame only', () => {
    const s = sceneFor({}, false);
    const { engine } = fakeEngine();
    const a = renderPhone3D(engine, args(s, 0.5));
    if (!('draw' in a)) throw new Error('expected a rendered frame');
    const b = renderPhone3D(engine, args(s, 0.6));
    if (!('draw' in b)) throw new Error('expected a rendered frame');
    expect(() => a.draw(() => undefined)).toThrow(/latest frame/);
    expect(b.draw(() => undefined)).toBe(true);
    expect(() => b.draw(() => undefined)).toThrow(/once/);
  });

  it('shadow off: no masks at all', () => {
    const s = sceneFor(moving({ shadow: { ...defaultPhone3D().shadow, on: false } }), true);
    const { engine, shadow, calls } = fakeEngine();
    frame(engine, args(s, 1.8));
    expect(shadow.maskRenders).toBe(0);
    expect(calls.some((c) => c.kind === 'shadow')).toBe(false);
  });
});

describe('screen texture size limit (§3.6)', () => {
  it('screenCanvasSize: never above the cap, holds the need, and the room up to the cap', () => {
    for (const cap of [4096, 8192, 16384]) {
      for (const [nw, nh, rw, rh] of [
        [576, 1245, 644, 1394],
        [3781, 8191, 5146, 11149],
        [100, 100, 20000, 20000],
        [1000, 4000, 0, 0],
      ]) {
        const need = { w: Math.min(nw, Math.min(cap, MAX_SCREEN_TEXTURE)), h: Math.min(nh, Math.min(cap, MAX_SCREEN_TEXTURE)) };
        const c = screenCanvasSize(need.w, need.h, cap, { w: rw, h: rh });
        const lim = Math.min(cap, MAX_SCREEN_TEXTURE);
        expect(c.w).toBeLessThanOrEqual(lim);
        expect(c.h).toBeLessThanOrEqual(lim);
        expect(c.w).toBeGreaterThanOrEqual(need.w);
        expect(c.h).toBeGreaterThanOrEqual(need.h);
        expect(c.w).toBeGreaterThanOrEqual(Math.min(rw, lim));
        expect(c.h).toBeGreaterThanOrEqual(Math.min(rh, lim));
        // Still a ladder rung (or the cap): a pure function of need and room.
        expect(c.w).toBe(textureSide(Math.max(need.w, Math.min(rw, lim)), lim));
      }
    }
  });

  it('4K at ss 3, ss 2 × size 1.5, or size 3: the real frame’s texture canvas stays within the GPU limit', () => {
    for (const maxSide of [8192, 4096]) {
      for (const [ss, size] of [
        [1, 1],
        [3, 1],
        [2, 1.5],
        [1, 3],
      ] as const) {
        const s = sceneFor({ supersample: ss, pose: { ...FRONT, size } }, true);
        const { engine, screen } = fakeEngine(maxSide);
        frame(engine, args(s, 0.5, { full: false, motion: null }));
        const c = { width: screen.size!.w, height: screen.size!.h };
        expect(c.width).toBeLessThanOrEqual(maxSide);
        expect(c.height).toBeLessThanOrEqual(maxSide);
        // And it holds the frame's own (capped) need.
        expect(engine.stats.texture.w).toBeGreaterThan(0);
        expect(c.width).toBeGreaterThanOrEqual(engine.stats.texture.w);
        expect(c.height).toBeGreaterThanOrEqual(engine.stats.texture.h);
        // The room alone (no clamp) would be over the limit in the big cases: the clamp is what holds.
        if (ss * size >= 3) expect(screenRoom(s.home.screen, ss, [size]).h).toBeGreaterThan(maxSide);
      }
    }
  });
});

describe('screen texture bands (§3.6, §3.9)', () => {
  it('planBands: equal bands that cover every row in order, each within the pixel limit, the last ending on the last row', () => {
    for (const [w, h, max] of [
      [576, 1245, SCREEN_BAND_PX],
      [1622, 3782, SCREEN_BAND_PX],
      [3502, 7559, SCREEN_BAND_PX],
      [8192, 8192, SCREEN_BAND_PX],
      [1000, 1000, 1000],
      [5000, 3, 10],
      [7, 1, 100],
    ]) {
      const b = planBands(w, h, max);
      expect(b.height * w <= max || b.height === 1).toBe(true);
      expect(b.height).toBeLessThanOrEqual(h);
      expect(b.y[0]).toBe(0);
      expect(b.y.at(-1)! + b.height).toBe(h);
      for (let i = 1; i < b.y.length; i++) {
        expect(b.y[i]).toBeGreaterThan(b.y[i - 1]);
        expect(b.y[i]).toBeLessThanOrEqual(b.y[i - 1] + b.height); // no gap
        if (i < b.y.length - 1) expect(b.y[i]).toBe(b.y[i - 1] + b.height); // only the last one overlaps
      }
      if (w * h <= max) expect(b).toEqual({ height: h, y: [0] });
    }
    expect(planBands(0, 10)).toEqual({ height: 0, y: [] });
    expect(planBands(3000, 7000, Infinity)).toEqual({ height: 7000, y: [0] }); // 'no limit' is one band
  });

  /** A canvas whose context tracks its translation, so a paint callback can see where it draws. */
  function trackingCanvas() {
    const state = { ty: 0, stack: [] as number[] };
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (o, k) => {
        if (k === 'setTransform') return (_a: number, _b: number, _c: number, _d: number, _e: number, f: number) => void (state.ty = f);
        if (k === 'save') return () => void state.stack.push(state.ty);
        if (k === 'restore') return () => void (state.ty = state.stack.pop() ?? 0);
        if (k === '__ty') return state.ty;
        return k in o ? o[k as string] : () => undefined;
      },
      set: (o, k, v) => ((o[k as string] = v), true),
    });
    return { width: 0, height: 0, getContext: () => ctx };
  }

  it('1080: one band, the 2D canvas is the texture (as before); 4K ss 1 and ss 2: bands, each the content shifted by its row, mips once', () => {
    vi.stubGlobal('document', { createElement: () => trackingCanvas() });
    for (const [patch, k4, bandsMin] of [
      [{}, false, 1],
      [{}, true, 2],
      [{ supersample: 2 }, true, 8],
    ] as const) {
      const s = sceneFor(patch as Partial<Phone3D>, k4);
      const { engine, screen, uploads } = fakeEngine();
      const shifts: number[] = [];
      const a = args(s, 0.5);
      frame(engine, { ...a, drawScreen: (ctx) => void shifts.push((ctx as unknown as { __ty: number }).__ty) });
      const { w, h } = screen.size!;
      const band = screen.canvas!;
      expect(screen.bands).toBe(uploads.length);
      expect(shifts).toHaveLength(uploads.length);
      if (bandsMin === 1) {
        expect(uploads).toHaveLength(1);
        expect([band.width, band.height]).toEqual([w, h]);
      } else {
        expect(uploads.length).toBeGreaterThanOrEqual(bandsMin);
        expect(band.width * band.height).toBeLessThanOrEqual(SCREEN_BAND_PX);
      }
      // Every GL row of the texture is written, by whole-band uploads at x 0; band i's canvas row 0 is texture row
      // shifts[i] (paint saw a −y translation), and with flipY it lands on GL row h − y − band height.
      const rows = new Uint8Array(h);
      uploads.forEach((u, i) => {
        expect([u.w, u.h, u.x, u.dstW, u.dstH, u.flipY]).toEqual([w, band.height, 0, w, h, true]);
        expect(u.y).toBe(h + shifts[i] - band.height);
        expect(u.mips).toBe(i === uploads.length - 1);
        rows.fill(1, u.y, u.y + u.h);
      });
      expect(rows.every((r) => r === 1)).toBe(true);
      expect(screen.texture!.generateMipmaps).toBe(true); // left as allocated
    }
  });
});

describe('oblique cap from ss 2 (§3.6, §3.9)', () => {
  it('FRONT is never capped (1:1 at every ss); an oblique screen is capped at ss × the largest size from ss 2 only', () => {
    expect(obliqueScaleCap(1, [1, 2])).toBe(Infinity);
    expect(obliqueScaleCap(2, [0.8, 1.3])).toBeCloseTo(2.6, 12);
    for (const ss of [1, 2, 3] as const) {
      const front = sceneFor({ supersample: ss }, true);
      const fq = screenQuadAt(front, 0.5).quad;
      const capped = planScreenTexture(fq, front.home.screen, ss, 8192, obliqueScaleCap(ss, [1]));
      expect(capped.aligned).toBe(true);
      expect(capped).toEqual(planScreenTexture(fq, front.home.screen, ss, 8192));
      if (ss <= 2) expect(capped.scale).toBe(ss); // (at ss 3 the 4K screen hits the 8192 texture limit first)
      // A turned phone whose near edge projects larger than FRONT.
      const s = sceneFor({ supersample: ss, ...moving() }, true);
      let grew = 0;
      for (let i = 30; i <= 90; i++) {
        const q = screenQuadAt(s, i / 30).quad;
        const free = planScreenTexture(q, s.home.screen, ss, 8192);
        const cap = planScreenTexture(q, s.home.screen, ss, 8192, obliqueScaleCap(ss, [1]));
        if (free.aligned) continue;
        if (ss === 1) expect(cap).toEqual(free);
        else expect(cap.scale).toBe(Math.min(free.scale, ss));
        if (free.scale > ss * 1.02) grew++;
      }
      if (ss <= 2) expect(grew).toBeGreaterThan(0); // the turn really has frames the cap acts on
    }
  });

  it('from ss 2 the room holds every frame of a turn: the texture is made once', () => {
    for (const ss of [2, 3] as const) {
      const s = sceneFor({ supersample: ss, ...moving() }, true);
      const { engine, screen } = fakeEngine();
      for (let i = 0; i <= 120; i += 2) frame(engine, args(s, i / 30));
      expect(screen.reallocs).toBe(1);
      // And it is the FRONT need's rung (the room has no perspective allowance from ss 2), within the GPU limit.
      // (At 4K, ss 3 steps down to 2: the ROI's long side × 3 is over 8192.)
      const eff = 2;
      const f = s.home.screen;
      expect(screen.size).toEqual({ w: textureSide(Math.ceil(f.w * eff) + 1), h: textureSide(Math.ceil(f.h * eff) + 1) });
    }
  });
});

describe('GPU memory at 4K (§3.9 table method, decimal MB)', () => {
  /** WP4a's parts the stand-in does not have, as §3.9 budgets them: a 512 HalfFloat PMREM (1536 × 2048 × 8 B),
   *  the RectAreaLight LTC tables (2 × 64² × 16 B), and geometry up to 10 MB. */
  const WP4A = 3 * 512 * 4 * 512 * 8 + 2 * 64 * 64 * 16 + 10e6;

  /** The heaviest frame of a 200° turn at 30 fps (t 0..4 s, the move 1..3 s), counted bytes plus WP4a's parts. */
  function peak(patch: Partial<Phone3D>, layout: 'fill' | 'social4k') {
    let p: Project = with3d(phoneProject(), moving(patch));
    if (layout === 'fill') p = normalizeProject({ ...p, layout: { ...p.layout, presetId: 'none' } });
    const s = scene3d(p, { width: 2160, height: 3840 })!;
    const { engine, bytes } = fakeEngine();
    let worst = { total: 0, parts: bytes() };
    for (let i = 0; i <= 120; i++) {
      frame(engine, args(s, i / 30));
      const parts = bytes();
      const total = Object.values(parts).reduce((x, y) => x + y, 0) + WP4A;
      if (total > worst.total) worst = { total, parts };
    }
    return worst;
  }

  it('ss 1: ≤ 340 MB with the phone filling the 2160×3840 canvas (the worst case)', () => {
    const m = peak({}, 'fill');
    expect(m.total / 1e6).toBeLessThanOrEqual(340);
    expect(m.parts.canvas2d).toBeLessThanOrEqual(SCREEN_BAND_PX * 4);
  });

  it('ss 2: ≤ 440 MB with the phone filling the canvas; ss 3 steps down to the same', () => {
    const m2 = peak({ supersample: 2 }, 'fill');
    expect(m2.total / 1e6).toBeLessThanOrEqual(440);
    expect(m2.parts.canvas2d).toBeLessThanOrEqual(SCREEN_BAND_PX * 4);
    const m3 = peak({ supersample: 3 }, 'fill');
    expect(m3.total / 1e6).toBeLessThanOrEqual(440);
  });
});
