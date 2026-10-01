// Backdrop presets: the tiles on the editor's Background tab and the
// `background {swatch}` agent op. Projects store the Background value, not
// the id, so editing a preset here never changes a saved project; ids are
// only the agent's names for them (aurora/ocean/sunset/mono predate the rest
// and must keep working).
import type { Background } from './types';

export type BackdropGroup = 'soft' | 'dark' | 'light' | 'vivid';

export interface Backdrop {
  id: string;
  name: string;
  group: BackdropGroup;
  bg: Background;
}

export const BACKDROP_GROUPS: { id: BackdropGroup; title: string }[] = [
  { id: 'soft', title: 'Soft' },
  { id: 'dark', title: 'Dark' },
  { id: 'light', title: 'Light' },
  { id: 'vivid', title: 'Vivid' },
];

type Blob = { x: number; y: number; r: number; hex: string };
const mesh = (baseHex: string, blobs: Blob[], grain?: number): Background =>
  ({ kind: 'mesh', baseHex, blobs, ...(grain ? { grain } : {}) });
const blob = (x: number, y: number, r: number, hex: string): Blob => ({ x, y, r, hex });

export const BACKDROPS: Backdrop[] = [
  // Soft
  { id: 'aurora', name: 'Aurora', group: 'soft', bg: { kind: 'gradient', startHex: '#3a1c71', endHex: '#d76d77', angle: 120 } },
  { id: 'sunset', name: 'Sunset', group: 'soft', bg: { kind: 'gradient', startHex: '#ff7e5f', endHex: '#feb47b', angle: 160 } },
  { id: 'peach', name: 'Peach', group: 'soft', bg: mesh('#f3cdb8', [blob(0.05, 0.05, 0.75, '#f4a894'), blob(0.95, 0.95, 0.7, '#f7dfc0'), blob(0.92, 0.08, 0.5, '#e6b3cf')]) },
  { id: 'lilac', name: 'Lilac', group: 'soft', bg: mesh('#dccdee', [blob(0.1, 0.9, 0.7, '#f0bfd6'), blob(0.9, 0.1, 0.7, '#bfcbf2'), blob(0.5, 0.45, 0.4, '#e6dcf4')]) },
  { id: 'sage', name: 'Sage', group: 'soft', bg: mesh('#c3d8cb', [blob(0.05, 0.1, 0.7, '#a6c9b9'), blob(0.95, 0.9, 0.7, '#dfe6c8'), blob(0.85, 0.15, 0.4, '#b9d6d6')]) },
  { id: 'dusk', name: 'Dusk', group: 'soft', bg: mesh('#7f84c2', [blob(0.05, 0.95, 0.8, '#f2a084'), blob(0.95, 0.05, 0.7, '#5a6bb8'), blob(0.55, 0.6, 0.45, '#c48fc0')]) },
  // Dark
  { id: 'mono', name: 'Mono', group: 'dark', bg: { kind: 'solid', hex: '#17171c' } },
  { id: 'ocean', name: 'Ocean', group: 'dark', bg: { kind: 'gradient', startHex: '#0f2027', endHex: '#2c5364', angle: 135 } },
  { id: 'midnight', name: 'Midnight', group: 'dark', bg: mesh('#060a18', [blob(0.15, 0.1, 0.75, '#1a2a6a'), blob(0.92, 0.95, 0.65, '#33195a')], 0.04) },
  { id: 'graphite', name: 'Graphite', group: 'dark', bg: mesh('#0d0d10', [blob(0.5, 0.3, 0.85, '#2b2c33')], 0.035) },
  { id: 'nebula', name: 'Nebula', group: 'dark', bg: mesh('#0a0613', [blob(0.12, 0.15, 0.6, '#45196a'), blob(0.9, 0.88, 0.6, '#5c1845'), blob(0.88, 0.08, 0.45, '#1b2870')], 0.04) },
  { id: 'deep-sea', name: 'Deep Sea', group: 'dark', bg: mesh('#03131a', [blob(0.15, 0.9, 0.75, '#0b4a50'), blob(0.9, 0.1, 0.65, '#0a2d4a')], 0.035) },
  { id: 'forest', name: 'Forest', group: 'dark', bg: mesh('#05110b', [blob(0.1, 0.12, 0.7, '#143f2a'), blob(0.92, 0.9, 0.6, '#1f4a36')], 0.035) },
  { id: 'ember', name: 'Ember', group: 'dark', bg: mesh('#0c0705', [blob(0.85, 1.0, 0.8, '#7c3415'), blob(0.08, 0.0, 0.55, '#36130f')], 0.04) },
  { id: 'slate', name: 'Slate', group: 'dark', bg: mesh('#2f3238', [blob(0.5, 0.25, 0.85, '#565a64')], 0.03) },
  // Light
  { id: 'studio', name: 'Studio', group: 'light', bg: mesh('#cfd0d4', [blob(0.5, 0.3, 0.85, '#f5f5f6')], 0.025) },
  { id: 'paper', name: 'Paper', group: 'light', bg: mesh('#e9e4db', [blob(0.4, 0.25, 0.9, '#f8f6f1')], 0.035) },
  { id: 'cloud', name: 'Cloud', group: 'light', bg: { kind: 'gradient', startHex: '#f6f8fb', endHex: '#d9e0ea', angle: 90 } },
  { id: 'mist', name: 'Mist', group: 'light', bg: mesh('#c6d3ea', [blob(0.08, 0.1, 0.7, '#a9bbe8'), blob(0.92, 0.92, 0.7, '#d4e8ef'), blob(0.9, 0.1, 0.45, '#c3b9e6')]) },
  { id: 'blush', name: 'Blush', group: 'light', bg: mesh('#f1e6e4', [blob(0.1, 0.1, 0.7, '#f9d9d2'), blob(0.9, 0.9, 0.7, '#e9e6f4')]) },
  // Vivid
  { id: 'electric', name: 'Electric', group: 'vivid', bg: mesh('#3420c4', [blob(0.05, 0.08, 0.7, '#1287ff'), blob(0.95, 0.92, 0.7, '#a92cf0'), blob(0.95, 0.05, 0.4, '#f0409e')]) },
  { id: 'citrus', name: 'Citrus', group: 'vivid', bg: mesh('#ff8a3d', [blob(0.05, 0.05, 0.7, '#ffc84a'), blob(0.95, 0.95, 0.7, '#f2486a')]) },
  { id: 'lagoon', name: 'Lagoon', group: 'vivid', bg: mesh('#0a9fa6', [blob(0.05, 0.95, 0.7, '#22d0a6'), blob(0.95, 0.05, 0.7, '#2a64f0')]) },
  { id: 'bloom', name: 'Bloom', group: 'vivid', bg: mesh('#d8336f', [blob(0.05, 0.05, 0.7, '#ff8466'), blob(0.95, 0.95, 0.7, '#7a2ff0')]) },
];

/** The preset with this id (case-insensitive), or undefined. */
export function backdropById(id: string): Backdrop | undefined {
  const key = id.toLowerCase();
  return BACKDROPS.find((b) => b.id === key);
}

const lc = (s: string) => s.toLowerCase();

/** Field-wise background equality (saved projects may order keys differently). */
export function sameBackground(a: Background, b: Background): boolean {
  if (a.kind === 'gradient' && b.kind === 'gradient') {
    return lc(a.startHex) === lc(b.startHex) && lc(a.endHex) === lc(b.endHex) && a.angle === b.angle;
  }
  if (a.kind === 'solid' && b.kind === 'solid') return lc(a.hex) === lc(b.hex);
  if (a.kind === 'mesh' && b.kind === 'mesh') {
    return (
      lc(a.baseHex) === lc(b.baseHex) &&
      (a.grain ?? 0) === (b.grain ?? 0) &&
      a.blobs.length === b.blobs.length &&
      a.blobs.every((p, i) => {
        const q = b.blobs[i];
        return p.x === q.x && p.y === q.y && p.r === q.r && lc(p.hex) === lc(q.hex);
      })
    );
  }
  return false;
}

/** `#rrggbb` → `rgba(r,g,b,a)`. */
export function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Falloff of a mesh blob: alpha at each fraction of its radius. Eased so
 *  blobs melt into each other with no visible rim. */
export const BLOB_STOPS: [number, number][] = [
  [0, 1],
  [0.25, 0.85],
  [0.5, 0.5],
  [0.75, 0.16],
  [1, 0],
];

/**
 * CSS for a tile swatch that approximates what the compositor paints.
 * Canvas angles are measured from +x (left to right) clockwise; CSS angles
 * from straight up, so CSS = canvas + 90.
 */
export function backgroundCss(bg: Background): string {
  if (bg.kind === 'solid') return bg.hex;
  if (bg.kind === 'gradient') return `linear-gradient(${bg.angle + 90}deg, ${bg.startHex}, ${bg.endHex})`;
  if (bg.kind === 'mesh') {
    // Tiles are 4:3 landscape, so a circle of r × width is r×100% wide and
    // r×133% tall.
    const layers = bg.blobs.map((b) => {
      const stops = BLOB_STOPS.map(([t, a]) => `${hexAlpha(b.hex, a)} ${t * 100}%`).join(', ');
      return `radial-gradient(ellipse ${(b.r * 100).toFixed(1)}% ${((b.r * 400) / 3).toFixed(1)}% at ${b.x * 100}% ${b.y * 100}%, ${stops})`;
    });
    // CSS draws the first layer on top; the compositor paints blobs in order.
    return [...layers.reverse(), bg.baseHex].join(', ');
  }
  return '#111';
}
