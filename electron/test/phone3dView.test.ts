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
import { grownSize, Passes, planSamples } from '../src/renderer/src/phone3d/passes';
import { ShadowPass } from '../src/renderer/src/phone3d/shadow';
import { MAX_SCREEN_TEXTURE, planBands, planScreenTexture, SCREEN_BAND_PX, ScreenTexture, screenCanvasSize, screenRoom, textureLimit, textureSide } from '../src/renderer/src/phone3d/screenTexture';
import { renderPhone3D, shadowSamples, type Blit3D, type Render3DArgs, type Render3DQuality } from '../src/renderer/src/phone3d/view';
import type { Engine } from '../src/renderer/src/phone3d/engine';
import { camAt, scene3d, screenQuadAt, type Scene3D } from '../src/shared/phone3d/projection';
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
    capabilities: { maxTextureSize: maxSide },
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
      environment: () => null,
      envStrength: () => 1,
      lights: () => new THREE.Group(),
      placeLights: () => {},
    },
    lights: null,
    phones: cache(),
    envs: cache(),
    current: { phone: null },
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

describe('shadow samples (§3.7 steps 5 and 8)', () => {
  it('still: sample 0 alone casts; moving: every sub-sample casts its own pose', () => {
    expect(shadowSamples({ n: 8, nMotion: 1 })).toEqual([0]);
    for (const n of [2, 7, 12, 36, 64]) expect(shadowSamples({ n, nMotion: n })).toEqual(Array.from({ length: n }, (_, k) => k));
  });
});

describe('renderPhone3D frame loop', () => {
  it('a moving 4K frame casts one drop silhouette per sub-sample plus one contact silhouette, and blurs once, before the tiles, whatever the tile count', () => {
    const s = sceneFor(moving(), true);
    const { engine, calls, shadow } = fakeEngine();
    let checkedTiles = 0;
    for (const t of [1.6, 1.8, 2.0]) {
      calls.length = 0;
      const masks = shadow.maskRenders;
      const sil = shadow.silhouettes;
      const { out } = frame(engine, args(s, t));
      expect(out.samples).toBeGreaterThan(8); // a real moving frame: more samples than the AA minimum
      expect(shadow.maskRenders - masks).toBe(1);
      expect(shadow.silhouettes - sil).toBe(out.samples + 1); // a drop cast per pose, one contact cast (middle pose)
      // Silhouettes all come before the first scene draw (no tile casts one again).
      const firstScene = calls.findIndex((c) => c.kind === 'scene');
      expect(calls.filter((c) => c.kind === 'shadow')).toHaveLength(out.samples + 1); // drop per pose + one contact
      expect(calls.slice(firstScene).some((c) => c.kind === 'shadow')).toBe(false);
      // N scene draws per tile.
      const scenes = calls.filter((c) => c.kind === 'scene');
      expect(scenes).toHaveLength(out.samples * out.tiles);
      checkedTiles = Math.max(checkedTiles, out.tiles);
    }
    expect(checkedTiles).toBeGreaterThan(1); // the case the per-tile bug lived in: several tiles
  });

  it('every sample of every tile draws the one frame catcher, which holds every sample’s own catcher area', async () => {
    const { catcherFrame, frameCatcher } = await import('../src/renderer/src/phone3d/shadow');
    const s = sceneFor(moving(), true);
    const { engine, calls } = fakeEngine();
    const { out } = frame(engine, args(s, 1.8));
    const scenes = calls.filter((c) => c.kind === 'scene');
    for (const c of scenes) {
      expect(c.contact).toBe(scenes[0].contact);
      expect(c.corners).toEqual(scenes[0].corners);
    }
    // The union really grows past the middle sample's own area while moving, and holds every sample's.
    const plan = planSamples({ t: 1.8, travelPx: 100, motion: { samples: 12, shutterSec: 0.5 / 30 }, full: true });
    const cams = plan.times.map((tt) => camAt(s, tt));
    const all = frameCatcher(s, cams, Math.floor(cams.length / 2));
    const mid = catcherFrame(s, cams[Math.floor(cams.length / 2)]);
    expect((all.u1 - all.u0) * (all.v1 - all.v0)).toBeGreaterThan((mid.u1 - mid.u0) * (mid.v1 - mid.v0));
    for (const c of cams) {
      const f = catcherFrame(s, c);
      expect(f.u0).toBeGreaterThanOrEqual(all.u0 - 1e-9);
      expect(f.u1).toBeLessThanOrEqual(all.u1 + 1e-9);
      expect(f.v0).toBeGreaterThanOrEqual(all.v0 - 1e-9);
      expect(f.v1).toBeLessThanOrEqual(all.v1 + 1e-9);
    }
    expect(out.samples).toBeGreaterThan(1);
  });

  it('full quality renders every sample plain (no MSAA target at all at 4K); a single-sample frame renders with MSAA', () => {
    const s = sceneFor({}, true);
    const { engine, calls, passes } = fakeEngine();
    frame(engine, args(s, 0.5));
    const scenes = calls.filter((c) => c.kind === 'scene');
    expect(scenes.length).toBeGreaterThan(8);
    expect(scenes.every((c) => c.target === passes.plain)).toBe(true);
    expect(passes.msaa).toBeNull();
    calls.length = 0;
    const s1080 = sceneFor({}, false);
    const { out } = frame(engine, args(s1080, 0.5, { full: false, motion: null }));
    const one = calls.filter((c) => c.kind === 'scene');
    expect(one).toHaveLength(out.tiles); // one sample per tile
    expect(one.every((c) => c.target === passes.msaa)).toBe(true);
    expect(passes.msaa).not.toBeNull();
  });

  it('the glass sheen is drawn on the samples planGlare picks, with their weights (still: sample 0 × N); never inside the flag (FRONT)', async () => {
    const { planGlare } = await import('../src/renderer/src/phone3d/passes');
    const tilted = { pose: { ...FRONT, tilt: 20 } } as Partial<Phone3D>;
    for (const [patch, t, inFlag] of [[{}, 0.5, true], [tilted, 0.5, false], [moving(), 1.8, false]] as const) {
      const s = sceneFor(patch as Partial<Phone3D>, false);
      const { engine } = fakeEngine();
      const glare = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
      (engine.kit as { phone: unknown }).phone = () => ({ root: new THREE.Group(), screen: new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()), glare, dispose() {} });
      const seen: number[] = [];
      const r = engine.renderer as unknown as { render: (sc: THREE.Scene, c: THREE.Camera) => void };
      const orig = r.render;
      r.render = (sc, c) => {
        if (sc === engine.scene) seen.push(glare.visible ? (glare.material.userData.glareWeight?.value ?? 1) : 0);
        orig(sc, c);
      };
      const { out } = frame(engine, args(s, t));
      const want = Array.from({ length: out.tiles }, () => planGlare({ n: out.samples, nMotion: out.samples > 8 ? out.samples : 1 })).flat();
      // At FRONT the front glass mirrors the flag (materials.ts FRONT_GLASS_FLAG): the shader would add exactly 0.
      expect(seen).toEqual(inFlag ? want.map(() => 0) : want);
      if (!inFlag) expect(seen.some((w) => w > 0)).toBe(true);
    }
  });

  it('a still frame renders its shadow once, and a repeat of the same frame (paused preview) reuses it', () => {
    for (const k4 of [false, true]) {
      const s = sceneFor({}, k4);
      const { engine, shadow } = fakeEngine();
      const { out: a } = frame(engine, args(s, 0.5));
      expect(a.samples).toBe(8);
      expect(shadow.maskRenders).toBe(1);
      expect(shadow.silhouettes).toBe(2); // 8 jittered samples, one pose: one drop and one contact silhouette
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

  it('the DoF target exists only once a frame blurs: with DoF off it is never made', () => {
    for (const k4 of [false, true]) {
      const { engine, passes } = fakeEngine();
      const off = { dof: { on: false, amount: 0.35, background: 0 } };
      frame(engine, args(sceneFor(off, k4), 0.5));
      frame(engine, args(sceneFor({ ...off, pose: { ...FRONT, turn: 40, tilt: 20 } }, k4), 0.5));
      expect(passes.dofOut).toBeNull();
      frame(engine, args(sceneFor({ pose: { ...FRONT, turn: 40, tilt: 20 } }, k4), 0.5));
      expect(passes.dofOut).not.toBeNull();
    }
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

describe('oblique density (§3.6, owner decision 11)', () => {
  it('FRONT is 1:1 at every ss; an oblique screen gets the density it needs at every ss, clamped only by the texture limit', () => {
    expect(textureLimit(16384)).toBe(MAX_SCREEN_TEXTURE);
    expect(textureLimit(4096)).toBe(4096);
    for (const ss of [1, 2, 3] as const) {
      const front = sceneFor({ supersample: ss }, true);
      const fq = screenQuadAt(front, 0.5).quad;
      const f = planScreenTexture(fq, front.home.screen, ss, 8192);
      expect(f.aligned).toBe(true);
      if (ss <= 2) expect(f.scale).toBe(ss); // (at ss 3 the 4K screen hits the 8192 texture limit first)
      // A turned phone whose near edge projects larger than FRONT gets more than ss texels per canvas px.
      const s = sceneFor({ supersample: ss, ...moving() }, true);
      let grew = 0;
      let most = 0;
      for (let i = 30; i <= 90; i++) {
        const q = screenQuadAt(s, i / 30).quad;
        const free = planScreenTexture(q, s.home.screen, ss, 8192);
        if (free.aligned) continue;
        if (free.scale > ss * 1.02) grew++;
        most = Math.max(most, free.scale / ss);
        // The only clamp: a 4096 GPU limit caps the texture side, never anything else.
        const small = planScreenTexture(q, s.home.screen, ss, 4096);
        expect(Math.max(small.w, small.h)).toBeLessThanOrEqual(4096);
        if (Math.max(free.w, free.h) <= 4094) expect(small).toEqual(free);
      }
      // This fixture's turn peaks at about 1.07× FRONT at its near edge; nothing holds it back to 1.0.
      if (ss <= 2) expect(grew).toBeGreaterThan(0);
      if (ss <= 2) expect(most).toBeGreaterThan(1.05);
    }
  });

  it('the room (FRONT × ss × largest size × 1.12) holds most frames of a turn: the texture is made at most twice', () => {
    for (const ss of [1, 2] as const) {
      const s = sceneFor({ supersample: ss, ...moving() }, true);
      const { engine, screen } = fakeEngine();
      for (let i = 0; i <= 120; i += 2) frame(engine, args(s, i / 30));
      expect(screen.reallocs).toBeLessThanOrEqual(2);
      const f = s.home.screen;
      expect(screen.size!.w).toBeGreaterThanOrEqual(Math.ceil(f.w * ss * 1.12));
    }
  });
});

describe('GPU memory at 4K (§3.9 table method, decimal MB)', () => {
  /** WP4a's parts the stand-in does not have, as §3.9 budgets them: a 512 HalfFloat PMREM (1536 × 2048 × 8 B),
   *  geometry up to 10 MB, and the RectAreaLight LTC tables (two 64 × 64 RGBA float textures). */
  const WP4A = 3 * 512 * 4 * 512 * 8 + 10e6 + 2 * 64 * 64 * 16;

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
