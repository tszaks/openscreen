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
import { DEFAULT_FRAME_SHADOW, frameGeometry, type Rect } from '../deviceGeometry';
import { body3dFor, type Body3D } from '../devices3d';
import { projectCanvasSize } from '../mobileProject';
import type { Project, Size } from '../types';
import { KEY_ELEVATION } from './lighting';
import { defaultPhone3D, type Phone3D, type Pose } from './model';
import { continuousRectPoints, pointInPolygon, type Pt2 } from './outline';
import { phoneHome, type PhoneHome } from './placement';
import { floatSampler, mulMat3, poseRotation, rotX, rotZ, type Mat3, type ShutterWindow } from './pose';

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
  /** The pose this camera was built for. */
  pose: Pose;
  /** A zoom push-in (owner decision 20), when one plays: canvas = s·p + (ox, oy), p the canvas point without it. */
  view?: View2D;
}

/**
 * A zoom push-in on the 3D camera (owner decision 20): the lens closes in on
 * the zoom centre (a longer focal length with a matching lens shift), so the
 * whole picture of the phone scales by `s` about a canvas point:
 * canvas = s·p + (ox, oy). The phone keeps its pose and stays whole; the
 * renderer draws it at the zoomed size, so the screen texture is sized from
 * the zoomed screen and stays 1:1 and sharp. Every projection here (hulls,
 * ROI, depth range, hit-testing) goes through it.
 */
export interface View2D {
  s: number;
  ox: number;
  oy: number;
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
  return { canvas, fov: camera.fov, focal, eye, rot, elevation: camera.elevation, R, Rpose, scale, pos, pxPerMm: g.pxPerMm, landscape, pose: { ...pose } };
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
  const x = ((nx + 1) / 2) * W;
  const y = ((1 - ny) / 2) * H;
  const v = cam.view;
  return v ? [v.s * x + v.ox, v.s * y + v.oy, z] : [x, y, z];
}

/** A model point (mm) → [canvas x, canvas y, view depth]. */
export function project(pt: Vec3, cam: Cam3D): [number, number, number] {
  return projectWorld(modelToWorld(pt, cam), cam);
}

// ---------------------------------------------------------------------------
// Clipping against the view
//
// projectWorld divides by the view depth, so a point at or behind the eye
// (depth ≤ 0) lands on the wrong side of the canvas. Anything that bounds,
// hulls or takes depths from geometry that can reach the camera (the floor
// catcher grown by the blur, a big tilted phone at a wide fov) clips first.

/** Clipped geometry keeps at least this view depth, px (the smallest near plane depthRange returns). */
export const NEAR_CLIP_PX = 1;

/** A world point in view space: [x right, y up, depth along the camera axis]. */
function toView(w: Vec3, cam: Cam3D): Vec3 {
  const c = mtv(cam.rot, sub(w, cam.eye));
  return [c[0], c[1], -c[2]];
}

/** A view-space point (depth > 0) → canvas. */
function viewToCanvas(v: Vec3, cam: Cam3D): Point {
  const W = cam.canvas.width;
  const H = cam.canvas.height;
  const x = (((cam.focal / (W / H)) * v[0]) / v[2] + 1) * (W / 2);
  const y = (1 - (cam.focal * v[1]) / v[2]) * (H / 2);
  const z = cam.view;
  return z ? { x: z.s * x + z.ox, y: z.s * y + z.oy } : { x, y };
}

type ClipPlane = (v: Vec3) => number;

/** The near plane at NEAR_CLIP_PX (≥ 0 = kept). */
const nearPlane: ClipPlane = (v) => v[2] - NEAR_CLIP_PX;

/** The canvas frustum: the near plane plus the 4 side planes through the canvas edges. Linear in view space, so
 *  clipping by them and interpolating in world space agree. */
function frustumPlanes(cam: Cam3D): ClipPlane[] {
  const W = cam.canvas.width;
  const H = cam.canvas.height;
  const fx = cam.focal / (W / H);
  const fy = cam.focal;
  // With a zoom (View2D) the canvas edges are the planes where the zoomed NDC is ±1: ndc' = s·ndc + t.
  const k = cam.view?.s ?? 1;
  const tx = cam.view ? k - 1 + (2 * cam.view.ox) / W : 0;
  const ty = cam.view ? 1 - k - (2 * cam.view.oy) / H : 0;
  return [
    nearPlane,
    (v) => (1 - tx) * v[2] - k * fx * v[0],
    (v) => (1 + tx) * v[2] + k * fx * v[0],
    (v) => (1 - ty) * v[2] - k * fy * v[1],
    (v) => (1 + ty) * v[2] + k * fy * v[1],
  ];
}

/** Sutherland–Hodgman: a convex polygon (view space, in order) clipped by each plane in turn. May be empty. */
function clipPolygon(poly: readonly Vec3[], planes: readonly ClipPlane[]): Vec3[] {
  let out = [...poly];
  for (const plane of planes) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i];
      const b = src[(i + 1) % src.length];
      const da = plane(a);
      const db = plane(b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const k = da / (da - db);
        out.push([a[0] + k * (b[0] - a[0]), a[1] + k * (b[1] - a[1]), a[2] + k * (b[2] - a[2])]);
      }
    }
    if (!out.length) break;
  }
  return out;
}

/**
 * The part of the convex hull of `pts` (view space) at depth ≥ NEAR_CLIP_PX, as a point set with the same convex
 * hull: the points in front, plus where every segment between a point in front and one behind crosses the near
 * plane (that includes every hull edge that crosses it). Unchanged when nothing reaches the near plane.
 */
function clipCloudToNear(pts: readonly Vec3[]): Vec3[] {
  const front = pts.filter((v) => nearPlane(v) >= 0);
  if (front.length === pts.length) return [...pts];
  const out = [...front];
  for (const a of front) {
    for (const b of pts) {
      const db = nearPlane(b);
      if (db >= 0) continue;
      const da = nearPlane(a);
      const k = da / (da - db);
      out.push([a[0] + k * (b[0] - a[0]), a[1] + k * (b[1] - a[1]), NEAR_CLIP_PX]);
    }
  }
  return out;
}

/** The canvas outline of the visible part of a convex solid or planar shape given by its extreme world points:
 *  clipped to the near plane, then projected and hulled. Exact (a perspective view maps a convex set in front of
 *  the eye to a convex set), and may extend past the canvas. Empty when all of it is behind the camera. */
function projectedConvex(world: readonly Vec3[], cam: Cam3D): Point[] {
  return convexHull(clipCloudToNear(world.map((w) => toView(w, cam))).map((v) => viewToCanvas(v, cam)));
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
  /** The zoom push-in at output time t (owner decision 20), or null/absent when no zoom plays. The compositor sets
   *  it from the project's zoom segments; a scene without it (agent tools, warnings) is the unzoomed view. */
  viewAt?: (t: number) => View2D | null;
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
  const cam = cameraFor(s.home, pose, s.p3.camera, s.canvas, s.body3d);
  const v = s.viewAt?.(t);
  if (v && (v.s !== 1 || v.ox !== 0 || v.oy !== 0)) cam.view = v;
  return cam;
}

/**
 * The push-in that frames a zoom on the 3D phone (owner decision 20): the
 * flat zoom's scale `k`, about the point `uv` of the screen (0..1 over the
 * flat screen rect, v down: the centre of what the flat zoom would show), so
 * that point lands where the screen's centre is without the zoom. At k = 1
 * and the screen's centre it is the identity. From the unzoomed camera at t
 * (pose included), so it follows the screen as the phone moves.
 */
export function zoomViewAt(s: Scene3D, t: number, k: number, uv: Point): View2D | null {
  if (!(k > 1 + 1e-6)) return null;
  const base = cameraFor(s.home, s.poseAt(t), s.p3.camera, s.canvas, s.body3d);
  const { quad } = screenQuadAt(s, t, base);
  const h = homography(quad);
  const p = applyHomography(h, uv.x, uv.y);
  const r = applyHomography(h, 0.5, 0.5);
  if (!p || !r) return null;
  return { s: k, ox: r.x - k * p.x, oy: r.y - k * p.y };
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

/**
 * Sine of the angle between the screen's normal and the camera's axis: 0 when the screen is parallel to the canvas
 * (FRONT with the camera level), wherever the phone stands on the canvas. The front glass's flag fade
 * (materials.ts FRONT_GLASS_FLAG) uses the same number in the shader: the length of the view-space normal's x and y.
 */
export function screenAxisSin(cam: Pick<Cam3D, 'Rpose' | 'rot'>): number {
  const n = mtv(cam.rot, mv(cam.Rpose, [0, 0, 1]));
  return Math.hypot(n[0], n[1]);
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

/**
 * Canvas px → the screen mesh's own uv at `cam` (u along the model's +x, v
 * along its +y, 0..1 over the portrait screen rect: the uv the renderer's
 * screen mesh carries, before the texture's own transform). Built from the
 * four projected corners of that rect, so it holds in landscape too. The
 * renderer uses it to read the screen texture where the frame's centre pose
 * put it (a steady screen under motion blur).
 */
export function screenUvMap(s: Scene3D, cam: Cam3D): Homography {
  const w = s.screenMm.width;
  const h = s.screenMm.height;
  const z = s.body3d.depthMm / 2;
  // Mesh uv (0,0), (1,0), (1,1), (0,1) = the unit square's corners in homography()'s order.
  const corners: Vec3[] = [
    [-w / 2, -h / 2, z],
    [w / 2, -h / 2, z],
    [w / 2, h / 2, z],
    [-w / 2, h / 2, z],
  ];
  const quad = corners.map((c) => {
    const [x, y] = projectWorld(modelToWorld(c, cam), cam);
    return { x, y };
  }) as Quad;
  return invHomography(homography(quad));
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

/** The body's canvas outline: its extreme points, clipped to the near plane when a big phone at a wide fov reaches
 *  the camera, projected and hulled. */
function projectedHull(s: Scene3D, cam: Cam3D, buttons: boolean): Point[] {
  return projectedConvex(bodyPointsMm(s, buttons).map((p) => modelToWorld(p, cam)), cam);
}

/** The convex hull of the projected body (8 corners + plateau top) at t, canvas px (only the part in front of the
 *  camera; empty if none of it is). */
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

/** The wall catcher stands this far behind the phone's rearmost point at each moment (lens glass included, so the
 *  camera plateau never pokes through), the same rule as the floor's 1 mm under the lowest point. A fixed far wall
 *  (the spec's first 0.8·bodyW behind the centre) threw the default shadow 56% of the body height below the phone,
 *  which cannot mirror DEFAULT_FRAME_SHADOW (D14). */
export const WALL_GAP_MM = 1;
/** The ambient shadow's Gaussian σ per unit of the body's long side, at the default softness: the 2D frame's
 *  (canvas shadowBlur is 2σ, so σ = DEFAULT_FRAME_SHADOW.blur / 2 = 0.0425). */
export const SHADOW_AMBIENT_SIGMA = DEFAULT_FRAME_SHADOW.blur / 2;
/** The contact layer: the silhouette cast STRAIGHT onto the catcher (along its normal, not along the key), blurred
 *  to 0.22× the ambient σ at 0.7× the opacity (deviceFrame.ts' two layers). It hugs the phone's outline on every
 *  side, as the shade a phone close to a surface casts whatever the light; the ambient layer is the drop shadow,
 *  cast along the key. */
export const SHADOW_CONTACT = { sigma: 0.22, opacity: 0.7 } as const;
/** How many σ of the ambient blur the catcher area and the ROI keep. Past 3σ outside the silhouette, an edge's
 *  alpha is 0.5·erfc(3/√2)·opacity < 0.0014 < 1/255 at any opacity ≤ 1 (the ROI-border gate). */
export const SHADOW_SUPPORT_SIGMAS = 3;
/** The softness at which the 3D shadow equals the 2D one (phone3d's default). */
const SOFTNESS_REF = defaultPhone3D().shadow.softness;

/**
 * The most the drop shadow is pushed off the phone, per unit of the body's long side (owner decision 7: a look
 * decision). Round 2 capped it at the 2D frame shadow's offset (0.04): with the wall 1 mm behind the phone the
 * shadow then hid behind the body and the judges saw no shadow at all on a flat backdrop (rounds 2 and 3). At 0.08
 * the drop shadow shows as a soft shape below and beside the phone on the side away from the key, while the
 * contact layer (cast straight back, SHADOW_CONTACT) keeps a tight dark edge all round it, so the phone sits on
 * the backdrop instead of floating. Edge-on it still shrinks to a short soft shape, not a slab.
 */
export const SHADOW_OFFSET = 0.08;

/**
 * The direction (unit, toward the light) the shadow is cast along at this pose: the key's (`azimuth`, default the
 * project's light.azimuth, KEY_ELEVATION up), its sideways part scaled down so the highest point of the body above
 * the catcher lands at most SHADOW_OFFSET · body long side from where it would with a light straight on (the drop
 * layer; the contact layer is cast straight on, contactPointsWorld).
 * The pose's `light` channel does NOT turn it: a shot turns the reflections, but a shadow that swept across the
 * backdrop in a spin-in (a hard wedge, then a streak, then a blob) drew the eye off the phone. Pure; the renderer
 * casts the silhouette along exactly this (renderer/phone3d/shadow.ts sampleLight).
 */
export function shadowLightDir(s: Scene3D, cam: Cam3D, azimuth: number = s.p3.light.azimuth): Vec3 {
  const pts = bodyPointsMm(s, true).map((p) => modelToWorld(p, cam));
  const L = keyLightDir(azimuth);
  const wall = s.p3.shadow.kind === 'wall';
  // Height above the catcher of the highest point, and the light's sideways run per unit of height.
  const along = wall ? Math.max(L[2], MIN_WALL_LZ) : L[1];
  const height = wall ? Math.max(...pts.map((q) => q[2])) - wallZ(pts, cam) : Math.max(...pts.map((q) => q[1])) - floorY(pts, cam);
  const side = wall ? Math.hypot(L[0], L[1]) / along : Math.hypot(L[0], L[2]) / along;
  const cap = SHADOW_OFFSET * Math.max(s.bodyMm.width, s.bodyMm.height) * cam.scale;
  const k = side * height > cap && side > 0 ? cap / (side * height) : 1;
  const d: Vec3 = wall ? [L[0] * k, L[1] * k, along] : [L[0] * k, along, L[2] * k];
  const n = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / n, d[1] / n, d[2] / n];
}

/** The world points of the body's shadow on the active catcher, cast along shadowLightDir. Wall: a plane parallel
 *  to the canvas, WALL_GAP_MM behind the rearmost hull point at this pose; floor: a horizontal plane 1 mm under the
 *  lowest hull point. `light.azimuth` overrides the key azimuth (default: the project's light.azimuth). */
export function shadowPointsWorld(s: Scene3D, cam: Cam3D, light?: { azimuth: number }): Vec3[] {
  const pts = bodyPointsMm(s, true).map((p) => modelToWorld(p, cam));
  const L = shadowLightDir(s, cam, light?.azimuth);
  if (s.p3.shadow.kind === 'wall') {
    const zw = wallZ(pts, cam);
    const lz = Math.max(L[2], MIN_WALL_LZ);
    return pts.map((q) => {
      const k = (q[2] - zw) / lz;
      return [q[0] - k * L[0], q[1] - k * L[1], zw] as Vec3;
    });
  }
  const yf = floorY(pts, cam);
  return pts.map((q) => {
    const k = (q[1] - yf) / L[1];
    return [q[0] - k * L[0], yf, q[2] - k * L[2]] as Vec3;
  });
}

/** The world points of the contact shadow on the active catcher: the body points cast straight onto it (wall: along
 *  −z; floor: along −y), on the same plane as shadowPointsWorld. */
export function contactPointsWorld(s: Scene3D, cam: Cam3D): Vec3[] {
  const pts = bodyPointsMm(s, true).map((p) => modelToWorld(p, cam));
  if (s.p3.shadow.kind === 'wall') {
    const zw = wallZ(pts, cam);
    return pts.map((q) => [q[0], q[1], zw] as Vec3);
  }
  const yf = floorY(pts, cam);
  return pts.map((q) => [q[0], yf, q[2]] as Vec3);
}

const floorY = (pts: readonly Vec3[], cam: Cam3D) => Math.min(...pts.map((q) => q[1])) - 1 * cam.scale;
const wallZ = (pts: readonly Vec3[], cam: Cam3D) => Math.min(...pts.map((q) => q[2])) - WALL_GAP_MM * cam.scale;

/**
 * The shadow's two Gaussian σ at this pose, in world units (canvas px at z = 0) MEASURED ON THE CATCHER PLANE:
 * ambient = SHADOW_AMBIENT_SIGMA · body long side · softness / 0.5, contact = SHADOW_CONTACT.sigma · ambient. At the
 * default softness this is the 2D frame shadow's blur for the same body size; it scales with pose.size like the
 * body. The renderer's blur footprint on the catcher must not be wider than `ambient` in any direction: a blur
 * done in the light's view stretches by 1/|L·n| when cast onto the catcher, so either render the silhouette in
 * catcher-plane coordinates (planar projection along the light) or scale the light-space σ by |L·n|.
 */
export function shadowSigma(s: Pick<Scene3D, 'p3' | 'bodyMm'>, cam: Pick<Cam3D, 'scale'>): { ambient: number; contact: number } {
  const long = Math.max(s.bodyMm.width, s.bodyMm.height) * cam.scale;
  const ambient = SHADOW_AMBIENT_SIGMA * long * (s.p3.shadow.softness / SOFTNESS_REF);
  return { ambient, contact: SHADOW_CONTACT.sigma * ambient };
}

/**
 * The 4 world corners of the catcher area that holds the whole blurred shadow at this pose: the drop and contact
 * shadow points' bounding box in the catcher plane (wall: x, y; floor: x, z), grown by SHADOW_SUPPORT_SIGMAS · ambient σ on each
 * side. The renderer draws exactly this quad; renderRoi, depthRange, maxCocPx and shadowBlurPx use its visible part
 * (catcherInView), so they agree by construction.
 */
export function shadowCatcherCorners(s: Scene3D, cam: Cam3D, light?: { azimuth: number }): Vec3[] {
  const pts = [...shadowPointsWorld(s, cam, light), ...contactPointsWorld(s, cam)];
  const g = SHADOW_SUPPORT_SIGMAS * shadowSigma(s, cam).ambient;
  const wall = s.p3.shadow.kind === 'wall';
  const a = 0; // x on both catchers
  const b = wall ? 1 : 2; // the catcher's second in-plane axis
  const lo = (i: number) => Math.min(...pts.map((q) => q[i])) - g;
  const hi = (i: number) => Math.max(...pts.map((q) => q[i])) + g;
  const plane = wall ? pts[0][2] : pts[0][1];
  const [a0, a1, b0, b1] = [lo(a), hi(a), lo(b), hi(b)];
  const at = (u: number, v: number): Vec3 => (wall ? [u, v, plane] : [u, plane, v]);
  return [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)];
}

/** The shadow's outline on the canvas at t: the body hull cast onto the catcher along the key light, then projected. */
export function shadowHull(p: SceneSource, t: number, light?: { azimuth: number }, canvas?: Size): Point[] | null {
  const s = asScene(p, canvas);
  if (!s) return null;
  const cam = camAt(s, t);
  return projectedConvex(shadowPointsWorld(s, cam, light), cam);
}

/**
 * The part of the catcher area (shadowCatcherCorners) the camera can see: the quad clipped to the canvas frustum
 * (NEAR_CLIP_PX near plane and the 4 side planes), as world points in order. Empty when none of it is on the canvas.
 * Grown by 3σ, the floor quad can reach past the camera (its near corners then sit behind the eye and would project
 * to the wrong side), so renderRoi, depthRange, maxCocPx and shadowBlurPx all use this, never the raw corners. The
 * renderer still draws the whole quad: the GPU clips it the same way.
 */
export function catcherInView(s: Scene3D, cam: Cam3D, light?: { azimuth: number }): Vec3[] {
  const view = clipPolygon(shadowCatcherCorners(s, cam, light).map((w) => toView(w, cam)), frustumPlanes(cam));
  return view.map((v) => {
    const c = mv(cam.rot, [v[0], v[1], -v[2]]);
    return [cam.eye[0] + c[0], cam.eye[1] + c[1], cam.eye[2] + c[2]] as Vec3;
  });
}

/** The ambient shadow's full support (SHADOW_SUPPORT_SIGMAS · σ) in canvas px at t, measured where the visible
 *  catcher (catcherInView) is nearest the camera (the largest it can look on the canvas). Finite and ≥ 0; 0 with
 *  the shadow off or the catcher off the canvas. */
export function shadowBlurPx(p: SceneSource, t: number, canvas?: Size): number {
  const s = asScene(p, canvas);
  if (!s || !s.p3.shadow.on) return 0;
  const cam = camAt(s, t);
  const seen = catcherInView(s, cam);
  if (!seen.length) return 0;
  const nearest = Math.max(NEAR_CLIP_PX, Math.min(...seen.map((w) => toView(w, cam)[2])));
  return (SHADOW_SUPPORT_SIGMAS * shadowSigma(s, cam).ambient * (cam.focal * cam.canvas.height) * (cam.view?.s ?? 1)) / (2 * nearest);
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
  // Depths of what can be seen: the body clipped to the near plane, and the catcher clipped to the canvas frustum.
  const body = clipCloudToNear(bodyPointsMm(s, true).map((q) => toView(modelToWorld(q, cam), cam)));
  const catcher = s.p3.shadow.on ? catcherInView(s, cam).map((w) => toView(w, cam)) : [];
  let m = 0;
  for (const v of [...body, ...catcher]) m = Math.max(m, cocPx(s.p3, pose.focus, s.canvas.height, zf, v[2]));
  return m * (cam.view?.s ?? 1);
}

export interface RoiOptions {
  /** Extra margin, px (default 0). */
  extraPx?: number;
}

/**
 * The canvas region the 3D pass must render: the body hull (with buttons)
 * and the visible part of the catcher area that holds the whole blurred
 * shadow (catcherInView, projected), unioned over `times`, each dilated by
 * the max DoF circle of confusion + 2 px, clamped to the canvas, then
 * snapped OUTWARD to whole canvas pixels (integer x/y keep the FRONT screen
 * texel-aligned, so drawImage never resamples the phone). Only the shadow
 * is grown by its blur, so the blur does not inflate the phone's part.
 * May be empty (w or h 0) when the phone is entirely off the canvas; x/y
 * always lie on the canvas (0..W, 0..H).
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
    const body = projectedHull(s, cam, true);
    if (body.length) r = unionRect(r, bboxOf(body));
    if (shadow) {
      const seen = catcherInView(s, cam).map((w) => viewToCanvas(toView(w, cam), cam));
      if (seen.length) r = unionRect(r, bboxOf(seen));
    }
    coc = Math.max(coc, maxCocPx(s, tt));
  }
  if (!r) return { x: 0, y: 0, w: 0, h: 0 };
  const pad = coc + 2 + (opts.extraPx ?? 0);
  const W = s.canvas.width;
  const H = s.canvas.height;
  const clamp = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
  const x0 = clamp(Math.floor(r.x - pad), W);
  const y0 = clamp(Math.floor(r.y - pad), H);
  const x1 = clamp(Math.ceil(r.x + r.w + pad), W);
  const y1 = clamp(Math.ceil(r.y + r.h + pad), H);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Near/far planes that hold the whole body and its shadow catcher at t.
 * With zc the body centre's depth along the camera axis and R the body's
 * bounding radius in px (buttons, plateau and lens glass included):
 * near = max(1, min(zc − R, nearest visible catcher point)) and
 * far = max(zc + R, farthest visible catcher point) + 1 px, where the
 * visible catcher is catcherInView (the catcher area clipped to the canvas
 * frustum; only with the shadow on). Parts of the catcher off the canvas or
 * behind the eye are not drawn, so they do not pull near down to 1 px (the
 * shimmer §3.7 step 2 is about). Depths are along the view axis, the way
 * the planes clip.
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
  const zc = projectWorld(c.pos, c)[2];
  let lo = zc - R;
  let hi = zc + R;
  if (s.p3.shadow.on) {
    for (const w of catcherInView(s, c)) {
      const z = toView(w, c)[2];
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
    }
  }
  return { near: Math.max(1, lo), far: hi + 1 };
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
 * [t − shutter/2, t + shutter/2], or over `win` when a pose break cuts it
 * (shutterWindow; the same window planSamples samples), in render pixels
 * (canvas px × renderScale). Pose only, so deterministic. Drives the adaptive
 * motion-blur count: measured across a break it would count the jump itself.
 */
export function hullTravelPx(p: SceneSource, t: number, shutterSec: number, renderScale = 1, canvas?: Size, win?: ShutterWindow | null): number {
  const s = asScene(p, canvas);
  if (!s || !(shutterSec > 0) || (win && !(win.hi > win.lo))) return 0;
  const pts = bodyPointsMm(s, true);
  let prev: [number, number][] | null = null;
  const dist = new Array(pts.length).fill(0);
  for (let k = 0; k <= TRAVEL_STEPS; k++) {
    const tt = win ? win.lo + ((win.hi - win.lo) * k) / TRAVEL_STEPS : t - shutterSec / 2 + (shutterSec * k) / TRAVEL_STEPS;
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
