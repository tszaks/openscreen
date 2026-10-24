// Apple's continuous ("squircle") corner, as data. One table drives both the
// 2D frame (renderer/src/mobile/deviceFrame.ts continuousRectPath) and every
// 3D outline (the band sweep, the glass caps, the screen hit-test), so the
// flat frame and the 3D phone can never disagree about a corner.
//
// The curve starts CORNER_EXTENT·r from the corner and has no curvature jump
// where it meets the straight edge, unlike arcTo. Each entry is one path
// command for one corner, listed from the edge that runs toward the corner to
// the edge that leaves it; each point is [along-first-edge-inset,
// along-second-edge-inset], in units of the nominal radius r.

export type CornerCommand = readonly ['L', number, number] | readonly ['C', number, number, number, number, number, number];

export const CONTINUOUS_CORNER: readonly CornerCommand[] = [
  ['L', 1.52866483, 0],
  ['C', 1.08849323, 0, 0.86840689, 0, 0.66993427, 0.065496],
  ['L', 0.63149399, 0.074911],
  ['C', 0.37282392, 0.16905899, 0.16905899, 0.37282392, 0.074911, 0.63149399],
  ['L', 0.065496, 0.66993427],
  ['C', 0, 0.86840689, 0, 1.08849323, 0, 1.52866483],
];

/** How far from the corner the curve starts, in units of the nominal radius. */
export const CORNER_EXTENT = 1.52866483;

/** The radius actually drawn: never so large that two corners overlap. */
export const clampCornerRadius = (w: number, h: number, radius: number) =>
  Math.max(0, Math.min(radius, Math.min(w, h) / 2 / CORNER_EXTENT));

export type Pt2 = [number, number];

/** One corner frame: origin + two unit axes (into the first edge, into the second). */
type CornerFrame = readonly [number, number, number, number, number, number];

/** The four corner frames of a rect at (x, y) with size w × h, in path order
 *  (top-right, bottom-right, bottom-left, top-left) for a y-down canvas. */
export function cornerFrames(x: number, y: number, w: number, h: number): CornerFrame[] {
  return [
    [x + w, y, -1, 0, 0, 1], // top-right: along the top edge (inset leftward), then down
    [x + w, y + h, 0, -1, -1, 0], // bottom-right
    [x, y + h, 1, 0, 0, -1], // bottom-left
    [x, y, 0, 1, 1, 0], // top-left
  ];
}

const at = (c: CornerFrame, r: number, a: number, b: number): Pt2 => [c[0] + (c[2] * a + c[4] * b) * r, c[1] + (c[3] * a + c[5] * b) * r];

/** A path command in absolute coordinates. */
export type PathCommand =
  | { op: 'M' | 'L'; p: Pt2 }
  | { op: 'C'; c1: Pt2; c2: Pt2; p: Pt2 }
  | { op: 'Z' };

/**
 * The continuous-corner rounded rect at (x, y), w × h, as path commands: the
 * exact sequence continuousRectPath hands to a canvas. With r = 0 it is null
 * (the caller draws a plain rect).
 */
export function continuousRectCommands(x: number, y: number, w: number, h: number, radius: number): PathCommand[] | null {
  const r = clampCornerRadius(w, h, radius);
  if (r <= 0) return null;
  const corners = cornerFrames(x, y, w, h);
  const out: PathCommand[] = [{ op: 'M', p: at(corners[3], r, 0, CORNER_EXTENT) }];
  for (const c of corners) {
    for (const cmd of CONTINUOUS_CORNER) {
      if (cmd[0] === 'C') {
        out.push({ op: 'C', c1: at(c, r, cmd[1], cmd[2]), c2: at(c, r, cmd[3], cmd[4]), p: at(c, r, cmd[5], cmd[6]) });
      } else {
        out.push({ op: 'L', p: at(c, r, cmd[1], cmd[2]) });
      }
    }
  }
  out.push({ op: 'Z' });
  return out;
}

const bez = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

/**
 * Points along the continuous-corner outline of a w × h rect CENTRED on the
 * origin. With y pointing up (three.js), the points run counter-clockwise,
 * which is what ShapeUtils expects for an outer contour; read with y down
 * (a canvas), the same numbers run clockwise, matching continuousRectPath.
 * `segPerCorner` samples are spread over each corner's three bezier spans
 * (at least one per span); the straight edges are single segments. The
 * first point is not repeated at the end.
 */
export function continuousRectPoints(w: number, h: number, r: number, segPerCorner: number): Pt2[] {
  const cmds = continuousRectCommands(-w / 2, -h / 2, w, h, r);
  if (!cmds) return [[w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, -h / 2]];
  const perSpan = Math.max(1, Math.round(segPerCorner / 3));
  const pts: Pt2[] = [];
  let cur: Pt2 = [0, 0];
  const push = (p: Pt2) => {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-12 || Math.abs(last[1] - p[1]) > 1e-12) pts.push(p);
  };
  for (const c of cmds) {
    if (c.op === 'M' || c.op === 'L') {
      push(c.p);
      cur = c.p;
    } else if (c.op === 'C') {
      for (let k = 1; k <= perSpan; k++) {
        const t = k / perSpan;
        push([bez(cur[0], c.c1[0], c.c2[0], c.p[0], t), bez(cur[1], c.c1[1], c.c2[1], c.p[1], t)]);
      }
      cur = c.p;
    }
  }
  // The path closes back onto its start: drop a repeated last point.
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length > 1 && Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) pts.pop();
  return pts;
}

/** `q` is inside (or on) the polygon `poly` (even-odd rule; any winding). */
export function pointInPolygon(poly: readonly Pt2[], q: Pt2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
