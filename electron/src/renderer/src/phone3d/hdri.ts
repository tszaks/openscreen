// The studio HDRI (owner decision 15): ONE CC0 Poly Haven studio panorama,
// the room the phone reflects. assets/SOURCE.md has its origin and licence.
//
// It is inlined into the engine chunk (Vite `?inline`), which loader.ts
// imports only when a project's 3D phone is active, so a flat project never
// loads it (nor three). Decoded once per process, synchronously (atob +
// three's HDRLoader), so building the environment stays a pure function of
// the project: no fetch, no file:// rules, no frame that renders before the
// room is there.
import { DataTexture, HalfFloatType, LinearFilter, LinearSRGBColorSpace, RepeatWrapping, ClampToEdgeWrapping, RGBAFormat } from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import STUDIO_HDR from './assets/studio.hdr?inline';

/** The shipped panorama and how it sits in the studio frame (environment.ts). */
export const HDRI = {
  /** Poly Haven asset id (assets/SOURCE.md). */
  id: 'studio_small_09',
  /** Panorama turn, degrees, so its main lights stand where the key does (picked by looking). */
  yawDeg: 270,
} as const;

export interface HdriData {
  width: number;
  height: number;
  /** RGBA half floats, top row first (the file's order). */
  data: Uint16Array;
}

let decoded: HdriData | null = null;

/** Base64 (a data URL's payload) → bytes. */
function base64Bytes(dataUrl: string): ArrayBuffer {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** The decoded panorama (once per process). */
export function hdriData(): HdriData {
  if (decoded) return decoded;
  const loader = new HDRLoader();
  loader.setDataType(HalfFloatType);
  const r = loader.parse(base64Bytes(STUDIO_HDR)) as { width: number; height: number; data: Uint16Array };
  if (!r || !(r.width > 0) || !(r.height > 0)) throw new Error('phone3d: the studio HDRI did not decode');
  decoded = { width: r.width, height: r.height, data: r.data };
  return decoded;
}

/** A GPU texture of the panorama (equirectangular, linear, half float). The caller disposes it. */
export function hdriTexture(): DataTexture {
  const { width, height, data } = hdriData();
  const tex = new DataTexture(data, width, height, RGBAFormat, HalfFloatType);
  tex.colorSpace = LinearSRGBColorSpace;
  tex.flipY = true; // as HDRLoader's own load() sets it: v = 0 is the bottom row
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
