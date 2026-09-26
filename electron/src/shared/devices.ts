// iPhone / iPad model registry and capture-size detection.
//
// Every number here is public:
// - Native screen pixels, ppi and body size (mm): Apple tech specs pages,
//   https://support.apple.com/en-us/docs/iphone and
//   https://support.apple.com/en-us/docs/ipad (one page per model), and the
//   App Store Connect screenshot/preview size table
//   https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications
// - Point sizes and scale factors: Apple HIG "Layout > Specifications"
//   https://developer.apple.com/design/human-interface-guidelines/layout
// - Finish names: the Apple tech specs page of each model.
// - Screen corner radii: UIScreen's `_displayCornerRadius`, as published by
//   the open-source ScreenCorners project (https://github.com/kylebshr/ScreenCorners)
//   and cross-checked against Apple's own rounded-corner screen shapes.
// - Dynamic Island / notch geometry and button positions are measured
//   proportions (points and fractions of body height), not copied artwork.
//   Apple's device bezel images are NOT used anywhere: their license forbids
//   redistribution, so frames are drawn procedurally (deviceFrame.ts).
//
// Finish hex values are approximations of each finish's frame colour, used
// only to tint the procedural metal band.

import type { Size } from './types';

export type DeviceFamily = 'iphone' | 'ipad';
export type FrameMaterial = 'titanium' | 'aluminum' | 'steel';
export type Orientation = 'portrait' | 'landscape';

/** Screen cutout, in device points measured from the top edge of the screen (portrait). */
export type Cutout =
  | { kind: 'none' }
  | { kind: 'island'; width: number; height: number; top: number }
  | {
      kind: 'notch';
      width: number;
      height: number;
      /** Radius of the concave "ears" where the notch meets the top edge. */
      earRadius: number;
      /** Radius of the notch's two lower corners. */
      bottomRadius: number;
    };

/** A hardware button on the side of the body. `top`/`length` are fractions of body height. */
export interface SideButton {
  side: 'left' | 'right';
  kind: 'action' | 'mute' | 'volumeUp' | 'volumeDown' | 'side' | 'cameraControl' | 'top';
  top: number;
  length: number;
}

export interface DeviceFinish {
  id: string;
  name: string;
  /** Frame (metal band) colour. */
  hex: string;
}

export interface DeviceModel {
  id: string;
  name: string;
  family: DeviceFamily;
  year: number;
  /** App Store display class, e.g. '6.9"'. */
  displayClass: string;
  /** Native screen pixels, portrait. */
  screenPx: Size;
  /** Native pixels per logical point (13 mini renders @3x and downsamples to 2.88). */
  pointScale: number;
  ppi: number;
  /** Screen corner radius in points (multiply by pointScale for native px). */
  cornerRadiusPt: number;
  /** Physical body size in millimetres (Apple tech specs), portrait. */
  bodyMm: { width: number; height: number };
  /** Visible metal rim from the front, in mm; the rest of the border is black glass. */
  rimMm: number;
  material: FrameMaterial;
  cutout: Cutout;
  /** Round home button under the screen (iPhone SE). */
  homeButton: boolean;
  buttons: SideButton[];
  finishes: DeviceFinish[];
}

// ---------------------------------------------------------------------------
// Shared building blocks

const ISLAND: Cutout = { kind: 'island', width: 126, height: 37.33, top: 11.33 };
const NOTCH: Cutout = { kind: 'notch', width: 162, height: 33, earRadius: 6, bottomRadius: 20 };
const NONE: Cutout = { kind: 'none' };

/** 15 Pro and later: Action button replaces the ring/silent switch. */
const actionButtons = (cameraControl: boolean): SideButton[] => [
  { side: 'left', kind: 'action', top: 0.175, length: 0.05 },
  { side: 'left', kind: 'volumeUp', top: 0.255, length: 0.068 },
  { side: 'left', kind: 'volumeDown', top: 0.345, length: 0.068 },
  { side: 'right', kind: 'side', top: 0.26, length: 0.105 },
  ...(cameraControl ? [{ side: 'right', kind: 'cameraControl', top: 0.61, length: 0.1 } as SideButton] : []),
];

/** Pre-Action-button phones: ring/silent switch. */
const muteButtons: SideButton[] = [
  { side: 'left', kind: 'mute', top: 0.17, length: 0.035 },
  { side: 'left', kind: 'volumeUp', top: 0.255, length: 0.068 },
  { side: 'left', kind: 'volumeDown', top: 0.345, length: 0.068 },
  { side: 'right', kind: 'side', top: 0.26, length: 0.105 },
];

const seButtons: SideButton[] = [
  { side: 'left', kind: 'mute', top: 0.13, length: 0.035 },
  { side: 'left', kind: 'volumeUp', top: 0.21, length: 0.06 },
  { side: 'left', kind: 'volumeDown', top: 0.295, length: 0.06 },
  { side: 'right', kind: 'side', top: 0.21, length: 0.075 },
];

/** Modern iPads: top button + volume on the right edge (portrait). */
const ipadButtons: SideButton[] = [
  { side: 'right', kind: 'volumeUp', top: 0.07, length: 0.05 },
  { side: 'right', kind: 'volumeDown', top: 0.13, length: 0.05 },
];

const f = (name: string, hex: string): DeviceFinish => ({
  id: name.toLowerCase().replace(/[()]/g, '').replace(/\s+/g, '-'),
  name,
  hex,
});

interface ModelSpec {
  id: string;
  name: string;
  year: number;
  displayClass: string;
  px: [number, number];
  pt?: number;
  ppi?: number;
  corner: number;
  mm: [number, number];
  material: FrameMaterial;
  cutout: Cutout;
  buttons: SideButton[];
  finishes: DeviceFinish[];
  family?: DeviceFamily;
  homeButton?: boolean;
  rimMm?: number;
}

const model = (s: ModelSpec): DeviceModel => ({
  id: s.id,
  name: s.name,
  family: s.family ?? 'iphone',
  year: s.year,
  displayClass: s.displayClass,
  screenPx: { width: s.px[0], height: s.px[1] },
  pointScale: s.pt ?? 3,
  ppi: s.ppi ?? 460,
  cornerRadiusPt: s.corner,
  bodyMm: { width: s.mm[0], height: s.mm[1] },
  rimMm: s.rimMm ?? 0.85,
  material: s.material,
  cutout: s.cutout,
  homeButton: s.homeButton ?? false,
  buttons: s.buttons,
  finishes: s.finishes,
});

// ---------------------------------------------------------------------------
// Registry. Ordered newest first: when several models share a capture size,
// the first match is the default guess.

export const DEVICES: DeviceModel[] = [
  // 2025
  model({
    id: 'iphone-17-pro-max', name: 'iPhone 17 Pro Max', year: 2025, displayClass: '6.9"',
    px: [1320, 2868], corner: 62, mm: [78.0, 163.4], material: 'aluminum', cutout: ISLAND,
    buttons: actionButtons(true),
    finishes: [f('Cosmic Orange', '#E8732F'), f('Deep Blue', '#3A4659'), f('Silver', '#DDDEDF')],
  }),
  model({
    id: 'iphone-17-pro', name: 'iPhone 17 Pro', year: 2025, displayClass: '6.3"',
    px: [1206, 2622], corner: 62, mm: [71.9, 150.0], material: 'aluminum', cutout: ISLAND,
    buttons: actionButtons(true),
    finishes: [f('Cosmic Orange', '#E8732F'), f('Deep Blue', '#3A4659'), f('Silver', '#DDDEDF')],
  }),
  model({
    id: 'iphone-air', name: 'iPhone Air', year: 2025, displayClass: '6.5"',
    px: [1260, 2736], corner: 62, mm: [74.7, 156.2], material: 'titanium', cutout: ISLAND,
    buttons: actionButtons(true),
    finishes: [
      f('Sky Blue', '#CBDCEA'), f('Light Gold', '#E9DFC9'), f('Cloud White', '#F0EFEA'), f('Space Black', '#2E2E30'),
    ],
  }),
  model({
    id: 'iphone-17', name: 'iPhone 17', year: 2025, displayClass: '6.3"',
    px: [1206, 2622], corner: 62, mm: [71.5, 149.6], material: 'aluminum', cutout: ISLAND,
    buttons: actionButtons(true),
    finishes: [
      f('Black', '#2F2F31'), f('White', '#EFEFEC'), f('Mist Blue', '#A8B9CB'), f('Sage', '#B5BFA5'),
      f('Lavender', '#D2C6E0'),
    ],
  }),
  // 2024 / 2025 (16e)
  model({
    id: 'iphone-16-pro-max', name: 'iPhone 16 Pro Max', year: 2024, displayClass: '6.9"',
    px: [1320, 2868], corner: 62, mm: [77.6, 163.0], material: 'titanium', cutout: ISLAND,
    buttons: actionButtons(true),
    finishes: [
      f('Desert Titanium', '#BFA48F'), f('Natural Titanium', '#C2BCB2'), f('White Titanium', '#F2F1ED'),
      f('Black Titanium', '#3C3C3D'),
    ],
  }),
  model({
    id: 'iphone-16-pro', name: 'iPhone 16 Pro', year: 2024, displayClass: '6.3"',
    px: [1206, 2622], corner: 62, mm: [71.5, 149.6], material: 'titanium', cutout: ISLAND,
    buttons: actionButtons(true),
    finishes: [
      f('Desert Titanium', '#BFA48F'), f('Natural Titanium', '#C2BCB2'), f('White Titanium', '#F2F1ED'),
      f('Black Titanium', '#3C3C3D'),
    ],
  }),
  model({
    id: 'iphone-16-plus', name: 'iPhone 16 Plus', year: 2024, displayClass: '6.7"',
    px: [1290, 2796], corner: 55, mm: [77.8, 160.9], material: 'aluminum', cutout: ISLAND,
    buttons: actionButtons(true),
    finishes: [
      f('Black', '#3C3D3A'), f('White', '#F5F5F3'), f('Pink', '#EFB3D5'), f('Teal', '#AED3D0'),
      f('Ultramarine', '#9AA9EE'),
    ],
  }),
  model({
    id: 'iphone-16', name: 'iPhone 16', year: 2024, displayClass: '6.1"',
    px: [1179, 2556], corner: 55, mm: [71.6, 147.6], material: 'aluminum', cutout: ISLAND,
    buttons: actionButtons(true),
    finishes: [
      f('Black', '#3C3D3A'), f('White', '#F5F5F3'), f('Pink', '#EFB3D5'), f('Teal', '#AED3D0'),
      f('Ultramarine', '#9AA9EE'),
    ],
  }),
  model({
    id: 'iphone-16e', name: 'iPhone 16e', year: 2025, displayClass: '6.1"',
    px: [1170, 2532], corner: 47.33, mm: [71.5, 146.7], material: 'aluminum', cutout: NOTCH,
    buttons: actionButtons(false),
    finishes: [f('Black', '#2E2E30'), f('White', '#F3F3F1')],
  }),
  // 2023
  model({
    id: 'iphone-15-pro-max', name: 'iPhone 15 Pro Max', year: 2023, displayClass: '6.7"',
    px: [1290, 2796], corner: 55, mm: [76.7, 159.9], material: 'titanium', cutout: ISLAND,
    buttons: actionButtons(false),
    finishes: [
      f('Natural Titanium', '#BEB6AB'), f('Blue Titanium', '#414A56'), f('White Titanium', '#F2F1EB'),
      f('Black Titanium', '#3B3B3D'),
    ],
  }),
  model({
    id: 'iphone-15-pro', name: 'iPhone 15 Pro', year: 2023, displayClass: '6.1"',
    px: [1179, 2556], corner: 55, mm: [70.6, 146.6], material: 'titanium', cutout: ISLAND,
    buttons: actionButtons(false),
    finishes: [
      f('Natural Titanium', '#BEB6AB'), f('Blue Titanium', '#414A56'), f('White Titanium', '#F2F1EB'),
      f('Black Titanium', '#3B3B3D'),
    ],
  }),
  model({
    id: 'iphone-15-plus', name: 'iPhone 15 Plus', year: 2023, displayClass: '6.7"',
    px: [1290, 2796], corner: 55, mm: [77.8, 160.9], material: 'aluminum', cutout: ISLAND,
    buttons: muteButtons,
    finishes: [
      f('Black', '#35393B'), f('Blue', '#D3DCDF'), f('Green', '#CAD4C5'), f('Yellow', '#EDE6CA'), f('Pink', '#E6CACC'),
    ],
  }),
  model({
    id: 'iphone-15', name: 'iPhone 15', year: 2023, displayClass: '6.1"',
    px: [1179, 2556], corner: 55, mm: [71.6, 147.6], material: 'aluminum', cutout: ISLAND,
    buttons: muteButtons,
    finishes: [
      f('Black', '#35393B'), f('Blue', '#D3DCDF'), f('Green', '#CAD4C5'), f('Yellow', '#EDE6CA'), f('Pink', '#E6CACC'),
    ],
  }),
  // 2022
  model({
    id: 'iphone-14-pro-max', name: 'iPhone 14 Pro Max', year: 2022, displayClass: '6.7"',
    px: [1290, 2796], corner: 55, mm: [77.6, 160.7], material: 'steel', cutout: ISLAND,
    buttons: muteButtons,
    finishes: [f('Space Black', '#403E3D'), f('Silver', '#EDEDEB'), f('Gold', '#F1E4C8'), f('Deep Purple', '#594F63')],
  }),
  model({
    id: 'iphone-14-pro', name: 'iPhone 14 Pro', year: 2022, displayClass: '6.1"',
    px: [1179, 2556], corner: 55, mm: [71.5, 147.5], material: 'steel', cutout: ISLAND,
    buttons: muteButtons,
    finishes: [f('Space Black', '#403E3D'), f('Silver', '#EDEDEB'), f('Gold', '#F1E4C8'), f('Deep Purple', '#594F63')],
  }),
  model({
    id: 'iphone-14-plus', name: 'iPhone 14 Plus', year: 2022, displayClass: '6.7"',
    px: [1284, 2778], ppi: 458, corner: 53.33, mm: [78.1, 160.8], material: 'aluminum', cutout: NOTCH,
    buttons: muteButtons,
    finishes: [
      f('Midnight', '#232A31'), f('Starlight', '#F6F2EC'), f('Blue', '#A0B4C7'), f('Purple', '#E2D9E8'),
      f('(PRODUCT)RED', '#B8102A'), f('Yellow', '#F4E07A'),
    ],
  }),
  model({
    id: 'iphone-14', name: 'iPhone 14', year: 2022, displayClass: '6.1"',
    px: [1170, 2532], corner: 47.33, mm: [71.5, 146.7], material: 'aluminum', cutout: NOTCH,
    buttons: muteButtons,
    finishes: [
      f('Midnight', '#232A31'), f('Starlight', '#F6F2EC'), f('Blue', '#A0B4C7'), f('Purple', '#E2D9E8'),
      f('(PRODUCT)RED', '#B8102A'), f('Yellow', '#F4E07A'),
    ],
  }),
  // 2021
  model({
    id: 'iphone-13-pro-max', name: 'iPhone 13 Pro Max', year: 2021, displayClass: '6.7"',
    px: [1284, 2778], ppi: 458, corner: 53.33, mm: [78.1, 160.8], material: 'steel', cutout: NOTCH,
    buttons: muteButtons,
    finishes: [
      f('Graphite', '#54524F'), f('Gold', '#F5E4CC'), f('Silver', '#EEEFEA'), f('Sierra Blue', '#A5BED6'),
      f('Alpine Green', '#576856'),
    ],
  }),
  model({
    id: 'iphone-13-pro', name: 'iPhone 13 Pro', year: 2021, displayClass: '6.1"',
    px: [1170, 2532], corner: 47.33, mm: [71.5, 146.7], material: 'steel', cutout: NOTCH,
    buttons: muteButtons,
    finishes: [
      f('Graphite', '#54524F'), f('Gold', '#F5E4CC'), f('Silver', '#EEEFEA'), f('Sierra Blue', '#A5BED6'),
      f('Alpine Green', '#576856'),
    ],
  }),
  model({
    id: 'iphone-13', name: 'iPhone 13', year: 2021, displayClass: '6.1"',
    px: [1170, 2532], corner: 47.33, mm: [71.5, 146.7], material: 'aluminum', cutout: NOTCH,
    buttons: muteButtons,
    finishes: [
      f('Midnight', '#232A31'), f('Starlight', '#F6F2EC'), f('Blue', '#2D6A89'), f('Pink', '#F5DDD5'),
      f('Green', '#3B4E3A'), f('(PRODUCT)RED', '#B8102A'),
    ],
  }),
  model({
    id: 'iphone-13-mini', name: 'iPhone 13 mini', year: 2021, displayClass: '5.4"',
    px: [1080, 2340], pt: 2.88, ppi: 476, corner: 44, mm: [64.2, 131.5], material: 'aluminum', cutout: NOTCH,
    buttons: muteButtons,
    finishes: [
      f('Midnight', '#232A31'), f('Starlight', '#F6F2EC'), f('Blue', '#2D6A89'), f('Pink', '#F5DDD5'),
      f('Green', '#3B4E3A'), f('(PRODUCT)RED', '#B8102A'),
    ],
  }),
  model({
    id: 'iphone-se-3', name: 'iPhone SE (3rd generation)', year: 2022, displayClass: '4.7"',
    px: [750, 1334], pt: 2, ppi: 326, corner: 0, mm: [67.3, 138.4], material: 'aluminum', cutout: NONE,
    homeButton: true, rimMm: 1.0, buttons: seButtons,
    finishes: [f('Midnight', '#232A31'), f('Starlight', '#F4EFE9'), f('(PRODUCT)RED', '#B8102A')],
  }),

  // iPads (portrait). Front camera sits in the bezel, so no cutout.
  model({
    id: 'ipad-pro-13-m4', name: 'iPad Pro 13-inch (M4)', family: 'ipad', year: 2024, displayClass: '13"',
    px: [2064, 2752], pt: 2, ppi: 264, corner: 18, mm: [215.5, 281.6], material: 'aluminum', cutout: NONE,
    rimMm: 1.2, buttons: ipadButtons,
    finishes: [f('Space Black', '#3A3A3C'), f('Silver', '#E1E2E4')],
  }),
  model({
    id: 'ipad-pro-11-m4', name: 'iPad Pro 11-inch (M4)', family: 'ipad', year: 2024, displayClass: '11"',
    px: [1668, 2420], pt: 2, ppi: 264, corner: 18, mm: [177.5, 249.7], material: 'aluminum', cutout: NONE,
    rimMm: 1.2, buttons: ipadButtons,
    finishes: [f('Space Black', '#3A3A3C'), f('Silver', '#E1E2E4')],
  }),
  model({
    id: 'ipad-air-13', name: 'iPad Air 13-inch (M3)', family: 'ipad', year: 2025, displayClass: '13"',
    px: [2048, 2732], pt: 2, ppi: 264, corner: 18, mm: [214.9, 280.6], material: 'aluminum', cutout: NONE,
    rimMm: 1.2, buttons: ipadButtons,
    finishes: [f('Space Gray', '#7B7C7F'), f('Blue', '#BFCAD6'), f('Purple', '#D5CCE0'), f('Starlight', '#E7E1D6')],
  }),
  model({
    id: 'ipad-air-11', name: 'iPad Air 11-inch (M3)', family: 'ipad', year: 2025, displayClass: '11"',
    px: [1640, 2360], pt: 2, ppi: 264, corner: 18, mm: [178.5, 247.6], material: 'aluminum', cutout: NONE,
    rimMm: 1.2, buttons: ipadButtons,
    finishes: [f('Space Gray', '#7B7C7F'), f('Blue', '#BFCAD6'), f('Purple', '#D5CCE0'), f('Starlight', '#E7E1D6')],
  }),
  model({
    id: 'ipad-mini-a17', name: 'iPad mini (A17 Pro)', family: 'ipad', year: 2024, displayClass: '8.3"',
    px: [1488, 2266], pt: 2, ppi: 326, corner: 21.5, mm: [134.8, 195.4], material: 'aluminum', cutout: NONE,
    rimMm: 1.1, buttons: ipadButtons,
    finishes: [f('Space Gray', '#7B7C7F'), f('Blue', '#BFCAD6'), f('Purple', '#D5CCE0'), f('Starlight', '#E7E1D6')],
  }),
];

export const DEFAULT_DEVICE_ID = 'iphone-17-pro';

export function getDevice(id: string): DeviceModel | undefined {
  return DEVICES.find((d) => d.id === id);
}

export function defaultDevice(): DeviceModel {
  return getDevice(DEFAULT_DEVICE_ID)!;
}

/** Finish by id, falling back to the model's first (launch-hero) finish. */
export function getFinish(device: DeviceModel, finishId?: string): DeviceFinish {
  return device.finishes.find((x) => x.id === finishId) ?? device.finishes[0];
}

/** Logical screen size in points. */
export function screenPoints(device: DeviceModel): Size {
  return {
    width: Math.round(device.screenPx.width / device.pointScale),
    height: Math.round(device.screenPx.height / device.pointScale),
  };
}

/** Screen corner radius in native pixels. */
export function cornerRadiusPx(device: DeviceModel): number {
  return device.cornerRadiusPt * device.pointScale;
}

/** Physical screen size in mm, derived from native pixels and ppi. */
export function screenMm(device: DeviceModel): { width: number; height: number } {
  const mmPerPx = 25.4 / device.ppi;
  return { width: device.screenPx.width * mmPerPx, height: device.screenPx.height * mmPerPx };
}

// ---------------------------------------------------------------------------
// Detection

export interface DeviceMatch {
  /** Best guess (newest model among exact matches). */
  device: DeviceModel;
  /** Every model that fits, best first. The UI should offer these in a picker. */
  candidates: DeviceModel[];
  orientation: Orientation;
  /** True when the capture is exactly a model's native size. */
  exact: boolean;
  /** Capture pixels per native pixel (1 for exact, <1 for a downscaled capture). */
  scale: number;
  /** 0..1: 1 = exact size, lower for aspect-only or nearest matches. */
  confidence: number;
}

/**
 * Best device for a capture of `width` x `height` pixels. Orientation-aware
 * (landscape captures swap the dimensions). Tries, in order:
 *  1. exact native size (a wired AVFoundation capture is always native),
 *  2. same aspect ratio at a uniform scale (a downscaled or re-encoded file),
 *  3. nearest aspect ratio (unknown device; low confidence).
 * Several models share a panel, so `candidates` lists all of them.
 */
export function detectDevice(width: number, height: number, family?: DeviceFamily): DeviceMatch {
  const orientation: Orientation = width > height ? 'landscape' : 'portrait';
  const w = Math.min(width, height);
  const h = Math.max(width, height);
  const pool = family ? DEVICES.filter((d) => d.family === family) : DEVICES;

  const exact = pool.filter((d) => d.screenPx.width === w && d.screenPx.height === h);
  if (exact.length > 0) {
    return { device: exact[0], candidates: exact, orientation, exact: true, scale: 1, confidence: 1 };
  }

  // Encoders round odd dimensions to even; allow a couple of pixels of slop.
  // Pro and Pro Max panels differ in aspect by <0.1%, so rank by the height
  // error; the sort is stable, keeping same-panel models newest first.
  const heightErr = (d: DeviceModel) => Math.abs(d.screenPx.height * (w / d.screenPx.width) - h);
  const scaled = pool
    .filter((d) => w / d.screenPx.width <= 1.001 && heightErr(d) <= 2.5)
    .sort((a, b) => heightErr(a) - heightErr(b));
  if (scaled.length > 0) {
    const scale = w / scaled[0].screenPx.width;
    return { device: scaled[0], candidates: scaled, orientation, exact: false, scale, confidence: 0.8 };
  }

  const aspect = h / w;
  const ranked = [...pool].sort(
    (a, b) =>
      Math.abs(a.screenPx.height / a.screenPx.width - aspect) -
      Math.abs(b.screenPx.height / b.screenPx.width - aspect),
  );
  const best = ranked[0];
  const err = Math.abs(best.screenPx.height / best.screenPx.width - aspect) / aspect;
  const bestAspect = best.screenPx.height / best.screenPx.width;
  const candidates = ranked.filter(
    (d) => Math.abs(d.screenPx.height / d.screenPx.width - bestAspect) < 1e-3,
  );
  return {
    device: best,
    candidates,
    orientation,
    exact: false,
    scale: w / best.screenPx.width,
    confidence: Math.max(0, 0.5 - err * 10),
  };
}

/**
 * A frame-only "generic phone" for sources that match no known model
 * (Android, a cropped window): same shape language, no cutout.
 */
export function genericDevice(width: number, height: number): DeviceModel {
  const w = Math.min(width, height);
  const h = Math.max(width, height);
  const pointScale = w >= 900 ? 3 : 2;
  const ppi = 460;
  const mmPerPx = 25.4 / ppi;
  const border = 2.6;
  return {
    id: 'generic',
    name: 'Generic phone',
    family: 'iphone',
    year: 0,
    displayClass: '',
    screenPx: { width: w, height: h },
    pointScale,
    ppi,
    cornerRadiusPt: Math.round((w / pointScale) * 0.12),
    bodyMm: { width: w * mmPerPx + border * 2, height: h * mmPerPx + border * 2 },
    rimMm: 0.85,
    material: 'aluminum',
    cutout: NONE,
    homeButton: false,
    buttons: muteButtons,
    finishes: [f('Graphite', '#3A3A3C'), f('Silver', '#DDDEDF')],
  };
}
