// What the 3D phone needs beyond shared/devices.ts (which stays untouched):
// body depth, the edge shape, the back finish and the camera plateau.
//
// Sources (all Apple, fetched 2026-10-24; the raw pages and the readings are
// reproducible with the URLs below):
// - Depth: each model's support.apple.com "Tech Specs" page ("Size and
//   Weight > Depth"; Apple's depth excludes the camera). The URL is on every
//   row. Width and height on those pages match devices.ts bodyMm exactly.
// - Camera plateau, lens, flash, sensor and mic positions and sizes, and the
//   plateau / lens heights: Apple's accessory "Dimensional Drawings" PDFs,
//   https://developer.apple.com/accessories/dimensional-drawings/ (one PDF
//   per model, file name on every row). Positions are millimetres from the
//   top-left corner of the BACK as seen from behind, exactly as Apple
//   dimensions them. Numbers Apple dimensions are copied as printed. A few
//   outlines are not dimensioned (the plateau's footprint on some models,
//   its corner radius, some heights); those are measured from the same
//   drawing against its own dimensioned features (`px` in the row note) or,
//   where no drawing gave a number, marked `estimate`. Like the devices.ts
//   header says for its cutouts and buttons: these are measured proportions,
//   not copied artwork.
// - No Apple logo, no artwork, no CAD model: the back stays blank.

import type { DeviceModel, SideButton } from './devices';

export interface Body3D {
  /** Apple tech-spec "Depth", camera bump excluded (mm). */
  depthMm: number;
  /** 12–16 flat; 17 / Air (and SE, iPhone 8-style) rounded. */
  edge: 'flat' | 'rounded';
  /** Pro frosted, base glossy (phone3d.back overrides). */
  back: 'frosted' | 'glossy';
  plateau: {
    /**
     * square: a continuous-corner rounded rect (13–16 Pro, 13–15, 13 mini, iPad Pro).
     * bar: spans the full width at the top of the back (17 Pro / Pro Max).
     * pill: its raised top surface has fully round ends (16, 16 Plus, 17: a
     *   vertical stadium; Air: a full-width bar carrying a horizontal pill).
     * single: no plateau, one round lens turret (16e, SE, iPad Air, iPad mini):
     *   the rect is the turret's bounding square and the shape is a circle.
     */
    kind: 'square' | 'bar' | 'pill' | 'single';
    /** The plateau's footprint, as fractions of the back's W/H from the top-left of the BACK. */
    x: number;
    y: number;
    w: number;
    h: number;
    /** Footprint corner radius (mm). */
    rMm: number;
    /** Height of the plateau's top above the back glass (mm). */
    heightMm: number;
    /** The top surface is the footprint inset by this much (the sloped/filleted side), mm. 0 = straight wall. */
    insetMm: number;
    /** Lens cover glass above the plateau top (mm); the lens ring stands this proud. */
    lensProudMm: number;
    /** Lens centres as plateau fractions; rMm = the lens opening radius. */
    lenses: { x: number; y: number; rMm: number }[];
    /** Plateau fractions (may lie outside 0..1 when the part sits on the back glass beside the plateau, e.g. the 16's flash). */
    flash?: { x: number; y: number; rMm?: number };
    sensor?: { x: number; y: number; rMm?: number };
    mic?: { x: number; y: number; rMm?: number };
  };
  /** Button width as a fraction of depth. */
  buttonDepth: number;
  /** Antenna band lines, fractions of body height (approximations). */
  antennaLines: number[];
  /** Buttons devices.ts lacks. kind 'top' sits on the TOP edge: `top` is then the
   *  fraction of body WIDTH from the left (front view) and `length` a fraction of width. */
  extraButtons?: SideButton[];
}

/** One row of measurements, in Apple's own units (mm from the back's top-left). */
interface Row {
  /** support.apple.com Tech Specs page the depth comes from. */
  specs: string;
  depthMm: number;
  /** Dimensional-drawing PDF the plateau comes from (file name). */
  drawing: string;
  edge: Body3D['edge'];
  back: Body3D['back'];
  kind: Body3D['plateau']['kind'];
  /** Footprint [x0, y0, x1, y1] in mm; x1 = 'W' spans to the far edge. */
  foot: readonly [number, number, number | 'W', number];
  rMm: number;
  heightMm: number;
  insetMm: number;
  lensProudMm: number;
  /** [x, y, diameter] mm. */
  lenses: readonly (readonly [number, number, number])[];
  flash?: readonly [number, number, number];
  sensor?: readonly [number, number, number];
  mic?: readonly [number, number, number];
  extraButtons?: SideButton[];
  /** What was dimensioned, measured (px) or estimated. */
  note: string;
}

const DD = 'https://developer.apple.com/download/files/accessories/dimensional-drawings/';

// Shared camera modules (the drawings give identical millimetres for these pairs).
const PRO_16 = {
  kind: 'square', foot: [1.04, 1.04, 45.22, 46.54], rMm: 7, insetMm: 3.66,
  lenses: [[14.17, 14.17, 16.2], [14.17, 33.41, 16.2], [32.16, 23.79, 16.2]],
} as const;
const PRO_14 = {
  kind: 'square', foot: [2.19, 2.19, 44.12, 45.61], rMm: 7, insetMm: 2.6,
  lenses: [[14.28, 14.28, 15.61], [14.28, 33.52, 15.61], [32.12, 23.9, 15.61]],
  flash: [32.12, 10.32, 6.9], mic: [37.91, 33.98, 1.15],
} as const;
const PRO_13 = {
  kind: 'square', foot: [1.15, 1.15, 42.39, 43.62], rMm: 7, insetMm: 3.12, heightMm: 1.68, lensProudMm: 1.92,
  flash: [30.08, 9.42, 6.28], mic: [35.76, 32.21, 1.15],
} as const;
const DUAL_16 = {
  kind: 'pill', foot: [1.09, 1.25, 26.16, 43.72], rMm: 12.5, insetMm: 2.7, heightMm: 1.85, lensProudMm: 1.63,
  lenses: [[13.62, 13.62, 16], [13.62, 31.34, 16]], flash: [30.01, 22.48, 6.28],
} as const;
const BAR_17PRO = { kind: 'bar', rMm: 7, insetMm: 4.8, heightMm: 2.55, lensProudMm: 1.88 } as const;

const pro16Note = 'dimensioned: footprint, top (inset), lenses, flash, mic, heights; px: corner radius; LiDAR position not dimensioned (placed mirroring the flash about camera 3)';

// Every model in devices.ts. Order follows devices.ts.
const ROWS: Record<string, Row> = {
  'iphone-17-pro-max': {
    specs: 'https://support.apple.com/en-us/125091', depthMm: 8.75, drawing: 'iphone-17-pro-max.pdf', edge: 'rounded', back: 'frosted',
    ...BAR_17PRO, foot: [0, 0, 'W', 48.3],
    lenses: [[14.37, 14.37, 16.2], [14.37, 33.61, 16.2], [32.36, 23.99, 16.2]],
    flash: [64.16, 13.82, 6.8], sensor: [64.16, 34.16, 6.65], mic: [64.16, 23.99, 1.15],
    note: 'dimensioned: lenses, flash, sensor, mic, plateau 2.55, glass +1.88 above plateau; px: plateau bottom edge 48.3, top inset 4.8, corner radius',
  },
  'iphone-17-pro': {
    specs: 'https://support.apple.com/en-us/125090', depthMm: 8.75, drawing: 'iphone-17-pro.pdf', edge: 'rounded', back: 'frosted',
    ...BAR_17PRO, foot: [0, 0, 'W', 48.1],
    lenses: [[14.37, 14.37, 16.2], [14.37, 33.61, 16.2], [32.36, 23.99, 16.2]],
    flash: [58.03, 13.82, 6.8], sensor: [58.03, 34.16, 6.65], mic: [58.03, 23.99, 1.05],
    note: 'dimensioned: lenses, flash, sensor, mic, plateau 2.55, glass +1.88; px: plateau bottom edge 48.1, top inset 4.8, corner radius',
  },
  'iphone-air': {
    specs: 'https://support.apple.com/en-us/125092', depthMm: 5.64, drawing: 'iphone-air.pdf', edge: 'rounded', back: 'frosted',
    kind: 'pill', foot: [0, 0, 'W', 31.4], rMm: 7, heightMm: 3.03, insetMm: 4.4, lensProudMm: 2.65,
    lenses: [[16.29, 16.29, 15.82]], flash: [58.42, 16.29, 6.3], mic: [51.34, 16.29, 2.3],
    note: 'dimensioned: lens, flash, mic, plateau 3.03 and lens glass 5.68 above the back glass; px: bar bottom 31.4, pill inset 4.4',
  },
  'iphone-17': {
    specs: 'https://support.apple.com/en-us/125089', depthMm: 7.95, drawing: 'iphone-17.pdf', edge: 'rounded', back: 'glossy',
    kind: 'pill', foot: [1.18, 1.34, 26.06, 43.62], rMm: 12.4, heightMm: 1.78, insetMm: 2.63, lensProudMm: 1.67,
    lenses: [[13.62, 13.62, 16], [13.62, 31.34, 16]], flash: [30.41, 22.48, 6.28], mic: [20.54, 22.48, 1],
    note: 'dimensioned: footprint, top, lenses, flash (beside the plateau), mic, plateau 1.78, lens glass 3.45',
  },
  'iphone-16-pro-max': {
    specs: 'https://support.apple.com/en-us/121032', depthMm: 8.25, drawing: 'iphone-16-pro-max.pdf', edge: 'flat', back: 'frosted',
    ...PRO_16, heightMm: 2.05, lensProudMm: 2.23, flash: [32.16, 10.22, 6.92], sensor: [32.16, 37.36, 6.6], mic: [38, 34.14, 0.75],
    note: pro16Note,
  },
  'iphone-16-pro': {
    specs: 'https://support.apple.com/en-us/121031', depthMm: 8.25, drawing: 'iphone-16-pro.pdf', edge: 'flat', back: 'frosted',
    ...PRO_16, heightMm: 2.05, lensProudMm: 2.23, flash: [32.16, 10.22, 6.92], sensor: [32.16, 37.36, 6.6], mic: [38, 34.14, 0.75],
    note: pro16Note,
  },
  'iphone-16-plus': {
    specs: 'https://support.apple.com/en-us/121030', depthMm: 7.8, drawing: 'iphone-16-plus.pdf', edge: 'flat', back: 'glossy',
    ...DUAL_16, mic: [20.55, 22.48, 1],
    note: 'dimensioned: footprint, top, lenses, flash (beside the plateau), mic, plateau 1.85, lens glass 3.48',
  },
  'iphone-16': {
    specs: 'https://support.apple.com/en-us/121029', depthMm: 7.8, drawing: 'iphone-16.pdf', edge: 'flat', back: 'glossy',
    ...DUAL_16, mic: [20.54, 22.48, 1],
    note: 'dimensioned: footprint, top, lenses, flash (beside the plateau), mic, plateau 1.85, lens glass 3.48',
  },
  'iphone-16e': {
    specs: 'https://support.apple.com/en-us/122208', depthMm: 7.8, drawing: 'iphone-16e.pdf', edge: 'flat', back: 'glossy',
    kind: 'single', foot: [5.835, 5.835, 20.805, 20.805], rMm: 7.485, heightMm: 1.68, insetMm: 0, lensProudMm: 0,
    lenses: [[13.32, 13.32, 14.97]], flash: [29.68, 13.32, 3.75], mic: [24.3, 13.32, 1.3],
    note: 'dimensioned: lens Ø14.97 (the turret), flash, mic, lens glass 1.68 above the back glass; no plateau',
  },
  'iphone-15-pro-max': {
    specs: 'https://support.apple.com/en-us/111828', depthMm: 8.25, drawing: 'iphone-15-pro-max.pdf', edge: 'flat', back: 'frosted',
    ...PRO_16, heightMm: 2.05, lensProudMm: 2.02, flash: [32.16, 10.22, 6.9], sensor: [32.16, 37.36, 6.6], mic: [37.95, 33.86, 0.75],
    note: pro16Note,
  },
  'iphone-15-pro': {
    specs: 'https://support.apple.com/en-us/111829', depthMm: 8.25, drawing: 'iphone-15-pro.pdf', edge: 'flat', back: 'frosted',
    ...PRO_16, heightMm: 2.05, lensProudMm: 1.73, flash: [32.16, 10.22, 6.92], sensor: [32.16, 37.36, 6.6], mic: [37.95, 33.86, 0.75],
    note: pro16Note,
  },
  'iphone-15-plus': {
    specs: 'https://support.apple.com/en-us/111830', depthMm: 7.8, drawing: 'iphone-15-plus.pdf', edge: 'flat', back: 'glossy',
    kind: 'square', foot: [1.22, 1.22, 37.15, 37.15], rMm: 6.5, heightMm: 1.85, insetMm: 2.68, lensProudMm: 1.63,
    lenses: [[12.73, 12.73, 15.07], [25.64, 25.64, 15.07]], flash: [27.32, 11.06, 6.28], mic: [11.47, 26.9, 2.1],
    note: 'same module as the 15 (its drawing prints the same 12.73 / 27.32 lens and flash columns; detail not re-read); heights from its side view',
  },
  'iphone-15': {
    specs: 'https://support.apple.com/en-us/111831', depthMm: 7.8, drawing: 'iphone-15.pdf', edge: 'flat', back: 'glossy',
    kind: 'square', foot: [1.22, 1.22, 37.15, 37.15], rMm: 6.5, heightMm: 1.85, insetMm: 2.68, lensProudMm: 1.63,
    lenses: [[12.73, 12.73, 15.07], [25.64, 25.64, 15.07]], flash: [27.32, 11.06, 6.28], mic: [11.47, 26.9, 2.1],
    note: 'dimensioned: footprint, top, lenses, flash, mic, plateau 1.85, lens glass 3.48; px: corner radius',
  },
  'iphone-14-pro-max': {
    specs: 'https://support.apple.com/en-us/111846', depthMm: 7.85, drawing: 'iphone-14-pro-max.pdf', edge: 'flat', back: 'frosted',
    ...PRO_14, heightMm: 1.85, lensProudMm: 1.9, sensor: [32.12, 37.48, 6.6],
    note: 'dimensioned: footprint, top, lenses, flash, mic (same mm as the 14 Pro); plateau 1.85 from the 14 Pro side view; estimate: lens glass, LiDAR position',
  },
  'iphone-14-pro': {
    specs: 'https://support.apple.com/en-us/111849', depthMm: 7.85, drawing: 'iphone-14-pro.pdf', edge: 'flat', back: 'frosted',
    ...PRO_14, heightMm: 1.85, lensProudMm: 1.9, sensor: [32.12, 37.48, 6.6],
    note: 'dimensioned: footprint, top, lenses, flash, mic, plateau 1.85; estimate: lens glass, LiDAR position',
  },
  'iphone-14-plus': {
    specs: 'https://support.apple.com/en-us/111854', depthMm: 7.8, drawing: 'iphone-14-plus.pdf', edge: 'flat', back: 'glossy',
    kind: 'square', foot: [1.28, 1.28, 36.57, 36.57], rMm: 6.5, heightMm: 1.5, insetMm: 2.6, lensProudMm: 1.1,
    lenses: [[12.55, 12.55, 14.38], [25.3, 25.3, 14.38]], flash: [26.97, 10.87, 6.28], mic: [11.29, 26.56, 2.1],
    note: 'dimensioned: footprint, top, lenses, flash, mic; estimate: heights (side view not read; set like the 13)',
  },
  'iphone-14': {
    specs: 'https://support.apple.com/en-us/111850', depthMm: 7.8, drawing: 'iphone-14.pdf', edge: 'flat', back: 'glossy',
    kind: 'square', foot: [1.2, 1.2, 35.9, 35.9], rMm: 6.5, heightMm: 1.5, insetMm: 2.6, lensProudMm: 1.1,
    lenses: [[11.88, 11.88, 14.38], [24.63, 24.63, 14.38]], flash: [26.3, 10.21, 6.28], mic: [10.62, 25.89, 2.1],
    note: 'dimensioned: footprint right/bottom, top, lenses, flash, mic; px: footprint left/top; estimate: heights (set like the 13)',
  },
  'iphone-13-pro-max': {
    specs: 'https://support.apple.com/en-us/111870', depthMm: 7.65, drawing: 'iphone-13-pro-max.pdf', edge: 'flat', back: 'frosted',
    ...PRO_13, lenses: [[13.43, 13.43, 15.53], [13.43, 31.35, 15.53], [30.08, 22.39, 15.53]], sensor: [30.08, 35.36, 6.3],
    note: 'dimensioned: footprint, top, lenses, flash, mic, plateau 1.68, lens glass 3.60; estimate: LiDAR position',
  },
  'iphone-13-pro': {
    specs: 'https://support.apple.com/en-us/111871', depthMm: 7.65, drawing: 'iphone-13-pro.pdf', edge: 'flat', back: 'frosted',
    ...PRO_13, lenses: [[13.43, 13.43, 15.53], [13.43, 31.35, 15.53], [30.08, 22.39, 15.8]], sensor: [30.08, 35.36, 6.3],
    note: 'dimensioned: footprint, top, lenses, plateau 1.68, lens glass 3.60; flash Ø and mic from the 13 Pro Max drawing (same module); estimate: LiDAR position',
  },
  'iphone-13': {
    specs: 'https://support.apple.com/en-us/111872', depthMm: 7.65, drawing: 'iphone-13.pdf', edge: 'flat', back: 'glossy',
    kind: 'square', foot: [1.15, 1.15, 35.12, 35.12], rMm: 6.5, heightMm: 1.5, insetMm: 2.49, lensProudMm: 1.09,
    lenses: [[11.88, 11.88, 13.69], [24.24, 24.24, 13.69]], flash: [26.11, 10.01, 6.28], mic: [10.43, 25.69, 2.4],
    note: 'dimensioned: footprint x, top x, lenses, flash, mic, plateau 1.50, lens glass 2.59; px: footprint/top y (square, matches x)',
  },
  'iphone-13-mini': {
    specs: 'https://support.apple.com/en-us/111873', depthMm: 7.65, drawing: 'iphone-13-mini.pdf', edge: 'flat', back: 'glossy',
    kind: 'square', foot: [1.2, 1.0, 33.27, 32.97], rMm: 6, heightMm: 1.48, insetMm: 1.875, lensProudMm: 1.03,
    lenses: [[10.85, 10.85, 13.69], [23.21, 23.21, 13.69]], flash: [25, 8.98, 6.28], mic: [9.4, 24.66, 2.4],
    note: 'dimensioned: footprint size 32.07 x 31.97, top 28.32, lenses, flash y, mic, heights 1.48 / 2.51 (labels printed in the other order; the physically possible order used); px: footprint origin, flash x',
  },
  'iphone-se-3': {
    specs: 'https://support.apple.com/en-us/111866', depthMm: 7.3, drawing: 'iphone-se-3rd-generation.pdf', edge: 'rounded', back: 'glossy',
    kind: 'single', foot: [4.55, 4.55, 13.85, 13.85], rMm: 4.65, heightMm: 0.87, insetMm: 0, lensProudMm: 0,
    lenses: [[9.2, 9.2, 7.4]], flash: [21.6, 9.2, 4.5],
    note: 'dimensioned: turret height 0.87, lens-to-flash 12.40; px: turret Ø9.3, lens centre, lens opening, flash size',
  },
  'ipad-pro-13-m4': {
    specs: 'https://support.apple.com/en-us/119891', depthMm: 5.1, drawing: 'ipad-pro-13-inch-m4.pdf', edge: 'flat', back: 'glossy',
    kind: 'square', foot: [4.4, 4.2, 35.4, 35.6], rMm: 6, heightMm: 1, insetMm: 2.3, lensProudMm: 0.5,
    lenses: [[14.03, 14.03, 10.83]], flash: [26.82, 20.04, 6.7], sensor: [14.03, 26.05, 8.41], mic: [26.82, 27.98, 1.72],
    note: 'dimensioned: camera, LiDAR (sensor), flash, mic; px: footprint, inset; estimate: heights',
  },
  'ipad-pro-11-m4': {
    specs: 'https://support.apple.com/en-us/119892', depthMm: 5.3, drawing: 'ipad-pro-11-inch-m4.pdf', edge: 'flat', back: 'glossy',
    kind: 'square', foot: [4.4, 4.2, 35.4, 35.6], rMm: 6, heightMm: 1, insetMm: 2.3, lensProudMm: 0.5,
    lenses: [[14.03, 14.03, 10.83]], flash: [26.82, 20.04, 6.7], sensor: [14.03, 26.05, 8.41], mic: [26.82, 27.98, 1.72],
    note: 'dimensioned: camera, LiDAR (sensor), flash, mic; px: footprint, inset; estimate: heights',
  },
  'ipad-air-13': {
    specs: 'https://support.apple.com/en-us/122242', depthMm: 6.1, drawing: 'ipad-air-13-inch-m3.pdf', edge: 'flat', back: 'glossy',
    kind: 'single', foot: [4.22, 4.24, 21.14, 21.16], rMm: 8.46, heightMm: 1, insetMm: 0, lensProudMm: 0,
    lenses: [[12.68, 12.7, 9.85]], mic: [12.68, 27.6, 1],
    note: 'module assumed identical to the iPad Air 11 drawing (not re-read); estimate: height',
  },
  'ipad-air-11': {
    specs: 'https://support.apple.com/en-us/122241', depthMm: 6.1, drawing: 'ipad-air-11-inch-m3.pdf', edge: 'flat', back: 'glossy',
    kind: 'single', foot: [4.22, 4.24, 21.14, 21.16], rMm: 8.46, heightMm: 1, insetMm: 0, lensProudMm: 0,
    lenses: [[12.68, 12.7, 9.85]], mic: [12.68, 27.6, 1],
    note: 'dimensioned: lens Ø9.85, bump Ø16.92, lens x 12.68; px: lens y, mic y; estimate: height',
  },
  'ipad-mini-a17': {
    specs: 'https://support.apple.com/en-us/121456', depthMm: 6.3, drawing: 'ipad-mini-a17-pro.pdf', edge: 'flat', back: 'glossy',
    kind: 'single', foot: [5.08, 5.08, 20.52, 20.52], rMm: 7.72, heightMm: 1, insetMm: 0, lensProudMm: 0,
    lenses: [[12.8, 12.8, 9.89]], flash: [12.8, 27.7, 3.75], mic: [12.8, 22.4, 0.8],
    note: 'dimensioned: lens Ø9.89, bump Ø15.44, flash Ø3.75, mic Ø0.80; px: positions (lens x assumed equal to y); estimate: height',
  },
};

/** The source of each model's numbers, for docs and `info`: tech-spec URL, drawing URL and what was measured. */
export function body3dSource(id: string): { specs: string; drawing: string; note: string } | null {
  const r = ROWS[id];
  return r ? { specs: r.specs, drawing: DD + r.drawing, note: r.note } : null;
}

/** Model ids that have a measured row. */
export const BODY3D_IDS: readonly string[] = Object.keys(ROWS);

const BUTTON_DEPTH = 0.62;
/** Antenna band lines (approximation): near the top and bottom of every metal-banded iPhone. */
const IPHONE_ANTENNA = [0.07, 0.93];

function fromRow(r: Row, device: Pick<DeviceModel, 'bodyMm'>): Body3D {
  const W = device.bodyMm.width;
  const H = device.bodyMm.height;
  const [x0, y0, x1raw, y1] = r.foot;
  const x1 = x1raw === 'W' ? W : x1raw;
  const pw = x1 - x0;
  const ph = y1 - y0;
  const frac = (p: readonly [number, number, number]) => ({ x: (p[0] - x0) / pw, y: (p[1] - y0) / ph, rMm: p[2] / 2 });
  const out: Body3D = {
    depthMm: r.depthMm,
    edge: r.edge,
    back: r.back,
    plateau: {
      kind: r.kind,
      x: x0 / W,
      y: y0 / H,
      w: pw / W,
      h: ph / H,
      rMm: r.rMm,
      heightMm: r.heightMm,
      insetMm: r.insetMm,
      lensProudMm: r.lensProudMm,
      lenses: r.lenses.map(frac),
    },
    buttonDepth: BUTTON_DEPTH,
    antennaLines: IPHONE_ANTENNA,
  };
  if (r.flash) out.plateau.flash = frac(r.flash);
  if (r.sensor) out.plateau.sensor = frac(r.sensor);
  if (r.mic) out.plateau.mic = frac(r.mic);
  if (r.extraButtons) out.extraButtons = r.extraButtons;
  return out;
}

/** iPads: the top button devices.ts lacks (estimate: near the top-right corner, front view, portrait). */
const IPAD_TOP_BUTTON: SideButton[] = [{ side: 'right', kind: 'top', top: 0.82, length: 0.1 }];

/**
 * Per-model overrides (the measured rows, as Partial<Body3D> in the spec's
 * shape). body3dFor fills everything else from the family.
 */
export const BODY3D: Record<string, Partial<Body3D>> = Object.fromEntries(
  Object.entries(ROWS).map(([id, r]) => [id, { depthMm: r.depthMm, edge: r.edge, back: r.back }]),
);

/**
 * The 3D data for a device: its measured row when there is one; otherwise
 * (genericDevice, a future model) the iPhone 15's 2-lens module (iPhone) or
 * the iPad Air's single lens (iPad), placed by the same millimetres on this
 * body, with the family's typical depth (iPhone 7.8 mm, iPad 6.1 mm).
 */
export function body3dFor(device: Pick<DeviceModel, 'id' | 'family' | 'bodyMm'>): Body3D {
  const row = ROWS[device.id];
  const ipad = device.family === 'ipad';
  const base = row ?? (ipad ? ROWS['ipad-air-11'] : ROWS['iphone-15']);
  const b = fromRow(base, device);
  if (!row) {
    b.depthMm = ipad ? 6.1 : 7.8;
    b.edge = 'flat';
    b.back = 'glossy';
  }
  if (ipad) {
    b.antennaLines = [];
    b.extraButtons = IPAD_TOP_BUTTON;
  }
  return b;
}
