// The procedural 3D phone (spec §3.3, D14). Everything is built from the
// public numbers in shared/devices.ts (body, screen, corner radius, buttons)
// and shared/devices3d.ts (depth, edge, camera plateau). No CAD, no Apple
// artwork, no logo: the back is blank.
//
// Units are millimetres. The phone is portrait, y up, the screen faces +z,
// and the body is centred on the origin, so the front glass lies on
// z = depth/2 (the plane projection.ts puts on the canvas at FRONT).
//
// Shape language:
// - The body outline is the continuous ("squircle") corner from
//   shared/phone3d/outline.ts, the same table the 2D frame draws with, so the
//   3D silhouette at FRONT is the 2D silhouette.
// - The band is a swept profile along that outline. Flat edges (12–16, the
//   iPads) have a straight wall and 0.35 mm 45° chamfers; a 0.1 mm fillet
//   of 3 rings sits on each chamfer edge, so a 1–2 px glint runs along it.
//   Rounded edges (17, Air, SE) are a quarter-ellipse per half, wall to
//   face, tangent-continuous at both ends: its z semi-axis is 0.45·depth, so
//   the side curves over 90% of each half; its inset semi-axis is all the
//   metal the 2D rim shows (rim − seam − a 0.06 mm land), because the front
//   glass starts at the rim and the band cannot inset further without
//   changing the FRONT silhouette. With about 0.7 mm of inset over about
//   4 mm of height the side is a gentle bow that tightens into a ~0.1 mm
//   round at the face (the ellipse's own end curvature a²/b, no separate
//   fillet). A circle of radius 0.45·depth would need an inset of 0.45·depth.
//   Normals are analytic (never averaged across a crease); every real
//   crease duplicates its ring. Tangents run along the outline for the
//   brushed-metal anisotropy.
// - A dark recessed seam separates the band from the glass on both faces.
//   The glass has a small rounded edge that drops into the seam.
// - The camera plateau is a swept footprint with a pillow edge; each lens
//   is a ring, a dark barrel seen from inside (its normals face the axis:
//   the same pixels as an outward cylinder drawn BackSide), a retaining
//   ring, three stacked element domes and a cover
//   glass, so the lens parallaxes when the phone turns.
// - Screen, glare and lens cover are overlay layers (depthWrite off, polygon
//   offset, fixed renderOrder; materials.ts sets those).
// - Rings of a sweep are the body outline moved inward along its normals
//   (not re-built as a (w−2i, h−2i, r−i) rect), so every ring has the same
//   points in the same order; for the insets used here (≤ 1.45 mm) the two
//   differ by under 0.025 mm. The outer ring IS the 2D outline (both tested).
// - The 17 Pro / Pro Max are an aluminium unibody: a metal back and plateau
//   with an inlaid Ceramic Shield panel (its size is an estimate, below).
// - The SE's home button, earpiece and camera and an iPad's bezel camera sit
//   outside the screen texture, so they are meshes here ('frontHardware').
//
// Each mesh carries `userData.part`; materials.ts `applyMaterials` maps
// parts to materials. Geometry is cached per device (LRU 3).

import {
  BufferGeometry,
  CircleGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  ShapeUtils,
  Vector2,
  type Material,
} from 'three';
import type { DeviceModel, SideButton } from '../../../shared/devices';
import type { Body3D } from '../../../shared/devices3d';
import { frameGeometry } from '../../../shared/deviceGeometry';
import { CONTINUOUS_CORNER, CORNER_EXTENT, clampCornerRadius, cornerFrames } from '../../../shared/phone3d/outline';

// ---------------------------------------------------------------------------
// Dimensions (mm). Each is a measured proportion or a stated estimate.

/** Chamfer on flat-edged bands (45°, front and back). */
export const CHAMFER_MM = 0.35;
/** Fillet on each chamfer edge; catches the 1–2 px glint (D14: 0.08–0.12). */
export const FILLET_MM = 0.1;
/** Rings in each fillet (D14: 2 or 3). */
export const FILLET_RINGS = 3;
/** Rounded edges: the profile's z semi-axis, as a fraction of depth (spec §3.3). */
export const ROUNDED_ARC = 0.45;
/** Rounded edges: the flat metal land between the curve's end and the seam. */
export const ROUNDED_LAND_MM = 0.06;
/** Seam between band and glass: width and depth (spec §3.3). */
export const SEAM_W_MM = 0.12;
export const SEAM_D_MM = 0.1;
/** The cover glass's rounded edge, mm across: a thin bright line round the front (about 2.5 px at 1080). Wider cuts into the
 *  screen hole on the narrowest bezels (iPhone 17, 16 Pro Max: 0.35 mm already does). */
export const GLASS_EDGE_MM = 0.3;
/** Antenna line width (along the outline). */
const ANTENNA_W_MM = 0.6;
/** Plateau: the shortest run of its filleted rise (a plateau with no measured inset still rolls onto its top). */
const PLATEAU_MIN_RUN_MM = 0.6;
/** Rings in the plateau's rise. */
const PLATEAU_RISE_RINGS = 14;
/** Lens assembly. */
const LENS_GLASS_FRAC = 0.83; // cover-glass radius / ring radius (round 3's 0.78 drew rings that read as thick toy bezels)
const LENS_RING_FILLET_MM = 0.1;
const LENS_BEVEL_MM = 0.25; // the cover glass sits this far below the ring top
const LENS_BARREL_MM = 1.5;
/** Inside a lens, as fractions of the cover-glass radius: the retaining ring's inner and outer radius (the hood fills outside it). */
export const LENS_RINGS = { retainer: [0.79, 0.83] } as const;
/** The lens elements' shading curvature: a dome this × its radius high (normals tilt up to 45° at the rim). */
export const LENS_DOME = 0.5;
/** Buttons. */
export const BUTTON_PROUD_MM = 0.55;
const BUTTON_EMBED_MM = 0.3;
/** The crown's inset run as a fraction of the button's width (the top stays flat over the middle 1 − 2·this). */
const BUTTON_CROWN = 0.32;
/** Camera Control: a sapphire strip nearly flush with the band (round 2's 0.28 mm crown read as a black slot). */
const CAMERA_CONTROL_PROUD_MM = 0.06;
/** The flash: a thin metal ring round a frosted diffuser that fills it (round 2's black 22% ring read as clip-art). */
const FLASH_LAMP_FRAC = 0.88;
/** The flash diffuser's Fresnel lens: this many fine concentric rings, a shade darker than the diffuser. */
const FLASH_FRESNEL_RINGS = 7;
/** Bottom edge: USB-C pill and grilles. */
const PORT_MM = { w: 8.3, h: 2.5 };
const GRILLE = { holes: 6, d: 0.95, pitch: 1.3, gap: 2.4 };
/** Decals sit this far proud of the surface they are on (plus polygon offset). */
const DECAL_LIFT_MM = 0.01;
/** Outline samples per corner (3 bezier spans; 12 per span). */
export const SEG_PER_CORNER = 36;
const CIRCLE_SEG = 64;

/**
 * Estimate (no Apple drawing gives it): the aluminium-unibody 17 Pro / Pro Max
 * has a Ceramic Shield panel inlaid in the back below the plateau, nearly edge
 * to edge: `margin` of metal from the body outline at the sides and bottom
 * (the band's rounded edge takes about 0.7 mm of it, so about 0.8 mm of flat
 * metal shows beside the glass: 7 px at 1080), `top` mm below the foot of
 * the plateau's step; its corners are concentric with the body's. Round 2's 7 mm
 * and round 3's 4.2 mm margins read as a sticker or a tray set into the back.
 */
const UNIBODY_PANEL = { margin: 1.5, top: 2.5 };
/** Rows across a full-width plateau's rise (shared by the band, its seam and the back). */
const RISE_ROWS = 32;
/**
 * A full-width plateau's step, in profile: a small concave fillet at its foot,
 * a steep straight wall and a larger convex fillet onto the top (look round 4).
 * Round 3's smootherstep over the measured 4.8 mm top inset was a soft ramp
 * whose long slope faced down and drew a wide dark band across the back (a
 * crease, a folded plate); a real machined step is a short wall whose rounded
 * top edge catches a thin line of light. `wall` is the wall's angle from the
 * back (degrees); the fillet radii are mm and shrink together when the step is
 * too low for them.
 */
export const PLATEAU_STEP = { wall: 70, footR: 0.3, topR: 0.7 } as const;

interface Rise {
  /** Model y where the rise leaves the back, and where it reaches the plateau top (y1 > y0). */
  y0: number;
  y1: number;
  /** The rows' y, y0 .. y1. */
  rows: number[];
  at(y: number): { dz: number; dzdy: number };
}

/**
 * The step profile (PLATEAU_STEP) for a height h: its run (mm across) and its
 * height dz and slope dz/ds at a distance s from the foot. Slope 0 at both
 * ends and tangent-continuous everywhere (arc, line, arc), so reflections run
 * off the back onto the wall and onto the top with no kink.
 */
export function stepProfile(h: number): { run: number; at(s: number): { dz: number; dzdy: number } } {
  const th = (PLATEAU_STEP.wall * Math.PI) / 180;
  const sin = Math.sin(th);
  const cos = Math.cos(th);
  const tan = Math.tan(th);
  // Arcs climb r(1 − cos θ) each; if they would climb past h, both shrink by the same factor.
  const k = Math.min(1, h / ((PLATEAU_STEP.footR + PLATEAU_STEP.topR) * (1 - cos)));
  const rf = PLATEAU_STEP.footR * k;
  const rt = PLATEAU_STEP.topR * k;
  const wallH = Math.max(0, h - (rf + rt) * (1 - cos));
  const s1 = rf * sin; // foot arc ends
  const s2 = s1 + wallH / tan; // wall ends
  const run = s2 + rt * sin;
  return {
    run,
    at(s) {
      const x = Math.min(run, Math.max(0, s));
      if (x <= s1) {
        const q = Math.sqrt(Math.max(1e-12, rf * rf - x * x));
        return { dz: rf - q, dzdy: x / q };
      }
      if (x <= s2) return { dz: rf * (1 - cos) + (x - s1) * tan, dzdy: tan };
      const e = run - x;
      const q = Math.sqrt(Math.max(1e-12, rt * rt - e * e));
      return { dz: h - rt + q, dzdy: e / q };
    },
  };
}

/** A full-width plateau's rise across the back: the step profile (stepProfile) from the foot of its footprint (model y0) up to the top. */
export function fullBarRise(H: number, pl: Body3D['plateau']): Rise {
  const y0 = H / 2 - (pl.y + pl.h) * H;
  const prof = stepProfile(pl.heightMm);
  const run = prof.run;
  return {
    y0,
    y1: y0 + run,
    rows: Array.from({ length: RISE_ROWS + 1 }, (_, k) => y0 + (run * k) / RISE_ROWS),
    at: (y) => prof.at(y - y0),
  };
}

/**
 * Splits the back's cap contour (cut at every rise row) into the part below
 * the rise, the part above it (the plateau top) and each row's x extent.
 */
function splitAtRise(contour: V2[], rise: Rise): { below: V2[]; above: V2[]; rows: [number, number, number][] } {
  const eps = 1e-6;
  const n = contour.length;
  const run = (inside: (y: number) => boolean): V2[] => {
    const ins = contour.map((q) => inside(q[1]));
    const starts = ins.flatMap((v, j) => (v && !ins[(j - 1 + n) % n] ? [j] : []));
    if (starts.length !== 1) throw new Error(`phone3d: the back splits into ${starts.length} parts at the plateau rise`);
    const out: V2[] = [];
    for (let k = 0; k < n && ins[(starts[0] + k) % n]; k++) out.push(contour[(starts[0] + k) % n]);
    return out;
  };
  const rows = rise.rows.map((y): [number, number, number] => {
    const xs = contour.filter((q) => Math.abs(q[1] - y) < eps).map((q) => q[0]);
    if (xs.length < 2) throw new Error(`phone3d: no back contour row at y = ${y}`);
    return [y, Math.min(...xs), Math.max(...xs)];
  });
  return { below: run((y) => y <= rise.y0 + eps), above: run((y) => y >= rise.y1 - eps), rows };
}
/** The unibody panel's seam: width and depth of the metal step round the glass (a fine line, under 1 px at 1080). */
const PANEL_SEAM_MM = 0.05;
/** The panel glass's rounded edge (a small bevel that catches light as it rises out of the seam). */
const PANEL_EDGE_MM = 0.12;

/** The panel glass edge: a quarter-ellipse from the seam floor (inset `seam`, depth `seam`) up onto the flat glass. */
function panelEdge(seam: number): Strip {
  const out: Strip = [];
  for (let k = 0; k <= 6; k++) {
    const a = (k / 6) * (Math.PI / 2);
    const n = norm2(seam * Math.cos(a), PANEL_EDGE_MM * Math.sin(a));
    out.push({ i: seam + PANEL_EDGE_MM * (1 - Math.cos(a)), z: -seam + seam * Math.sin(a), no: n[0], nz: n[1] });
  }
  return out;
}

export const RENDER_ORDER = { glass: 0, screen: 1, glare: 2, lensElements: 3, lensCover: 4, decal: 1 } as const;

export type PhonePart =
  | 'band'
  | 'seam'
  | 'frontGlass'
  | 'screen'
  | 'glare'
  | 'back'
  | 'backPanel'
  | 'plateau'
  | 'lensRing'
  | 'lensBarrel'
  | 'lensElements'
  | 'lensCover'
  | 'flash'
  | 'sensor'
  | 'mic'
  | 'button'
  | 'cameraControl'
  | 'port'
  | 'frontHardware';

export const PHONE_PARTS: readonly PhonePart[] = [
  'band', 'seam', 'frontGlass', 'screen', 'glare', 'back', 'backPanel', 'plateau', 'lensRing', 'lensBarrel',
  'lensElements', 'lensCover', 'flash', 'sensor', 'mic', 'button', 'cameraControl', 'port', 'frontHardware',
];

/** Material groups inside the band mesh. */
export const BAND_GROUP = { metal: 0, antenna: 1 } as const;
/** Material groups of the front hardware in the bezel (SE, iPads): glass lens, metal ring, dark grille. */
export const FRONT_GROUP = { lens: 0, ring: 1, grille: 2 } as const;
/** Material groups inside the lens-elements mesh: three element domes (top to bottom) and the retaining ring. */
export const LENS_GROUP = { element0: 0, element1: 1, element2: 2, retainer: 3, hood: 4 } as const;
/** Material groups inside the flash mesh. */
export const FLASH_GROUP = { ring: 0, lamp: 1, fresnel: 2 } as const;
/** frontGlass material groups: the flat sheet (border round the screen) and its rounded rim. */
export const FRONT_GLASS_GROUP = { flat: 0, rim: 1 } as const;

/** The measured layout the meshes were built from, for tests and the renderer. */
export interface PhoneDims {
  bodyW: number;
  bodyH: number;
  depth: number;
  bodyRadius: number;
  rim: number;
  screenW: number;
  screenH: number;
  screenRadius: number;
  edge: Body3D['edge'];
  unibody: boolean;
  /** z of the plateau top and of the lens ring tops (negative: the back is −z). */
  plateauTopZ: number;
  lensTopZ: number;
  /** Profile z values where a hard crease duplicates a ring (front half; the back mirrors them). */
  creaseZ: number[];
}

// ---------------------------------------------------------------------------
// 2D loops: CCW points (y up) with unit tangents (direction of travel).

type V2 = [number, number];
interface Loop {
  p: V2[];
  t: V2[];
}

const norm2 = (x: number, y: number): V2 => {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
};
/** Outward normal of a CCW loop at a point with tangent t. */
const outwardOf = (t: V2): V2 => [t[1], -t[0]];

const bez = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};
const bezD = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return 3 * (u * u * (b - a) + 2 * u * t * (c - b) + t * t * (d - c));
};

/**
 * The continuous-corner rect of w × h centred on the origin, with its own
 * radius per corner (y-up order: bottom-right, top-right, top-left,
 * bottom-left). With four equal radii the points are exactly
 * continuousRectPoints(w, h, r, segPerCorner): the 2D frame's outline.
 */
export function rectLoop(w: number, h: number, radii: number | readonly [number, number, number, number], segPerCorner = SEG_PER_CORNER): Loop {
  const rs = typeof radii === 'number' ? [radii, radii, radii, radii] : radii;
  const corners = cornerFrames(-w / 2, -h / 2, w, h);
  const perSpan = Math.max(1, Math.round(segPerCorner / 3));
  const p: V2[] = [];
  const t: V2[] = [];
  const push = (q: V2, tq: V2) => {
    const last = p[p.length - 1];
    if (last && Math.abs(last[0] - q[0]) < 1e-12 && Math.abs(last[1] - q[1]) < 1e-12) return;
    p.push(q);
    t.push(tq);
  };
  const at = (ci: number, a: number, b: number): V2 => {
    const c = corners[ci];
    const r = clampCornerRadius(w, h, rs[ci]);
    return [c[0] + (c[2] * a + c[4] * b) * r, c[1] + (c[3] * a + c[5] * b) * r];
  };
  // Start where continuousRectCommands starts: on the edge before corner 0.
  let cur = at(3, 0, CORNER_EXTENT);
  push(cur, [1, 0]);
  for (let ci = 0; ci < 4; ci++) {
    for (const cmd of CONTINUOUS_CORNER) {
      if (cmd[0] === 'L') {
        const q = at(ci, cmd[1], cmd[2]);
        const d = norm2(q[0] - cur[0], q[1] - cur[1]);
        if (Math.hypot(q[0] - cur[0], q[1] - cur[1]) > 1e-12) push(q, d);
        cur = q;
      } else {
        const c1 = at(ci, cmd[1], cmd[2]);
        const c2 = at(ci, cmd[3], cmd[4]);
        const q = at(ci, cmd[5], cmd[6]);
        for (let k = 1; k <= perSpan; k++) {
          const s = k / perSpan;
          push(
            [bez(cur[0], c1[0], c2[0], q[0], s), bez(cur[1], c1[1], c2[1], q[1], s)],
            norm2(bezD(cur[0], c1[0], c2[0], q[0], s), bezD(cur[1], c1[1], c2[1], q[1], s)),
          );
        }
        cur = q;
      }
    }
  }
  // The path closes onto its start.
  const f = p[0];
  const l = p[p.length - 1];
  if (p.length > 1 && Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) {
    p.pop();
    t.pop();
  }
  return { p, t };
}

/** A stadium (two semicircle ends on the long axis), centred, CCW. */
export function stadiumLoop(w: number, h: number, seg = CIRCLE_SEG / 2): Loop {
  if (w > h) {
    const v = stadiumLoop(h, w, seg);
    // Rotate +90° (keeps CCW): (x, y) → (−y, x).
    return { p: v.p.map(([x, y]) => [-y, x]), t: v.t.map(([x, y]) => [-y, x]) };
  }
  const r = w / 2;
  const a = h / 2 - r;
  const p: V2[] = [];
  const t: V2[] = [];
  for (const [cy, a0] of [[a, 0], [-a, Math.PI]] as const) {
    for (let k = 0; k <= seg; k++) {
      const th = a0 + (Math.PI * k) / seg;
      p.push([r * Math.cos(th), cy + r * Math.sin(th)]);
      t.push([-Math.sin(th), Math.cos(th)]);
    }
  }
  if (a < 1e-9) {
    // A circle: drop the duplicated joins.
    return circleLoop(r, seg * 2);
  }
  return { p, t };
}

export function circleLoop(r: number, seg = CIRCLE_SEG): Loop {
  const p: V2[] = [];
  const t: V2[] = [];
  for (let k = 0; k < seg; k++) {
    const th = (2 * Math.PI * k) / seg;
    p.push([r * Math.cos(th), r * Math.sin(th)]);
    t.push([-Math.sin(th), Math.cos(th)]);
  }
  return { p, t };
}

/** The loop moved inward by `d` along its normals (uniform, or one value per point). */
export function insetLoop(loop: Loop, d: number | readonly number[]): V2[] {
  return loop.p.map((q, j) => {
    const n = outwardOf(loop.t[j]);
    const dj = typeof d === 'number' ? d : d[j];
    return [q[0] - n[0] * dj, q[1] - n[1] * dj];
  });
}

/** Insert a point wherever an edge crosses one of the horizontal lines y = c (strictly). */
function cutLoop(loop: Loop, ys: readonly number[]): Loop {
  const p: V2[] = [];
  const t: V2[] = [];
  const n = loop.p.length;
  for (let j = 0; j < n; j++) {
    const a = loop.p[j];
    const b = loop.p[(j + 1) % n];
    p.push(a);
    t.push(loop.t[j]);
    const cuts = ys
      .filter((c) => (a[1] - c) * (b[1] - c) < 0)
      .map((c) => (c - a[1]) / (b[1] - a[1]))
      .sort((x, y) => x - y);
    for (const s of cuts) {
      const ta = loop.t[j];
      const tb = loop.t[(j + 1) % n];
      p.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]);
      t.push(norm2(ta[0] + (tb[0] - ta[0]) * s, ta[1] + (tb[1] - ta[1]) * s));
    }
  }
  return { p, t };
}

// ---------------------------------------------------------------------------
// Profiles: (z, inset) samples with analytic normals (outward, z) components.

interface PP {
  z: number;
  i: number;
  no: number;
  nz: number;
}
type Strip = PP[];

/**
 * The rise of a full-width camera plateau as a function of model y (spec §3.3): the body grows back by `dz` at
 * height y, with slope dz/dy. `side` is the back's z sign in the frame being built (−1 in model space, +1 in the
 * back frame): only points on that side of z = 0 move.
 */
interface Lift {
  side: 1 | -1;
  at(y: number): { dz: number; dzdy: number };
}

/** Arc of radius r around centre (ci, cz) in (inset, z), normal angle from a0 to a1 (0 = outward, 90° = +z), convex. */
function convexArc(ci: number, cz: number, r: number, a0: number, a1: number, n: number): Strip {
  const out: Strip = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n;
    out.push({ i: ci - r * Math.cos(a), z: cz + r * Math.sin(a), no: Math.cos(a), nz: Math.sin(a) });
  }
  return out;
}

/** Mirror a strip through z = 0 (front half → back half). */
const mirrorStrip = (s: Strip): Strip => s.map((q) => ({ z: -q.z, i: q.i, no: q.no, nz: -q.nz }));

/**
 * The rounded band's quarter-ellipse in (inset, z), centred at (a, z0): from
 * the wall (inset 0, z0, normal outward) to the face (inset a, z0 + b,
 * normal +z). b = 0.45·depth; a = the rim's metal less the land.
 */
export function roundedEllipse(depth: number, rim: number) {
  const b = ROUNDED_ARC * depth;
  const a = Math.max(0.05, rim - SEAM_W_MM - ROUNDED_LAND_MM);
  return { a, b, z0: depth / 2 - b };
}

/**
 * Samples of the quarter-ellipse i = a(1 − cos t), z = z0 + b·sin t, with
 * the analytic normal ∝ (b·cos t, a·sin t). With b ≫ a the normal turns
 * slowly along the side and fast at the face, so samples are the union of
 * even steps in t (for the silhouette along z) and even steps in the normal
 * angle (≤ 7.5° apart, for smooth shading at the face).
 */
function ellipseStrip(a: number, b: number, z0: number): Strip {
  const N = 12;
  const ts: number[] = [];
  for (let k = 0; k <= N; k++) {
    ts.push((k / N) * (Math.PI / 2));
    // Normal angle θ = atan((a/b)·tan t)  ⇒  t = atan((b/a)·tan θ).
    const th = (k / N) * (Math.PI / 2);
    ts.push(k === N ? Math.PI / 2 : Math.atan((b / a) * Math.tan(th)));
  }
  ts.sort((x, y) => x - y);
  const out: Strip = [];
  for (const t of ts) {
    const [no, nz] = norm2(b * Math.cos(t), a * Math.sin(t));
    const q: PP = { i: a * (1 - Math.cos(t)), z: z0 + b * Math.sin(t), no, nz };
    const prev = out[out.length - 1];
    // Two samples that nearly coincide in both height and normal add a ring and nothing else.
    if (prev && q.z - prev.z < 0.03 && Math.abs(Math.atan2(q.nz, q.no) - Math.atan2(prev.nz, prev.no)) < Math.PI / 180) {
      if (t === Math.PI / 2) out[out.length - 1] = q; // keep the exact end
      continue;
    }
    out.push(q);
  }
  return out;
}

/**
 * The band's front half, wall to lip, plus the seam. Returns the band strips
 * (continuous normals inside each strip), the seam strips, where the glass
 * starts, and the crease z values.
 */
function bandProfile(edge: Body3D['edge'], depth: number, rim: number) {
  const d2 = depth / 2;
  const lipEnd = rim - SEAM_W_MM;
  const band: Strip[] = [];
  const deg = Math.PI / 180;
  if (edge === 'flat') {
    // Wall → fillet → 45° chamfer → fillet → lip. Fillet tangent length f·tan(22.5°).
    const f = FILLET_MM;
    const tl = f * Math.tan(22.5 * deg);
    const c = CHAMFER_MM;
    // Corner 1 at (i 0, z d2 − c); corner 2 at (i c, z d2).
    const f1 = convexArc(f, d2 - c - tl, f, 0, 45 * deg, FILLET_RINGS);
    // Fillet 2: centre sits f inside the lip plane and f inside the chamfer line.
    const c2z = d2 - f;
    const c2i = c + tl;
    const f2 = convexArc(c2i, c2z, f, 45 * deg, 90 * deg, FILLET_RINGS);
    const wall: PP[] = [{ z: 0, i: 0, no: 1, nz: 0 }];
    const strip: Strip = [...wall, ...f1, ...f2, { z: d2, i: lipEnd, no: 0, nz: 1 }];
    // The 45° chamfer is the straight span from f1's end to f2's start.
    band.push(strip);
  } else {
    // Short flat middle → quarter-ellipse → land → lip, tangent-continuous.
    const { a, b, z0 } = roundedEllipse(depth, rim);
    band.push([{ z: 0, i: 0, no: 1, nz: 0 }, ...ellipseStrip(a, b, z0).slice(z0 > 1e-6 ? 0 : 1), { z: d2, i: lipEnd, no: 0, nz: 1 }]);
  }
  // Seam: lip edge drops (normal inward), floor (normal +z), then the glass
  // edge rises and rounds onto the flat glass. Hard creases between them.
  const seamTop = d2;
  const seamFloor = d2 - SEAM_D_MM;
  const seam: Strip[] = [
    [
      { z: seamTop, i: lipEnd, no: -1, nz: 0 },
      { z: seamFloor, i: lipEnd, no: -1, nz: 0 },
    ],
    [
      { z: seamFloor, i: lipEnd, no: 0, nz: 1 },
      { z: seamFloor, i: rim, no: 0, nz: 1 },
    ],
  ];
  // Glass edge: from the seam floor at `rim`, a quarter-ellipse up to the flat glass.
  const ge = GLASS_EDGE_MM;
  const glassEdge: Strip = [];
  for (let k = 0; k <= 6; k++) {
    const a = (k / 6) * (Math.PI / 2);
    // inset = rim + ge·(1 − cos a); z = seamFloor + SEAM_D·sin a; normal ∝ (SEAM_D·cos a, ge·sin a)
    const n = norm2(SEAM_D_MM * Math.cos(a), ge * Math.sin(a));
    glassEdge.push({ i: rim + ge * (1 - Math.cos(a)), z: seamFloor + SEAM_D_MM * Math.sin(a), no: n[0], nz: n[1] });
  }
  return { band, seam, glassEdge, glassInset: rim + ge, creaseZ: [seamTop, seamFloor] };
}

// ---------------------------------------------------------------------------
// Mesh building

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  tan: number[] = [];
  uv: number[] = [];
  groups: number[][] = [];
  withUv = false;

  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, tx = 1, ty = 0, tz = 0, u = 0, w = 0): number {
    const nl = Math.hypot(nx, ny, nz) || 1;
    const tl = Math.hypot(tx, ty, tz) || 1;
    this.pos.push(x, y, z);
    this.nrm.push(nx / nl, ny / nl, nz / nl);
    this.tan.push(tx / tl, ty / tl, tz / tl, 1);
    this.uv.push(u, w);
    return this.pos.length / 3 - 1;
  }

  /** Triangle a-b-c, flipped if its winding disagrees with the vertex normals. */
  tri(a: number, b: number, c: number, group = 0) {
    const P = this.pos;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const wx = P[c * 3] - ax, wy = P[c * 3 + 1] - ay, wz = P[c * 3 + 2] - az;
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    const area = Math.hypot(cx, cy, cz);
    if (area < 1e-14) return; // degenerate (a collapsed ring)
    const N = this.nrm;
    const sx = N[a * 3] + N[b * 3] + N[c * 3];
    const sy = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1];
    const sz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    const g = (this.groups[group] ??= []);
    if (cx * sx + cy * sy + cz * sz >= 0) g.push(a, b, c);
    else g.push(a, c, b);
  }

  geometry(): BufferGeometry {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('tangent', new Float32BufferAttribute(this.tan, 4));
    if (this.withUv) geo.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    const index: number[] = [];
    this.groups.forEach((g, gi) => {
      if (!g || g.length === 0) return;
      geo.addGroup(index.length, g.length, gi);
      index.push(...g);
    });
    geo.setIndex(index);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
}

/**
 * Sweep profile strips along a loop. Each strip gets its own rings, so
 * strips meet at hard creases. `groupOf(j)` picks the material group of the
 * faces between loop points j and j+1; `lift` moves the back side's points
 * back by a full-width plateau's rise.
 */
function sweep(
  b: Builder,
  loop: Loop,
  strips: Strip[],
  opts: { groupOf?: (j: number) => number; z0?: number; lift?: Lift } = {},
) {
  const n = loop.p.length;
  const z0 = opts.z0 ?? 0;
  const lift = opts.lift;
  for (const strip of strips) {
    const ring: number[][] = [];
    for (const q of strip) {
      const row: number[] = [];
      for (let j = 0; j < n; j++) {
        const t = loop.t[j];
        const o = outwardOf(t);
        const nn = norm2(q.no, q.nz);
        const x = loop.p[j][0] - o[0] * q.i;
        const y = loop.p[j][1] - o[1] * q.i;
        let z = z0 + q.z;
        let nx = o[0] * nn[0];
        let ny = o[1] * nn[0];
        const nz = nn[1];
        let tz = 0;
        // A lifted point (on the back side of the body) moves back by the plateau rise at its height; its normal
        // takes the rise's slope along the outline and its tangent climbs with it (exact on a straight side: the
        // surface is sheared along y).
        if (lift && lift.side * z > 1e-9) {
          const r = lift.at(y);
          z += lift.side * r.dz;
          const k = -r.dzdy * t[1] * nz * lift.side;
          nx += k * t[0];
          ny += k * t[1];
          tz = lift.side * r.dzdy * t[1];
        }
        row.push(b.v(x, y, z, nx, ny, nz, t[0], t[1], tz));
      }
      ring.push(row);
    }
    for (let k = 0; k + 1 < ring.length; k++) {
      for (let j = 0; j < n; j++) {
        const j2 = (j + 1) % n;
        const g = opts.groupOf ? opts.groupOf(j) : 0;
        b.tri(ring[k][j], ring[k][j2], ring[k + 1][j], g);
        b.tri(ring[k][j2], ring[k + 1][j2], ring[k + 1][j], g);
      }
    }
  }
}

/** A flat cap over a polygon (with optional holes) at height z, facing ±z. */
function cap(b: Builder, contour: V2[], z: number, facing: 1 | -1, holes: V2[][] = [], uvRect?: { x: number; y: number; w: number; h: number }, group = 0) {
  const c = contour.map(([x, y]) => new Vector2(x, y));
  const hs = holes.map((h) => h.map(([x, y]) => new Vector2(x, y)));
  const faces = ShapeUtils.triangulateShape(c, hs);
  const all = [...contour, ...holes.flat()];
  const base = all.map(([x, y]) =>
    b.v(x, y, z, 0, 0, facing, 1, 0, 0, uvRect ? (x - uvRect.x) / uvRect.w : 0, uvRect ? (y - uvRect.y) / uvRect.h : 0),
  );
  for (const [i, j, k] of faces) b.tri(base[i], base[j], base[k], group);
}

/** Merge builder output into a mesh with its part tag. */
function partMesh(part: PhonePart, b: Builder, renderOrder = 0): Mesh | null {
  if (b.pos.length === 0) return null;
  const m = new Mesh(b.geometry(), PLACEHOLDER);
  m.name = part;
  m.userData.part = part;
  m.renderOrder = renderOrder;
  return m;
}

/** Shared stand-in until applyMaterials runs (never rendered by itself). */
const PLACEHOLDER: Material[] = [];

/** Apply a matrix to everything a builder has so far (positions, normals, tangents). */
function transformBuilder(b: Builder, from: number, m: Matrix4) {
  const e = m.elements;
  for (let v = from; v < b.pos.length / 3; v++) {
    const x = b.pos[v * 3], y = b.pos[v * 3 + 1], z = b.pos[v * 3 + 2];
    b.pos[v * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
    b.pos[v * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    b.pos[v * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    // Rotations only (orthonormal): normals and tangents transform like directions.
    for (const arr of [b.nrm, b.tan]) {
      const s = arr === b.tan ? 4 : 3;
      const ax = arr[v * s], ay = arr[v * s + 1], az = arr[v * s + 2];
      arr[v * s] = e[0] * ax + e[4] * ay + e[8] * az;
      arr[v * s + 1] = e[1] * ax + e[5] * ay + e[9] * az;
      arr[v * s + 2] = e[2] * ax + e[6] * ay + e[10] * az;
    }
  }
}

// ---------------------------------------------------------------------------
// Parts

/**
 * A capsule button: stadium outline in its own plane, swept outward along a
 * crowned profile (a quarter-ellipse from the wall to the top, its inset
 * semi-axis BUTTON_CROWN of the width), so the top is a gentle dome that
 * sweeps through the studio like the band does. A flat-topped pill mirrored
 * one patch of the studio and read lighter and glossier than the frame.
 */
function buildButton(b: Builder, length: number, width: number, proud: number, place: Matrix4) {
  const from = b.pos.length / 3;
  // Local: stadium in xy (x = across the band depth, y = along its length), sweep +z outward.
  const loop = stadiumLoop(width, length, 16);
  const ai = width * BUTTON_CROWN;
  const steps = 8;
  const crown: Strip = [{ z: -BUTTON_EMBED_MM, i: 0, no: 1, nz: 0 }];
  for (let k = 0; k <= steps; k++) {
    const t = (k / steps) * (Math.PI / 2);
    const n = norm2(proud * Math.cos(t), ai * Math.sin(t));
    crown.push({ i: ai * (1 - Math.cos(t)), z: proud * Math.sin(t), no: n[0], nz: n[1] });
  }
  sweep(b, loop, [crown]);
  cap(b, insetLoop(loop, ai), proud, 1);
  transformBuilder(b, from, place);
}

/** Rotation + translation that maps a button's local frame onto the body. */
function buttonPlacement(btn: SideButton, W: number, H: number): { m: Matrix4; length: number } {
  const m = new Matrix4();
  if (btn.kind === 'top') {
    // Top edge: `top` and `length` are fractions of body width from the left (front view).
    const length = btn.length * W;
    const xc = -W / 2 + (btn.top + btn.length / 2) * W;
    // local z → +Y, local y → +X, local x → +Z.
    m.set(0, 1, 0, xc, 0, 0, 1, H / 2, 1, 0, 0, 0, 0, 0, 0, 1);
    return { m, length };
  }
  const length = btn.length * H;
  const yc = H / 2 - (btn.top + btn.length / 2) * H;
  if (btn.side === 'right') {
    // local z → +X, local y → +Y, local x → −Z.
    m.set(0, 0, 1, W / 2, 0, 1, 0, yc, -1, 0, 0, 0, 0, 0, 0, 1);
  } else {
    // local z → −X, local y → +Y, local x → +Z.
    m.set(0, 0, -1, -W / 2, 0, 1, 0, yc, 1, 0, 0, 0, 0, 0, 0, 1);
  }
  return { m, length };
}

/** Back frame (the back seen from behind, y up, z out of the back) → model: a half turn about y. */
const BACK_TO_MODEL = new Matrix4().makeRotationY(Math.PI);

interface BackFrame {
  /** Back-view mm (from the back's top-left as seen from behind) → back-frame xy. */
  xy(bx: number, by: number): V2;
}

/**
 * A plateau (or turret) footprint, swept up from the back surface along a
 * filleted rise: z = h·(3u² − 2u³) over the inset run u ∈ 0..1, so it leaves
 * the back with a concave fillet, is steepest (1.5·h/run) halfway, and rolls
 * onto the flat top with a convex one; its normal never faces down. Round 1
 * rose with a vertical wall under a quarter-ellipse: the wall faced the floor
 * and drew a black undercut band, so the plateau looked glued on. The run is
 * the measured top inset (devices3d insetMm), at least PLATEAU_MIN_RUN_MM.
 */
function buildPlateau(b: Builder, loop: Loop, zBack: number, heightMm: number, insetMm: number, holes: V2[][] = []) {
  const a = Math.max(insetMm, PLATEAU_MIN_RUN_MM, heightMm * 0.9);
  const strip: Strip = [];
  const steps = PLATEAU_RISE_RINGS;
  for (let k = 0; k <= steps; k++) {
    const u = k / steps;
    const z = heightMm * u * u * (3 - 2 * u);
    // dz/di = 6h·u(1 − u)/a; outward normal ∝ (dz/di, 1) in (outward, z).
    const slope = (6 * heightMm * u * (1 - u)) / a;
    const n = norm2(slope, 1);
    strip.push({ i: a * u, z, no: n[0], nz: n[1] });
  }
  sweep(b, loop, [strip], { z0: zBack });
  cap(b, insetLoop(loop, a), zBack + heightMm, 1, holes);
}

interface LensBuild {
  ring: Builder;
  barrel: Builder;
  elements: Builder;
  cover: Builder;
}

interface LensSpec {
  /** Back-frame centre. */
  x: number;
  y: number;
  /** Outer radius of the metal ring; 0 = no ring (the lens sits in a turret's top). */
  ringR: number;
  /** Cover-glass (and barrel) radius. */
  glassR: number;
  /** The surface the lens stands on (back-frame z). */
  zBase: number;
  /** How far the ring top stands above zBase (0 without a ring). */
  proud: number;
  /** Deepest the barrel may go below the cover glass (stays inside the solid under it). */
  maxDepth: number;
}

/**
 * One lens: a metal ring (outer wall, 0.1 mm top fillet, flat top, an inner
 * bevel down to the glass), a dark barrel whose inside we see, three
 * stacked element domes (one material group each, rougher further down)
 * and a cover glass at the top of the barrel. The elements sit at
 * different depths, so the lens parallaxes as the phone turns.
 */
function buildLens(L: LensBuild, s: LensSpec) {
  const { x, y, ringR, glassR, zBase, proud } = s;
  const top = zBase + proud;
  const ringed = ringR > 0 && proud > 0;
  const coverZ = ringed ? top - Math.min(LENS_BEVEL_MM, proud * 0.25 + 0.05) : top - 0.15;
  const barrelTop = ringed ? coverZ : top;
  const at = (loop: Loop): Loop => ({ p: loop.p.map(([px, py]) => [px + x, py + y]), t: loop.t });
  if (ringed) {
    const outer = at(circleLoop(ringR));
    const f = Math.min(LENS_RING_FILLET_MM, proud * 0.3);
    const wall: Strip = [{ z: 0, i: 0, no: 1, nz: 0 }, ...convexArc(f, proud - f, f, 0, Math.PI / 2, 3)];
    const bevelW = ringR - f - glassR;
    const flat: Strip = [
      { z: proud, i: f, no: 0, nz: 1 },
      { z: proud, i: f + bevelW * 0.45, no: 0, nz: 1 },
    ];
    const drop = top - coverZ;
    const n = norm2(-drop, bevelW * 0.55);
    const slope: Strip = [
      { z: proud, i: f + bevelW * 0.45, no: n[0], nz: n[1] },
      { z: proud - drop, i: ringR - glassR, no: n[0], nz: n[1] },
    ];
    sweep(L.ring, outer, [wall, flat, slope], { z0: zBase });
  }
  const depth = Math.max(0.2, Math.min(LENS_BARREL_MM, s.maxDepth));
  const bottom = coverZ - depth;
  const bLoop = at(circleLoop(glassR));
  // The barrel's normals point at its axis: we only ever see its inside.
  sweep(L.barrel, bLoop, [[
    { z: barrelTop, i: 0, no: -1, nz: 0 },
    { z: bottom, i: 0, no: -1, nz: 0 },
  ]]);
  cap(L.barrel, bLoop.p, bottom, 1);
  // Three stacked coated elements, each a dome steep enough that a softbox reflects in it as a small coloured
  // crescent, not a tint over the whole disc (round 3's shallow top element turned every lens one flat violet).
  const fr = [0.25, 0.52, 0.8];
  const rr = [0.78, 0.6, 0.42];
  fr.forEach((fz, gi) => {
    const r = glassR * rr[gi];
    const zc = coverZ - depth * fz;
    // A curved element mirrors a spread of the studio: the key lands as a small catchlight near its top instead
    // of the element reading as a flat disc. Its crown stays under the one above it (and under the cover).
    const sag = Math.min(r * 0.45, depth * fz * 0.85);
    // The barrel is only about 1.5 mm deep, so the domes are nearly flat (sag/r about 0.06) and mirrored a softbox
    // edge as one straight line across a flat violet disc. Shading uses the curvature of a dome LENS_DOME × r high
    // (its normals tilt up to atan(2·LENS_DOME) at the rim); the geometry keeps its true depth.
    const shadeSag = r * LENS_DOME;
    const rings = 8;
    const seg = 48;
    const idx: number[][] = [];
    for (let k = 0; k <= rings; k++) {
      const rk = (r * k) / rings;
      const zk = zc + sag * (1 - (rk / r) ** 2);
      // Dome z = sag·(1 − (ρ/r)²); the shading normal's slope is the shading dome's, −2·shadeSag·ρ/r².
      const slope = (2 * shadeSag * rk) / (r * r);
      const row: number[] = [];
      for (let q = 0; q < (k === 0 ? 1 : seg); q++) {
        const th = (2 * Math.PI * q) / seg;
        row.push(L.elements.v(x + rk * Math.cos(th), y + rk * Math.sin(th), zk, slope * Math.cos(th), slope * Math.sin(th), 1, -Math.sin(th), Math.cos(th), 0));
      }
      idx.push(row);
    }
    for (let k = 1; k <= rings; k++) {
      for (let q = 0; q < seg; q++) {
        const q2 = (q + 1) % seg;
        if (k === 1) L.elements.tri(idx[0][0], idx[1][q], idx[1][q2], gi);
        else {
          L.elements.tri(idx[k - 1][q], idx[k][q], idx[k][q2], gi);
          L.elements.tri(idx[k - 1][q], idx[k][q2], idx[k - 1][q2], gi);
        }
      }
    }
  });
  // Under the cover glass, from the outside in: a matte black hood (the lens housing's face), a thin dark metal
  // retaining ring (the first fine ring the eye reads inside a real lens), then the deep optics.
  const rz = coverZ - Math.min(0.12, depth * 0.1);
  const ringAt = (k: number) => at(circleLoop(glassR * k)).p;
  cap(L.elements, ringAt(0.995), rz, 1, [ringAt(LENS_RINGS.retainer[1]).slice().reverse()], undefined, LENS_GROUP.hood);
  const rz2 = rz - Math.min(0.05, depth * 0.04);
  cap(L.elements, ringAt(LENS_RINGS.retainer[1]), rz2, 1, [ringAt(LENS_RINGS.retainer[0]).slice().reverse()], undefined, LENS_GROUP.retainer);
  cap(L.cover, bLoop.p, coverZ, 1);
}

/** A flat disc decal at back-frame (x, y), height z (facing +z). */
function disc(b: Builder, x: number, y: number, r: number, z: number, group = 0, seg = 40) {
  cap(b, circleLoop(r, seg).p.map(([px, py]) => [px + x, py + y]), z, 1, [], undefined, group);
}

// ---------------------------------------------------------------------------
// The phone

export interface PhoneModel {
  group: Group;
  dims: PhoneDims;
  /** Total triangles (instances counted). */
  triangles: number;
}

/** Body, screen and corner radii in mm, exactly as the 2D frame computes them. */
export function phoneDims2d(device: DeviceModel) {
  const W = device.bodyMm.width;
  const H = device.bodyMm.height;
  const g = frameGeometry({ x: 0, y: 0, w: W, h: H }, device, { orientation: 'portrait' });
  return { W, H, bodyRadius: g.bodyRadius, screenW: g.screenW, screenH: g.screenH, screenRadius: g.screenRadius, rim: device.rimMm };
}

/** The 17 Pro / Pro Max: aluminium unibody, metal back and plateau, glass inlay. */
export function isUnibody(device: DeviceModel, body: Body3D): boolean {
  return body.plateau.kind === 'bar' && device.material === 'aluminum' && device.family === 'iphone';
}

/**
 * A new phone for a device, not cached: the caller owns it and disposes it
 * (disposePhone). The engine's own LRU holds these; phoneModel below is the
 * cached form for tools.
 */
export function createPhone(device: DeviceModel, body: Body3D): PhoneModel {
  const { W, H, bodyRadius, screenW, screenH, screenRadius, rim } = phoneDims2d(device);
  const depth = body.depthMm;
  const d2 = depth / 2;
  const unibody = isUnibody(device, body);
  const group = new Group();
  group.name = `phone3d:${device.id}`;
  const add = (m: Mesh | null) => m && group.add(m);

  // --- Band (+ antenna lines), seams, glass edges --------------------------------
  // A full-width camera plateau (17 Pro, Pro Max, Air) is part of the body: across the top of the back the whole
  // body is `heightMm` deeper, so the band's back half, its seam and glass edge move back with it and the plateau's
  // sides ARE the band. Its lower edge is one rise across the full width (fullBarRise), a smoothstep over the
  // measured top inset; the outline is cut at every row of the rise, so the band, the step and the back share
  // vertices there.
  const pl = body.plateau;
  const fullBar = pl.kind !== 'single' && (pl.kind === 'bar' || pl.w > 0.98);
  const rise = fullBar ? fullBarRise(H, pl) : null;
  const lift = (side: 1 | -1): Lift | undefined => (rise ? { side, at: rise.at } : undefined);
  const outline = rectLoop(W, H, bodyRadius);
  const antennaYs = body.antennaLines.flatMap((f) => {
    const yc = H / 2 - f * H;
    return [yc - ANTENNA_W_MM / 2, yc + ANTENNA_W_MM / 2];
  });
  const bandLoop = cutLoop(outline, [...antennaYs, ...(rise?.rows ?? [])]);
  const isAntenna = (j: number) => {
    const a = bandLoop.p[j];
    const c = bandLoop.p[(j + 1) % bandLoop.p.length];
    const ym = (a[1] + c[1]) / 2;
    return body.antennaLines.some((f) => Math.abs(ym - (H / 2 - f * H)) < ANTENNA_W_MM / 2);
  };
  const prof = bandProfile(body.edge, depth, rim);
  const band = new Builder();
  sweep(band, bandLoop, [...prof.band, ...prof.band.map(mirrorStrip)], {
    groupOf: (j) => (isAntenna(j) ? BAND_GROUP.antenna : BAND_GROUP.metal),
    lift: lift(-1),
  });
  add(partMesh('band', band));

  const seam = new Builder();
  sweep(seam, outline, prof.seam); // front
  if (!unibody) sweep(seam, bandLoop, prof.seam.map(mirrorStrip), { lift: lift(-1) }); // back
  add(partMesh('seam', seam));

  // Screen and glare: the 2D screen outline ON the glass plane (z = depth/2,
  // where projection.ts puts the screen quad, so FRONT is exact).
  const screenLoop = rectLoop(screenW, screenH, screenRadius);

  // Front glass: rounded edge into the seam, then the flat cap: the black
  // border AROUND the screen. The screen's own outline is a hole in it, so no
  // glass lies under the screen: two coplanar surfaces with different
  // triangles z-fight at small turns (the polygon offset's few depth units
  // cannot cover their interpolation difference), and showed as black blocks
  // over the screen at turn 0.02°. The hole shares the screen's vertices, so
  // the two meet with no crack.
  const glassContour = insetLoop(outline, prof.glassInset);
  const front = new Builder();
  sweep(front, outline, [prof.glassEdge], { groupOf: () => FRONT_GLASS_GROUP.rim });
  cap(front, glassContour, d2, 1, [screenLoop.p], undefined, FRONT_GLASS_GROUP.flat);
  add(partMesh('frontGlass', front, RENDER_ORDER.glass));

  // The screen and the glare over it are the same triangles (the same cap of
  // the same points), so their depths are equal and the glare passes LEQUAL.
  const screen = new Builder();
  screen.withUv = true;
  cap(screen, screenLoop.p, d2, 1, [], { x: -screenW / 2, y: -screenH / 2, w: screenW, h: screenH });
  add(partMesh('screen', screen, RENDER_ORDER.screen));
  const glare = new Builder();
  cap(glare, screenLoop.p, d2, 1);
  add(partMesh('glare', glare, RENDER_ORDER.glare));

  // Front hardware that sits in the bezel, outside the screen texture (the
  // island and notch are drawn into the screen by drawCutouts): the SE's
  // earpiece, camera and home button, an iPad's bezel camera. Same
  // positions and sizes as deviceFrame.ts drawFrontHardware (y flipped).
  const hw = new Builder();
  const zf = d2 + DECAL_LIFT_MM;
  const topBezelMid = (H / 2 - rim + screenH / 2) / 2; // halfway between the glass's top edge and the screen's
  if (device.homeButton) {
    const ew = W * 0.14;
    const eh = 1.1;
    cap(hw, stadiumLoop(ew, eh, 8).p.map(([x, y]): V2 => [x, y + topBezelMid]), zf, 1, [], undefined, FRONT_GROUP.grille);
    disc(hw, -W * 0.14, topBezelMid, 1.5, zf, FRONT_GROUP.lens);
    const hbY = -((screenH / 2 + H / 2 - rim) / 2);
    const hbR = 5.5;
    disc(hw, 0, hbY, hbR - 0.35, zf, FRONT_GROUP.lens, 64);
    // The ring: a thin metal annulus standing just proud of the glass.
    const ring = circleLoop(hbR, 64);
    const ringIn = insetLoop(ring, 0.35);
    cap(hw, ring.p.map(([x, y]): V2 => [x, y + hbY]), zf + DECAL_LIFT_MM, 1, [ringIn.map(([x, y]): V2 => [x, y + hbY]).reverse()], undefined, FRONT_GROUP.ring);
  } else if (device.family === 'ipad') {
    const onTop = device.id.startsWith('ipad-mini');
    if (onTop) disc(hw, 0, topBezelMid, 1.4, zf, FRONT_GROUP.lens);
    else disc(hw, (screenW / 2 + W / 2 - rim) / 2, 0, 1.4, zf, FRONT_GROUP.lens);
  }
  add(partMesh('frontHardware', hw, RENDER_ORDER.decal));

  // --- Back --------------------------------------------------------------------
  const fx0 = pl.x * W;
  const fy0 = pl.y * H;
  const fw = pl.w * W;
  const fh = pl.h * H;
  const frame: BackFrame = { xy: (bx, by) => [bx - W / 2, H / 2 - by] };
  const backFrom = (b: Builder, from: number) => transformBuilder(b, from, BACK_TO_MODEL);

  // Back cap: glass with a rounded edge into its seam; on the unibody the
  // metal runs straight from the band into the back (no seam) and a glass
  // panel is inlaid below the plateau. Built in the back frame; the body
  // outline (and its cuts) is symmetric in x, so the same loop serves.
  const back = new Builder();
  const backPanel = new Builder();
  const plateau = new Builder();
  if (!unibody) sweep(back, bandLoop, [prof.glassEdge], { lift: lift(1) });
  const capContour = insetLoop(bandLoop, unibody ? rim - SEAM_W_MM : prof.glassInset);
  const panelHoles: V2[][] = [];
  if (unibody) {
    // The inlaid Ceramic Shield panel (estimate, UNIBODY_PANEL), below the plateau's rise.
    const pTop = fy0 + fh + UNIBODY_PANEL.top;
    const pBottom = H - UNIBODY_PANEL.margin;
    const pw = W - 2 * UNIBODY_PANEL.margin;
    const ph = pBottom - pTop;
    const [pcx, pcy] = frame.xy(W / 2, (pTop + pBottom) / 2);
    const panelLoop = rectLoop(pw, ph, Math.max(1, bodyRadius - UNIBODY_PANEL.margin));
    const pl2: Loop = { p: panelLoop.p.map(([x, y]) => [x + pcx, y + pcy]), t: panelLoop.t };
    panelHoles.push(pl2.p.slice().reverse());
    // Panel seam: the metal steps down PANEL_SEAM_MM (a wall facing the
    // panel and a narrow floor, both metal: the back's own material), then the
    // panel glass rounds up out of it. Flush, with no black keyline: the
    // front seam's #0a0a0a ring here drew a hairline outline round a matte
    // card, which read as computer-drawn.
    sweep(back, pl2, [
      [
        { z: d2, i: 0, no: -1, nz: 0 },
        { z: d2 - PANEL_SEAM_MM, i: 0, no: -1, nz: 0 },
      ],
      [
        { z: d2 - PANEL_SEAM_MM, i: 0, no: 0, nz: 1 },
        { z: d2 - PANEL_SEAM_MM, i: PANEL_SEAM_MM, no: 0, nz: 1 },
      ],
    ]);
    const pe = panelEdge(PANEL_SEAM_MM);
    sweep(backPanel, pl2, [pe], { z0: d2 });
    cap(backPanel, insetLoop(pl2, PANEL_SEAM_MM + PANEL_EDGE_MM), d2, 1);
  }
  if (rise) {
    // The back below the rise, the rise itself (rows across the full width: the surface depends on y only, so one
    // quad per row is exact) and the plateau top above it.
    const parts = splitAtRise(capContour, rise);
    cap(back, parts.below, d2, 1, panelHoles);
    let prev: [number, number] | null = null;
    for (const [y, xl, xr] of parts.rows) {
      const r = rise.at(y);
      const n = norm2(-r.dzdy, 1);
      const row: [number, number] = [plateau.v(xl, y, d2 + r.dz, 0, n[0], n[1]), plateau.v(xr, y, d2 + r.dz, 0, n[0], n[1])];
      if (prev) {
        plateau.tri(prev[0], prev[1], row[1]);
        plateau.tri(prev[0], row[1], row[0]);
      }
      prev = row;
    }
    cap(plateau, parts.above, d2 + pl.heightMm, 1);
  } else {
    cap(back, capContour, d2, 1, panelHoles);
  }
  backFrom(back, 0);
  backFrom(backPanel, 0);
  add(partMesh('back', back));
  add(partMesh('backPanel', backPanel));

  // Plateau (footprint plateaus and turrets; a full-width bar was built with the back above).
  const [pcx, pcy] = frame.xy(fx0 + fw / 2, fy0 + fh / 2);
  let plLoop: Loop | null = null;
  const topInset = pl.kind === 'single' ? 0 : pl.insetMm;
  if (pl.kind === 'single') plLoop = circleLoop(Math.min(fw, fh) / 2);
  else if (!fullBar) plLoop = pl.kind === 'pill' ? stadiumLoop(fw, fh) : rectLoop(fw, fh, pl.rMm);
  if (plLoop) plLoop = { p: plLoop.p.map(([x, y]) => [x + pcx, y + pcy]), t: plLoop.t };
  const plateauTop = d2 + pl.heightMm;
  const lensPos = (f: { x: number; y: number }): V2 => frame.xy(fx0 + f.x * fw, fy0 + f.y * fh);
  const turretR = Math.min(fw, fh) / 2;
  const lensSpecs: LensSpec[] = pl.lenses.map((lens) => {
    const [x, y] = lensPos(lens);
    if (pl.kind === 'single') {
      // The turret is the ring: the lens is set into its top, the barrel goes down inside it.
      return { x, y, ringR: 0, glassR: Math.min(lens.rMm, turretR * 0.8), zBase: plateauTop, proud: 0, maxDepth: pl.heightMm - 0.25 };
    }
    const proud = pl.lensProudMm;
    return { x, y, ringR: lens.rMm, glassR: lens.rMm * LENS_GLASS_FRAC, zBase: plateauTop, proud, maxDepth: proud - Math.min(LENS_BEVEL_MM, proud * 0.25 + 0.05) - 0.05 };
  });
  const holes = pl.kind === 'single' ? lensSpecs.map((l) => circleLoop(l.glassR).p.map(([px, py]): V2 => [px + l.x, py + l.y])) : [];
  if (plLoop) buildPlateau(plateau, plLoop, d2, pl.heightMm, topInset, holes);
  transformBuilder(plateau, 0, BACK_TO_MODEL);
  add(partMesh('plateau', plateau));

  // Lenses.
  const L: LensBuild = { ring: new Builder(), barrel: new Builder(), elements: new Builder(), cover: new Builder() };
  const topContour = plLoop ? insetLoop(plLoop, Math.max(topInset, PLATEAU_MIN_RUN_MM, pl.heightMm * 0.9)) : null;
  const onTop = (q: V2) => (rise ? q[1] >= rise.y1 - 1e-6 : pointInPoly(topContour!, q));
  for (const spec of lensSpecs) buildLens(L, spec);
  for (const b of [L.ring, L.barrel, L.elements, L.cover]) transformBuilder(b, 0, BACK_TO_MODEL);
  add(partMesh('lensRing', L.ring));
  add(partMesh('lensBarrel', L.barrel));
  add(partMesh('lensElements', L.elements, RENDER_ORDER.lensElements));
  add(partMesh('lensCover', L.cover, RENDER_ORDER.lensCover));

  // Flash, sensor (LiDAR), mic: discs on the plateau top, or on the back beside it.
  const surfaceZ = (q: V2) => (onTop(q) ? plateauTop : d2) + DECAL_LIFT_MM;
  const flash = new Builder();
  // Flash and LiDAR sit under flat cover glass (owner decision 15: glass-covered, not flat discs): a glass disc
  // over each (the lens covers' material: it mirrors the room), over a frosted diffuser with the fine concentric
  // rings of its Fresnel lens (flash), or a dark sensor window (LiDAR).
  const covers = new Builder();
  if (pl.flash) {
    const q = lensPos(pl.flash);
    const r = pl.flash.rMm ?? 3.4;
    const z = surfaceZ(q);
    const rl = r * FLASH_LAMP_FRAC;
    disc(flash, q[0], q[1], r, z, FLASH_GROUP.ring);
    disc(flash, q[0], q[1], rl, z + DECAL_LIFT_MM, FLASH_GROUP.lamp);
    for (let k = 1; k <= FLASH_FRESNEL_RINGS; k++) {
      const ro = (rl * (k + 0.5)) / (FLASH_FRESNEL_RINGS + 1);
      const ri = ro - rl / (2 * (FLASH_FRESNEL_RINGS + 1));
      const ring = (rad: number) => circleLoop(rad, 48).p.map(([px, py]): V2 => [px + q[0], py + q[1]]);
      cap(flash, ring(ro), z + 2 * DECAL_LIFT_MM, 1, [ring(ri).reverse()], undefined, FLASH_GROUP.fresnel);
    }
    disc(covers, q[0], q[1], r * 0.98, z + 3 * DECAL_LIFT_MM);
  }
  const sensor = new Builder();
  if (pl.sensor) {
    const q = lensPos(pl.sensor);
    const r = pl.sensor.rMm ?? 3.3;
    disc(sensor, q[0], q[1], r, surfaceZ(q));
    disc(covers, q[0], q[1], r * 0.98, surfaceZ(q) + 3 * DECAL_LIFT_MM);
  }
  const mic = new Builder();
  if (pl.mic) {
    const q = lensPos(pl.mic);
    disc(mic, q[0], q[1], Math.max(0.35, pl.mic.rMm ?? 0.5), surfaceZ(q), 0, 20);
  }
  for (const b of [flash, sensor, mic, covers]) transformBuilder(b, 0, BACK_TO_MODEL);
  add(partMesh('flash', flash, RENDER_ORDER.decal));
  add(partMesh('sensor', sensor, RENDER_ORDER.decal));
  add(partMesh('lensCover', covers, RENDER_ORDER.lensCover));
  add(partMesh('mic', mic, RENDER_ORDER.decal));

  // --- Buttons --------------------------------------------------------------------
  const buttons = new Builder();
  const control = new Builder();
  for (const btn of [...device.buttons, ...(body.extraButtons ?? [])]) {
    const { m, length } = buttonPlacement(btn, W, H);
    if (btn.kind === 'cameraControl') buildButton(control, length, body.buttonDepth * depth, CAMERA_CONTROL_PROUD_MM, m);
    else buildButton(buttons, length, body.buttonDepth * depth, BUTTON_PROUD_MM, m);
  }
  add(partMesh('button', buttons));
  add(partMesh('cameraControl', control));

  // --- Bottom edge: port pill and two grilles (decals on the wall) ------------------
  const port = new Builder();
  const portH = Math.min(PORT_MM.h, depth * 0.45);
  const toBottom = new Matrix4().set(1, 0, 0, 0, 0, 0, -1, -H / 2 - DECAL_LIFT_MM, 0, 1, 0, 0, 0, 0, 0, 1);
  // local x → model x, local y → model z, local z (normal) → model −y.
  cap(port, stadiumLoop(PORT_MM.w, portH, 12).p, 0, 1);
  transformBuilder(port, 0, toBottom);
  const portMesh = partMesh('port', port, RENDER_ORDER.decal);
  add(portMesh);
  let grilleTris = 0;
  if (portMesh) {
    const hole = new CircleGeometry(GRILLE.d / 2, 12);
    hole.applyMatrix4(new Matrix4().makeRotationX(Math.PI / 2)); // face −y
    const holes = new InstancedMesh(hole, PLACEHOLDER, GRILLE.holes * 2);
    holes.name = 'port:grille';
    holes.userData.part = 'port';
    holes.renderOrder = RENDER_ORDER.decal;
    const m = new Matrix4();
    let k = 0;
    for (const side of [-1, 1]) {
      for (let h = 0; h < GRILLE.holes; h++) {
        const x = side * (PORT_MM.w / 2 + GRILLE.gap + GRILLE.d / 2 + h * GRILLE.pitch);
        m.makeTranslation(x, -H / 2 - DECAL_LIFT_MM, 0);
        holes.setMatrixAt(k++, m);
      }
    }
    holes.instanceMatrix.needsUpdate = true;
    group.add(holes);
    grilleTris = (hole.index ? hole.index.count / 3 : 0) * holes.count;
  }

  let triangles = grilleTris;
  group.traverse((o) => {
    if (o instanceof Mesh && !(o instanceof InstancedMesh)) triangles += (o.geometry.index?.count ?? 0) / 3;
  });

  const dims: PhoneDims = {
    bodyW: W,
    bodyH: H,
    depth,
    bodyRadius,
    rim,
    screenW,
    screenH,
    screenRadius,
    edge: body.edge,
    unibody,
    plateauTopZ: -plateauTop,
    lensTopZ: -(plateauTop + (pl.kind === 'single' ? 0 : pl.lensProudMm)),
    creaseZ: prof.creaseZ,
  };
  group.userData.dims = dims;
  return { group, dims, triangles };
}

function pointInPoly(poly: V2[], q: V2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Cache (LRU 3)

const CACHE_SIZE = 3;
const cache = new Map<string, PhoneModel>();

function cacheKey(device: DeviceModel, body: Body3D): string {
  return JSON.stringify([device.id, device.bodyMm, device.screenPx, device.ppi, device.cornerRadiusPt, device.rimMm, body]);
}

/** Dispose every geometry in a phone group. */
export function disposePhone(model: PhoneModel) {
  model.group.traverse((o) => {
    if (o instanceof Mesh) o.geometry.dispose();
  });
}

/**
 * The phone for a device, in mm (portrait, y up, front +z, centred). Cached
 * by device (LRU 3); evicted phones are disposed, so callers must not keep a
 * group across a buildPhone call for a 4th device.
 */
export function buildPhone(device: DeviceModel, body3d: Body3D): Group {
  return phoneModel(device, body3d).group;
}

/** buildPhone plus its dimensions and triangle count. */
export function phoneModel(device: DeviceModel, body3d: Body3D): PhoneModel {
  const key = cacheKey(device, body3d);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const model = createPhone(device, body3d);
  cache.set(key, model);
  while (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value as string;
    const old = cache.get(oldest)!;
    cache.delete(oldest);
    disposePhone(old);
  }
  return model;
}

/** Drop every cached phone (context loss, unload). */
export function clearPhoneCache() {
  for (const m of cache.values()) disposePhone(m);
  cache.clear();
}
