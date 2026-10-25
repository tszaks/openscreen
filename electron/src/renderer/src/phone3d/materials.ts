// Materials for the procedural phone (spec §3.4, §3.5, §3.6, D3).
//
// One reflection lobe per real surface: cover glass is one surface; a
// colour-under-glass back is a diffuse colour layer under one glass surface
// (clearcoat); steel and titanium have no clearcoat; anodised aluminium is a
// dyed oxide under a clear seal, so it has one (look round 4).
//
// Every material that is drawn into the engine's 2-attachment target gets
// one of two output patches (`mrtOutput`):
//   'lit'    attachment 0 = three's HDR result, attachment 1 = vec4(0)
//   'screen' attachment 0 = vec4(0, 0, 0, a), attachment 1 = its linear
//            premultiplied colour, so the output pass keeps it exact
// Nothing is tone mapped here; the output pass does that once (D3).
//
// Thin layers on top of another surface (screen, glare, lens cover glass)
// are overlay layers: depthWrite off and a polygon offset toward the
// camera. Under a reversed depth buffer three r186 negates only the offset
// FACTOR (WebGLState.js:871), so the units' sign is flipped here.

import {
  AddEquation,
  Color,
  CustomBlending,
  FrontSide,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  OneFactor,
  ZeroFactor,
  type Material,
  type Object3D,
  type Texture,
  } from 'three';
import type { DeviceModel, FrameMaterial } from '../../../shared/devices';
import type { Body3D } from '../../../shared/devices3d';
import { flagFade, lodBias, mrtOutput, noRectLights, rectSpecularOnly, roomEnv, screenLookup } from './passes';
import { FLASH_GROUP, BAND_GROUP, FRONT_GLASS_GROUP, FRONT_GROUP, isUnibody, type PhonePart } from './geometry';

// ---------------------------------------------------------------------------
// bandF0: a finish swatch → a believable metal reflectance

/**
 * Base metal reflectance (linear RGB) and the luminance floor a finish is
 * lifted to. Aluminium's floor is 0.16, not the spec's 0.30: anodised
 * aluminium is a dyed oxide, and at 0.30 every dark finish (Deep Blue,
 * Midnight, Black) turned into light grey in the turntable, while 0.16
 * keeps them dark and still lets the softbox streaks read as metal.
 */
export const METAL_F0: Record<FrameMaterial, { f0: [number, number, number]; floor: number }> = {
  titanium: { f0: [0.54, 0.5, 0.45], floor: 0.18 },
  steel: { f0: [0.56, 0.57, 0.58], floor: 0.18 },
  aluminum: { f0: [0.91, 0.92, 0.92], floor: 0.16 },
};

/** Rec. 709 luminance of a linear colour. */
export const luminance = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * The finishes in devices.ts are marketing swatches (Black #2E2E30, Space
 * Black #403E3D, Deep Blue #3A4659). As metal F0 they reflect 3–5%: a black
 * mirror that reads as plastic. So a swatch below its metal's floor is
 * lifted to the floor by SCALING its linear colour, which keeps its hue and
 * saturation (mixing toward the grey base F0, the spec's first idea, turned
 * Deep Blue grey). If a channel would pass 1 it is pulled toward the neutral
 * grey of the same luminance. A black swatch takes the base metal's own
 * tint at the floor. Swatches already above the floor are kept.
 */
export function bandF0(hex: string, material: FrameMaterial): Color {
  const c = new Color().setStyle(hex); // linear (ColorManagement on)
  const { f0, floor } = METAL_F0[material];
  const L0 = luminance(c);
  if (L0 >= floor) return c;
  if (L0 < 1e-4) {
    const b = new Color(f0[0], f0[1], f0[2]);
    return b.multiplyScalar(floor / luminance(b));
  }
  const m = c.clone().multiplyScalar(floor / L0);
  const peak = Math.max(m.r, m.g, m.b);
  if (peak > 1) {
    // Mix toward grey (same luminance) just enough to bring the peak to 1.
    const t = (peak - 1) / (peak - floor);
    m.lerp(new Color(floor, floor, floor), t);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Shader patches: one implementation, in passes.ts (it owns the MRT layout).

export { LOD_BIAS, LOD_MAP_FRAGMENT, MRT_DECL, lodBias, mrtOutput } from './passes';

/** Overlay layer (screen, glare, lens cover): no depth write, pulled toward the camera. */
export function overlay<M extends Material>(mat: M, reversedDepth: boolean): M {
  mat.depthWrite = false;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = reversedDepth ? 4 : -4;
  return mat;
}

/** Add the specular only (black base): rgb += src, alpha unchanged, so coverage stays correct. */
function reflectionOnly<M extends Material>(mat: M): M {
  mat.blending = CustomBlending;
  mat.blendEquation = AddEquation;
  mat.blendSrc = OneFactor;
  mat.blendDst = OneFactor;
  mat.blendEquationAlpha = AddEquation;
  mat.blendSrcAlpha = ZeroFactor;
  mat.blendDstAlpha = OneFactor;
  return mat;
}

// ---------------------------------------------------------------------------
// The material set

export type BackFinish = 'glossy' | 'frosted';

export interface PhoneMaterials {
  band: MeshPhysicalMaterial;
  antenna: MeshPhysicalMaterial;
  seam: MeshPhysicalMaterial;
  frontGlass: MeshPhysicalMaterial;
  glassRim: MeshPhysicalMaterial;
  glare: MeshPhysicalMaterial;
  back: MeshPhysicalMaterial;
  backPanel: MeshPhysicalMaterial;
  plateau: MeshPhysicalMaterial;
  lensRing: MeshPhysicalMaterial;
  lensBarrel: MeshPhysicalMaterial;
  lensElements: [MeshPhysicalMaterial, MeshPhysicalMaterial, MeshPhysicalMaterial];
  lensRetainer: MeshPhysicalMaterial;
  lensHood: MeshPhysicalMaterial;
  lensCover: MeshPhysicalMaterial;
  flashRing: MeshPhysicalMaterial;
  flash: MeshPhysicalMaterial;
  flashFresnel: MeshPhysicalMaterial;
  sensor: MeshPhysicalMaterial;
  decal: MeshPhysicalMaterial;
  cameraControl: MeshPhysicalMaterial;
  screen: MeshBasicMaterial;
  /** Every material once (for disposal and envMapIntensity). */
  all: Material[];
}

export interface MaterialOptions {
  /** renderer.state.buffers.depth.getReversed(): flips the overlay polygon-offset units. */
  reversedDepth?: boolean;
  /** Polished (not brushed) titanium band: the iPhone Air. */
  polishedBand?: boolean;
  /** The back is metal, not glass (iPads; the 17 Pro unibody). */
  backMetal?: boolean;
  /** The plateau is metal (17 Pro unibody) or the lens ring metal (single-lens turret). */
  plateau?: 'glass' | 'band' | 'lensRing';
}

const srgb = (hex: string) => new Color().setStyle(hex);

/**
 * How far each back surface's colour is mixed toward white (sRGB). The spec
 * started at 8% (glossy) and 20% (frosted); in the turntable 20% turned
 * Black Titanium's back mid-grey under the key, so the frosted lift is 6%
 * (the etched surface's own specular already lightens it). The unibody's
 * Ceramic Shield panel reads a step lighter than the aluminium around it.
 */
/** The lens elements under the cover, top to bottom: roughness, specular (× the 6.7% F0 of ior 1.7 glass) and the
 *  coating's cast. Saturated casts (violet, green, amber) so each element's reflection of a softbox reads as the
 *  coloured glint of coated optics, ring inside ring (round 2's pale casts read as flat dark discs). */
export const LENS_ELEMENTS = [
  { roughness: 0.04, specular: 1, cast: '#a48cff' },
  { roughness: 0.1, specular: 1, cast: '#6fe0a4' },
  { roughness: 0.2, specular: 0.6, cast: '#ffd9a0' },
] as const;
/** Lens cover glass roughness: a softbox reflects as a soft round highlight (0.02 drew it as a hard square). */
export const LENS_COVER_ROUGHNESS = 0.02;
/** Lens cover specularIntensity: × the 4% F0 of glass ≈ 1.2% straight on (AR coated). */
export const LENS_COVER_SPECULAR = 1;

/**
 * The front cover glass is ONE sheet: the black border round the screen
 * (frontGlass) and the sheen over the screen (glare) reflect with the same
 * roughness and the same strength, so a reflection runs across the whole
 * front unbroken (round 1's border mirror stopped at the screen edge in a
 * grey-white halo). The glare is added on top of the screen after its
 * texture lookup (mrtOutput 'glare'), so the screen pixels themselves stay
 * exact.
 * The glass mirrors the softboxes only (envMapIntensity 0): the set round the
 * phone is the room's fill, and a fill reflected across the whole screen is a
 * grey veil, not a sheen (round 2 kept it under 25% by making the glass weak,
 * and the judges saw no reflection at any angle). A softbox draws a
 * soft-edged reflection that slides across the front as the phone turns, its
 * edges crossing the screen. On white UI the sheen is lost in the white, as on
 * a real phone; on dark UI and the border it shows.
 * Facing the camera the glass mirrors the studio's black flag round the lens
 * (FRONT_GLASS_FLAG), so the screen at FRONT is exact for every preset and key
 * azimuth. Look round 4 relied on placing no box near the camera axis, and
 * that held only for studio at the default azimuth: the box above the camera
 * lifted dark UI at the top of a FRONT screen by up to 93 levels (26.7 dB
 * against flat, gate 40), and soft or a mirrored key veiled the whole screen.
 */
export const FRONT_GLASS_ROUGHNESS = 0.04;
/** The front glass's reflection knee (passes.ts roomEnv): the room's walls fade, its lights stay. */
export const FRONT_GLASS_KNEE = 1;
/** The glare's strength per unit of phone3d.glass: the default 0.25 → 1, bare cover glass (4% straight on, rising
 *  toward grazing), so a softbox reflects as a faint sheet that slides over the screen as the phone turns; glass 1
 *  → 4, a glossy showroom mirror. Round 3's anti-reflective 1.4% vanished on white UI at every angle (all three
 *  judges: no reflection at any angle, a flat print). Facing the camera the flag (FRONT_GLASS_FLAG) keeps the
 *  screen exact; one sheet for the border and the screen. */
export const FRONT_GLASS_SPECULAR_PER_GLASS = 4;
/**
 * The black flag round the camera lens, as the angle between the screen's normal and the camera's axis: the front
 * glass (border and glare) reflects nothing within `clearDeg` and fully from `fullDeg` (smoothstep between, on the
 * sine; projection.ts screenAxisSin is the same number on the CPU, so a sample inside clearDeg skips the glare draw).
 * The clear zone covers every angle where the screen must be read: the busy-time rule (direct.ts BUSY_FACING_DEG,
 * 12°: the phone stays within it for every tap), bold's resting pose (BOLD_BASE, 9.4°), the spin-in's landing
 * (turn 4) and the floor fix's camera elevation (warnings.ts FLOOR_FIX_ELEVATION, 12°), plus 1° so a pose exactly on
 * 12° is not on the edge. Fix round 1's 5° left a grey veil on dark UI at BOLD_BASE (18.9 dB) and at elevation 12.
 * The sheen is full from 25°, below the hero layback (about 29°), so the layback and every turn show all of it.
 */
export const FRONT_GLASS_FLAG = { clearDeg: 13, fullDeg: 25 } as const;
export const FRONT_GLASS_FLAG_SIN = {
  clear: Math.sin((FRONT_GLASS_FLAG.clearDeg * Math.PI) / 180),
  full: Math.sin((FRONT_GLASS_FLAG.fullDeg * Math.PI) / 180),
} as const;

/** The front glass's specularIntensity for a phone3d.glass value (border and glare alike). */
export const frontGlassSpecular = (glass: number) => Math.max(0, glass) * FRONT_GLASS_SPECULAR_PER_GLASS;

/** The front glass's rounded rim (always bare polished glass, whatever phone3d.glass is). */
export const GLASS_RIM = { roughness: 0.06, specular: 1.5 } as const;

export const BACK_LIFT = { glossy: 0.04, frosted: 0.06 };
/** The flash diffuser's colour (sRGB). */
export const FLASH_DIFFUSER = '#cdc8bc';
/** The LiDAR / front camera glass's colour under its clear cover (sRGB). */
export const SENSOR_COLOR = '#100e16';
/** Camera Control's sapphire: the finish's metal colour × this (a dark glass that still reads as the finish's). */
export const CAMERA_CONTROL_TINT = 0.12;
/**
 * The unibody panel's frosted Ceramic Shield over the colour layer (look round 4). Round 3 made it a diffuse
 * dielectric in the metal's colour; a diffuse surface and a metal answer the light differently, so the panel came
 * out darker than the metal round it in most poses and read as a recessed tray or a sticker. Now it is the SAME
 * metal (same reflectance, so it tracks the aluminium's brightness in every pose and light), a touch desaturated,
 * rougher (the etched glass spreads each highlight wider and dimmer) under a satin clearcoat (the glass surface's
 * own soft sheen). It differs from the aluminium only by finish, as on the phone.
 */
export const PANEL = { metalness: 0.3, roughness: 0.4, desaturate: 0.1, lift: 1.0, clearcoat: 0.8, clearcoatRoughness: 0.2 } as const;
/** The lens and flash rings: the finish's metal, darker and less saturated (a deeper shade of the body, not a bright bezel). */
export const LENS_RING = { darken: 0.55, desaturate: 0.4, roughness: 0.3 } as const;
/** Mix a swatch toward white by `t` in sRGB (how a designer lightens a colour), returned linear. */
function towardWhite(hex: string, t: number): Color {
  const c = new Color().setStyle(hex);
  const s = c.clone().convertLinearToSRGB();
  s.lerp(new Color(1, 1, 1), t);
  return s.convertSRGBToLinear();
}

function physical(params: ConstructorParameters<typeof MeshPhysicalMaterial>[0], room: { knee?: number } = {}): MeshPhysicalMaterial {
  const m = roomEnv(mrtOutput(new MeshPhysicalMaterial(params), 'lit'), room);
  // A metal has no diffuse term: skip the rect lights' diffuse integral (exact, and a third of their cost).
  return params?.metalness === 1 ? rectSpecularOnly(m) : m;
}

/** Anodised aluminium roughness (the 17 Pro unibody, the 16/17 bands). */
export const ALUMINIUM_ROUGHNESS = 0.16;

function bandMaterial(hex: string, material: FrameMaterial, polished: boolean): MeshPhysicalMaterial {
  const color = bandF0(hex, material);
  if (material === 'steel') return physical({ color, metalness: 1, roughness: 0.08 });
  if (material === 'titanium') {
    return polished
      ? physical({ color, metalness: 1, roughness: 0.12, anisotropy: 0.2 })
      : physical({ color, metalness: 1, roughness: 0.32, anisotropy: 0.5 });
  }
  // Anodised aluminium: satin. With the softboxes as lights at a finite distance (look round 3), 0.3 spreads each
  // box into a broad soft highlight that slides over the back and the band; round 2's 0.24 was chosen against
  // an environment-only studio, where the back had no other way to fall off.
  return physical({ color, metalness: 1, roughness: ALUMINIUM_ROUGHNESS });
}

/**
 * The materials for one finish. `back` is already resolved ('auto' →
 * Body3D.back, see materialsForDevice). Cached (LRU 6); evicted sets are
 * disposed.
 */
export function materialsFor(hex: string, material: FrameMaterial, back: BackFinish, glass: number, opts: MaterialOptions = {}): PhoneMaterials {
  const key = JSON.stringify([hex.toLowerCase(), material, back, round3(glass), !!opts.reversedDepth, !!opts.polishedBand, !!opts.backMetal, opts.plateau ?? 'glass']);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const set = create(hex, material, back, glass, opts);
  cache.set(key, set);
  while (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value as string;
    const old = cache.get(oldest)!;
    cache.delete(oldest);
    for (const m of old.all) m.dispose();
  }
  return set;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const CACHE_SIZE = 6;
const cache = new Map<string, PhoneMaterials>();

function create(hex: string, material: FrameMaterial, back: BackFinish, glass: number, opts: MaterialOptions): PhoneMaterials {
  const reversed = !!opts.reversedDepth;
  const band = bandMaterial(hex, material, !!opts.polishedBand);
  // Antenna lines: a dielectric filler tinted like the finish.
  const antenna = physical({ color: srgb(hex).multiplyScalar(0.55), roughness: 0.45, metalness: 0 });
  const seam = physical({ color: srgb('#0a0a0a'), roughness: 0.6, metalness: 0 });
  const spec = frontGlassSpecular(glass);
  const flag = (m: MeshPhysicalMaterial) => flagFade(m, FRONT_GLASS_FLAG_SIN.clear, FRONT_GLASS_FLAG_SIN.full);
  const frontGlass = flag(noRectLights(physical({ color: srgb('#050506'), roughness: FRONT_GLASS_ROUGHNESS, ior: 1.5, specularIntensity: spec, metalness: 0 }, { knee: FRONT_GLASS_KNEE })));
  const glare = reflectionOnly(overlay(flag(noRectLights(roomEnv(mrtOutput(new MeshPhysicalMaterial({ color: 0x000000, roughness: FRONT_GLASS_ROUGHNESS, ior: 1.5, specularIntensity: spec, metalness: 0 }), 'glare'), { knee: FRONT_GLASS_KNEE }))), reversed));
  glare.visible = glass > 0;
  // The glass's rounded rim: polished bare glass that mirrors the whole studio (set included), so the overhead
  // gradient and the strips draw a thin bright line round the front at every angle.
  const glassRim = physical({ color: srgb('#050506'), roughness: GLASS_RIM.roughness, ior: 1.5, specularIntensity: GLASS_RIM.specular, metalness: 0 });

  const glossy = (c: Color) => physical({ color: c, roughness: 0.6, specularIntensity: 0, clearcoat: 1, clearcoatRoughness: 0.02, metalness: 0 });
  const frosted = (c: Color) => physical({ color: c, roughness: 0.42, specularIntensity: 1, metalness: 0 });
  const backGlass = back === 'glossy' ? glossy(towardWhite(hex, BACK_LIFT.glossy)) : frosted(towardWhite(hex, BACK_LIFT.frosted));
  const backMat = opts.backMetal ? band : backGlass;
  // The unibody's inlaid Ceramic Shield panel (PANEL): the metal's own reflectance, desaturated, rougher, under a
  // satin clearcoat, so it reads as the same colour in a different finish in every pose.
  const backPanel = physical({
    color: desaturate(bandF0(hex, material), PANEL.desaturate).multiplyScalar(PANEL.lift),
    metalness: PANEL.metalness,
    roughness: PANEL.roughness,
    clearcoat: PANEL.clearcoat,
    clearcoatRoughness: PANEL.clearcoatRoughness,
  });

  const lensRing = physical({ color: ringColorOf(hex, material), metalness: 1, roughness: LENS_RING.roughness });
  const plateauGlass = glossy(towardWhite(hex, BACK_LIFT.glossy));
  const plateau = opts.plateau === 'band' ? band : opts.plateau === 'lensRing' ? lensRing : plateauGlass;

  const lensBarrel = physical({ color: srgb('#1c1c1f'), metalness: 1, roughness: 0.5, side: FrontSide });
  // Coated optics: near-black with a cool cast, glossy at the top, rougher deeper down. Multi-coated lens glass
  // reflects well under 1%, not the 6.7% of bare ior-1.7 glass: at full specular the key softbox showed as a white
  // block inside every lens on the turn to the back.
  // Coated optics seen through the cover: near-black domes stacked in the barrel, each reflecting the studio
  // faintly through its own coating cast (violet, green, neutral), so the lens reads as 2-3 concentric dark rings
  // with a small soft catchlight of the key on the curved top element, and parallaxes as the phone turns. The
  // retaining ring between them is dark satin metal: a thin grey ring, never a bright one.
  const lensElements = LENS_ELEMENTS.map((e) =>
    noRectLights(physical({ color: srgb('#040406'), roughness: e.roughness, metalness: 0, ior: 1.7, specularIntensity: e.specular, specularColor: srgb(e.cast) })),
  ) as PhoneMaterials['lensElements'];
  const lensRetainer = physical({ color: srgb('#3a3a40'), metalness: 1, roughness: 0.3 });
  const lensHood = physical({ color: srgb('#060607'), metalness: 0, roughness: 0.55, specularIntensity: 0.5 });
  const lensCover = reflectionOnly(
    overlay(
      noRectLights(physical({ color: srgb('#000000'), roughness: LENS_COVER_ROUGHNESS, metalness: 0, ior: 1.5, specularIntensity: LENS_COVER_SPECULAR })),
      reversed,
    ),
  );
  // Flash: a thin polished ring of the finish's metal round a frosted diffuser under a clear cover (the cover's
  // clearcoat reflects the softboxes like the lens glass does; the diffuser under it is a pale warm grey, not cream).
  const flashRing = physical({ color: ringColorOf(hex, material), metalness: 1, roughness: LENS_RING.roughness });
  // Under its cover glass (geometry.ts: a lensCover disc over it) the diffuser is frosted plastic: no coat of its own.
  const flash = physical({ color: srgb(FLASH_DIFFUSER), roughness: 0.55, metalness: 0, specularIntensity: 0.3 });
  const flashFresnel = physical({ color: srgb(FLASH_DIFFUSER).multiplyScalar(0.88), roughness: 0.5, metalness: 0, specularIntensity: 0.3 });
  // LiDAR / front camera glass: a dark violet-black disc under clear glass (clearcoat), so it reflects the studio
  // like the lens covers; round 2's matte near-#000 read as a hole.
  const sensor = physical({ color: srgb(SENSOR_COLOR), roughness: 0.35, metalness: 0, specularIntensity: 0.5 });
  const decal = physical({ color: srgb('#050505'), roughness: 0.9, metalness: 0 });
  for (const m of [flashRing, flash, flashFresnel, sensor, decal]) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = reversed ? 4 : -4;
  }
  // Camera Control: a flush sapphire strip over a dark sensor tinted by the finish: glossy glass (clearcoat) that
  // mirrors the softboxes, not a black slot.
  const cameraControl = physical({
    color: bandF0(hex, material).multiplyScalar(CAMERA_CONTROL_TINT),
    roughness: 0.3,
    metalness: 0,
    specularIntensity: 0.6,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
  });

  const screen = screenLookup(lodBias(mrtOutput(overlay(new MeshBasicMaterial({ map: null, toneMapped: false }), reversed), 'screen')));
  // The screen is the one overlay that writes depth (pulled forward by the same offset): the GPU's hidden-surface
  // removal then skips shading the glass cap under it, which covers most of a FRONT phone. The glare drawn over it
  // is at the same offset depth and passes the LESS_EQUAL test.
  screen.depthWrite = true;

  const all: Material[] = [];
  for (const m of [band, antenna, seam, frontGlass, glassRim, glare, backGlass, backPanel, plateauGlass, lensRing, lensBarrel, ...lensElements, lensRetainer, lensHood, lensCover, flashRing, flash, flashFresnel, sensor, decal, cameraControl, screen]) {
    if (!all.includes(m)) all.push(m);
  }
  return {
    band,
    antenna,
    seam,
    frontGlass,
    glassRim,
    glare,
    back: backMat,
    backPanel,
    plateau,
    lensRing,
    lensBarrel,
    lensElements,
    lensRetainer,
    lensHood,
    lensCover,
    flashRing,
    flash,
    flashFresnel,
    sensor,
    decal,
    cameraControl,
    screen,
    all,
  };
}

/** The lens and flash rings: the finish's metal reflectance, darker and less saturated (LENS_RING). */
function ringColorOf(hex: string, material: FrameMaterial): Color {
  return desaturate(bandF0(hex, material), LENS_RING.desaturate).multiplyScalar(1 - LENS_RING.darken);
}

/** Mix a linear colour toward the grey of its own luminance by t. */
function desaturate(c: Color, t: number): Color {
  const L = luminance(c);
  return c.clone().lerp(new Color(L, L, L), t);
}

// ---------------------------------------------------------------------------
// Device-level resolution and assignment

/** Bands that are polished rather than brushed (Apple: the iPhone Air has a "polished titanium frame"). */
const POLISHED_BANDS = new Set(['iphone-air']);

/**
 * Everything materialsFor needs, resolved from the device: the back
 * ('auto' → Body3D.back), polished titanium, a metal back (iPads, the 17 Pro
 * unibody) and what the plateau is made of.
 */
export function materialsForDevice(
  device: DeviceModel,
  body3d: Body3D,
  finishHex: string,
  back: 'auto' | BackFinish,
  glass: number,
  opts: Pick<MaterialOptions, 'reversedDepth'> & { cached?: boolean } = {},
): PhoneMaterials {
  const unibody = isUnibody(device, body3d);
  const resolved: MaterialOptions = {
    reversedDepth: opts.reversedDepth,
    polishedBand: POLISHED_BANDS.has(device.id),
    backMetal: unibody || device.family === 'ipad',
    plateau: unibody ? 'band' : body3d.plateau.kind === 'single' ? 'lensRing' : 'glass',
  };
  const backFinish = back === 'auto' ? body3d.back : back;
  // Uncached: the caller owns the set and disposes `all` (the engine's phone LRU does).
  if (opts.cached === false) return create(finishHex, device.material, backFinish, glass, resolved);
  return materialsFor(finishHex, device.material, backFinish, glass, resolved);
}

/** The material (or per-group list) each part uses. */
export function materialForPart(part: PhonePart, m: PhoneMaterials): Material | Material[] {
  switch (part) {
    case 'band': {
      const list: Material[] = [];
      list[BAND_GROUP.metal] = m.band;
      list[BAND_GROUP.antenna] = m.antenna;
      return list;
    }
    case 'flash': {
      const list: Material[] = [];
      list[FLASH_GROUP.ring] = m.flashRing;
      list[FLASH_GROUP.lamp] = m.flash;
      list[FLASH_GROUP.fresnel] = m.flashFresnel;
      return list;
    }
    case 'lensElements':
      return [...m.lensElements, m.lensRetainer, m.lensHood];
    case 'frontHardware': {
      const list: Material[] = [];
      list[FRONT_GROUP.lens] = m.sensor;
      list[FRONT_GROUP.ring] = m.band;
      list[FRONT_GROUP.grille] = m.decal;
      return list;
    }
    case 'button':
      return m.band;
    case 'mic':
    case 'port':
      return m.decal;
    case 'seam':
      return m.seam;
    case 'frontGlass': {
      const list: Material[] = [];
      list[FRONT_GLASS_GROUP.flat] = m.frontGlass;
      list[FRONT_GLASS_GROUP.rim] = m.glassRim;
      return list;
    }
    case 'screen':
      return m.screen;
    case 'glare':
      return m.glare;
    case 'back':
      return m.back;
    case 'backPanel':
      return m.backPanel;
    case 'plateau':
      return m.plateau;
    case 'lensRing':
      return m.lensRing;
    case 'lensBarrel':
      return m.lensBarrel;
    case 'lensCover':
      return m.lensCover;
    case 'sensor':
      return m.sensor;
    case 'cameraControl':
      return m.cameraControl;
  }
}

/** Point every mesh of a phone group (geometry.ts) at its material. Cheap; call per frame if the finish changes. */
export function applyMaterials(group: Object3D, m: PhoneMaterials) {
  group.traverse((o) => {
    const part = o.userData.part as PhonePart | undefined;
    if (part && o instanceof Mesh) o.material = materialForPart(part, m);
  });
}

/** Set the screen texture (screenTexture.ts owns it). */
export function setScreenMap(m: PhoneMaterials, map: Texture | null) {
  if (m.screen.map !== map) {
    m.screen.map = map;
    m.screen.needsUpdate = true;
  }
}

/** envMapIntensity follows light.intensity (§3.4). */
export function setEnvIntensity(m: PhoneMaterials, intensity: number) {
  for (const mat of m.all) if (mat instanceof MeshPhysicalMaterial) mat.envMapIntensity = intensity;
}

/** Drop every cached material set (context loss, unload). */
export function clearMaterialCache() {
  for (const set of cache.values()) for (const m of set.all) m.dispose();
  cache.clear();
}
