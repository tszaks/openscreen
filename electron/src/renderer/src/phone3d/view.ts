// renderPhone3D: the one call the compositor makes for a 3D phone frame
// (SPEC §3.7). Per output frame:
//   1. ROI: body hull ∪ its shadow on the catcher over the sub-frame times,
//      padded by the DoF reach + 2 px, snapped outward to whole canvas
//      pixels (shared renderRoi). Only the phone's area is rendered.
//   2. the sample plan (planSamples): times and jitter, from pose only
//   3. the screen texture, drawn by the compositor at 1:1 render resolution
//   4. per tile, per sample: shadow masks (once when the phone is still),
//      depth range, jittered view offset, the scene into the 2-attachment
//      MSAA target, added into the accumulation target
//   5. DoF on both attachments, when it would show
//   6. the output pass into the engine canvas's top-left roi.w × roi.h
// Returns the engine canvas and the ROI; the compositor copies that area
// 1:1 at integer coordinates, so drawImage never resamples the phone.
import type { Rect } from '../../../shared/deviceGeometry';
import {
  camAt,
  depthRange,
  hullTravelPx,
  maxCocPx,
  projectWorld,
  renderRoi,
  screenQuadAt,
  type Cam3D,
  type Scene3D,
} from '../../../shared/phone3d/projection';
import type { Engine, PhoneLook } from './engine';
import { planSamples, planTiles, Passes, type SamplePlan } from './passes';
import { planScreenTexture } from './screenTexture';
import { catcherFrame } from './shadow';

const DEG = Math.PI / 180;

export interface Render3DQuality {
  /** Supersample factor (export and frames; the preview uses 1). */
  ss: 1 | 2 | 3;
  /** Export / full-quality frames: 8 jittered samples and the adaptive motion count. False: one sample. */
  full: boolean;
  /** Motion blur: the minimum sample count and the shutter as a fraction of a frame; null = off. */
  motion: { samples: number; shutter: number } | null;
  /** Output frame rate (the shutter is shutter / fps seconds). */
  fps: number;
}

export interface Render3DArgs {
  scene: Scene3D;
  /** Output time, seconds. */
  time: number;
  look: PhoneLook;
  /** The background's mean linear colour (the environment's floor bounce). */
  bgMean: readonly [number, number, number];
  /**
   * Draws the screen content into the texture: the flat screen rect lands on
   * `dst` (texels, top-down), and every overlay size that follows the canvas
   * is multiplied by `pxScale` (texels per canvas px).
   */
  drawScreen: (ctx: CanvasRenderingContext2D, dst: Rect, pxScale: number) => void;
  quality: Render3DQuality;
}

export type Render3DResult =
  | { canvas: HTMLCanvasElement; roi: Rect; samples: number; tiles: number }
  | { lost: true }
  | { empty: true; roi: Rect };

/** DoF below this largest blur (render px) is invisible and skipped. */
export const DOF_MIN_PX = 0.25;
/** Vogel taps for the DoF gather. */
export const DOF_TAPS = { full: 64, preview: 16 } as const;

/** Timing for stats only: never affects pixels (§3.9). On with ?p3dstats or window.__p3dStatsOn. */
function statsOn(): boolean {
  const g = globalThis as { __p3dStatsOn?: boolean; location?: { search?: string } };
  return g.__p3dStatsOn === true || !!g.location?.search?.includes('p3dstats');
}

/** Puts the phone, the lights and the environment rotation at the pose of `cam`. */
function applyPose(engine: Engine, s: Scene3D, cam: Cam3D): void {
  const p = cam.pose;
  const g = engine.poseGroup;
  g.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
  g.rotation.set(-p.tilt * DEG, p.turn * DEG, -p.rotate * DEG, 'ZXY');
  g.scale.setScalar(cam.scale);
  engine.inner.rotation.set(0, 0, cam.landscape);
  const az = (s.p3.light.azimuth + p.light) * DEG;
  if (engine.current.rig) engine.current.rig.rotation.set(0, az, 0);
  engine.scene.environmentRotation.set(0, az, 0);
}

/** The perspective camera for `cam`, its depth range, and the jittered window of the full W·ss × H·ss view. */
function applyCamera(
  engine: Engine,
  s: Scene3D,
  cam: Cam3D,
  t: number,
  ss: number,
  win: { x: number; y: number; w: number; h: number },
): { near: number; far: number } {
  const c = engine.camera;
  const W = s.canvas.width;
  const H = s.canvas.height;
  const range = depthRange(s, t, cam) ?? { near: 1, far: 1e5 };
  c.fov = cam.fov;
  c.aspect = W / H;
  c.near = range.near;
  c.far = range.far;
  c.position.set(cam.eye[0], cam.eye[1], cam.eye[2]);
  c.rotation.set(-cam.elevation * DEG, 0, 0);
  c.setViewOffset(W * ss, H * ss, win.x, win.y, win.w, win.h);
  c.updateProjectionMatrix();
  c.updateMatrixWorld(true);
  return range;
}

/** Makes sure the phone for this scene and look, its light rig and the environment are in the scene. */
function prepareScene(engine: Engine, a: Render3DArgs): void {
  const s = a.scene;
  const p3 = s.p3;
  const look = a.look;
  const device = s.home.device;
  const phoneKey = `${engine.generation}|${device.id}|${s.home.orientation}|${look.hex}|${look.back}|${look.glass}|${s.body3d.depthMm}`;
  const phone = engine.phones.get(phoneKey, () => engine.kit.phone(s, look, engine.renderer));
  if (engine.current.phone !== phone) {
    if (engine.current.phone) engine.inner.remove(engine.current.phone.root);
    engine.inner.add(phone.root);
    engine.current.phone = phone;
  }
  const preset = p3.light.preset;
  const rigKey = `${engine.generation}|${preset}|${p3.light.intensity}`;
  const rig = engine.rigs.get(rigKey, () => {
    const obj = engine.kit.lights(preset, p3.light.intensity);
    return {
      obj,
      dispose: () =>
        obj.traverse((o) => {
          const d = o as unknown as { dispose?: () => void };
          if (o !== obj && typeof d.dispose === 'function') d.dispose();
        }),
    };
  });
  if (engine.current.rig !== rig.obj) {
    if (engine.current.rig) engine.scene.remove(engine.current.rig);
    engine.scene.add(rig.obj);
    engine.current.rig = rig.obj;
  }
  const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 15) / 15;
  const bg = [q(a.bgMean[0]), q(a.bgMean[1]), q(a.bgMean[2])] as const;
  const envKey = `${engine.generation}|${preset}|${bg.join(',')}`;
  const env = engine.envs.get(envKey, () => {
    const tex = engine.kit.environment(preset, bg, engine.renderer);
    return { tex, dispose: () => tex?.dispose() };
  });
  engine.scene.environment = env.tex;
  engine.scene.environmentIntensity = p3.light.intensity * engine.kit.envStrength(preset);
}

/** Render one frame of the 3D phone into the engine canvas. */
export function renderPhone3D(engine: Engine, a: Render3DArgs): Render3DResult {
  if (engine.lost || engine.renderer.getContext().isContextLost()) return { lost: true };
  const timing = statsOn();
  const t0 = timing ? performance.now() : 0;
  const s = a.scene;
  const p3 = s.p3;
  const t = a.time;
  const W = s.canvas.width;
  const H = s.canvas.height;
  const r = engine.renderer;
  let ss: number = a.quality.ss;

  // 1-2. Sample plan and ROI.
  const motion = a.quality.full && a.quality.motion && a.quality.fps > 0 ? a.quality.motion : null;
  const shutterSec = motion ? Math.max(0, motion.shutter) / a.quality.fps : 0;
  const travelPx = motion && shutterSec > 0 ? hullTravelPx(s, t, shutterSec, ss) : 0;
  const plan: SamplePlan = planSamples({ t, travelPx, motion: motion ? { samples: motion.samples, shutterSec } : null, full: a.quality.full });
  const roi = renderRoi(s, t, plan.nMotion > 1 ? plan.times : undefined);
  if (!roi || roi.w <= 0 || roi.h <= 0) return { empty: true, roi: roi ?? { x: 0, y: 0, w: 0, h: 0 } };
  const maxSide = engine.maxSide();
  while (ss > 1 && Math.max(roi.w, roi.h) * ss > maxSide) ss--;
  const rw = roi.w * ss;
  const rh = roi.h * ss;

  prepareScene(engine, a);
  const phone = engine.current.phone!;

  // 3. The screen texture, at the frame's centre pose (the video frame is fixed for the frame).
  const camT = camAt(s, t);
  const { quad } = screenQuadAt(s, t, camT);
  const layout = planScreenTexture(quad, s.home.screen, ss, maxSide);
  const tctx = engine.screen.begin(layout.w, layout.h);
  a.drawScreen(tctx, layout.dst, layout.scale);
  const tex = engine.screen.commit(layout, camT.landscape);
  if (phone.screen.material.map !== tex) {
    phone.screen.material.map = tex;
    phone.screen.material.needsUpdate = true;
  }

  // DoF reach (render px) over the frame's samples.
  const cams = plan.times.map((tt, k) => (k > 0 && tt === plan.times[0] ? null : camAt(s, tt)));
  const camFor = (k: number) => cams[k] ?? cams[0]!;
  let coc = 0;
  if (p3.dof.on) {
    for (let k = 0; k < plan.times.length; k++) if (k === 0 || cams[k]) coc = Math.max(coc, maxCocPx(s, plan.times[k]) * ss);
  }
  const dofOn = coc >= DOF_MIN_PX;
  const tiles = planTiles(rw, rh, ss, dofOn ? coc + 2 : 0);
  const tw = Math.max(...tiles.map((x) => x.pw));
  const th = Math.max(...tiles.map((x) => x.ph));
  engine.passes.ensure(tw, th);
  const canvas = engine.sizeCanvas(roi.w, roi.h);
  const passes = engine.passes;
  const shadowOn = p3.shadow.on && p3.shadow.opacity > 0;
  engine.shadow.catcher.visible = shadowOn;
  const N = plan.n;

  for (const tile of tiles) {
    if (N > 1) passes.clearAccum(tile.pw, tile.ph);
    let range = { near: 1, far: 2 };
    for (let k = 0; k < N; k++) {
      const cam = camFor(k);
      const tk = plan.times[k];
      applyPose(engine, s, cam);
      engine.poseGroup.updateMatrixWorld(true);
      if (shadowOn && (k === 0 || plan.nMotion > 1)) engine.shadow.render(engine.poseGroup, catcherFrame(s, cam), p3.shadow.opacity);
      const [jx, jy] = plan.jitter[k];
      range = applyCamera(engine, s, cam, tk, ss, {
        x: roi.x * ss + tile.px + jx,
        y: roi.y * ss + tile.py + jy,
        w: tile.pw,
        h: tile.ph,
      });
      const msaa = passes.msaa!;
      Passes.view(msaa, tile.pw, tile.ph);
      r.setRenderTarget(msaa);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, false);
      r.render(engine.scene, engine.camera);
      if (N > 1) {
        const w1 = plan.screenFromFirst ? (k === 0 ? 1 : 0) : 1 / N;
        passes.accumulate(tile.pw, tile.ph, 1 / N, w1);
      }
    }
    let src = N > 1 ? passes.accum! : passes.msaa!;
    if (dofOn) {
      // Focus on the screen centre at the frame's centre pose.
      const focusZ = projectScreenCentreDepth(s, camT) ?? projectWorld(camT.pos, camT)[2];
      const pose = camT.pose;
      src = passes.dof(src, tile.pw, tile.ph, {
        near: range.near,
        far: range.far,
        focusZ,
        cocScale: p3.dof.amount * pose.focus * 0.02 * H * ss,
        maxCoc: coc,
        taps: a.quality.full ? DOF_TAPS.full : DOF_TAPS.preview,
      });
    }
    passes.output(
      src,
      { x: tile.x / ss, y: tile.y / ss, w: tile.w / ss, h: tile.h / ss },
      { x: tile.px, y: tile.py, w: tile.pw, h: tile.ph },
      ss,
      canvas.h,
    );
  }
  r.setRenderTarget(null);

  const st = engine.stats;
  st.renders++;
  st.samples = N;
  st.tiles = tiles.length;
  st.roi = roi;
  st.texture = { w: layout.w, h: layout.h };
  st.gpuBytes = engine.gpuBytes();
  if (timing) {
    // Finish the GPU work so the time is the real cost, not just the submit (stats runs only).
    const gl = r.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    st.lastMs = performance.now() - t0;
    const g = globalThis as { __p3d?: { n: number; ms: number[]; last: EngineStatsSnapshot } };
    const rec = (g.__p3d ??= { n: 0, ms: [], last: null as unknown as EngineStatsSnapshot });
    rec.n++;
    rec.ms.push(st.lastMs);
    if (rec.ms.length > 2000) rec.ms.shift();
    rec.last = { ...st, W, H, ss, travelPx, nMotion: plan.nMotion, dof: dofOn, gpu: engine.gpuName() };
  }
  return { canvas: engine.canvas, roi, samples: N, tiles: tiles.length };
}

type EngineStatsSnapshot = Engine['stats'] & { W: number; H: number; ss: number; travelPx: number; nMotion: number; dof: boolean; gpu: string };

/** View depth of the screen centre (the DoF focus), px. */
function projectScreenCentreDepth(s: Scene3D, cam: Cam3D): number | null {
  const z = s.body3d.depthMm / 2;
  // The screen centre in model space is (0, 0, z); model → world = pos + scale·R·p.
  const R = cam.R;
  const w: [number, number, number] = [
    cam.pos[0] + cam.scale * R[2] * z,
    cam.pos[1] + cam.scale * R[5] * z,
    cam.pos[2] + cam.scale * R[8] * z,
  ];
  const d = projectWorld(w, cam)[2];
  return Number.isFinite(d) && d > 0 ? d : null;
}

