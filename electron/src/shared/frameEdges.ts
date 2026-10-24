// Where the flat (2D) device frame's two hard edges are in a still: the
// outer body edge and the edge of the screen hole in the black glass. Owner
// decision 14 for the 4K-downscale check (SPEC §4.2): those edges are drawn
// with device-pixel insets in mobile/deviceFrame.ts (the hole is inset half
// an output pixel so the bezel overlaps the content's anti-aliased edge; the
// outer stroke sits a quarter pixel in), which is right per output pixel at
// every size, so a 4K frame downscaled to 1080 differs from the 1080 frame
// along them by design. The check leaves out a 1.5 px band (at 1080 scale)
// centred on each edge and instead checks the frame's geometry: the body
// rect and the screen rect must match within 1 px at 1080 scale.
//
// `frames` reports this per still (HeadlessFrame.deviceFrame) from the
// compositor's own numbers: the body is the compositor's contentRect (the
// box drawDeviceFrame draws in) fitted as frameGeometry fits it, and the
// screen is its screenMap.screen. Pure; no DOM.
//
// Only the recording's own frame is reported. The phone layer beside a Mac
// screen (compositor drawPhoneLayer) draws a device frame too; it is not
// reported, because no layout-preset fixture has one. If one did, its edges
// would make the picture gate fail (a false alarm, never a false pass).

import { deviceBodyRect, frameGeometry, type Rect } from './deviceGeometry';
import { isPhoneProject, layoutPreset, resolveDevice } from './mobileProject';
import { continuousRectPoints, type Pt2 } from './phone3d/outline';
import type { Project } from './types';

export interface FrameEdges {
  /** The drawn device body (canvas space, after rotation). */
  body: Rect;
  /** The screen on the canvas (the compositor's screenMap.screen). */
  screen: Rect;
  /** Closed outlines, each a list of points (the first not repeated): [outer body edge, screen-hole edge]. */
  edges: Pt2[][];
}

/** The screen hole's inset in output px, as drawDeviceFrame cuts it (deviceFrame.ts bezelPath). */
export const SCREEN_HOLE_INSET_PX = 0.5;
/** Samples per rounded corner: the polyline is within 0.05 px of the curve for a 100 px corner. */
const SEG_PER_CORNER = 24;

/**
 * Whether the compositor drew the flat device frame for `project`: a phone
 * recording with the frame on, either without a layout preset or with a
 * framed one (compositor phoneSetup), and not drawn in 3D this frame.
 */
export function drawsFlatFrame(project: Project, drew3d: boolean): boolean {
  if (!isPhoneProject(project) || !project.device.frame || drew3d) return false;
  const preset = layoutPreset(project);
  return !preset || preset.layout === 'framed';
}

/**
 * The frame's edges for a still the compositor just drew (null when it drew
 * no flat frame). `contentRect` and `screen` are the compositor's
 * contentRect and screenMap.screen; `drew3d` its drew3d.
 */
export function frameEdges(
  project: Project,
  s: { contentRect: Rect | null; screen: Rect | null; drew3d: boolean },
): FrameEdges | null {
  if (!s.contentRect || !s.screen || !drawsFlatFrame(project, s.drew3d)) return null;
  const { device, orientation } = resolveDevice(project);
  const opts = { orientation };
  const g = frameGeometry(s.contentRect, device, opts);
  const cos = Math.cos(g.rotation);
  const sin = Math.sin(g.rotation);
  // drawDeviceFrame draws in portrait space, then rotates and moves to the centre.
  const place = (pts: Pt2[]): Pt2[] => pts.map(([x, y]) => [g.cx + x * cos - y * sin, g.cy + x * sin + y * cos]);
  const i = SCREEN_HOLE_INSET_PX;
  return {
    body: deviceBodyRect(s.contentRect, device, opts),
    screen: { ...s.screen },
    edges: [
      place(continuousRectPoints(g.bodyW, g.bodyH, g.bodyRadius, SEG_PER_CORNER)),
      place(continuousRectPoints(g.screenW - 2 * i, g.screenH - 2 * i, Math.max(0, g.screenRadius - i), SEG_PER_CORNER)),
    ],
  };
}

/** `f` with every length times `k` (canvas px → PNG px for a scaled still). */
export function scaleFrameEdges(f: FrameEdges, k: number): FrameEdges {
  const r = (x: Rect): Rect => ({ x: x.x * k, y: x.y * k, w: x.w * k, h: x.h * k });
  return { body: r(f.body), screen: r(f.screen), edges: f.edges.map((e) => e.map(([x, y]) => [x * k, y * k] as Pt2)) };
}
