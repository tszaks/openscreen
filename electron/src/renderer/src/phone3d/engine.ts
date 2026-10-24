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
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { frameGeometry, type Rect } from '../../../shared/deviceGeometry';
import { LIGHT_PRESETS } from '../../../shared/phone3d/lighting';
import type { LightPreset, Phone3D } from '../../../shared/phone3d/model';
import { continuousRectPoints } from '../../../shared/phone3d/outline';
import type { Scene3D } from '../../../shared/phone3d/projection';
import { mrtOutput, lodBias, Passes } from './passes';
import { ScreenTexture } from './screenTexture';
import { ShadowPass } from './shadow';
import { renderPhone3D, type Render3DArgs, type Render3DResult } from './view';

// ---------------------------------------------------------------------------
// What the engine needs from the phone's geometry, materials and lighting.
// WP4a's geometry.ts / materials.ts / environment.ts provide the real ones
// (buildPhone, materialsFor, studioLights, studioEnv); until they land the
// engine uses STAND_IN_KIT below. Integration swaps `kit` in one place.

/** A built phone: the model in mm (portrait, y up, front +z, centred, front glass on z = depth/2). */
export interface PhoneModel {
  root: THREE.Object3D;
  /**
   * The screen mesh. Its material is a MeshBasicMaterial (toneMapped false)
   * with the mrtOutput 'screen' and lodBias patches; its UVs are planar, u
   * along +x and v along +y (up), 0..1 over the screen outline; it lies ON
   * the front glass plane (z = depth/2) as an overlay layer (polygonOffset,
   * depthWrite false), so at FRONT it projects exactly onto the flat screen
   * rect and the screen texture stays texel exact.
   */
  screen: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  dispose(): void;
}

export interface PhoneLook {
  /** Finish hex (devices.ts getFinish). */
  hex: string;
  back: Phone3D['back'];
  glass: number;
}

export interface PhoneKit {
  /** The phone for this scene's device and look. Every material in it has an mrtOutput patch. */
  phone(s: Scene3D, look: PhoneLook, renderer: THREE.WebGLRenderer): PhoneModel;
  /** The light rig for a preset at azimuth 0 (the engine rotates it about y to the key azimuth), scaled by intensity. */
  lights(preset: LightPreset, intensity: number): THREE.Object3D;
  /** The environment (reflections and fill) for a preset and the background's mean linear colour; null for none. */
  environment(preset: LightPreset, bgMean: readonly [number, number, number], renderer: THREE.WebGLRenderer): THREE.Texture | null;
  /** The environment's strength (envMapIntensity is set from light.intensity times this). */
  envStrength(preset: LightPreset): number;
}

// --- Stand-in kit (until WP4a): the real outline, a bevelled extruded body,
// glass cap, screen, a camera plateau; directional lights from the preset's
// boxes and three's RoomEnvironment for reflections.

function shape(points: readonly (readonly [number, number])[]): THREE.Shape {
  return new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
}

function planarUv(geo: THREE.BufferGeometry, w: number, h: number): void {
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / w + 0.5;
    uv[i * 2 + 1] = pos.getY(i) / h + 0.5;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** A finish hex as a metal colour bright enough to read as metal (the swatches are marketing greys). */
function metalColor(hex: string): THREE.Color {
  const c = new THREE.Color().setStyle(hex);
  const base = new THREE.Color(0.56, 0.57, 0.58);
  const lum = (k: THREE.Color) => 0.2126 * k.r + 0.7152 * k.g + 0.0722 * k.b;
  for (let i = 0; i < 20 && lum(c) < 0.18; i++) c.lerp(base, 0.15);
  return c;
}

export const STAND_IN_KIT: PhoneKit = {
  phone(s, look, renderer) {
    const bw = s.bodyMm.width;
    const bh = s.bodyMm.height;
    const d = s.body3d.depthMm;
    const g = frameGeometry(s.home.body, s.home.device, { orientation: s.home.orientation });
    const rBody = Math.min(g.bodyRadius / g.pxPerMm, bw / 2 - 0.01);
    const rim = Math.max(0.3, s.home.device.rimMm);
    const bevel = Math.min(0.6, d * 0.12);
    const root = new THREE.Group();
    const disposables: { dispose(): void }[] = [];
    const lit = <M extends THREE.Material>(m: M) => {
      disposables.push(m);
      return mrtOutput(m, 'lit');
    };
    const band = lit(new THREE.MeshPhysicalMaterial({ color: metalColor(look.hex), metalness: 1, roughness: 0.28 }));
    const backMat = lit(
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color().setStyle(look.hex).lerp(new THREE.Color(1, 1, 1), 0.08),
        roughness: 0.45,
        clearcoat: look.back === 'glossy' ? 1 : 0,
        clearcoatRoughness: 0.03,
      }),
    );
    const glassMat = lit(new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: 0.04, metalness: 0, specularIntensity: 0.7 }));
    // Body: the continuous-corner outline, extruded with a small bevel; front face just under the glass cap.
    const inner = continuousRectPoints(bw - 2 * bevel, bh - 2 * bevel, Math.max(0.1, rBody - bevel), 16);
    const body = new THREE.ExtrudeGeometry(shape(inner), {
      depth: d - 2 * bevel - 0.04,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 3,
      curveSegments: 16,
    });
    body.translate(0, 0, -(d - 2 * bevel - 0.04) / 2);
    disposables.push(body);
    root.add(new THREE.Mesh(body, [backMat, band]));
    // Front glass cap at z = d/2.
    const cap = new THREE.ShapeGeometry(shape(continuousRectPoints(bw - 2 * rim, bh - 2 * rim, Math.max(0.1, rBody - rim), 16)), 16);
    cap.translate(0, 0, d / 2);
    disposables.push(cap);
    const capMesh = new THREE.Mesh(cap, glassMat);
    capMesh.renderOrder = 0;
    root.add(capMesh);
    // Screen: on the glass plane, an overlay layer.
    const sw = s.screenMm.width;
    const sh = s.screenMm.height;
    const screenGeo = new THREE.ShapeGeometry(shape(continuousRectPoints(sw, sh, s.screenRadiusMm, 24)), 24);
    planarUv(screenGeo, sw, sh);
    screenGeo.translate(0, 0, d / 2);
    disposables.push(screenGeo);
    const reversed = renderer.state.buffers.depth.getReversed();
    const screenMat = lodBias(
      mrtOutput(
        new THREE.MeshBasicMaterial({
          toneMapped: false,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: reversed ? 4 : -4,
        }),
        'screen',
      ),
    );
    disposables.push(screenMat);
    const screen = new THREE.Mesh(screenGeo, screenMat);
    screen.renderOrder = 1;
    root.add(screen);
    // Camera plateau on the back (fractions from the BACK's top-left, so x is mirrored).
    const pl = s.body3d.plateau;
    const pw = pl.w * bw;
    const ph = pl.h * bh;
    const plateau = new THREE.ExtrudeGeometry(shape(continuousRectPoints(pw, ph, Math.min(pl.rMm, pw / 2, ph / 2), 8)), {
      depth: pl.heightMm,
      bevelEnabled: false,
      curveSegments: 8,
    });
    plateau.translate(bw / 2 - (pl.x + pl.w / 2) * bw, bh / 2 - (pl.y + pl.h / 2) * bh, -d / 2 - pl.heightMm + 0.01);
    disposables.push(plateau);
    root.add(new THREE.Mesh(plateau, [backMat, backMat]));
    const lensMat = lit(new THREE.MeshPhysicalMaterial({ color: 0x07080a, roughness: 0.08, metalness: 0.2 }));
    for (const lens of pl.lenses) {
      const r = lens.rMm;
      const cyl = new THREE.CylinderGeometry(r, r, pl.lensProudMm + 0.2, 32);
      cyl.rotateX(Math.PI / 2);
      cyl.translate(
        bw / 2 - (pl.x + lens.x * pl.w) * bw,
        bh / 2 - (pl.y + lens.y * pl.h) * bh,
        -d / 2 - pl.heightMm - (pl.lensProudMm + 0.2) / 2 + 0.1,
      );
      disposables.push(cyl);
      root.add(new THREE.Mesh(cyl, lensMat));
    }
    return {
      root,
      screen,
      dispose: () => disposables.forEach((x) => x.dispose()),
    };
  },
  lights(preset, intensity) {
    const rig = LIGHT_PRESETS[preset];
    const group = new THREE.Group();
    for (const b of rig.boxes) {
      const light = new THREE.DirectionalLight(new THREE.Color().setStyle(b.color), 2.4 * b.intensity * intensity * Math.sqrt(b.w * b.h));
      const a = (b.azimuth * Math.PI) / 180;
      const e = (b.elevation * Math.PI) / 180;
      light.position.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
      group.add(light);
      group.add(light.target);
    }
    return group;
  },
  environment(_preset, _bgMean, renderer) {
    const pm = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const tex = pm.fromScene(room, 0.04).texture;
    room.dispose();
    pm.dispose();
    return tex;
  },
  envStrength(preset) {
    return 0.35 + LIGHT_PRESETS[preset].ambient * 4;
  },
};

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
  kit: PhoneKit = STAND_IN_KIT;
  /** Built phones by device + look (LRU 3); environments by preset + bg (LRU 4); light rigs by preset + intensity. */
  readonly phones = new Lru<PhoneModel>(3);
  readonly envs = new Lru<{ tex: THREE.Texture | null; dispose(): void }>(4);
  readonly rigs = new Lru<{ obj: THREE.Object3D; dispose(): void }>(4);
  current: { phone: PhoneModel | null; rig: THREE.Object3D | null } = { phone: null, rig: null };
  readonly stats: EngineStats = { renders: 0, lastMs: 0, samples: 0, tiles: 0, roi: { x: 0, y: 0, w: 0, h: 0 }, texture: { w: 0, h: 0 }, gpuBytes: 0 };
  private canvasSize = { w: 0, h: 0 };
  private restoreWaiters: (() => void)[] = [];
  private readonly gpu: string;

  /** `reversedDepth: false` forces the classic depth buffer (the z-fight gate renders both ways). */
  constructor(opts: { reversedDepth?: boolean } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.canvas.addEventListener('webglcontextlost', this.onLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onRestored, false);
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
    const r = this.renderer;
    r.setPixelRatio(1);
    r.autoClear = false;
    r.toneMapping = THREE.NoToneMapping;
    r.toneMappingExposure = 1;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.setClearColor(0x000000, 0);
    this.gpu = readGpuName(r.getContext());
    this.passes = new Passes(r);
    this.screen = new ScreenTexture(r.capabilities.getMaxAnisotropy());
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

  /** Makes the canvas at least w × h, re-created only past the 8% hysteresis (§3.7 step 7). */
  sizeCanvas(w: number, h: number): { w: number; h: number } {
    const cur = this.canvasSize;
    if (w > cur.w || h > cur.h || w < cur.w * 0.92 || h < cur.h * 0.92) {
      this.renderer.setSize(w, h, false);
      this.canvasSize = { w, h };
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

  /** GPU bytes held by the engine's own targets and textures (not three's internal caches). */
  gpuBytes(): number {
    return this.passes.bytes() + this.screen.bytes() + this.shadow.bytes() + this.canvasSize.w * this.canvasSize.h * 4 * 2;
  }

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
    this.screen = new ScreenTexture(this.renderer.capabilities.getMaxAnisotropy());
    this.scene.remove(this.shadow.catcher);
    this.shadow = new ShadowPass(this.renderer);
    this.scene.add(this.shadow.catcher);
    this.canvasSize = { w: 0, h: 0 };
    const waiters = this.restoreWaiters;
    this.restoreWaiters = [];
    waiters.forEach((f) => f());
  };

  /** Drop every cached model, environment and rig (dispose only while the context is alive). */
  dropCaches(dispose: boolean): void {
    if (this.current.phone) this.inner.remove(this.current.phone.root);
    if (this.current.rig) this.scene.remove(this.current.rig);
    this.current = { phone: null, rig: null };
    this.scene.environment = null;
    this.phones.clear(dispose);
    this.envs.clear(dispose);
    this.rigs.clear(dispose);
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

