// The 3D phone engine (SPEC §3.1, D17): ONE WebGLRenderer per process, a
// module singleton, with its canvas, its targets and passes, the screen
// texture, the shadow pass, the scene and the caches of phone models. The
// compositor never imports this file: loader.ts loads it (and three) with a
// dynamic import only when a project's 3D phone is active (D9).
//
// Context loss: `webglcontextlost` is prevented (so the browser may restore
// it), `generation` is bumped and every cached GPU object is dropped; the
// next render after `webglcontextrestored` rebuilds them lazily. While lost,
// render() returns { lost: true }: the preview draws flat with a notice, a
// strict export waits for the restore (waitForRestore) and then aborts.
import * as THREE from 'three';
import type { Rect } from '../../../shared/deviceGeometry';
import { STUDIO_KIT, type PhoneKit, type PhoneModel } from './kit';
import { grownSize, Passes } from './passes';
import { ScreenTexture } from './screenTexture';
import { ShadowPass } from './shadow';
import { renderPhone3D, type Render3DArgs, type Render3DResult } from './view';

// What the engine renders: the phone, its lights and its environment (kit.ts).
export type { PhoneKit, PhoneLook, PhoneModel } from './kit';

// ---------------------------------------------------------------------------
// The engine

/** A small LRU of disposable things. */
class Lru<V extends { dispose(): void }> {
  private readonly map = new Map<string, V>();
  constructor(private readonly cap: number) {}
  get(key: string, make: () => V): V {
    let v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
      return v;
    }
    v = make();
    this.map.set(key, v);
    while (this.map.size > this.cap) {
      const [k, old] = this.map.entries().next().value as [string, V];
      this.map.delete(k);
      old.dispose();
    }
    return v;
  }
  /** Forget everything; dispose unless the context is gone (its GPU objects already are). */
  clear(dispose: boolean): void {
    if (dispose) for (const v of this.map.values()) v.dispose();
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
  values(): IterableIterator<V> {
    return this.map.values();
  }
}

/** Bytes per texel of a texture's type (RGBA). */
function texelBytes(t: THREE.Texture): number {
  return t.type === THREE.HalfFloatType ? 8 : t.type === THREE.FloatType ? 16 : 4;
}

/** GPU bytes of every buffer geometry under `root` (each counted once). */
function geometryBytes(root: THREE.Object3D): number {
  const seen = new Set<THREE.BufferGeometry>();
  let b = 0;
  root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g?.isBufferGeometry || seen.has(g)) return;
    seen.add(g);
    for (const a of Object.values(g.attributes)) b += (a as THREE.BufferAttribute).array.byteLength;
    if (g.index) b += g.index.array.byteLength;
  });
  return b;
}

/** Per-frame numbers for budgets and tests (window.__p3d with ?p3dstats). */
export interface EngineStats {
  renders: number;
  lastMs: number;
  samples: number;
  tiles: number;
  roi: Rect;
  texture: { w: number; h: number };
  gpuBytes: number;
}

export class Engine {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  /** Bumped on every context loss: anything cached against an older generation is stale. */
  generation = 0;
  lost = false;
  readonly scene = new THREE.Scene();
  /** pose: position, rotation (ZXY) and scale; `inner` holds the landscape turn; the model sits in inner. */
  readonly poseGroup = new THREE.Group();
  readonly inner = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(22, 1, 1, 2);
  passes: Passes;
  screen: ScreenTexture;
  shadow: ShadowPass;
  kit: PhoneKit = STUDIO_KIT;
  /**
   * Built phones by device + look (LRU 3); the studio environment by preset + bg (LRU 1: a 512 PMREM is 25 MB, and
   * the 4K budget of §3.9 holds one; a new preset or background rebuilds it once).
   */
  readonly phones = new Lru<PhoneModel>(3);
  readonly envs = new Lru<{ tex: THREE.Texture | null; dispose(): void }>(1);
  current: { phone: PhoneModel | null } = { phone: null };
  readonly stats: EngineStats = { renders: 0, lastMs: 0, samples: 0, tiles: 0, roi: { x: 0, y: 0, w: 0, h: 0 }, texture: { w: 0, h: 0 }, gpuBytes: 0 };
  private canvasSize = { w: 0, h: 0 };
  private restoreWaiters: (() => void)[] = [];
  private readonly gpu: string;

  /** `reversedDepth: false` forces the classic depth buffer (the z-fight gate renders both ways). */
  constructor(opts: { reversedDepth?: boolean } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      reversedDepthBuffer: opts.reversedDepth !== false,
    });
    // After three's own handlers (registered by the constructor above): on restore, three must re-create its GL
    // state and re-enable extensions (EXT_color_buffer_float, anisotropy) before anything here touches GL.
    this.canvas.addEventListener('webglcontextlost', this.onLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onRestored, false);
    const r = this.renderer;
    r.setPixelRatio(1);
    r.autoClear = false;
    r.toneMapping = THREE.NoToneMapping;
    r.toneMappingExposure = 1;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.setClearColor(0x000000, 0);
    this.gpu = readGpuName(r.getContext());
    this.passes = new Passes(r);
    this.screen = new ScreenTexture(r, r.capabilities.getMaxAnisotropy());
    this.shadow = new ShadowPass(r);
    this.camera.matrixAutoUpdate = true;
    this.scene.add(this.poseGroup);
    this.poseGroup.add(this.inner);
    this.poseGroup.rotation.order = 'ZXY';
    this.scene.add(this.shadow.catcher);
  }

  /** The GPU's name (WEBGL_debug_renderer_info), e.g. "Apple M1"; for HeadlessResult.gpu. */
  gpuName(): string {
    return this.gpu;
  }

  /** Largest render target / texture side used. */
  maxSide(): number {
    const caps = this.renderer.capabilities;
    const gl = this.renderer.getContext();
    const rb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
    return Math.min(8192, caps.maxTextureSize, rb || 8192);
  }

  /** Makes the canvas at least w × h, re-created only when the ROI outgrows it or falls below half of it
   *  (needsRealloc); the output pass writes its top-left roi.w × roi.h (§3.7 step 7). */
  sizeCanvas(w: number, h: number): { w: number; h: number } {
    const next = grownSize(this.canvasSize, w, h);
    if (next !== this.canvasSize) {
      this.renderer.setSize(next.w, next.h, false);
      this.canvasSize = next;
    }
    return this.canvasSize;
  }

  /** Render one frame of the 3D phone (view.ts). */
  render(args: Render3DArgs): Render3DResult {
    return renderPhone3D(this, args);
  }

  /** Resolves true once the context is back, false after `ms`. Resolves true at once when not lost. */
  waitForRestore(ms: number): Promise<boolean> {
    if (!this.lost) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.restoreWaiters = this.restoreWaiters.filter((f) => f !== done);
        resolve(false);
      }, ms);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.restoreWaiters.push(done);
    });
  }

  /**
   * GPU bytes the 3D path holds (the §3.9 budget): the tile targets, the shadow masks, the screen texture with
   * mips and its 2D canvas (an accelerated 2D canvas is a GPU surface), the engine canvas (two drawing buffers),
   * the cached environments (PMREM) and the cached phones' geometry. Not counted: three's shader programs and the
   * browser's own overhead (the GPU harness measures the GPU process's footprint for that).
   */
  gpuBytes(): number {
    let b = this.passes.bytes() + this.screen.bytes() + this.screen.canvasBytes() + this.shadow.bytes() + this.canvasSize.w * this.canvasSize.h * 4 * 2;
    for (const env of this.envs.values()) {
      const img = env.tex?.image as { width?: number; height?: number } | undefined;
      if (env.tex && img?.width && img.height) b += img.width * img.height * texelBytes(env.tex);
    }
    for (const phone of this.phones.values()) {
      let g = this.geometrySizes.get(phone);
      if (g === undefined) this.geometrySizes.set(phone, (g = geometryBytes(phone.root)));
      b += g;
    }
    return b;
  }
  private readonly geometrySizes = new WeakMap<PhoneModel, number>();

  private readonly onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
    this.generation++;
    this.dropCaches(false);
  };

  private readonly onRestored = () => {
    this.lost = false;
    this.generation++;
    // three re-creates its GL state; targets and passes are rebuilt from scratch.
    this.passes = new Passes(this.renderer);
    this.screen = new ScreenTexture(this.renderer, this.renderer.capabilities.getMaxAnisotropy());
    this.scene.remove(this.shadow.catcher);
    this.shadow = new ShadowPass(this.renderer);
    this.scene.add(this.shadow.catcher);
    this.canvasSize = { w: 0, h: 0 };
    const waiters = this.restoreWaiters;
    this.restoreWaiters = [];
    // In a later task: microtasks run between event listeners, and nothing may render before every
    // restore handler has run.
    setTimeout(() => waiters.forEach((f) => f()), 0);
  };

  /** Drop every cached model and environment (dispose only while the context is alive). */
  dropCaches(dispose: boolean): void {
    if (this.current.phone) this.inner.remove(this.current.phone.root);
    this.current = { phone: null };
    this.scene.environment = null;
    this.phones.clear(dispose);
    this.envs.clear(dispose);
  }

  dispose(): void {
    this.dropCaches(true);
    this.passes.dispose();
    this.screen.dispose();
    this.shadow.dispose();
    this.renderer.dispose();
  }
}

function readGpuName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : (gl.getParameter(gl.RENDERER) as string);
    return String(name || 'unknown');
  } catch {
    return 'unknown';
  }
}

let engine: Engine | null = null;
let disposeHooked = false;

/** The process's one engine (D17): created on first use, kept for the life of the page. */
export function getEngine(): Engine {
  if (!engine) {
    engine = new Engine();
    if (!disposeHooked && typeof window !== 'undefined') {
      disposeHooked = true;
      window.addEventListener('beforeunload', () => engine?.dispose());
    }
  }
  return engine;
}

/** How many engines (WebGL contexts) this process has made: 0 or 1. */
export function engineCount(): number {
  return engine ? 1 : 0;
}

