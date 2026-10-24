// renderPhone3D's frame loop (SPEC §3.7), run in node with the real Passes,
// ShadowPass and ScreenTexture on a renderer that records its calls instead
// of drawing. It pins what the loop asks the GPU to do: shadow masks once per
// frame whatever the tile count (§3.7 step 8: "the shadow targets are per
// frame, not per tile"), every sample's catcher pointing at the masks of the
// pose it belongs to, N scene renders per tile, and a screen texture that
// never outgrows the GPU's size limit (§3.6).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Passes } from '../src/renderer/src/phone3d/passes';
import { ShadowPass, SHADOW_SLOTS } from '../src/renderer/src/phone3d/shadow';
import { MAX_SCREEN_TEXTURE, ScreenTexture, screenCanvasSize, screenRoom, textureSide } from '../src/renderer/src/phone3d/screenTexture';
import { planShadowSlots, renderPhone3D, type Render3DArgs, type Render3DQuality } from '../src/renderer/src/phone3d/view';
import type { Engine } from '../src/renderer/src/phone3d/engine';
import { scene3d, type Scene3D } from '../src/shared/phone3d/projection';
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

/** An Engine whose renderer records draws: the real passes, shadow and screen texture objects, no GL. */
function fakeEngine(maxSide = 8192) {
  const calls: Call[] = [];
  let target: THREE.WebGLRenderTarget | null = null;
  const scene = new THREE.Scene();
  const renderer = {
    getContext: () => ({ isContextLost: () => false }),
    initTexture: () => undefined,
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
  const screen = new ScreenTexture(1);
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
      environment: () => null,
      envStrength: () => 1,
    },
    phones: cache(),
    envs: cache(),
    rigs: cache(),
    current: { phone: null, rig: null },
    stats: { renders: 0, lastMs: 0, samples: 0, tiles: 0, roi: { x: 0, y: 0, w: 0, h: 0 }, texture: { w: 0, h: 0 }, gpuBytes: 0 },
    maxSide: () => maxSide,
    sizeCanvas: (w: number, h: number) => ({ w, h }),
    gpuBytes: () => 0,
    gpuName: () => 'fake',
  };
  return { engine: engine as unknown as Engine, calls, shadow, passes, screen };
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
      const out = renderPhone3D(engine, args(s, t));
      if (!('canvas' in out)) throw new Error('expected a rendered frame');
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
    const out = renderPhone3D(engine, args(s, 1.8));
    if (!('canvas' in out)) throw new Error('expected a rendered frame');
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
      const a = renderPhone3D(engine, args(s, 0.5));
      if (!('canvas' in a)) throw new Error('expected a rendered frame');
      expect(a.samples).toBe(8);
      expect(shadow.maskRenders).toBe(1);
      expect(shadow.slotCount).toBe(1); // a still phone never makes the moving-frame slots
      renderPhone3D(engine, args(s, 0.5));
      expect(shadow.maskRenders).toBe(1);
    }
  });

  it('shadow off: no masks at all', () => {
    const s = sceneFor(moving({ shadow: { ...defaultPhone3D().shadow, on: false } }), true);
    const { engine, shadow, calls } = fakeEngine();
    renderPhone3D(engine, args(s, 1.8));
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
        const out = renderPhone3D(engine, args(s, 0.5, { full: false, motion: null }));
        expect('canvas' in out).toBe(true);
        const c = screen.canvas!;
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
