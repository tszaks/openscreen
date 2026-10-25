// The studio HDRI (owner decision 15): ONE CC0 Poly Haven studio panorama,
// the room the phone reflects. assets/SOURCE.md has its origin and licence.
//
// It is inlined into the engine chunk (Vite `?inline`), which loader.ts
// imports only when a project's 3D phone is active, so a flat project never
// loads it (nor three). Decoded once per process, synchronously, so building
// the environment stays a pure function of the project: no fetch, no file://
// rules, no frame that renders before the room is there.
//
// It stays in its own 8-bit RGBE form on the GPU (4 B a texel; the dome
// shader decodes it, environment.ts): a half-float upload is twice that, and
// the 4K memory budget (owner decision 16) has no room for the difference.
import { ClampToEdgeWrapping, DataTexture, NearestFilter, NoColorSpace, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three';
import STUDIO_HDR from './assets/studio.hdr?inline';

/** The shipped panorama and how it sits in the studio frame (environment.ts). */
export const HDRI = {
  /** Poly Haven asset id (assets/SOURCE.md). */
  id: 'studio_small_09',
  /** Panorama turn, degrees, picked by looking (look v2 round 2; round 1 had 270). With a colour-coded debug
   *  panorama, a back at turn 150-180 mirrors a window about 40° wide and 45° tall round the horizon, and the
   *  turn-to-back's end pose mirrors the band above it. At 133 that end pose sees the first octabox's edge (a soft
   *  gradient across the plateau and the panel) and the turns sweep the cyclorama's edge across the back; at 270
   *  the end pose mirrored the even white cyclorama (one flat tone), at 153 the octabox washed Cosmic Orange to
   *  salmon, at 113 the back went flat and dark. */
  yawDeg: 133,
} as const;

export interface HdriData {
  width: number;
  height: number;
  /** RGBE bytes (mantissas, shared exponent), top row first (the file's order). */
  rgbe: Uint8Array;
}

/** One RGBE texel → linear RGB: m/255 · 2^(e − 128), exactly as three's HDRLoader decodes it (0 when e is 0). */
export function rgbeToFloat(r: number, g: number, b: number, e: number): [number, number, number] {
  if (e === 0) return [0, 0, 0];
  const f = 2 ** (e - 128) / 255;
  return [r * f, g * f, b * f];
}

/** Base64 (a data URL's payload) → bytes. */
function base64Bytes(dataUrl: string): Uint8Array {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A Radiance .hdr file (32-bit_rle_rgbe, "-Y h +X w") → its RGBE bytes. Reads
 * run-length scanlines (2, 2, width) and flat ones; throws on anything else,
 * so a different asset cannot slip in half-read.
 */
export function decodeRadiance(bytes: Uint8Array): HdriData {
  let pos = 0;
  const line = () => {
    let s = '';
    while (pos < bytes.length && bytes[pos] !== 0x0a) s += String.fromCharCode(bytes[pos++]);
    pos++;
    return s;
  };
  if (!line().startsWith('#?')) throw new Error('phone3d: the studio HDRI is not a Radiance file');
  for (let l = line(); l !== ''; l = line()) {
    if (l.startsWith('FORMAT=') && l !== 'FORMAT=32-bit_rle_rgbe') throw new Error(`phone3d: unsupported HDRI ${l}`);
    if (pos >= bytes.length) throw new Error('phone3d: the studio HDRI header has no end');
  }
  const m = /^-Y (\d+) \+X (\d+)$/.exec(line());
  if (!m) throw new Error('phone3d: the studio HDRI is not -Y h +X w');
  const height = Number(m[1]);
  const width = Number(m[2]);
  const out = new Uint8Array(width * height * 4);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    const rle = width >= 8 && width < 32768 && bytes[pos] === 2 && bytes[pos + 1] === 2 && ((bytes[pos + 2] << 8) | bytes[pos + 3]) === width;
    if (!rle) {
      out.set(bytes.subarray(pos, pos + width * 4), y * width * 4);
      pos += width * 4;
      continue;
    }
    pos += 4;
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        let n = bytes[pos++];
        if (n > 128) {
          n -= 128;
          if (x + n > width) throw new Error('phone3d: HDRI scanline overrun');
          const v = bytes[pos++];
          for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = v;
        } else {
          if (n === 0 || x + n > width) throw new Error('phone3d: bad HDRI run');
          for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = bytes[pos++];
        }
      }
    }
    out.set(scan, y * width * 4);
  }
  if (pos > bytes.length) throw new Error('phone3d: the studio HDRI is truncated');
  return { width, height, rgbe: out };
}

let decoded: HdriData | null = null;

/** The decoded panorama (once per process). */
export function hdriData(): HdriData {
  return (decoded ??= decodeRadiance(base64Bytes(STUDIO_HDR)));
}

/**
 * A GPU texture of the panorama: equirectangular RGBE bytes, nearest filtered
 * (RGBE does not filter; the dome shader decodes the four texels round a
 * point and interpolates them itself). The caller disposes it.
 */
export function hdriTexture(): DataTexture {
  const { width, height, rgbe } = hdriData();
  const tex = new DataTexture(rgbe, width, height, RGBAFormat, UnsignedByteType);
  tex.colorSpace = NoColorSpace;
  tex.flipY = true; // the file is top row first; flipped, v = 0 is its bottom row, as three's equirectUv expects
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
