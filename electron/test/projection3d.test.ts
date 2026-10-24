import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FRAME_SHADOW, frameGeometry } from '../src/shared/deviceGeometry';
import { FRONT, POSE_RANGE, type Pose } from '../src/shared/phone3d/model';
import {
  applyHomography,
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
  screenQuad,
  SHADOW_AMBIENT_SIGMA,
  SHADOW_CONTACT,
  SHADOW_SUPPORT_SIGMAS,
  shadowBlurPx,
  shadowCatcherCorners,
  shadowHull,
  shadowPointsWorld,
  shadowSigma,
  WALL_GAP_MM,
  subFrameTimes,
  type Cam3D,
  type Quad,
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
      const pts = shadowPointsWorld(s, cam);
      const ax = kind === 'wall' ? [0, 1] : [0, 2];
      const plane = kind === 'wall' ? 2 : 1;
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

  it('depthRange keeps the whole body and catcher between near and far (200 random poses); near ≥ 0.25·d when size ≤ 1.5', () => {
    const r = lcg(99);
    for (let i = 0; i < 200; i++) {
      const kind = i % 2 ? 'wall' : 'floor';
      const p = with3d(phoneProject({ presetId: LAYOUTS[i % 3] }), {
        camera: { fov: 8 + r() * 52, elevation: r() * 30 },
        shadow: { on: true, kind, opacity: 0.4, softness: 0.5 },
        light: { preset: 'studio', azimuth: (r() - 0.5) * 360, intensity: 1 },
      });
      const s = scene3d(p)!;
      const pose = randomPose(r);
      const cam = camAt(s, 0, pose);
      const { near, far } = depthRange(s, 0, cam)!;
      const depths = [...bodyPointsMm(s, true).map((q) => project(q, cam)[2]), ...[...shadowPointsWorld(s, cam), ...shadowCatcherCorners(s, cam)].map((w) => projectWorld(w, cam)[2])];
      for (const z of depths) {
        expect(z).toBeGreaterThanOrEqual(near - 1e-6);
        expect(z).toBeLessThanOrEqual(far + 1e-6);
      }
      if (pose.size <= 1.5) {
        const d = projectWorld(cam.pos, cam)[2]; // the body centre's depth along the camera axis
        expect(near, `fov ${p.phone3d!.camera.fov} size ${pose.size}`).toBeGreaterThanOrEqual(0.25 * d);
      }
    }
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
