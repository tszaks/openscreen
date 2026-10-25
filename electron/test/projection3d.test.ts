import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FRAME_SHADOW, frameGeometry } from '../src/shared/deviceGeometry';
import { FRONT, POSE_RANGE, type Pose } from '../src/shared/phone3d/model';
import { BOLD_BASE, BUSY_FACING_DEG } from '../src/shared/phone3d/direct';
import { FLOOR_FIX_ELEVATION } from '../src/shared/phone3d/warnings';
import { FRONT_GLASS_FLAG, FRONT_GLASS_FLAG_SIN } from '../src/renderer/src/phone3d/materials';
import {
  applyHomography,
  BUTTON_PROUD_MM,
  catcherInView,
  convexHull,
  NEAR_CLIP_PX,
  bodyBounds,
  bodyHull,
  bodyPointsMm,
  camAt,
  canvasToScreenUV,
  depthRange,
  homography,
  hullTravelPx,
  invHomography,
  modelToWorld,
  project,
  projectWorld,
  renderRoi,
  scene3d,
  screenMap3d,
  screenAxisSin,
  screenQuad,
  SHADOW_AMBIENT_SIGMA,
  SHADOW_CONTACT,
  SHADOW_SUPPORT_SIGMAS,
  shadowBlurPx,
  shadowCatcherCorners,
  shadowHull,
  shadowPointsWorld,
  contactPointsWorld,
  shadowSigma,
  SHADOW_OFFSET,
  shadowLightDir,
  WALL_GAP_MM,
  subFrameTimes,
  type Cam3D,
  type Quad,
  type Vec3,
} from '../src/shared/phone3d/projection';
import { IPHONES, lcg, move, phoneProject, with3d } from './helpers/phone3dFixtures';

const LAYOUTS = ['social-9x16', 'landscape-16x9', 'none'];

function randomPose(r: () => number): Pose {
  const pick = (k: keyof typeof POSE_RANGE, shrink = 1) => {
    const [lo, hi] = POSE_RANGE[k];
    return (lo + (hi - lo) * r()) * shrink;
  };
  return { turn: pick('turn'), tilt: pick('tilt'), rotate: pick('rotate'), size: 0.3 + r() * 1.7, x: pick('x', 0.4), y: pick('y', 0.4), light: pick('light'), focus: r() * 2 };
}

/** The same camera and model built with three.js. */
function threeProject(cam: Cam3D, pts: [number, number, number][]): [number, number][] {
  const { width: W, height: H } = cam.canvas;
  const camera = new THREE.PerspectiveCamera(cam.fov, W / H, 1, 1e7);
  camera.position.set(...cam.eye);
  camera.rotation.set(-cam.elevation * (Math.PI / 180), 0, 0);
  camera.updateMatrixWorld(true);
  return pts.map((p) => {
    const v = new THREE.Vector3(...modelToWorld(p, cam)).project(camera);
    return [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H];
  });
}

/** The model transform built with three.js Object3Ds from the pose (Euler 'ZXY'). */
function threeModel(cam: Cam3D, pose: Pose, pts: [number, number, number][]): [number, number, number][] {
  const deg = Math.PI / 180;
  const obj = new THREE.Object3D();
  obj.position.set(...cam.pos);
  obj.rotation.set(-pose.tilt * deg, pose.turn * deg, -pose.rotate * deg, 'ZXY');
  obj.scale.setScalar(cam.scale);
  const inner = new THREE.Object3D();
  inner.rotation.z = cam.landscape;
  obj.add(inner);
  obj.updateMatrixWorld(true);
  return pts.map((p) => inner.localToWorld(new THREE.Vector3(...p)).toArray() as [number, number, number]);
}

describe('FRONT matches the flat frame', () => {
  it('the FRONT screen quad equals the flat screen rect within 0.25 px for every iPhone × 3 layouts', () => {
    let worst = 0;
    for (const d of IPHONES) {
      for (const presetId of LAYOUTS) {
        const p = with3d(phoneProject({ width: d.screenPx.width, height: d.screenPx.height, presetId, modelId: d.id }));
        const s = scene3d(p)!;
        expect(s, `${d.id} ${presetId}`).not.toBeNull();
        const { quad, facing } = screenQuad(s, 0)!;
        const r = s.home.screen;
        const want = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
        quad.forEach((q, i) => (worst = Math.max(worst, Math.hypot(q.x - want[i][0], q.y - want[i][1]))));
        expect(facing).toBeGreaterThan(0.99);
      }
    }
    expect(worst).toBeLessThan(0.25);
  });

  it('a landscape capture and a moved/resized phone also match at FRONT', () => {
    for (const presetId of LAYOUTS) {
      const p = with3d(phoneProject({ width: 2622, height: 1206, presetId }));
      p.style.contentTransform = { x: 0.4, y: 0.55, scale: 0.8 };
      const s = scene3d(p)!;
      const { quad } = screenQuad(s, 0)!;
      const r = s.home.screen;
      expect(Math.abs(quad[0].x - r.x)).toBeLessThan(0.25);
      expect(Math.abs(quad[2].y - (r.y + r.h))).toBeLessThan(0.25);
    }
  });

  it('the FRONT body hull is the body rect, a little smaller (the back is farther away)', () => {
    const s = scene3d(with3d(phoneProject()))!;
    const b = bodyBounds(s, 0)!;
    const r = s.home.body;
    // Front-face corners land exactly on the rect; the hull includes them.
    expect(Math.abs(b.x - r.x)).toBeLessThan(0.25);
    expect(Math.abs(b.w - r.w)).toBeLessThan(0.5);
  });
});

describe('projection vs three.js', () => {
  it('200 random poses (fov, elevation, landscape, size, offsets) match PerspectiveCamera + Euler ZXY within 0.01 px', () => {
    const r = lcg(42);
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const landscape = i % 3 === 0;
      const p = with3d(phoneProject({ ...(landscape ? { width: 2622, height: 1206 } : {}), presetId: LAYOUTS[i % 3] }), {
        camera: { fov: 8 + r() * 52, elevation: r() * 30 },
      });
      const s = scene3d(p)!;
      const pose = randomPose(r);
      const cam = camAt(s, 0, pose);
      const pts = bodyPointsMm(s, true);
      // The model transform agrees with three's Object3D (Euler 'ZXY')...
      const ours = pts.map((q) => modelToWorld(q, cam));
      const theirs = threeModel(cam, pose, pts);
      ours.forEach((o, k) => expect(Math.hypot(o[0] - theirs[k][0], o[1] - theirs[k][1], o[2] - theirs[k][2])).toBeLessThan(1e-6 * cam.scale * 1000));
      // ...and the projection agrees with three's camera.
      const tp = threeProject(cam, pts);
      pts.forEach((q, k) => {
        const [x, y] = project(q, cam);
        worst = Math.max(worst, Math.hypot(x - tp[k][0], y - tp[k][1]));
      });
    }
    expect(worst).toBeLessThan(0.01);
  });
});

describe('screenAxisSin (the front glass flag, materials.ts FRONT_GLASS_FLAG)', () => {
  it('0 at FRONT wherever the phone stands; sin of the tilt or of the camera elevation; equals three view-space normal', () => {
    const p = with3d(phoneProject({ presetId: 'social-9x16' }), {});
    const s = scene3d(p)!;
    for (const at of [{}, { x: 0.3, y: -0.2, size: 0.6 }, { rotate: 40 }]) expect(screenAxisSin(camAt(s, 0, { ...FRONT, ...at }))).toBeLessThan(1e-12);
    expect(screenAxisSin(camAt(s, 0, { ...FRONT, tilt: 16 }))).toBeCloseTo(Math.sin((16 * Math.PI) / 180), 12);
    expect(screenAxisSin(camAt(s, 0, { ...FRONT, turn: -24 }))).toBeCloseTo(Math.sin((24 * Math.PI) / 180), 12);
    const up = scene3d(with3d(phoneProject({ presetId: 'social-9x16' }), { camera: { fov: 22, elevation: 9 } }))!;
    expect(screenAxisSin(camAt(up, 0, FRONT))).toBeCloseTo(Math.sin((9 * Math.PI) / 180), 12);
    // Against three: the screen normal through the model's and the camera's matrices, as the shader's view-space normal.
    const r = lcg(7);
    for (let i = 0; i < 50; i++) {
      const q = with3d(phoneProject({ presetId: LAYOUTS[i % 3] }), { camera: { fov: 22, elevation: r() * 30 } });
      const sq = scene3d(q)!;
      const pose = randomPose(r);
      const cam = camAt(sq, 0, pose);
      const deg = Math.PI / 180;
      const obj = new THREE.Object3D();
      obj.rotation.set(-pose.tilt * deg, pose.turn * deg, -pose.rotate * deg, 'ZXY');
      obj.updateMatrixWorld(true);
      const camera = new THREE.PerspectiveCamera();
      camera.rotation.set(-cam.elevation * deg, 0, 0);
      camera.updateMatrixWorld(true);
      const n = new THREE.Vector3(0, 0, 1).transformDirection(obj.matrixWorld).transformDirection(camera.matrixWorldInverse);
      expect(screenAxisSin(cam)).toBeCloseTo(Math.hypot(n.x, n.y), 9);
    }
  });
});

describe('the front glass flag covers every pose where the screen is read (materials.ts FRONT_GLASS_FLAG)', () => {
  // Look round 4 fix round 2: a 5° flag left a grey veil on dark UI at bold's resting pose (9.4°) and under the
  // floor fix's camera elevation (12°). Each of these is inside the clear zone (screen = glass-0 screen), on every layout.
  const deg = (d: number) => (d * Math.PI) / 180;
  it('busy-time limit, BOLD_BASE, the spin-in landing and the floor fix elevation are clear; the hero layback is full', () => {
    const clear: [string, Pose, number][] = [
      ['BOLD_BASE', BOLD_BASE, 0],
      ['spin-in landing (turn 4)', { ...FRONT, turn: 4 }, 0],
      ...[-1, 1].flatMap((k): [string, Pose, number][] => [
        [`turn ${k * BUSY_FACING_DEG}`, { ...FRONT, turn: k * BUSY_FACING_DEG }, 0],
        [`tilt ${k * BUSY_FACING_DEG}`, { ...FRONT, tilt: k * BUSY_FACING_DEG }, 0],
      ]),
      ['FRONT, floor fix elevation', FRONT, FLOOR_FIX_ELEVATION],
      ['BOLD_BASE, floor fix elevation', BOLD_BASE, FLOOR_FIX_ELEVATION],
    ];
    for (const layout of LAYOUTS) {
      for (const [name, pose, elevation] of clear) {
        const s = scene3d(with3d(phoneProject({ presetId: layout }), { camera: { fov: 22, elevation } }))!;
        expect(screenAxisSin(camAt(s, 0, pose)), `${layout} ${name}`).toBeLessThan(FRONT_GLASS_FLAG_SIN.clear);
      }
      const s = scene3d(with3d(phoneProject({ presetId: layout }), {}))!;
      // The hero layback's lean (shots.ts HERO_LEAN: turn -24, tilt 16, about 28.6°) shows the full sheen.
      expect(screenAxisSin(camAt(s, 0, { ...FRONT, turn: -24, tilt: 16, rotate: -4 })), layout).toBeGreaterThanOrEqual(FRONT_GLASS_FLAG_SIN.full);
    }
    expect(FRONT_GLASS_FLAG.clearDeg).toBeGreaterThan(Math.max(BUSY_FACING_DEG, FLOOR_FIX_ELEVATION));
    expect(Math.sin(deg(FRONT_GLASS_FLAG.fullDeg))).toBeCloseTo(FRONT_GLASS_FLAG_SIN.full, 12);
  });
});

describe('screen hit-testing', () => {
  it('the homography round trip is within 1e-6', () => {
    const r = lcg(7);
    for (let i = 0; i < 100; i++) {
      const s = scene3d(with3d(phoneProject(), { pose: { ...randomPose(r), turn: (r() - 0.5) * 140, tilt: (r() - 0.5) * 140 } }))!;
      const { quad } = screenQuad(s, 0)!;
      const h = homography(quad);
      const hi = invHomography(h);
      // Corners map exactly.
      const corners: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
      corners.forEach(([u, v], k) => {
        const c = applyHomography(h, u, v)!;
        expect(Math.hypot(c.x - quad[k].x, c.y - quad[k].y)).toBeLessThan(1e-6);
      });
      for (let j = 0; j < 10; j++) {
        const u = r();
        const v = r();
        const c = applyHomography(h, u, v)!;
        const back = applyHomography(hi, c.x, c.y)!;
        expect(Math.abs(back.x - u)).toBeLessThan(1e-6);
        expect(Math.abs(back.y - v)).toBeLessThan(1e-6);
      }
    }
  });

  it('matches a ray cast against the screen plane', () => {
    const s = scene3d(with3d(phoneProject(), { pose: { ...FRONT, turn: 35, tilt: 20, rotate: 10 } }))!;
    const cam = camAt(s, 0);
    const map = screenMap3d(s, 0)!;
    const sw = s.screenMm.width;
    const sh = s.screenMm.height;
    const z = s.body3d.depthMm / 2;
    // A point on the screen at (u, v) projects where the homography says.
    for (const [u, v] of [[0.3, 0.4], [0.5, 0.5], [0.8, 0.1]]) {
      const [x, y] = project([(u - 0.5) * sw, (0.5 - v) * sh, z], cam);
      const uv = canvasToScreenUV(map, x, y)!;
      expect(uv.x).toBeCloseTo(u, 6);
      expect(uv.y).toBeCloseTo(v, 6);
    }
  });

  it('turn 180 gives null; a corner outside the continuous outline gives null; the centre hits', () => {
    const back = screenMap3d(with3d(phoneProject(), { pose: { ...FRONT, turn: 180 } }), 0)!;
    const c = applyHomography(back.h, 0.5, 0.5)!;
    expect(canvasToScreenUV(back, c.x, c.y)).toBeNull();
    const front = screenMap3d(with3d(phoneProject()), 0)!;
    const mid = applyHomography(front.h, 0.5, 0.5)!;
    expect(canvasToScreenUV(front, mid.x, mid.y)).toMatchObject({ x: expect.closeTo(0.5, 9), y: expect.closeTo(0.5, 9) });
    const corner = applyHomography(front.h, 0.002, 0.002)!;
    expect(canvasToScreenUV(front, corner.x, corner.y)).toBeNull();
    // 79° off-axis still hits, 81° does not.
    const steep = (turn: number) => {
      const m = screenMap3d(with3d(phoneProject(), { pose: { ...FRONT, turn } }), 0)!;
      const q = applyHomography(m.h, 0.5, 0.5)!;
      return canvasToScreenUV(m, q.x, q.y);
    };
    expect(steep(70)).not.toBeNull();
    expect(steep(85)).toBeNull();
  });
});

describe('shadow light (look round 2: a drop shadow at every turn)', () => {
  /** Largest sideways offset (world px) of a shadow point from its body point seen straight on the catcher. */
  const offsetOf = (p: ReturnType<typeof with3d>) => {
    const s = scene3d(p)!;
    const cam = camAt(s, 0);
    const pts = bodyPointsMm(s, true).map((q) => modelToWorld(q, cam));
    const sh = shadowPointsWorld(s, cam);
    const wall = s.p3.shadow.kind === 'wall';
    return { s, cam, off: Math.max(...pts.map((q, i) => (wall ? Math.hypot(q[0] - sh[i][0], q[1] - sh[i][1]) : Math.hypot(q[0] - sh[i][0], q[2] - sh[i][2])))) };
  };

  it('the drop shadow\'s offset never passes SHADOW_OFFSET × body long side (a look decision, twice the 2D frame\'s), front to edge-on, wall and floor', () => {
    expect(SHADOW_OFFSET).toBe(2 * DEFAULT_FRAME_SHADOW.offsetY);
    for (const kind of ['wall', 'floor'] as const) {
      for (const turn of [0, 30, 60, 90, 120, 150, 180]) {
        for (const azimuth of [-35, 0, 60, 160]) {
          const p = with3d(phoneProject(), { pose: { ...FRONT, turn }, shadow: { on: true, kind, opacity: 0.4, softness: 0.5 }, light: { preset: 'studio', azimuth, intensity: 1 } });
          const { s, cam, off } = offsetOf(p);
          const long = Math.max(s.bodyMm.width, s.bodyMm.height) * cam.scale;
          expect(off, `${kind} turn ${turn} az ${azimuth}`).toBeLessThanOrEqual(SHADOW_OFFSET * long * 1.0001);
        }
      }
    }
    // Edge-on, round 1's wall shadow ran ~5 phone widths sideways; now it hugs the profile.
    const edge = offsetOf(with3d(phoneProject(), { pose: { ...FRONT, turn: 90 } }));
    expect(edge.off).toBeLessThan(edge.s.bodyMm.width * edge.cam.scale * 0.25);
  });

  it('keeps the key\'s direction (down and away from the key), and a shot\'s light channel does not swing it', () => {
    const base = with3d(phoneProject(), { light: { preset: 'studio', azimuth: -35, intensity: 1 } });
    const s = scene3d(base)!;
    const cam = camAt(s, 0);
    const L = shadowLightDir(s, cam);
    expect(L[0]).toBeLessThan(0); // light from the left: the shadow falls right
    expect(L[1]).toBeGreaterThan(0); // from above: it falls down
    const swung = with3d(phoneProject(), { light: { preset: 'studio', azimuth: -35, intensity: 1 }, pose: { ...FRONT, light: -60 } });
    const s2 = scene3d(swung)!;
    expect(shadowLightDir(s2, camAt(s2, 0))).toEqual(L);
  });
});

describe('ROI, shadow and depth', () => {
  const contains = (r: { x: number; y: number; w: number; h: number }, pts: { x: number; y: number }[]) =>
    pts.every((q) => q.x >= r.x - 1e-9 && q.x <= r.x + r.w + 1e-9 && q.y >= r.y - 1e-9 && q.y <= r.y + r.h + 1e-9);

  it('renderRoi contains shadowHull and the body hull for wall and floor at 5 light angles, snapped to whole pixels', () => {
    for (const kind of ['wall', 'floor'] as const) {
      for (const azimuth of [-150, -60, 0, 45, 120]) {
        const p = with3d(phoneProject(), {
          pose: { ...FRONT, turn: 25, tilt: 10, size: 0.7 },
          light: { preset: 'studio', azimuth, intensity: 1 },
          shadow: { on: true, kind, opacity: 0.4, softness: 0.5 },
          camera: { fov: 22, elevation: 12 },
        });
        const roi = renderRoi(p, 0)!;
        for (const v of [roi.x, roi.y, roi.w, roi.h]) expect(Number.isInteger(v)).toBe(true);
        const sh = shadowHull(p, 0)!;
        const W = 1080;
        const H = 1920;
        // Inside the canvas part of the shadow (the ROI is clamped to the canvas).
        const clampPt = (q: { x: number; y: number }) => ({ x: Math.min(W, Math.max(0, q.x)), y: Math.min(H, Math.max(0, q.y)) });
        expect(contains(roi, sh.map(clampPt)), `${kind} ${azimuth}`).toBe(true);
        expect(contains(roi, bodyHull(p, 0)!.map(clampPt))).toBe(true);
      }
    }
  });

  it('renderRoi unions the sub-frame times and pads by the blur', () => {
    const p = with3d(phoneProject(), { transitions: [move('a', 0, 1, { turn: 90 })], shadow: { on: false, kind: 'wall', opacity: 0.4, softness: 0.5 }, dof: { on: false, amount: 0.35, background: 0 } });
    const one = renderRoi(p, 0.5)!;
    const many = renderRoi(p, 0.5, subFrameTimes(0.5, 1 / 60, 8))!;
    expect(many.w).toBeGreaterThanOrEqual(one.w);
    const b = bodyBounds(p, 0.5)!;
    // 2 px pad (no shadow, no DoF), then snapped outward; buttons add a little more.
    expect(one.x).toBeLessThanOrEqual(Math.floor(b.x - 2));
    expect(one.x).toBeGreaterThan(b.x - 2 - 12);
  });

  it('shadow catchers: the wall is WALL_GAP_MM behind the rearmost hull point at every pose; the floor is 1 mm under the lowest', () => {
    const base = with3d(phoneProject(), { shadow: { on: true, kind: 'wall', opacity: 0.4, softness: 0.5 } });
    const s = scene3d(base)!;
    for (const pose of [FRONT, { ...FRONT, turn: 60 }, { ...FRONT, tilt: -40, rotate: 30 }, { ...FRONT, turn: 180 }, { ...FRONT, size: 0.5, x: 0.2 }]) {
      const cam = camAt(s, 0, pose);
      const rear = Math.min(...bodyPointsMm(s, true).map((q) => modelToWorld(q, cam)[2]));
      for (const q of shadowPointsWorld(s, cam)) expect(q[2]).toBeCloseTo(rear - WALL_GAP_MM * cam.scale, 6);
    }
    const fs = scene3d(with3d(phoneProject(), { shadow: { on: true, kind: 'floor', opacity: 0.4, softness: 0.5 } }))!;
    const fcam = camAt(fs, 0);
    const floor = shadowPointsWorld(fs, fcam);
    const lowest = Math.min(...bodyPointsMm(fs, true).map((q) => modelToWorld(q, fcam)[1]));
    for (const q of floor) expect(q[1]).toBeCloseTo(lowest - fcam.scale, 6);
  });

  it('the default wall shadow stays close under the phone, like the 2D frame shadow (D14)', () => {
    // The first spec's wall (0.8·bodyW behind the centre) put the shadow's TOP 56% of the body height down.
    for (const presetId of LAYOUTS) {
      const p = with3d(phoneProject({ presetId }));
      const b = bodyBounds(p, 0)!;
      const sh = shadowHull(p, 0)!;
      const top = Math.min(...sh.map((q) => q.y));
      const bottom = Math.max(...sh.map((q) => q.y));
      expect(top - b.y, presetId).toBeLessThan(0.05 * b.h);
      expect(bottom - (b.y + b.h), presetId).toBeLessThan(0.2 * b.h);
    }
  });

  it('shadowSigma mirrors DEFAULT_FRAME_SHADOW at the default softness and scales with softness and size', () => {
    expect(SHADOW_AMBIENT_SIGMA).toBe(DEFAULT_FRAME_SHADOW.blur / 2); // canvas shadowBlur = 2σ
    expect(SHADOW_CONTACT.sigma).toBe(0.22);
    for (const presetId of LAYOUTS) {
      const p = with3d(phoneProject({ presetId }));
      const s = scene3d(p)!;
      const g = frameGeometry(s.home.body, s.home.device, { orientation: s.home.orientation });
      const long2d = Math.max(g.bodyW, g.bodyH);
      const sig = shadowSigma(s, camAt(s, 0));
      expect(sig.ambient * 2, presetId).toBeCloseTo(DEFAULT_FRAME_SHADOW.blur * long2d, 6);
      expect(sig.contact).toBeCloseTo(0.22 * sig.ambient, 9);
      const soft = scene3d(with3d(phoneProject({ presetId }), { shadow: { on: true, kind: 'wall', opacity: 0.4, softness: 1 } }))!;
      expect(shadowSigma(soft, camAt(soft, 0)).ambient).toBeCloseTo(2 * sig.ambient, 6);
      expect(shadowSigma(s, camAt(s, 0, { ...FRONT, size: 0.5 })).ambient).toBeCloseTo(0.5 * sig.ambient, 6);
    }
  });

  it('the catcher area holds every shadow point plus SHADOW_SUPPORT_SIGMAS·σ, in the catcher plane', () => {
    for (const kind of ['wall', 'floor'] as const) {
      const s = scene3d(with3d(phoneProject(), { shadow: { on: true, kind, opacity: 0.4, softness: 0.7 }, camera: { fov: 22, elevation: 12 } }))!;
      const cam = camAt(s, 0, { ...FRONT, turn: 35, tilt: 15 });
      const g = SHADOW_SUPPORT_SIGMAS * shadowSigma(s, cam).ambient;
      const corners = shadowCatcherCorners(s, cam);
      // Both layers: the drop shadow (cast along the key) and the contact shadow (cast straight onto the catcher).
      const pts = [...shadowPointsWorld(s, cam), ...contactPointsWorld(s, cam)];
      const ax = kind === 'wall' ? [0, 1] : [0, 2];
      const plane = kind === 'wall' ? 2 : 1;
      expect(contactPointsWorld(s, cam).every((q) => q[plane] === pts[0][plane])).toBe(true);
      for (const c of corners) expect(c[plane]).toBeCloseTo(pts[0][plane], 9);
      for (const i of ax) {
        expect(Math.min(...corners.map((c) => c[i]))).toBeCloseTo(Math.min(...pts.map((q) => q[i])) - g, 6);
        expect(Math.max(...corners.map((c) => c[i]))).toBeCloseTo(Math.max(...pts.map((q) => q[i])) + g, 6);
      }
    }
  });

  it('ROI border: the blurred shadow\'s alpha is < 1/255 on every ROI edge inside the canvas (wall and floor, 5 light angles, opacity 1)', () => {
    // The renderer blurs the silhouette with a Gaussian of σ (shadowSigma.ambient) ON THE CATCHER PLANE. A convex
    // silhouette blurred that way puts at most 0.5·erfc(d/(σ√2)) of its mass at a point d outside it (the
    // half-plane bound). Each ROI border point is cast back from the camera onto the catcher plane and d is
    // measured there, so the floor's foreshortening is handled exactly.
    const erfc = (x: number) => {
      const t = 1 / (1 + 0.5 * x);
      return t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    };
    type P2 = { x: number; y: number };
    const hull2 = (pts: P2[]) => {
      const q = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
      const cross = (o: P2, a: P2, b: P2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
      const lo: P2[] = [];
      for (const v of q) {
        while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], v) <= 0) lo.pop();
        lo.push(v);
      }
      const up: P2[] = [];
      for (let i = q.length - 1; i >= 0; i--) {
        while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q[i]) <= 0) up.pop();
        up.push(q[i]);
      }
      return [...lo.slice(0, -1), ...up.slice(0, -1)];
    };
    const distOutside = (v: P2, hull: P2[]) => {
      let d = Infinity;
      for (let i = 0; i < hull.length; i++) {
        const a = hull[i];
        const b = hull[(i + 1) % hull.length];
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const u = Math.max(0, Math.min(1, ((v.x - a.x) * vx + (v.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
        d = Math.min(d, Math.hypot(v.x - a.x - u * vx, v.y - a.y - u * vy));
      }
      return d;
    };
    let checked = 0;
    for (const presetId of LAYOUTS) {
      for (const kind of ['wall', 'floor'] as const) {
        for (const azimuth of [-150, -60, 0, 45, 120]) {
          for (const pose of [FRONT, { ...FRONT, turn: 30, tilt: 10, size: 0.7 }, { ...FRONT, size: 0.45, x: -0.2 }]) {
            const p = with3d(phoneProject({ presetId }), {
              pose,
              light: { preset: 'studio', azimuth, intensity: 1 },
              shadow: { on: true, kind, opacity: 1, softness: 1 },
              camera: { fov: 22, elevation: 12 },
            });
            const roi = renderRoi(p, 0)!;
            const s = scene3d(p)!;
            const cam = camAt(s, 0);
            const sigma = shadowSigma(s, cam).ambient;
            const pts = shadowPointsWorld(s, cam);
            const wall = kind === 'wall';
            const inPlane = (w: number[]): P2 => ({ x: w[0], y: wall ? w[1] : w[2] });
            const hull = hull2(pts.map(inPlane));
            const plane = wall ? pts[0][2] : pts[0][1];
            const axis = wall ? 2 : 1;
            const { width: W, height: H } = s.canvas;
            const toPlane = (px: number, py: number): P2 | null => {
              const c = [((2 * px) / W - 1) * (W / H) / cam.focal, (1 - (2 * py) / H) / cam.focal, -1];
              const m = cam.rot;
              const dir = [m[0] * c[0] + m[1] * c[1] + m[2] * c[2], m[3] * c[0] + m[4] * c[1] + m[5] * c[2], m[6] * c[0] + m[7] * c[1] + m[8] * c[2]];
              const k = (plane - cam.eye[axis]) / dir[axis];
              if (!(k > 0)) return null; // the ray never meets the catcher: nothing is drawn there
              return inPlane([cam.eye[0] + k * dir[0], cam.eye[1] + k * dir[1], cam.eye[2] + k * dir[2]]);
            };
            const edges: P2[] = [];
            for (let k = 0; k <= 40; k++) {
              const fx = roi.x + (roi.w * k) / 40;
              const fy = roi.y + (roi.h * k) / 40;
              if (roi.y > 0) edges.push({ x: fx, y: roi.y });
              if (roi.y + roi.h < H) edges.push({ x: fx, y: roi.y + roi.h });
              if (roi.x > 0) edges.push({ x: roi.x, y: fy });
              if (roi.x + roi.w < W) edges.push({ x: roi.x + roi.w, y: fy });
            }
            for (const q of edges) {
              const v = toPlane(q.x, q.y);
              if (!v) continue;
              const alpha = 0.5 * erfc(distOutside(v, hull) / (sigma * Math.SQRT2));
              expect(alpha, `${presetId} ${kind} az ${azimuth} turn ${pose.turn}`).toBeLessThan(1 / 255);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  // Shared by the property sweep and the regression cases below. Everything here is computed from the camera and the
  // shadow points by casting canvas rays, never from the clipping code under test.
  const erfc = (x: number) => {
    const t = 1 / (1 + 0.5 * x);
    return t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  };
  type P2 = { x: number; y: number };
  /** Distance from v to a convex polygon (0 inside), either winding. */
  const distToConvex = (v: P2, poly: P2[]) => {
    let pos = 0;
    let neg = 0;
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const c = vx * (v.y - a.y) - vy * (v.x - a.x);
      if (c > 0) pos++;
      if (c < 0) neg++;
      const u = Math.max(0, Math.min(1, ((v.x - a.x) * vx + (v.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
      d = Math.min(d, Math.hypot(v.x - a.x - u * vx, v.y - a.y - u * vy));
    }
    return pos === 0 || neg === 0 ? 0 : d;
  };
  /** A polygon clipped to the canvas rectangle (Sutherland–Hodgman in 2D). */
  const clipToCanvas = (poly: P2[], W: number, H: number): P2[] => {
    const edges: [(q: P2) => number][] = [[(q) => q.x], [(q) => W - q.x], [(q) => q.y], [(q) => H - q.y]];
    let out = poly;
    for (const [f] of edges) {
      const src = out;
      out = [];
      for (let i = 0; i < src.length; i++) {
        const a = src[i];
        const b = src[(i + 1) % src.length];
        if (f(a) >= 0) out.push(a);
        if ((f(a) >= 0) !== (f(b) >= 0)) {
          const k = f(a) / (f(a) - f(b));
          out.push({ x: a.x + k * (b.x - a.x), y: a.y + k * (b.y - a.y) });
        }
      }
    }
    return out;
  };

  /**
   * Checks one project at t = 0 against the ground truth from canvas rays: the ROI holds the visible body and shadow
   * hulls and the blurred shadow is < 1/255 on its in-canvas border; near/far hold every visible catcher point and
   * body point, near ≥ 1 and near is not pulled below what is visible (no collapse to 1 px from geometry that is
   * off the canvas or behind the eye); shadowBlurPx is finite and ≥ 0. Returns the number of ROI border samples.
   */
  function checkFrame(p: ReturnType<typeof with3d>, describe: string | (() => string)): number {
    let text: string | null = null;
    const label = () => (text ??= typeof describe === 'string' ? describe : describe());
    const s = scene3d(p)!;
    const cam = camAt(s, 0);
    const { width: W, height: H } = s.canvas;
    const wall = s.p3.shadow.kind === 'wall';
    const roi = renderRoi(p, 0)!;
    const { near, far } = depthRange(s, 0, cam)!;
    const blur = shadowBlurPx(p, 0);
    // One expect per property (millions of expect calls make the sweep slow); the label is built only on failure.
    const fail = (what: string) => expect.fail(`${label()}: ${what}`);
    if (!(Number.isFinite(blur) && blur >= 0)) fail(`shadowBlurPx ${blur}`);
    if (!(near >= 1 && far > near)) fail(`depthRange ${near}..${far}`);
    const inRoi = (q: P2) => q.x >= roi.x - 1e-6 && q.x <= roi.x + roi.w + 1e-6 && q.y >= roi.y - 1e-6 && q.y <= roi.y + roi.h + 1e-6;
    if (roi.x < 0 || roi.y < 0 || roi.x + roi.w > W || roi.y + roi.h > H) fail(`ROI ${JSON.stringify(roi)} off the canvas`);
    for (const q of clipToCanvas(shadowHull(p, 0)!, W, H)) if (!inRoi(q)) fail(`shadow hull ${q.x},${q.y} outside ${JSON.stringify(roi)}`);
    const bh0 = bodyHull(p, 0)!;
    for (const q of clipToCanvas(bh0, W, H)) if (!inRoi(q)) fail(`body hull ${q.x},${q.y} outside ${JSON.stringify(roi)}`);
    // Ground truth for the body: points along the 12 box edges that are in front of the eye (depth ≥ 1 px) project
    // inside bodyHull, and inside the ROI when on the canvas. A hull built from corners behind the eye fails this.
    const box = bodyPointsMm(s, false).slice(0, 8);
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        if ([0, 1, 2].filter((k) => box[i][k] !== box[j][k]).length !== 1) continue;
        for (let k = 0; k <= 32; k++) {
          const m: Vec3 = [0, 1, 2].map((c) => box[i][c] + ((box[j][c] - box[i][c]) * k) / 32) as Vec3;
          const [x, y, z] = project(m, cam);
          if (z < 1) continue;
          if (distToConvex({ x, y }, bh0) > 1e-6 * (Math.abs(x) + Math.abs(y) + W)) fail(`body edge point ${x},${y} (depth ${z}) outside bodyHull`);
          if (x >= 0 && x <= W && y >= 0 && y <= H && !inRoi({ x, y })) fail(`body edge point ${x},${y} outside ${JSON.stringify(roi)}`);
        }
      }
    }

    // A canvas ray onto the catcher plane: its world hit and its view depth (the ray's camera-space z is −1, so the
    // depth along the view axis is the ray parameter k), or null when the ray never meets the plane.
    const pts = shadowPointsWorld(s, cam);
    const corners = shadowCatcherCorners(s, cam);
    const axis = wall ? 2 : 1;
    const plane = pts[0][axis];
    const ray = (px: number, py: number): { w: number[]; z: number } | null => {
      const c = [((2 * px) / W - 1) * (W / H) / cam.focal, (1 - (2 * py) / H) / cam.focal, -1];
      const m = cam.rot;
      const dir = [m[0] * c[0] + m[1] * c[1] + m[2] * c[2], m[3] * c[0] + m[4] * c[1] + m[5] * c[2], m[6] * c[0] + m[7] * c[1] + m[8] * c[2]];
      const k = (plane - cam.eye[axis]) / dir[axis];
      if (!(k > 0) || !Number.isFinite(k)) return null;
      return { w: [cam.eye[0] + k * dir[0], cam.eye[1] + k * dir[1], cam.eye[2] + k * dir[2]], z: k };
    };
    const inPlane = (w: number[]): P2 => ({ x: w[0], y: wall ? w[1] : w[2] });
    const quad = corners.map(inPlane); // axis-aligned in the catcher plane
    const qx0 = Math.min(...quad.map((q) => q.x));
    const qx1 = Math.max(...quad.map((q) => q.x));
    const qy0 = Math.min(...quad.map((q) => q.y));
    const qy1 = Math.max(...quad.map((q) => q.y));
    const onCatcher = (v: P2) => v.x >= qx0 && v.x <= qx1 && v.y >= qy0 && v.y <= qy1;

    // Visible catcher points: a 25×25 grid over the canvas, 129 samples on each canvas edge, and the catcher's own
    // edges (the nearest and farthest visible points of a plane region lie on the canvas border or the region's
    // edges).
    let seenMin = Infinity;
    let seenMax = -Infinity;
    const sample = (px: number, py: number) => {
      const h = ray(px, py);
      if (!h || !onCatcher(inPlane(h.w))) return;
      seenMin = Math.min(seenMin, h.z);
      seenMax = Math.max(seenMax, h.z);
    };
    if (s.p3.shadow.on) {
      for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) sample((W * i) / 24, (H * j) / 24);
      for (let k = 0; k <= 128; k++) {
        sample((W * k) / 128, 0);
        sample((W * k) / 128, H);
        sample(0, (H * k) / 128);
        sample(W, (H * k) / 128);
      }
      // Each catcher edge, 512 steps in world space (depth is linear along it, so this finds where an edge enters
      // the canvas to within 1/512 of its depth span, even for a floor seen nearly edge-on as a thin band).
      for (let e = 0; e < 4; e++) {
        const a = corners[e];
        const b = corners[(e + 1) % 4];
        for (let k = 0; k <= 512; k++) {
          const w: Vec3 = [a[0] + ((b[0] - a[0]) * k) / 512, a[1] + ((b[1] - a[1]) * k) / 512, a[2] + ((b[2] - a[2]) * k) / 512];
          const [x, y, z] = projectWorld(w, cam);
          if (z > 0 && x >= 0 && x <= W && y >= 0 && y <= H) {
            seenMin = Math.min(seenMin, z);
            seenMax = Math.max(seenMax, z);
          }
        }
      }
    }
    if (seenMin < near * (1 - 1e-9) || seenMax > far * (1 + 1e-9)) fail(`visible catcher depths ${seenMin}..${seenMax} outside ${near}..${far}`);
    for (const q of bodyPointsMm(s, true)) {
      const z = project(q, cam)[2];
      if (z >= 1 && (z < near - 1e-6 || z > far + 1e-6)) fail(`body point depth ${z} outside ${near}..${far}`);
    }
    // Tight: near is no smaller than the body's bounding sphere and the nearest visible catcher point allow (10% for
    // the sampling grid). The old code fell to 1 px here when a corner off the canvas or behind the eye was nearer.
    const bw = s.bodyMm.width / 2 + BUTTON_PROUD_MM;
    const bh = s.bodyMm.height / 2 + BUTTON_PROUD_MM;
    const pl = s.body3d.plateau;
    const R = Math.hypot(bw, bh, s.body3d.depthMm / 2 + pl.heightMm + pl.lensProudMm) * cam.scale;
    const zc = projectWorld(cam.pos, cam)[2];
    if (near < 0.9 * Math.min(zc - R, seenMin)) fail(`near ${near} collapsed (body sphere ${zc - R}, nearest visible catcher ${seenMin})`);

    // The ROI border: the blurred shadow's alpha (the half-plane bound 0.5·erfc(d/(σ√2)) for a distance d outside
    // the convex silhouette, measured on the catcher plane) is < 1/255 wherever an in-canvas edge meets the catcher.
    let checked = 0;
    if (s.p3.shadow.on && s.p3.shadow.opacity > 0) {
      const sigma = shadowSigma(s, cam).ambient;
      const hull = convexHull(pts.map(inPlane));
      for (let k = 0; k <= 40; k++) {
        const fx = roi.x + (roi.w * k) / 40;
        const fy = roi.y + (roi.h * k) / 40;
        const edges: P2[] = [];
        if (roi.y > 0) edges.push({ x: fx, y: roi.y });
        if (roi.y + roi.h < H) edges.push({ x: fx, y: roi.y + roi.h });
        if (roi.x > 0) edges.push({ x: roi.x, y: fy });
        if (roi.x + roi.w < W) edges.push({ x: roi.x + roi.w, y: fy });
        for (const q of edges) {
          const h = ray(q.x, q.y);
          if (!h) continue; // the ray never meets the catcher: nothing is drawn there
          const alpha = 0.5 * erfc(distToConvex(inPlane(h.w), hull) / (sigma * Math.SQRT2));
          if (!(alpha < 1 / 255)) fail(`ROI ${JSON.stringify(roi)} border alpha ${alpha} at ${q.x},${q.y}`);
          checked++;
        }
      }
    }
    return checked;
  }

  it('property: ROI, depth range and blur hold for 3000 random valid frames (full pose range, fov 8–60, elevation 0–30, softness 0–1, any light, wall and floor)', () => {
    const r = lcg(2026);
    const pick = (k: keyof typeof POSE_RANGE) => POSE_RANGE[k][0] + (POSE_RANGE[k][1] - POSE_RANGE[k][0]) * r();
    let behind = 0;
    let border = 0;
    for (let i = 0; i < 3000; i++) {
      const kind = i % 2 ? 'wall' : 'floor';
      const pose: Pose = { turn: pick('turn'), tilt: pick('tilt'), rotate: pick('rotate'), size: pick('size'), x: pick('x') * (i % 4 < 2 ? 0.4 : 1), y: pick('y') * (i % 4 < 2 ? 0.4 : 1), light: pick('light'), focus: pick('focus') };
      const p = with3d(phoneProject({ presetId: LAYOUTS[i % 3] }), {
        pose,
        camera: { fov: 8 + r() * 52, elevation: r() * 30 },
        shadow: { on: true, kind, opacity: 1, softness: r() < 0.3 ? 1 : r() },
        light: { preset: 'studio', azimuth: (r() - 0.5) * 360, intensity: 1 },
        dof: { on: r() < 0.5, amount: 0.35, background: 0 },
      });
      const s = scene3d(p)!;
      const cam = camAt(s, 0);
      if (shadowCatcherCorners(s, cam).some((w) => projectWorld(w, cam)[2] <= 0)) behind++;
      border += checkFrame(p, () => `#${i} ${LAYOUTS[i % 3]} ${kind} ${JSON.stringify(pose)} ${JSON.stringify(p.phone3d!.camera)} az ${p.phone3d!.light.azimuth} softness ${p.phone3d!.shadow.softness} dof ${p.phone3d!.dof.on}`);
    }
    // The sweep must reach the case that broke: catcher corners behind the eye.
    expect(behind).toBeGreaterThan(30);
    expect(border).toBeGreaterThan(50000);
  });

  it('regressions: a floor catcher (or the phone) that reaches behind the camera does not cut the shadow, collapse near or flip the blur', () => {
    const floor = (presetId: string, fov: number, elevation: number, azimuth: number, pose: Partial<Pose>) =>
      with3d(phoneProject({ presetId }), {
        pose: { ...FRONT, ...pose },
        camera: { fov, elevation },
        shadow: { on: true, kind: 'floor', opacity: 1, softness: 1 },
        light: { preset: 'studio', azimuth, intensity: 1 },
        dof: { on: false, amount: 0.35, background: 0 },
      });
    const cases: [string, ReturnType<typeof with3d>][] = [
      ['9:16 size 1.5 y −0.35 fov 55 el 8 az 160', floor('social-9x16', 55, 8, 160, { size: 1.5, y: -0.35 })],
      // With the shadow offset capped, the floor catcher reaches behind the eye only for a big phone leaned toward
      // the camera (round 1 reached it with long shadows from a key behind the phone).
      ['9:16 fov 60 size 2 tilt −40 az 180', floor('social-9x16', 60, 0, 180, { size: 2, tilt: -40 })],
      ['9:16 fov 55 size 1.5 tilt −85 az 180', floor('social-9x16', 60, 8, 180, { size: 1.5, tilt: -85 })],
      ['16:9 fov 60 size 3 tilt −85 az 180', floor('landscape-16x9', 60, 0, 180, { size: 3, tilt: -85 })],
      ['none fov 60 size 3 tilt −40 az 180', floor('none', 60, 0, 180, { size: 3, tilt: -40 })],
    ];
    for (const [label, p] of cases) {
      const s = scene3d(p)!;
      const cam = camAt(s, 0);
      const nearest = Math.min(...shadowCatcherCorners(s, cam).map((w) => projectWorld(w, cam)[2]));
      if (label.startsWith('9:16 size 1.5')) {
        // Round 1's long shadow from a key behind (az 160) ran the floor catcher behind the eye here; with the
        // offset capped at the 2D frame shadow's (SHADOW_OFFSET) it stays in front.
        expect(nearest, label).toBeGreaterThan(0);
      } else {
        // The setup really has catcher corners behind the eye.
        expect(nearest, label).toBeLessThan(0);
      }
      checkFrame(p, label);
      // What is seen of the catcher is in front of the eye and on the canvas, and the blur is measured there.
      const seen = catcherInView(s, cam);
      expect(seen.length, label).toBeGreaterThanOrEqual(3);
      for (const w of seen) {
        const [x, y, z] = projectWorld(w, cam);
        expect(z, label).toBeGreaterThanOrEqual(NEAR_CLIP_PX - 1e-9);
        expect(x > -1e-6 && x < s.canvas.width + 1e-6 && y > -1e-6 && y < s.canvas.height + 1e-6, label).toBe(true);
      }
      expect(shadowBlurPx(p, 0), label).toBeGreaterThan(0);
    }
    // A size-3 phone tilted toward a raised camera reaches 800 px behind the eye: its hull and ROI still hold every
    // body point in front of the eye.
    const big = with3d(phoneProject(), { pose: { ...FRONT, size: 3, tilt: -85, turn: -45, rotate: 45 }, camera: { fov: 60, elevation: 30 } });
    const bs = scene3d(big)!;
    const bcam = camAt(bs, 0);
    expect(Math.min(...bodyPointsMm(bs, true).map((q) => project(q, bcam)[2]))).toBeLessThan(-500);
    checkFrame(big, 'size 3 tilt −85 fov 60 el 30');
    // The first case, by the numbers the review measured (the regressed code gave h = 1434, near = 1,
    // shadowBlurPx = −5682): near stays near the body, and the ROI is the canvas from the top down to the drop
    // shadow (look round 4's longer drop shadow reaches the canvas bottom here; the ROI is clipped to it).
    const p = cases[0][1];
    const roi = renderRoi(p, 0)!;
    expect(roi).toMatchObject({ x: 0, y: 0, w: 1080 });
    expect(roi.h).toBeGreaterThan(1600);
    expect(roi.h).toBeLessThanOrEqual(1920);
    expect(depthRange(p, 0)!.near).toBeGreaterThan(400);
  });

  it('near ≥ 0.25·d when size ≤ 1.5 and fov ≤ 35 (2000 random frames); the spec\'s bound fails past that for real geometry', () => {
    const r = lcg(99);
    for (let i = 0; i < 2000; i++) {
      const p = with3d(phoneProject({ presetId: LAYOUTS[i % 3] }), {
        camera: { fov: 8 + r() * 27, elevation: r() * 30 },
        shadow: { on: true, kind: i % 2 ? 'wall' : 'floor', opacity: 0.4, softness: r() },
        light: { preset: 'studio', azimuth: (r() - 0.5) * 360, intensity: 1 },
      });
      const s = scene3d(p)!;
      const pose = { ...randomPose(r), size: 0.2 + r() * 1.3 };
      const cam = camAt(s, 0, pose);
      const d = projectWorld(cam.pos, cam)[2];
      expect(depthRange(s, 0, cam)!.near, `fov ${p.phone3d!.camera.fov} size ${pose.size}`).toBeGreaterThanOrEqual(0.25 * d);
    }
    // At fov 60 a size-1.5 landscape phone's own nearest corner is at 0.20·d, so no near plane ≥ 0.25·d can hold it.
    const p = with3d(phoneProject({ presetId: 'landscape-16x9' }), { camera: { fov: 60, elevation: 0 } });
    const s = scene3d(p)!;
    const cam = camAt(s, 0, { ...FRONT, size: 1.5, tilt: -65, turn: -85 });
    const d = projectWorld(cam.pos, cam)[2];
    const nearest = Math.min(...bodyPointsMm(s, true).map((q) => project(q, cam)[2]));
    expect(nearest).toBeLessThan(0.25 * d);
    expect(depthRange(s, 0, cam)!.near).toBeLessThanOrEqual(nearest);
  });

  it('hullTravelPx is 0 for a still phone and grows with speed and render scale', () => {
    const still = with3d(phoneProject());
    expect(hullTravelPx(still, 1, 1 / 120)).toBe(0);
    const slow = with3d(phoneProject(), { transitions: [move('a', 0, 4, { turn: 90 }, { easing: { kind: 'linear' } })] });
    const fast = with3d(phoneProject(), { transitions: [move('a', 0, 1, { turn: 360 }, { easing: { kind: 'linear' } })] });
    const a = hullTravelPx(slow, 0.5, 1 / 120);
    const b = hullTravelPx(fast, 0.5, 1 / 120);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a * 4);
    expect(hullTravelPx(fast, 0.5, 1 / 120, 2)).toBeCloseTo(b * 2, 9);
  });

  it('subFrameTimes centres the shutter on t', () => {
    expect(subFrameTimes(1, 0.1, 1)).toEqual([1]);
    const ts = subFrameTimes(1, 0.1, 4);
    expect(ts[0]).toBeCloseTo(0.9625, 12);
    expect(ts[3]).toBeCloseTo(1.0375, 12);
  });

  it('every quad is in flat-rect corner order (TL, TR, BR, BL) at FRONT', () => {
    const q = screenQuad(with3d(phoneProject()), 0)!.quad as Quad;
    expect(q[0].x).toBeLessThan(q[1].x);
    expect(q[1].y).toBeLessThan(q[2].y);
  });

  it('a project without a framed phone has no scene', () => {
    const p = with3d(phoneProject());
    p.device.frame = false;
    expect(scene3d(p)).toBeNull();
    expect(renderRoi(p, 0)).toBeNull();
    expect(screenQuad(with3d(phoneProject({ presetId: 'appstore' })), 0)).toBeNull();
  });
});
