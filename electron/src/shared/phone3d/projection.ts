// The 3D phone's camera and projection, as pure math (no three.js): where
// every part of the phone lands on the canvas at an output time. The
// renderer builds its three.js camera from the same numbers (cameraFor), and
// test/projection3d.test.ts checks this file against three's
// PerspectiveCamera to 0.01 px.
//
// World frame: canvas pixels, origin at the canvas centre, y UP, +z toward
// the viewer; the canvas plane is z = 0. The camera sits at
// d = (H/2)/tan(fov/2) on the +z axis (raised by `elevation` around the
// phone's home, see cameraFor), so a point on z = 0 projects 1:1 onto the
// canvas. The phone model is in millimetres (portrait, y up, screen +z,
// centred), scaled by pxPerMm·size, and placed so its FRONT GLASS plane
// (z = depth/2) lies on z = 0 at FRONT: the 3D screen then covers the flat
// screen rect exactly, and turning 3D on does not move the recording.

import { screenMm } from '../devices';
import { frameGeometry, type Rect } from '../deviceGeometry';
import { body3dFor, type Body3D } from '../devices3d';
import { projectCanvasSize } from '../mobileProject';
import type { Project, Size } from '../types';
import { KEY_ELEVATION } from './lighting';
import { defaultPhone3D, type Phone3D, type Pose } from './model';
import { continuousRectPoints, pointInPolygon, type Pt2 } from './outline';
import { phoneHome, type PhoneHome } from './placement';
import { floatSampler, mulMat3, poseRotation, rotX, rotZ, type Mat3 } from './pose';

const DEG = Math.PI / 180;

export type Vec3 = [number, number, number];
export type Point = { x: number; y: number };

const mv = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const mtv = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** Side buttons stand this far proud of the body (devices.ts draws 0.55 mm); hulls used for ROIs include them. */
export const BUTTON_PROUD_MM = 0.6;
/** The facing below which the screen is not hit-testable (80° off-axis). */
export const MIN_HIT_FACING = Math.cos(80 * DEG);

// ---------------------------------------------------------------------------
// Camera

/** Everything needed to project the phone for one pose. */
export interface Cam3D {
  canvas: Size;
  /** Vertical field of view, degrees. */
  fov: number;
  /** 1 / tan(fov / 2). */
  focal: number;
  /** Camera position (world) and rotation (camera → world; the camera looks down its −z). */
  eye: Vec3;
  rot: Mat3;
  /** Camera elevation, degrees. */
  elevation: number;
  /** Model → world: world = pos + scale·R·p, with R = poseRotation(pose)·Rz(landscape). */
  R: Mat3;
  /** The pose part of R (no landscape turn): rotates canvas-oriented local vectors. */
  Rpose: Mat3;
  scale: number;
  pos: Vec3;
  /** Canvas px per mm at size 1 (the flat frame's). */
  pxPerMm: number;
  /** Landscape turn of the portrait model about z, radians (0 in portrait). */
  landscape: number;
}

/**
 * The camera and model placement for `pose` (cameraFor in the spec): a
 * perspective camera with vertical `camera.fov` at d = (H/2)/tan(fov/2),
 * orbited up by `camera.elevation` degrees around the phone's home point so
 * the home stays where it is on the canvas. The model is scaled by
 * pxPerMm·pose.size; x/y move it in the front-face plane by x·W and y·H
 * (+y = down on the canvas); landscape adds Rz(±90°) to match frameGeometry.
 */
export function cameraFor(
  home: Pick<PhoneHome, 'body' | 'device' | 'orientation'>,
  pose: Readonly<Pose>,
  camera: Phone3D['camera'],
  canvas: Size,
  body3d: Pick<Body3D, 'depthMm'>,
): Cam3D {
  const W = canvas.width;
  const H = canvas.height;
  const g = frameGeometry(home.body, home.device, { orientation: home.orientation });
  const focal = 1 / Math.tan((camera.fov * DEG) / 2);
  const d = (H / 2) * focal;
  const hx = g.cx - W / 2;
  const hy = H / 2 - g.cy;
  const e = camera.elevation * DEG;
  const rot = rotX(-e);
  const off = mv(rot, [-hx, -hy, d]);
  const eye: Vec3 = [hx + off[0], hy + off[1], off[2]];
  const landscape = -g.rotation;
  const Rpose = poseRotation(pose);
  const R = landscape ? mulMat3(Rpose, rotZ(landscape)) : Rpose;
  const scale = g.pxPerMm * pose.size;
  const pos: Vec3 = [hx + pose.x * W, hy - pose.y * H, (-body3d.depthMm / 2) * scale];
  return { canvas, fov: camera.fov, focal, eye, rot, elevation: camera.elevation, R, Rpose, scale, pos, pxPerMm: g.pxPerMm, landscape };
}

/** A model point (mm) in world space. */
export function modelToWorld(p: Vec3, cam: Cam3D): Vec3 {
  const r = mv(cam.R, p);
  return [cam.pos[0] + cam.scale * r[0], cam.pos[1] + cam.scale * r[1], cam.pos[2] + cam.scale * r[2]];
}

/** A canvas-oriented local point (mm; x right, y up as drawn on the canvas, screen +z) in world space. */
function localToWorld(p: Vec3, cam: Cam3D): Vec3 {
  const r = mv(cam.Rpose, p);
  return [cam.pos[0] + cam.scale * r[0], cam.pos[1] + cam.scale * r[1], cam.pos[2] + cam.scale * r[2]];
}

/** A world point → [canvas x, canvas y, view depth] (depth = distance along the camera axis, px). */
export function projectWorld(w: Vec3, cam: Cam3D): [number, number, number] {
  const c = mtv(cam.rot, sub(w, cam.eye));
  const z = -c[2];
  const W = cam.canvas.width;
  const H = cam.canvas.height;
  const nx = ((cam.focal / (W / H)) * c[0]) / z;
  const ny = (cam.focal * c[1]) / z;
  return [((nx + 1) / 2) * W, ((1 - ny) / 2) * H, z];
}

/** A model point (mm) → [canvas x, canvas y, view depth]. */
export function project(pt: Vec3, cam: Cam3D): [number, number, number] {
  return projectWorld(modelToWorld(pt, cam), cam);
}

// ---------------------------------------------------------------------------
// The scene for one project

/** What a project's 3D phone needs, resolved once (cheap to keep per render). */
export interface Scene3D {
  p3: Phone3D;
  home: PhoneHome;
  body3d: Body3D;
  canvas: Size;
  /** Portrait body and screen size, mm. */
  bodyMm: { width: number; height: number };
  screenMm: { width: number; height: number };
  /** Screen corner radius, mm. */
  screenRadiusMm: number;
  /** The drawn pose at output time t (float included). */
  poseAt: (t: number) => Pose;
}

/**
 * The 3D scene for `p` on a `canvas`-sized frame (default: the project's
 * canvas), or null when the project has no framed phone (phoneHome null).
 * A project without `phone3d` uses the defaults, so the 3D tab can preview
 * before the first edit. It does not check phone3dActive: callers gate.
 */
export function scene3d(p: Project, canvas: Size = projectCanvasSize(p)): Scene3D | null {
  const home = phoneHome(p, canvas);
  if (!home) return null;
  const p3 = p.phone3d ?? defaultPhone3D();
  const g = frameGeometry(home.body, home.device, { orientation: home.orientation });
  return {
    p3,
    home,
    body3d: body3dFor(home.device),
    canvas,
    bodyMm: { ...home.device.bodyMm },
    screenMm: screenMm(home.device),
    screenRadiusMm: g.screenRadius / g.pxPerMm,
    poseAt: floatSampler(p3),
  };
}

export type SceneSource = Scene3D | Project;
const isScene = (s: SceneSource): s is Scene3D => 'poseAt' in s && 'home' in s;
const asScene = (s: SceneSource, canvas?: Size): Scene3D | null => (isScene(s) ? s : scene3d(s, canvas));

/** The camera at output time t (pose from the scene, float included). */
export function camAt(s: Scene3D, t: number, pose: Pose = s.poseAt(t)): Cam3D {
  return cameraFor(s.home, pose, s.p3.camera, s.canvas, s.body3d);
}

// ---------------------------------------------------------------------------
// The screen

/** The screen corners on the canvas, in the order of the flat screen rect's TL, TR, BR, BL. */
export type Quad = [Point, Point, Point, Point];

/** Canvas-oriented screen size in mm (landscape swaps). */
function screenLocal(s: Scene3D): { w: number; h: number } {
  const land = s.home.orientation === 'landscape';
  return land ? { w: s.screenMm.height, h: s.screenMm.width } : { w: s.screenMm.width, h: s.screenMm.height };
}

/** The screen quad and how squarely it faces the camera (cosine between the
 *  screen normal and the ray from the screen centre to the eye). */
export function screenQuadAt(s: Scene3D, t: number, cam: Cam3D = camAt(s, t)): { quad: Quad; facing: number } {
  const { w, h } = screenLocal(s);
  const z = s.body3d.depthMm / 2;
  const corners: Vec3[] = [
    [-w / 2, h / 2, z],
    [w / 2, h / 2, z],
    [w / 2, -h / 2, z],
    [-w / 2, -h / 2, z],
  ];
  const quad = corners.map((c) => {
    const [x, y] = projectWorld(localToWorld(c, cam), cam);
    return { x, y };
  }) as Quad;
  const centre = localToWorld([0, 0, z], cam);
  const n = mv(cam.Rpose, [0, 0, 1]);
  const v = sub(cam.eye, centre);
  const facing = (n[0] * v[0] + n[1] * v[1] + n[2] * v[2]) / len(v);
  return { quad, facing };
}

/** screenQuad(p, t): the screen's 4 canvas corners plus facing; null without a framed phone. */
export function screenQuad(p: SceneSource, t: number, canvas?: Size): { quad: Quad; facing: number } | null {
  const s = asScene(p, canvas);
  return s ? screenQuadAt(s, t) : null;
}

/** Row-major 3×3: [x, y, w]ᵀ = H·[u, v, 1]ᵀ. */
export type Homography = Mat3;

/**
 * The exact projective map from the unit square (u right, v down; (0,0) =
 * the quad's first corner) onto `quad`. A perspective view of a plane is a
 * homography, so this is the same result as a raycast against the screen
 * plane, with no three.js.
 */
export function homography(quad: Quad): Homography {
  const [p0, p1, p2, p3] = quad;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0;
  let h = 0;
  if (Math.abs(sx) > 1e-12 || Math.abs(sy) > 1e-12) {
    const dx1 = p1.x - p2.x;
    const dx2 = p3.x - p2.x;
    const dy1 = p1.y - p2.y;
    const dy2 = p3.y - p2.y;
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ];
}

/** The inverse map (canvas → unit square). */
export function invHomography(m: Homography): Homography {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

/** Apply a homography to (x, y); null when the point maps behind (w ≤ 0). */
export function applyHomography(m: Homography, x: number, y: number): Point | null {
  const w = m[6] * x + m[7] * y + m[8];
  if (!(w > 0)) return null;
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
}

/** Everything the compositor's hit-testing needs for one frame. */
export interface ScreenMap3D {
  quad: Quad;
  facing: number;
  /** unit square → canvas, and back. */
  h: Homography;
  hInv: Homography;
  /** The continuous-corner screen outline in uv space (0..1). */
  outline: Pt2[];
}

/** The screen map at output time t (null without a framed phone). */
export function screenMap3d(p: SceneSource, t: number, canvas?: Size): ScreenMap3D | null {
  const s = asScene(p, canvas);
  if (!s) return null;
  const { quad, facing } = screenQuadAt(s, t);
  const h = homography(quad);
  const { w, h: sh } = screenLocal(s);
  const outline = continuousRectPoints(w, sh, s.screenRadiusMm, 24).map(([x, y]): Pt2 => [x / w + 0.5, y / sh + 0.5]);
  return { quad, facing, h, hInv: invHomography(h), outline };
}

/**
 * A canvas point → (u, v) on the screen (0..1 over the flat screen rect, v
 * down), or null when the screen faces away (facing < cos 80°) or the point
 * is outside the continuous-corner screen outline.
 */
export function canvasToScreenUV(map: ScreenMap3D, px: number, py: number): Point | null {
  if (map.facing < MIN_HIT_FACING) return null;
  const uv = applyHomography(map.hInv, px, py);
  if (!uv || uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return null;
  return pointInPolygon(map.outline, [uv.x, uv.y]) ? uv : null;
}

/** (u, v) on the screen → canvas (null when it maps behind the camera). */
export function screenUVToCanvas(map: ScreenMap3D, u: number, v: number): Point | null {
  return applyHomography(map.h, u, v);
}

// ---------------------------------------------------------------------------
// Body, hull, shadow

/** The phone's extreme points in model mm: 8 body-box corners, plus (when
 *  `buttons`) the box grown by the button protrusion, plus the plateau's top
 *  corners at the lens-glass height. Mirrored in x for the back view. */
export function bodyPointsMm(s: Pick<Scene3D, 'bodyMm' | 'body3d'>, buttons = false): Vec3[] {
  const bw = s.bodyMm.width;
  const bh = s.bodyMm.height;
  const d = s.body3d.depthMm;
  const grow = buttons ? BUTTON_PROUD_MM : 0;
  const pts: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push([sx * (bw / 2 + grow), sy * (bh / 2 + grow), (sz * d) / 2]);
  const pl = s.body3d.plateau;
  // Back-view fractions from the top-left as seen from behind: the back's left is the model's +x.
  const xl = bw / 2 - pl.x * bw;
  const xr = bw / 2 - (pl.x + pl.w) * bw;
  const yt = bh / 2 - pl.y * bh;
  const yb = bh / 2 - (pl.y + pl.h) * bh;
  const zt = -d / 2 - pl.heightMm - pl.lensProudMm;
  for (const x of [xl, xr]) for (const y of [yt, yb]) pts.push([x, y, zt]);
  return pts;
}

/** Convex hull (Andrew's monotone chain), counter-clockwise on a y-down canvas. */
export function convexHull(points: readonly Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function projectedHull(s: Scene3D, cam: Cam3D, buttons: boolean): Point[] {
  return convexHull(bodyPointsMm(s, buttons).map((p) => {
    const [x, y] = project(p, cam);
    return { x, y };
  }));
}

/** The convex hull of the projected body (8 corners + plateau top) at t, canvas px. */
export function bodyHull(p: SceneSource, t: number, canvas?: Size): Point[] | null {
  const s = asScene(p, canvas);
  return s ? projectedHull(s, camAt(s, t), false) : null;
}

const bboxOf = (pts: readonly Point[]): Rect => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of pts) {
    x0 = Math.min(x0, q.x);
    y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x);
    y1 = Math.max(y1, q.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
const unionRect = (a: Rect | null, b: Rect): Rect => {
  if (!a) return b;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
};

/** The bbox of the body hull at t, unioned over `times` (the motion-blur sub-frame times) when given. */
export function bodyBounds(p: SceneSource, t: number, times?: readonly number[], canvas?: Size): Rect | null {
  const s = asScene(p, canvas);
  if (!s) return null;
  let r: Rect | null = null;
  for (const tt of times?.length ? times : [t]) r = unionRect(r, bboxOf(projectedHull(s, camAt(s, tt), false)));
  return r;
}

/** Unit vector toward the key light (world), from its azimuth (degrees) and KEY_ELEVATION. */
export function keyLightDir(azimuthDeg: number, elevationDeg = KEY_ELEVATION): Vec3 {
  const a = azimuthDeg * DEG;
  const e = elevationDeg * DEG;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

/** A light from behind still casts onto the wall: L.z is held at least this (keeps the wall shadow finite). */
const MIN_WALL_LZ = 0.1;

/** The world points of the body's shadow on the active catcher (wall: a plane 0.8·bodyW behind the phone's centre;
 *  floor: 1 mm under the lowest hull point), cast along the key light (azimuth light.azimuth + pose.light, 55° up). */
export function shadowPointsWorld(s: Scene3D, cam: Cam3D, pose: Pose, light: { azimuth: number } = { azimuth: s.p3.light.azimuth + pose.light }): Vec3[] {
  const pts = bodyPointsMm(s, true).map((p) => modelToWorld(p, cam));
  const L = keyLightDir(light.azimuth);
  if (s.p3.shadow.kind === 'wall') {
    const zw = cam.pos[2] - 0.8 * s.bodyMm.width * cam.scale;
    const lz = Math.max(L[2], MIN_WALL_LZ);
    return pts.map((q) => {
      const k = (q[2] - zw) / lz;
      return [q[0] - k * L[0], q[1] - k * L[1], zw] as Vec3;
    });
  }
  const yf = Math.min(...pts.map((q) => q[1])) - 1 * cam.scale;
  return pts.map((q) => {
    const k = (q[1] - yf) / L[1];
    return [q[0] - k * L[0], yf, q[2] - k * L[2]] as Vec3;
  });
}

/** The shadow's outline on the canvas at t: the body hull cast onto the catcher along the key light, then projected. */
export function shadowHull(p: SceneSource, t: number, light?: { azimuth: number }, canvas?: Size): Point[] | null {
  const s = asScene(p, canvas);
  if (!s) return null;
  const pose = s.poseAt(t);
  const cam = camAt(s, t, pose);
  return convexHull(shadowPointsWorld(s, cam, pose, light).map((w) => {
    const [x, y] = projectWorld(w, cam);
    return { x, y };
  }));
}

/** The shadow blur's full kernel radius in canvas px: softness·40 px on a 1080-short-side canvas, scaled to the
 *  canvas's short side. The renderer's ambient blur must not reach past it (σ = radius / 3 fits). */
export function shadowBlurPx(p3: Pick<Phone3D, 'shadow'>, canvas: Size): number {
  return p3.shadow.softness * 40 * (Math.min(canvas.width, canvas.height) / 1080);
}

/** Circle of confusion at view depth z with the focus at z_f (spec §3.7 step 6), px. */
export function cocPx(p3: Pick<Phone3D, 'dof'>, focus: number, canvasH: number, zf: number, z: number): number {
  if (!p3.dof.on || focus <= 0 || !(z > 0)) return 0;
  return p3.dof.amount * focus * 0.02 * canvasH * Math.abs(1 - zf / z);
}

/** The largest depth-of-field blur on the phone or its shadow at t, px (0 with DoF off). */
export function maxCocPx(s: Scene3D, t: number): number {
  const pose = s.poseAt(t);
  if (!s.p3.dof.on || pose.focus <= 0) return 0;
  const cam = camAt(s, t, pose);
  const zf = projectWorld(localToWorld([0, 0, s.body3d.depthMm / 2], cam), cam)[2];
  const world = [...bodyPointsMm(s, true).map((q) => modelToWorld(q, cam)), ...(s.p3.shadow.on ? shadowPointsWorld(s, cam, pose) : [])];
  let m = 0;
  for (const w of world) m = Math.max(m, cocPx(s.p3, pose.focus, s.canvas.height, zf, projectWorld(w, cam)[2]));
  return m;
}

export interface RoiOptions {
  /** Extra margin, px (default 0). */
  extraPx?: number;
}

/**
 * The canvas region the 3D pass must render: the body hull (with buttons)
 * ∪ its shadow on the catcher, unioned over `times`, dilated by the shadow
 * blur radius + the max DoF circle of confusion + 2 px, clamped to the
 * canvas, then snapped OUTWARD to whole canvas pixels (integer x/y keep the
 * FRONT screen texel-aligned, so drawImage never resamples the phone).
 * May be empty (w or h 0) when the phone is entirely off the canvas.
 */
export function renderRoi(p: SceneSource, t: number, times?: readonly number[], opts: RoiOptions & { canvas?: Size } = {}): Rect | null {
  const s = asScene(p, opts.canvas);
  if (!s) return null;
  const shadow = s.p3.shadow.on && s.p3.shadow.opacity > 0;
  let r: Rect | null = null;
  let coc = 0;
  for (const tt of times?.length ? times : [t]) {
    const pose = s.poseAt(tt);
    const cam = camAt(s, tt, pose);
    r = unionRect(r, bboxOf(projectedHull(s, cam, true)));
    if (shadow) {
      r = unionRect(r, bboxOf(shadowPointsWorld(s, cam, pose).map((w) => {
        const [x, y] = projectWorld(w, cam);
        return { x, y };
      })));
    }
    coc = Math.max(coc, maxCocPx(s, tt));
  }
  const pad = (shadow ? shadowBlurPx(s.p3, s.canvas) : 0) + coc + 2 + (opts.extraPx ?? 0);
  const W = s.canvas.width;
  const H = s.canvas.height;
  const x0 = Math.max(0, Math.floor(r!.x - pad));
  const y0 = Math.max(0, Math.floor(r!.y - pad));
  const x1 = Math.min(W, Math.ceil(r!.x + r!.w + pad));
  const y1 = Math.min(H, Math.ceil(r!.y + r!.h + pad));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Near/far planes that hold the whole body and its catcher at t: with dist
 * the eye's distance to the body centre and R the body's bounding radius in
 * px (buttons, plateau and lens glass included), near = max(1, dist − R)
 * and far = dist + R + the catcher's farthest shadow point from the body
 * centre (0 with the shadow off).
 */
export function depthRange(p: SceneSource, t: number, cam?: Cam3D, canvas?: Size): { near: number; far: number } | null {
  const s = asScene(p, canvas);
  if (!s) return null;
  const pose = s.poseAt(t);
  const c = cam ?? camAt(s, t, pose);
  const bw = s.bodyMm.width / 2 + BUTTON_PROUD_MM;
  const bh = s.bodyMm.height / 2 + BUTTON_PROUD_MM;
  const pl = s.body3d.plateau;
  const bz = s.body3d.depthMm / 2 + pl.heightMm + pl.lensProudMm;
  const R = Math.hypot(bw, bh, bz) * c.scale;
  const dist = len(sub(c.pos, c.eye));
  let catcher = 0;
  if (s.p3.shadow.on) for (const w of shadowPointsWorld(s, c, pose)) catcher = Math.max(catcher, len(sub(w, c.pos)));
  return { near: Math.max(1, dist - R), far: dist + R + catcher };
}

/** Sub-frame sample times for a frame at t: t_k = t + ((k + 0.5)/n − 0.5)·shutterSec (§3.7 step 4). */
export function subFrameTimes(t: number, shutterSec: number, n: number): number[] {
  if (n <= 1 || !(shutterSec > 0)) return [t];
  return Array.from({ length: n }, (_, k) => t + ((k + 0.5) / n - 0.5) * shutterSec);
}

/** Steps hullTravelPx samples the shutter with (fixed: deterministic). */
export const TRAVEL_STEPS = 8;

/**
 * The longest path a projected hull corner travels over the shutter
 * [t − shutter/2, t + shutter/2], in render pixels (canvas px × renderScale).
 * Pose only, so deterministic. Drives the adaptive motion-blur count.
 */
export function hullTravelPx(p: SceneSource, t: number, shutterSec: number, renderScale = 1, canvas?: Size): number {
  const s = asScene(p, canvas);
  if (!s || !(shutterSec > 0)) return 0;
  const pts = bodyPointsMm(s, true);
  let prev: [number, number][] | null = null;
  const dist = new Array(pts.length).fill(0);
  for (let k = 0; k <= TRAVEL_STEPS; k++) {
    const tt = t - shutterSec / 2 + (shutterSec * k) / TRAVEL_STEPS;
    const cam = camAt(s, tt);
    const cur = pts.map((q) => {
      const [x, y] = project(q, cam);
      return [x, y] as [number, number];
    });
    if (prev) cur.forEach((c, i) => (dist[i] += Math.hypot(c[0] - prev![i][0], c[1] - prev![i][1])));
    prev = cur;
  }
  return Math.max(...dist) * renderScale;
}
