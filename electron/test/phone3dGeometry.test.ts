// WP4a: the procedural phone's geometry, materials and studio environment
// (spec §3.3, §3.4, D13, D14), built with three in node (no WebGL needed).

import { describe, expect, it } from 'vitest';
import {
  BufferGeometry,
  Color,
  CustomBlending,
  DataTexture,
  DataUtils,
  HalfFloatType,
  NearestFilter,
  UnsignedByteType,
  InstancedMesh,
  Mesh,
  MeshPhysicalMaterial,
  Quaternion,
  RectAreaLight,
  Scene,
  SRGBColorSpace,
  ShaderLib,
  ShaderMaterial,
  Texture,
  Vector3,
  type Group,
} from 'three';
import { DEVICES, genericDevice, getDevice, type DeviceModel } from '../src/shared/devices';
import { body3dFor } from '../src/shared/devices3d';
import { continuousRectPoints } from '../src/shared/phone3d/outline';
import { DEFAULT_KEY_AZIMUTH, FLAGS, KEY_ELEVATION, LIGHT_DISTANCE, LIGHT_PRESETS } from '../src/shared/phone3d/lighting';
import { defaultPhone3D, LIGHT_PRESET_NAMES } from '../src/shared/phone3d/model';
import {
  CHAMFER_MM,
  FILLET_MM,
  PHONE_PARTS,
  RENDER_ORDER,
  SEAM_D_MM,
  SEAM_W_MM,
  clearPhoneCache,
  fullBarRise,
  GLASS_EDGE_MM,
  PLATEAU_STEP,
  stepProfile,
  phoneDims2d,
  phoneModel,
  insetLoop,
  rectLoop,
  type PhoneModel,
} from '../src/renderer/src/phone3d/geometry';
import {
  LOD_MAP_FRAGMENT,
  MRT_DECL,
  METAL_F0,
  applyMaterials,
  bandF0,
  clearMaterialCache,
  luminance,
  materialsFor,
  materialsForDevice,
  mrtOutput,
  lodBias,
  FRONT_GLASS_ROUGHNESS,
  frontGlassSpecular,
  LENS_COVER_ROUGHNESS,
  LENS_ELEMENTS,
  ALUMINIUM_ROUGHNESS,
  PANEL,
  PLATEAU_WALL,
  LENS_RING,
  GLASS_RIM,
  FRONT_GLASS_KNEE,
  LENS_COVER_SPECULAR,
  FRONT_GLASS_FLAG,
  FRONT_GLASS_FLAG_SIN,
} from '../src/renderer/src/phone3d/materials';
import { RECT_DIFFUSE_LINE } from '../src/renderer/src/phone3d/passes';
import { aimStudio, boxSize, equirectDir, FLOOR_FALL, HDRI_LOOK, lightDir, placeStudio, quantizeBg, SET_TEX, studioLights, studioSet, studioScene } from '../src/renderer/src/phone3d/environment';
import { HDRI, hdriData, hdriTexture, rgbeToFloat } from '../src/renderer/src/phone3d/hdri';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { readFileSync } from 'node:fs';
import { APPLE_SWATCHES, APPLE_WRAPPER, appleFinishKey, finish3dHex } from '../src/renderer/src/phone3d/finishes3d';

const dev = (id: string) => getDevice(id)!;
const build = (d: DeviceModel): PhoneModel => phoneModel(d, body3dFor(d));
const meshes = (g: Group) => {
  const out: Mesh[] = [];
  g.traverse((o) => {
    if (o instanceof Mesh) out.push(o);
  });
  return out;
};
const part = (g: Group, name: string) => meshes(g).filter((m) => m.userData.part === name && !(m instanceof InstancedMesh));
const attr = (geo: BufferGeometry, n: string) => geo.getAttribute(n);

describe('nothing lies under the screen', () => {
  it('the front glass is a border with the screen cut out: no glass triangle on the screen plane inside the screen, and the two meet edge to edge', () => {
    for (const d of DEVICES) {
      const { group, dims } = build(d);
      const glass = part(group, 'frontGlass')[0];
      const screen = part(group, 'screen')[0];
      const z = dims.depth / 2;
      const pos = attr(glass.geometry, 'position');
      const idx = glass.geometry.index!;
      // A point strictly inside the screen's rounded rect (0.01 mm in from its edge).
      const inside = (x: number, y: number) => {
        const hw = dims.screenW / 2 - 0.01;
        const hh = dims.screenH / 2 - 0.01;
        const r = Math.max(0, dims.screenRadius - 0.01);
        const ax = Math.abs(x);
        const ay = Math.abs(y);
        if (ax > hw || ay > hh) return false;
        if (ax <= hw - r || ay <= hh - r) return true;
        return Math.hypot(ax - (hw - r), ay - (hh - r)) <= r * 0.95;
      };
      let onPlane = 0;
      for (let i = 0; i < idx.count; i += 3) {
        const v = [0, 1, 2].map((k) => idx.getX(i + k));
        if (!v.every((j) => Math.abs(pos.getZ(j) - z) < 1e-6)) continue;
        onPlane++;
        const cx = v.reduce((a, j) => a + pos.getX(j), 0) / 3;
        const cy = v.reduce((a, j) => a + pos.getY(j), 0) / 3;
        expect(inside(cx, cy), `${d.id}: glass triangle at ${cx.toFixed(2)}, ${cy.toFixed(2)} under the screen`).toBe(false);
      }
      expect(onPlane).toBeGreaterThan(0);
      // Every screen outline vertex is also a glass vertex (shared edge: no crack, no overlap).
      const sp = attr(screen.geometry, 'position');
      const key = (x: number, y: number) => `${x.toFixed(5)},${y.toFixed(5)}`;
      const glassKeys = new Set<string>();
      for (let j = 0; j < pos.count; j++) if (Math.abs(pos.getZ(j) - z) < 1e-6) glassKeys.add(key(pos.getX(j), pos.getY(j)));
      for (let j = 0; j < sp.count; j++) expect(glassKeys.has(key(sp.getX(j), sp.getY(j)))).toBe(true);
    }
  });
});

describe('every device builds', () => {
  const all = [...DEVICES, genericDevice(1179, 2556), genericDevice(1080, 1920)];
  it('covers 22 iPhones and 5 iPads', () => {
    expect(DEVICES.filter((d) => d.family === 'iphone')).toHaveLength(22);
    expect(DEVICES.filter((d) => d.family === 'ipad')).toHaveLength(5);
  });

  for (const d of all) {
    it(`${d.id} ${d.bodyMm.width}×${d.bodyMm.height}: under 60k triangles, mm bbox, unit normals, tangents`, () => {
      clearPhoneCache();
      const b3 = body3dFor(d);
      const { group, triangles, dims } = phoneModel(d, b3);
      expect(triangles).toBeGreaterThan(2000);
      expect(triangles).toBeLessThan(60_000);

      // Band bbox = the body in mm (within 0.05).
      const band = part(group, 'band')[0];
      const bb = band.geometry.boundingBox!;
      expect(Math.abs(bb.min.x + d.bodyMm.width / 2)).toBeLessThan(0.05);
      expect(Math.abs(bb.max.x - d.bodyMm.width / 2)).toBeLessThan(0.05);
      expect(Math.abs(bb.min.y + d.bodyMm.height / 2)).toBeLessThan(0.05);
      expect(Math.abs(bb.max.y - d.bodyMm.height / 2)).toBeLessThan(0.05);
      // A full-width plateau is part of the body: the band's back half reaches back to the plateau top.
      const bar = b3.plateau.kind === 'bar' || (b3.plateau.kind !== 'single' && b3.plateau.w > 0.98);
      expect(Math.abs(bb.min.z + b3.depthMm / 2 + (bar ? b3.plateau.heightMm : 0))).toBeLessThan(0.05);
      expect(Math.abs(bb.max.z - b3.depthMm / 2)).toBeLessThan(0.05);

      // Whole phone: front glass on +depth/2; the back reaches the lens tops exactly
      // where projection.ts's bodyPointsMm puts them; buttons stand 0.55 proud.
      const all3 = meshes(group).filter((m) => !(m instanceof InstancedMesh));
      let zMin = Infinity, zMax = -Infinity, xMax = -Infinity;
      for (const m of all3) {
        zMin = Math.min(zMin, m.geometry.boundingBox!.min.z);
        zMax = Math.max(zMax, m.geometry.boundingBox!.max.z);
        xMax = Math.max(xMax, m.geometry.boundingBox!.max.x);
      }
      expect(Math.abs(zMax - b3.depthMm / 2)).toBeLessThan(0.05);
      const lensTop = b3.depthMm / 2 + b3.plateau.heightMm + (b3.plateau.kind === 'single' ? 0 : b3.plateau.lensProudMm);
      expect(Math.abs(zMin + lensTop)).toBeLessThan(0.05);
      expect(dims.lensTopZ).toBeCloseTo(-lensTop, 6);
      expect(xMax).toBeGreaterThan(d.bodyMm.width / 2 + 0.25);
      expect(xMax).toBeLessThanOrEqual(d.bodyMm.width / 2 + 0.6 + 1e-9);

      for (const m of all3) {
        const n = attr(m.geometry, 'normal');
        const t = attr(m.geometry, 'tangent');
        expect(t, `${m.name} tangents`).toBeTruthy();
        for (let i = 0; i < n.count; i++) {
          const nl = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
          expect(Math.abs(nl - 1), `${m.name} normal ${i}`).toBeLessThan(1e-4);
          const tl = Math.hypot(t.getX(i), t.getY(i), t.getZ(i));
          expect(Math.abs(tl - 1), `${m.name} tangent ${i}`).toBeLessThan(1e-4);
        }
      }
      // On the band, the tangent runs along the outline: perpendicular to the normal, in the xy plane (where a
      // full-width plateau rises, it climbs with the rise).
      const n = attr(band.geometry, 'normal');
      const t = attr(band.geometry, 'tangent');
      const bandPos = attr(band.geometry, 'position');
      const rise = bar ? fullBarRise(d.bodyMm.height, b3.plateau) : null;
      for (let i = 0; i < n.count; i++) {
        expect(Math.abs(n.getX(i) * t.getX(i) + n.getY(i) * t.getY(i) + n.getZ(i) * t.getZ(i))).toBeLessThan(1e-4);
        const inRise = rise && bandPos.getY(i) > rise.y0 && bandPos.getY(i) < rise.y1 && bandPos.getZ(i) < 0;
        if (!inRise) expect(Math.abs(t.getZ(i))).toBeLessThan(1e-9);
      }

      // Parts: only known parts, no logo; seams, glass, screen, plateau and lens barrels present.
      for (const m of meshes(group)) expect(PHONE_PARTS).toContain(m.userData.part);
      for (const p of ['band', 'seam', 'frontGlass', 'screen', 'glare', 'back', 'plateau', 'lensBarrel', 'lensElements', 'lensCover', 'button']) {
        expect(part(group, p).length, p).toBeGreaterThan(0);
      }
      expect(meshes(group).some((m) => /logo|apple/i.test(m.name))).toBe(false);
    });
  }
});

describe('band profile (D14)', () => {
  /** Normals of band vertices on the right straight edge (tangent ≈ +y, x > 0), front half, as angles from +x toward +z. */
  function rightEdgeProfile(d: DeviceModel) {
    const band = part(build(d).group, 'band')[0];
    const p = attr(band.geometry, 'position');
    const n = attr(band.geometry, 'normal');
    const t = attr(band.geometry, 'tangent');
    const out: { z: number; inset: number; a: number }[] = [];
    for (let i = 0; i < p.count; i++) {
      if (p.getX(i) > 0 && Math.abs(t.getY(i) - 1) < 1e-9 && p.getZ(i) >= 0) {
        out.push({ z: p.getZ(i), inset: d.bodyMm.width / 2 - p.getX(i), a: (Math.atan2(n.getZ(i), n.getX(i)) * 180) / Math.PI });
      }
    }
    return out;
  }

  it('flat edges: wall, filleted 45° chamfer, lip; fillet rings within 0.1 mm of each chamfer edge', () => {
    const d = dev('iphone-16-pro');
    const prof = rightEdgeProfile(d);
    const angles = [...new Set(prof.map((q) => Math.round(q.a * 1000) / 1000))].sort((a, b) => a - b);
    expect(angles[0]).toBeCloseTo(0, 6);
    expect(angles).toContain(45);
    expect(angles[angles.length - 1]).toBeCloseTo(90, 6);
    // At least 2 distinct normals strictly inside each fillet (0–45, 45–90).
    expect(angles.filter((a) => a > 0.5 && a < 44.5).length).toBeGreaterThanOrEqual(2);
    expect(angles.filter((a) => a > 45.5 && a < 89.5).length).toBeGreaterThanOrEqual(2);
    // Fillet rings span about FILLET_MM·sin45 in z: they sit right at the chamfer edges.
    const d2 = body3dFor(d).depthMm / 2;
    const f1 = prof.filter((q) => q.a > 0.5 && q.a < 44.5);
    for (const q of f1) expect(Math.abs(q.z - (d2 - CHAMFER_MM))).toBeLessThan(FILLET_MM);
    // The chamfer itself: normals exactly 45° between the two fillets, no smoothing into the wall.
    const at45 = prof.filter((q) => Math.abs(q.a - 45) < 1e-6);
    expect(at45.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...at45.map((q) => q.inset)) - Math.min(...at45.map((q) => q.inset))).toBeGreaterThan(0.15);
  });

  it('rounded edges (17 Pro, Air, SE): smooth normals, no creases on the band', () => {
    for (const id of ['iphone-17-pro', 'iphone-air', 'iphone-se-3']) {
      const d = dev(id);
      const prof = rightEdgeProfile(d).sort((a, b) => a.z - b.z || a.inset - b.inset);
      // Consecutive profile samples never jump more than 12° in normal.
      for (let i = 1; i < prof.length; i++) expect(Math.abs(prof[i].a - prof[i - 1].a), id).toBeLessThan(12.01);
      expect(prof[0].a).toBeCloseTo(0, 6);
      expect(prof[prof.length - 1].a).toBeCloseTo(90, 6);
    }
  });

  it('rounded edges are round, not a flat wall with a round-over: the side curves over most of the half-depth', () => {
    for (const id of ['iphone-17-pro-max', 'iphone-17-pro', 'iphone-17', 'iphone-air', 'iphone-se-3']) {
      const d = dev(id);
      const d2 = body3dFor(d).depthMm / 2;
      const lipEnd = d.rimMm - SEAM_W_MM;
      const prof = rightEdgeProfile(d)
        .filter((q) => q.z < d2 - 1e-6 || q.a > 89.999) // drop the seam rings that share z = d2
        .sort((a, b) => a.z - b.z || a.inset - b.inset);
      /** Normal angle at height z, linear between the profile samples. */
      const angleAt = (z: number) => {
        const k = prof.findIndex((q) => q.z >= z);
        const p0 = prof[k - 1], p1 = prof[k];
        return p0.a + ((p1.a - p0.a) * (z - p0.z)) / (p1.z - p0.z);
      };
      const zWhere = (deg: number) => prof.find((q) => q.a >= deg)!.z;
      // Halfway up the half-depth the side already leans out of the wall plane.
      expect(angleAt(0.5 * d2), id).toBeGreaterThan(3);
      // The turn starts low (a flat wall would hold 0° to well above 0.6·d2) ...
      expect(zWhere(1) / d2, id).toBeLessThan(0.3);
      // ... and its first 45° spread over most of the half-depth: no short
      // fillet near the face does the work.
      expect((zWhere(45) - zWhere(1)) / d2, id).toBeGreaterThan(0.65);
      // The curve spends nearly the whole inset the visible rim allows
      // (the old flat-wall profile reached the face at 0.45 mm).
      const face = prof.find((q) => q.a > 89.999)!;
      expect(face.inset, id).toBeGreaterThan(lipEnd - 0.1);
      expect(face.inset, id).toBeLessThanOrEqual(lipEnd + 1e-6);
      // Insets grow monotonically from wall to face (convex, no dents).
      for (let i = 1; i < prof.length; i++) expect(prof[i].inset, id).toBeGreaterThanOrEqual(prof[i - 1].inset - 1e-6);
    }
  });

  it('hard creases at the seam: duplicated rings with normals ≥ 85° apart, front and back', () => {
    for (const id of ['iphone-15-pro', 'iphone-17', 'ipad-air-11']) {
      const d = dev(id);
      const { group } = build(d);
      const d2 = body3dFor(d).depthMm / 2;
      const seen = new Map<string, Vector3[]>();
      for (const m of [...part(group, 'band'), ...part(group, 'seam'), ...part(group, 'frontGlass'), ...part(group, 'back')]) {
        const p = attr(m.geometry, 'position');
        const n = attr(m.geometry, 'normal');
        for (let i = 0; i < p.count; i++) {
          const k = `${p.getX(i).toFixed(5)},${p.getY(i).toFixed(5)},${p.getZ(i).toFixed(5)}`;
          const list = seen.get(k) ?? [];
          list.push(new Vector3(n.getX(i), n.getY(i), n.getZ(i)));
          seen.set(k, list);
        }
      }
      let creasesFront = 0, creasesBack = 0;
      for (const [k, ns] of seen) {
        const z = Number(k.split(',')[2]);
        let maxAngle = 0;
        for (const a of ns) for (const b of ns) maxAngle = Math.max(maxAngle, a.angleTo(b));
        if (maxAngle >= (85 * Math.PI) / 180) {
          if (Math.abs(z - (d2 - SEAM_D_MM)) < 1e-4 || Math.abs(z - d2) < 1e-4) creasesFront++;
          if (Math.abs(z + (d2 - SEAM_D_MM)) < 1e-4 || Math.abs(z + d2) < 1e-4) creasesBack++;
        }
      }
      expect(creasesFront, id).toBeGreaterThan(100);
      expect(creasesBack, id).toBeGreaterThan(100);
    }
  });

  it('antenna lines are their own material group on iPhones only', () => {
    const band = part(build(dev('iphone-15-pro')).group, 'band')[0];
    expect(band.geometry.groups.map((g) => g.materialIndex).sort()).toEqual([0, 1]);
    const ipad = part(build(dev('ipad-pro-11-m4')).group, 'band')[0];
    expect(ipad.geometry.groups.map((g) => g.materialIndex)).toEqual([0]);
  });

  it('inset rings (moved along the normals) stay within 0.025 mm of the spec\'s (w−2i, h−2i, r−i) outline', () => {
    const distToPoly = (q: [number, number], poly: [number, number][]) => {
      let best = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy));
      }
      return best;
    };
    for (const d of [dev('iphone-17-pro'), dev('iphone-13-mini'), dev('iphone-se-3'), dev('ipad-pro-11-m4')]) {
      const { W, H, bodyRadius } = phoneDims2d(d);
      for (const i of [0.35, d.rimMm, d.rimMm + 0.25]) {
        const moved = insetLoop(rectLoop(W, H, bodyRadius, 36), i);
        const ref = rectLoop(W - 2 * i, H - 2 * i, bodyRadius - i, 144).p;
        let worst = 0;
        for (const q of moved) worst = Math.max(worst, distToPoly(q, ref));
        expect(worst, `${d.id} inset ${i}`).toBeLessThan(0.025);
      }
    }
  });

  it('the outline is the 2D frame outline (continuousRectPoints, same radius)', () => {
    for (const d of [dev('iphone-17-pro'), dev('iphone-se-3'), dev('ipad-mini-a17')]) {
      const { W, H, bodyRadius } = phoneDims2d(d);
      const a = rectLoop(W, H, bodyRadius, 36).p;
      const b = continuousRectPoints(W, H, bodyRadius, 36);
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i++) {
        expect(a[i][0]).toBeCloseTo(b[i][0], 9);
        expect(a[i][1]).toBeCloseTo(b[i][1], 9);
      }
    }
  });
});

describe('front, screen and back', () => {
  it('screen: the 2D screen outline on the glass plane with planar 0..1 UVs; overlay render order', () => {
    const d = dev('iphone-17-pro');
    const { group, dims } = build(d);
    const screen = part(group, 'screen')[0];
    const p = attr(screen.geometry, 'position');
    const uv = attr(screen.geometry, 'uv');
    let minU = 1, maxU = 0;
    for (let i = 0; i < p.count; i++) {
      expect(p.getZ(i)).toBeCloseTo(body3dFor(d).depthMm / 2, 6);
      expect(uv.getX(i)).toBeCloseTo((p.getX(i) + dims.screenW / 2) / dims.screenW, 6);
      expect(uv.getY(i)).toBeCloseTo((p.getY(i) + dims.screenH / 2) / dims.screenH, 6);
      minU = Math.min(minU, uv.getX(i));
      maxU = Math.max(maxU, uv.getX(i));
    }
    expect(minU).toBeCloseTo(0, 6);
    expect(maxU).toBeCloseTo(1, 6);
    expect(screen.renderOrder).toBe(RENDER_ORDER.screen);
    expect(part(group, 'glare')[0].renderOrder).toBe(RENDER_ORDER.glare);
    expect(part(group, 'frontGlass')[0].renderOrder).toBe(RENDER_ORDER.glass);
    expect(part(group, 'lensElements')[0].renderOrder).toBe(RENDER_ORDER.lensElements);
    expect(part(group, 'lensCover')[0].renderOrder).toBe(RENDER_ORDER.lensCover);
  });

  it('camera sits on the side-button side (+x) at the top; the plateau faces −z', () => {
    for (const d of DEVICES.filter((x) => x.family === 'iphone')) {
      const b3 = body3dFor(d);
      const cover = part(build(d).group, 'lensCover')[0];
      const bb = cover.geometry.boundingBox!;
      const c = bb.getCenter(new Vector3());
      expect(c.x, d.id).toBeGreaterThan(0);
      expect(c.y, d.id).toBeGreaterThan(d.bodyMm.height / 4);
      expect(c.z, d.id).toBeLessThan(-b3.depthMm / 2);
      const n = attr(cover.geometry, 'normal');
      expect(n.getZ(0)).toBeCloseTo(-1, 9);
    }
  });

  it('lens barrels: at least 0.2 mm deep, three element groups, a retaining ring and a hood', () => {
    for (const id of ['iphone-16-pro', 'iphone-13', 'iphone-se-3', 'iphone-16e', 'iphone-17-pro-max']) {
      const { group } = build(dev(id));
      const barrel = part(group, 'lensBarrel')[0];
      const bb = barrel.geometry.boundingBox!;
      expect(bb.max.z - bb.min.z, id).toBeGreaterThanOrEqual(0.2);
      const els = part(group, 'lensElements')[0];
      expect(new Set(els.geometry.groups.map((g) => g.materialIndex))).toEqual(new Set([0, 1, 2, 3, 4]));
      // Look round 4: the elements shade as domes (normals tilting well off the axis toward the rim), not flat discs
      // that mirror a softbox edge as one straight line.
      const en = attr(els.geometry, 'normal');
      let tilt = 0;
      for (let i = 0; i < en.count; i++) tilt = Math.max(tilt, Math.acos(Math.min(1, Math.abs(en.getZ(i)))) * (180 / Math.PI));
      expect(tilt, id).toBeGreaterThan(40);
      // Element discs sit at three different depths between the cover and the barrel floor.
      const cz = part(group, 'lensCover')[0].geometry.boundingBox!.min.z;
      const ez = els.geometry.boundingBox!;
      expect(ez.min.z).toBeGreaterThan(cz - 1e-9);
      expect(ez.max.z).toBeLessThan(bb.max.z);
    }
  });

  it('plateaus rise on a filleted curve: no face of the rise looks down at the floor (round 1 drew a black undercut there)', () => {
    for (const id of ['iphone-17-pro', 'iphone-16-pro', 'iphone-air', 'iphone-17']) {
      const { group } = build(dev(id));
      const pl = part(group, 'plateau')[0];
      const n = attr(pl.geometry, 'normal');
      let steepest = 0;
      let corner = 0;
      for (let i = 0; i < n.count; i++) {
        // A face of the rise that points down (−y) must also point out of the back (−z): never a vertical wall.
        const a = Math.acos(Math.min(1, -n.getZ(i))) * (180 / Math.PI);
        if (n.getY(i) < -0.2) corner = Math.max(corner, a);
        if (n.getY(i) < -0.5) steepest = Math.max(steepest, a);
      }
      // The bottom edge rises at most the machined step's wall angle (PLATEAU_STEP.wall); a bar's corners, where it
      // turns flush into the body sides, a little steeper. Round 1's wall was 90° along the whole edge.
      expect(steepest, id).toBeLessThan(PLATEAU_STEP.wall + 2);
      expect(corner, id).toBeLessThan(80);
    }
  });

  it('a full-width plateau rises on a crisp machined step (look round 4): a short steep wall between a small foot fillet and a rounded top edge', () => {
    for (const h of [2.55, 3.03, 0.6]) {
      const prof = stepProfile(h);
      // Round 3's smootherstep ran 4.8 mm across (a soft ramp that read as a crease or a folded plate).
      expect(prof.run, `h ${h}`).toBeLessThan(2.5);
      expect(prof.at(0).dz).toBeCloseTo(0, 9);
      expect(prof.at(prof.run).dz).toBeCloseTo(h, 9);
      expect(prof.at(0).dzdy).toBeCloseTo(0, 6);
      expect(prof.at(prof.run).dzdy).toBeCloseTo(0, 6);
      // Tangent-continuous and monotone: no kink a reflection would break on.
      let prev = prof.at(0);
      let steepest = 0;
      for (let k = 1; k <= 2000; k++) {
        const q = prof.at((prof.run * k) / 2000);
        expect(q.dz).toBeGreaterThanOrEqual(prev.dz - 1e-12);
        expect(Math.abs(Math.atan(q.dzdy) - Math.atan(prev.dzdy))).toBeLessThan(0.05);
        steepest = Math.max(steepest, q.dzdy);
        prev = q;
      }
      expect(Math.atan(steepest) * (180 / Math.PI)).toBeCloseTo(PLATEAU_STEP.wall, 1);
    }
  });

  it('a full-width plateau grows out of the band: its sides are the band, its rise meets the band with no crack', () => {
    for (const id of ['iphone-17-pro', 'iphone-17-pro-max', 'iphone-air']) {
      const d = dev(id);
      const b3 = body3dFor(d);
      const { group, dims } = build(d);
      const W = d.bodyMm.width;
      const H = d.bodyMm.height;
      const d2 = dims.depth / 2;
      const h = b3.plateau.heightMm;
      const rise = fullBarRise(H, b3.plateau);
      const band = part(group, 'band')[0];
      const bp = attr(band.geometry, 'position');
      // Above the rise the band's back half reaches the plateau top; below it, the back. Never past the body sides.
      let topZ = 0;
      let lowZ = 0;
      for (let i = 0; i < bp.count; i++) {
        const y = bp.getY(i);
        if (y > rise.y1 - 1e-4 && y < H / 2 - 20) topZ = Math.min(topZ, bp.getZ(i));
        if (y < rise.y0 + 1e-4 && y > -H / 2 + 20) lowZ = Math.min(lowZ, bp.getZ(i));
        expect(Math.abs(bp.getX(i)), id).toBeLessThanOrEqual(W / 2 + 1e-6);
      }
      expect(topZ, id).toBeCloseTo(-(d2 + h), 4);
      expect(lowZ, id).toBeCloseTo(-d2, 4);
      // The plateau surfaces stay inside the band's lip: nothing overhangs the sides (round 2: 9 px at turn 150).
      const surf = [...part(group, 'plateau'), ...part(group, 'back')];
      for (const m of surf) {
        const p = attr(m.geometry, 'position');
        for (let i = 0; i < p.count; i++) expect(Math.abs(p.getX(i)), id).toBeLessThan(W / 2 - dims.rim + SEAM_W_MM + 1e-4);
      }
      // No crack: every band vertex on the back's edge inside the rise (the lip on the unibody, the glass edge's
      // inner ring on a glass back) has a back or plateau vertex at the same point.
      const key = (x: number, y: number, z: number) => `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
      const surfPts = new Set<string>();
      for (const m of surf) {
        const p = attr(m.geometry, 'position');
        for (let i = 0; i < p.count; i++) surfPts.add(key(p.getX(i), p.getY(i), p.getZ(i)));
      }
      const edgeX = W / 2 - (dims.unibody ? dims.rim - SEAM_W_MM : dims.rim + GLASS_EDGE_MM);
      const edgeSrc = dims.unibody ? [band] : part(group, 'back');
      let checked = 0;
      for (const m of edgeSrc) {
        const p = attr(m.geometry, 'position');
        for (let i = 0; i < p.count; i++) {
          const y = p.getY(i);
          if (y < rise.y0 - 1e-4 || y > rise.y1 + 1e-4 || Math.abs(Math.abs(p.getX(i)) - edgeX) > 1e-4) continue;
          if (Math.abs(p.getZ(i) + d2 + rise.at(y).dz) > 1e-4) continue;
          expect(surfPts.has(key(p.getX(i), y, p.getZ(i))), `${id} edge vertex at y ${y.toFixed(3)}`).toBe(true);
          checked++;
        }
      }
      expect(checked, id).toBeGreaterThanOrEqual(2 * 21);
      let prev = -Infinity;
      for (const y of rise.rows) {
        const r = rise.at(y);
        expect(r.dz).toBeGreaterThanOrEqual(prev);
        prev = r.dz;
        expect(r.dzdy).toBeGreaterThanOrEqual(0);
      }
      expect(rise.at(rise.y0).dzdy).toBeCloseTo(0, 12);
      expect(rise.at(rise.y1).dzdy).toBeCloseTo(0, 12);
      expect(rise.at(rise.y1).dz).toBeCloseTo(h, 9);
    }
  });

  it('side buttons are crowned (their tops curve like the band) and about 3.5 mm across', () => {
    const { group, dims } = build(dev('iphone-17-pro'));
    const b = part(group, 'button')[0];
    const n = attr(b.geometry, 'normal');
    // Normals on the left-side buttons spread smoothly from the side (−x) toward the faces: a dome, not a flat top.
    const tilts = new Set<number>();
    for (let i = 0; i < n.count; i++) if (n.getX(i) < -0.2) tilts.add(Math.round(Math.acos(-n.getX(i)) * (180 / Math.PI) / 10));
    expect(tilts.size).toBeGreaterThanOrEqual(6);
    const bb = b.geometry.boundingBox!;
    expect(bb.max.z - bb.min.z).toBeLessThan(4);
    expect(bb.max.z - bb.min.z).toBeGreaterThan(0.3 * dims.depth);
  });

  it('17 Pro: aluminium unibody back with an inlaid glass panel in a fine metal seam (no black keyline); no back seam at the band', () => {
    const { group, dims } = build(dev('iphone-17-pro'));
    expect(dims.unibody).toBe(true);
    expect(part(group, 'backPanel').length).toBe(1);
    // The only dark seam is the front one: the panel sits in a 0.05 mm step of the back's own metal.
    expect(part(group, 'seam').map((m) => m.name)).toEqual(['seam']);
    const seamBox = part(group, 'seam')[0].geometry.boundingBox!;
    expect(seamBox.min.z).toBeGreaterThan(0);
    const back = part(group, 'back')[0].geometry.boundingBox!;
    const panel = part(group, 'backPanel')[0].geometry.boundingBox!;
    expect(back.max.z).toBeCloseTo(-dims.depth / 2 + 0.05, 6);
    expect(panel.max.z).toBeCloseTo(-dims.depth / 2 + 0.05, 6);
    expect(panel.min.z).toBeCloseTo(-dims.depth / 2, 6);
    expect(build(dev('iphone-16-pro')).dims.unibody).toBe(false);
    expect(part(build(dev('iphone-16-pro')).group, 'backPanel').length).toBe(0);
  });

  it('is deterministic: the same arrays on a rebuild', () => {
    const d = dev('iphone-air');
    clearPhoneCache();
    const a = meshes(build(d).group).map((m) => Array.from(attr(m.geometry, 'position').array));
    clearPhoneCache();
    const b = meshes(build(d).group).map((m) => Array.from(attr(m.geometry, 'position').array));
    expect(a).toEqual(b);
  });

  it('caches 3 phones and disposes the evicted one', () => {
    clearPhoneCache();
    const first = build(dev('iphone-17-pro'));
    let disposed = 0;
    first.group.traverse((o) => {
      if (o instanceof Mesh) o.geometry.addEventListener('dispose', () => disposed++);
    });
    expect(build(dev('iphone-17-pro'))).toBe(first);
    build(dev('iphone-16'));
    build(dev('iphone-air'));
    expect(disposed).toBe(0);
    build(dev('iphone-se-3'));
    expect(disposed).toBeGreaterThan(0);
  });
});

describe('materials (§3.4)', () => {
  const hue = (c: Color) => c.clone().getHSL({ h: 0, s: 0, l: 0 }, SRGBColorSpace);

  it('bandF0 meets each luminance floor and keeps the hue of every finish', () => {
    for (const d of DEVICES) {
      for (const f of d.finishes) {
        const out = bandF0(f.hex, d.material);
        const floor = METAL_F0[d.material].floor;
        expect(luminance(out), `${d.id} ${f.name}`).toBeGreaterThanOrEqual(floor - 1e-6);
        const src = new Color().setStyle(f.hex);
        const hs = hue(src);
        const ceiling = METAL_F0[d.material].ceiling;
        expect(luminance(out), `${d.id} ${f.name}`).toBeLessThanOrEqual(ceiling + 1e-6);
        if (luminance(src) > ceiling) expect(luminance(out)).toBeCloseTo(ceiling, 6);
        else if (luminance(src) >= floor) expect(out.getHex()).toBe(src.getHex());
        else if (hs.s > 0.15) {
          const dh = Math.abs(hue(out).h - hs.h);
          expect(Math.min(dh, 1 - dh) * 360, `${d.id} ${f.name}`).toBeLessThan(3);
        }
      }
    }
  });

  it('pins black, silver and orange', () => {
    const orange = bandF0('#E8732F', 'aluminum');
    const h = hue(orange);
    expect(h.h * 360).toBeGreaterThan(14);
    expect(h.h * 360).toBeLessThan(30);
    expect(h.s).toBeGreaterThan(0.5);
    // Silver: a light grey under the ceiling, its own grey kept (not white).
    const silver = bandF0('#F5F5F5', 'aluminum');
    expect(luminance(silver)).toBeCloseTo(METAL_F0.aluminum.ceiling, 6);
    expect(Math.max(silver.r, silver.g, silver.b) - Math.min(silver.r, silver.g, silver.b)).toBeLessThan(0.01);
    const black = bandF0('#3C3C3D', 'titanium');
    expect(luminance(black)).toBeCloseTo(0.18, 3);
    expect(Math.max(black.r, black.g, black.b) - Math.min(black.r, black.g, black.b)).toBeLessThan(0.05);
    // Deep Blue stays blue (saturation kept), not the grey that mixing toward the base F0 gave.
    const blue = bandF0('#3A4659', 'aluminum');
    expect(hue(blue).s).toBeGreaterThan(0.85 * hue(new Color().setStyle('#3A4659')).s);
    expect(hue(blue).h * 360).toBeGreaterThan(205);
    expect(hue(blue).h * 360).toBeLessThan(225);
  });

  it('matches the material table: anodised aluminium under a satin seal; no clearcoat on steel, titanium or front glass', () => {
    clearMaterialCache();
    const steel = materialsFor('#403E3D', 'steel', 'frosted', 0.25);
    expect(steel.band.metalness).toBe(1);
    expect(steel.band.roughness).toBe(0.08);
    expect(steel.band.clearcoat).toBe(0);
    const ti = materialsFor('#3C3C3D', 'titanium', 'frosted', 0.25);
    expect(ti.band.roughness).toBe(0.32);
    expect(ti.band.anisotropy).toBe(0.5);
    const al = materialsFor('#2F2F31', 'aluminum', 'glossy', 0.25);
    expect(al.band.roughness).toBe(ALUMINIUM_ROUGHNESS);
    // Look v2 (owner decision 15): bare anodised metal, no clear seal. Round 4's seal drew WHITE lines over the colour,
    // the painted-plastic look; with the studio HDRI as a room the metal's own coloured reflections carry the form.
    expect(al.band.clearcoat).toBe(0);
    expect(al.band.metalness).toBe(1);
    // Glossy back: diffuse colour layer under one glass coat.
    expect(al.back.roughness).toBe(0.6);
    expect(al.back.specularIntensity).toBe(0);
    expect(al.back.clearcoat).toBe(1);
    expect(al.back.clearcoatRoughness).toBe(0.02);
    // Frosted back: the etched surface, no coat.
    expect(ti.back.roughness).toBe(0.42);
    expect(ti.back.specularIntensity).toBe(1);
    expect(ti.back.clearcoat).toBe(0);
    // Plateau stays glossy glass on a frosted Pro.
    expect(ti.plateau.clearcoat).toBe(1);
    // Front glass: AR-coated, one lobe; the border and the screen's sheen are ONE sheet (same roughness, same
    // strength from the glass setting), so a reflection crosses the whole front with no halo at the screen edge.
    expect(ti.frontGlass.clearcoat).toBe(0);
    expect(ti.frontGlass.roughness).toBe(FRONT_GLASS_ROUGHNESS);
    expect(ti.glare.roughness).toBe(FRONT_GLASS_ROUGHNESS);
    expect(ti.frontGlass.specularIntensity).toBe(frontGlassSpecular(0.25));
    expect(ti.glare.specularIntensity).toBe(ti.frontGlass.specularIntensity);
    // Look round 4: the default glass is bare cover glass (4% straight on: specular 1); glass 1 is a glossy mirror.
    expect(frontGlassSpecular(0.25)).toBeCloseTo(1, 9);
    // The glass mirrors the room (the HDRI) through a knee, never the softboxes: a 60°-wide softbox mirrored at 4% was
    // the grey veil over the screen and the island at every angle past the flag (look v2).
    expect(ti.frontGlass.envMapIntensity).toBe(1);
    expect(ti.glare.envMapIntensity).toBe(1);
    for (const m of [ti.frontGlass, ti.glare]) {
      const key = m.customProgramCacheKey().split('|');
      expect(key).toContain('no-rect');
      expect(key).toContain(`room-env-knee-${FRONT_GLASS_KNEE.toFixed(3)}`);
    }
    expect(FRONT_GLASS_ROUGHNESS).toBeLessThan(0.08);
    expect(frontGlassSpecular(0)).toBe(0);
    expect(frontGlassSpecular(1)).toBe(4);
    // Its rounded rim is polished glass that mirrors the whole studio: the thin bright line round the front.
    expect(ti.glassRim.roughness).toBe(GLASS_RIM.roughness);
    expect(ti.glassRim.specularIntensity).toBe(GLASS_RIM.specular);
    expect(ti.glassRim.envMapIntensity).toBe(1);
    expect(ti.frontGlass.ior).toBe(1.5);
    expect(ti.frontGlass.color.getHexString()).toBe('050506');
    // Glare: additive, coverage untouched; none at glass 0.
    expect(ti.glare.blending).toBe(CustomBlending);
    expect(ti.glare.visible).toBe(true);
    expect(materialsFor('#3C3C3D', 'titanium', 'frosted', 0).glare.visible).toBe(false);
    // Lens cover: bare polished glass that mirrors the room (no softboxes: they drew blocky glyphs in the lenses), no
    // thin-film tint.
    expect(ti.lensCover.iridescence).toBe(0);
    expect(ti.lensCover.roughness).toBe(LENS_COVER_ROUGHNESS);
    expect(ti.lensCover.specularIntensity).toBe(LENS_COVER_SPECULAR);
    for (const m of [ti.lensCover, ...ti.lensElements]) expect(m.customProgramCacheKey().split('|')).toContain('no-rect');
    expect(ti.lensElements.map((m) => m.roughness)).toEqual(LENS_ELEMENTS.map((e) => e.roughness));
    // Unibody panel (look v2 round 2): frosted Ceramic Shield over the colour, the SAME reflectance as the aluminium
    // round it (round 1's mostly-diffuse panel read as a grey-slate or salmon sticker next to the metal); it differs
    // only by finish: rougher, under a soft glass coat.
    const uni = materialsFor('#3A4659', 'aluminum', 'frosted', 0.25, { backMetal: true, plateau: 'band' });
    expect(uni.backPanel.roughness).toBe(PANEL.roughness);
    expect(uni.backPanel.roughness).toBeGreaterThan(uni.band.roughness);
    expect(uni.backPanel.metalness).toBe(PANEL.metalness);
    expect(uni.backPanel.metalness).toBe(uni.band.metalness);
    expect(uni.backPanel.clearcoat).toBe(PANEL.clearcoat);
    expect(uni.backPanel.clearcoat).toBeGreaterThan(0);
    expect(uni.backPanel.clearcoatRoughness).toBeGreaterThanOrEqual(0.3);
    const lum = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    expect(uni.backPanel.color.r).toBeCloseTo(uni.band.color.r, 6);
    expect(uni.backPanel.color.g).toBeCloseTo(uni.band.color.g, 6);
    expect(uni.backPanel.color.b).toBeCloseTo(uni.band.color.b, 6);
    // The plateau step's wall: the plateau's metal, a touch darker, rougher and part diffuse (it faces down, away
    // from the lights: lit, it read as a lid in round 1; as a pure mirror of the dark floor, a black crease).
    expect(uni.plateauWall.metalness).toBe(PLATEAU_WALL.metalness);
    expect(uni.plateauWall.roughness).toBe(PLATEAU_WALL.roughness);
    expect(uni.plateauWall.roughness).toBeGreaterThan(uni.plateau.roughness);
    expect(lum(uni.plateauWall.color)).toBeCloseTo(lum(uni.plateau.color) * PLATEAU_WALL.tint, 6);
    expect(PLATEAU_WALL.tint).toBeLessThan(1);
    // Lens rings: a deeper, less saturated shade of the finish's metal (round 3's bright copper read as toy bezels).
    const orange = materialsFor('#E8732F', 'aluminum', 'frosted', 0.25, { backMetal: true, plateau: 'band' });
    expect(lum(orange.lensRing.color)).toBeLessThan(lum(orange.band.color) * 0.6);
    const sat = (c: { r: number; g: number; b: number }) => (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / Math.max(c.r, c.g, c.b);
    expect(sat(orange.lensRing.color)).toBeLessThan(sat(orange.band.color));
    expect(ti.lensRing.metalness).toBe(1);
    expect(ti.lensRing.roughness).toBe(LENS_RING.roughness);
    expect(ti.seam.color.getHexString()).toBe('0a0a0a');
    for (const m of [ti.band, steel.band, ti.lensRing, ti.lensBarrel]) expect(m.clearcoat).toBe(0);
  });

  it('overlay layers: polygon offset whose units flip under reversed depth; only the screen writes depth', () => {
    clearMaterialCache();
    const fwd = materialsFor('#C2BCB2', 'titanium', 'frosted', 0.25, { reversedDepth: false });
    const rev = materialsFor('#C2BCB2', 'titanium', 'frosted', 0.25, { reversedDepth: true });
    for (const [set, units] of [[fwd, -4], [rev, 4]] as const) {
      for (const m of [set.screen, set.glare, set.lensCover]) {
        expect(m.depthWrite).toBe(m === set.screen);
        expect(m.polygonOffset).toBe(true);
        expect(m.polygonOffsetFactor).toBe(-1);
        expect(m.polygonOffsetUnits).toBe(units);
      }
    }
    expect(fwd.screen.toneMapped).toBe(false);
  });

  it('mrtOutput writes both attachments; lodBias biases the screen sample', () => {
    const frag = () => ({ fragmentShader: ShaderLib.physical.fragmentShader, vertexShader: '', uniforms: {} });
    const lit = mrtOutput(new MeshPhysicalMaterial(), 'lit');
    const s1 = frag() as never as { fragmentShader: string };
    lit.onBeforeCompile(s1 as never, undefined as never);
    expect(s1.fragmentShader.startsWith(MRT_DECL)).toBe(true);
    expect(s1.fragmentShader.split(MRT_DECL).length).toBe(2);
    expect(s1.fragmentShader.trimEnd().endsWith('pc_fragScreen = vec4( 0.0 );\n}')).toBe(true);
    expect(lit.customProgramCacheKey()).toBe('mrt-lit');

    const set = materialsFor('#3C3C3D', 'titanium', 'frosted', 0.25);
    const s2 = { fragmentShader: ShaderLib.basic.fragmentShader, vertexShader: '', uniforms: {} };
    set.screen.onBeforeCompile(s2 as never, undefined as never);
    // The −0.5 bias sample through screenUv(): the uv shifted back by the sample's jitter (screenLookup).
    expect(s2.fragmentShader).toContain(LOD_MAP_FRAGMENT.replace('texture( map, vMapUv,', 'texture( map, screenUv(),'));
    expect(s2.fragmentShader).toContain('return vMapUv - dFdx( vMapUv ) * uScreenJitter.x + dFdy( vMapUv ) * uScreenJitter.y;');
    // screenUv() reads vMapUv, so it must come after three's declaration of it and before main() (round 3 first
    // put it at the top: the screen shader failed to compile and the screen vanished).
    const fs = s2.fragmentShader;
    expect(fs.indexOf('#include <uv_pars_fragment>')).toBeGreaterThan(-1);
    expect(fs.indexOf('vec2 screenUv()')).toBeGreaterThan(fs.indexOf('#include <uv_pars_fragment>'));
    expect(fs.indexOf('vec2 screenUv()')).toBeLessThan(fs.indexOf('void main() {'));
    expect(s2.fragmentShader).not.toContain('#include <map_fragment>');
    expect(s2.fragmentShader).toContain('pc_fragScreen = vec4( gl_FragColor.rgb * gl_FragColor.a, gl_FragColor.a );');
    expect(s2.fragmentShader).toContain('gl_FragColor = vec4( 0.0, 0.0, 0.0, gl_FragColor.a );');
    // Patches compose once and key the program cache.
    lodBias(set.screen);
    expect(set.screen.customProgramCacheKey()).toBe('mrt-screen|lodbias|screen-lookup');
    // Every lit material in the set is patched; the screen and the glare over it go to the screen attachment.
    for (const m of set.all) {
      expect(m.customProgramCacheKey(), m.type).toMatch(m === set.screen ? /^mrt-screen/ : m === set.glare ? /^mrt-glare\b/ : /^mrt-lit\b/);
    }
    const s3 = frag() as never as { fragmentShader: string };
    const glareOnly = mrtOutput(new MeshPhysicalMaterial(), 'glare');
    glareOnly.onBeforeCompile(s3 as never, undefined as never);
    expect(s3.fragmentShader.trimEnd().endsWith('pc_fragScreen = vec4( gl_FragColor.rgb * uGlareWeight, 0.0 );\n\tgl_FragColor = vec4( 0.0 );\n}')).toBe(true);
    expect(s3.fragmentShader.startsWith('uniform float uGlareWeight;') || s3.fragmentShader.includes('\nuniform float uGlareWeight;')).toBe(true);
  });

  it('rect lights skip their diffuse integral on metals (exact: no diffuse term there); the front glass and optics skip rect lights entirely', () => {
    clearMaterialCache();
    const set = materialsFor('#3A4659', 'aluminum', 'frosted', 0.25, { backMetal: true, plateau: 'band' });
    const frag = () => ({ fragmentShader: ShaderLib.physical.fragmentShader, vertexShader: '', uniforms: {} }) as never as { fragmentShader: string };
    const patched = (m: MeshPhysicalMaterial) => m.customProgramCacheKey().split('|').includes('rect-nodiffuse');
    for (const m of set.all) {
      if (!(m instanceof MeshPhysicalMaterial)) continue;
      const none = m.customProgramCacheKey().split('|').includes('no-rect');
      expect(patched(m), m.name || m.type).toBe(!none && m.metalness === 1);
    }
    expect(patched(set.band) && patched(set.lensRing) && patched(set.backPanel) && !patched(set.antenna)).toBe(true);
    const s1 = frag();
    set.band.onBeforeCompile(s1 as never, undefined as never);
    expect(s1.fragmentShader).not.toContain('#include <lights_physical_pars_fragment>');
    expect(s1.fragmentShader).not.toContain(RECT_DIFFUSE_LINE);
    // The specular and clearcoat integrals stay (two more LTC_Evaluate calls in the rect light function).
    const fn = s1.fragmentShader.slice(s1.fragmentShader.indexOf('void RE_Direct_RectArea_Physical'));
    expect(fn.slice(0, fn.indexOf('\n\t}\n')).split('LTC_Evaluate(').length - 1).toBe(2);
    const s2 = frag();
    set.antenna.onBeforeCompile(s2 as never, undefined as never);
    expect(s2.fragmentShader).toContain('#include <lights_physical_pars_fragment>');
  });

  it('front glass flag: the border and the glare reflect nothing within FRONT_GLASS_FLAG of the camera axis; the rim is untouched', () => {
    clearMaterialCache();
    const set = materialsFor('#3C3C3D', 'titanium', 'frosted', 0.25);
    const frag = () => ({ fragmentShader: ShaderLib.physical.fragmentShader, vertexShader: '', uniforms: {} }) as never as { fragmentShader: string };
    expect(FRONT_GLASS_FLAG_SIN.clear).toBeCloseTo(Math.sin((FRONT_GLASS_FLAG.clearDeg * Math.PI) / 180), 12);
    // The busy-time rule and the floor fix (12°) read the screen; the hero layback (about 28.6°) shows the full sheen.
    expect(FRONT_GLASS_FLAG.clearDeg).toBeGreaterThan(12);
    expect(FRONT_GLASS_FLAG.fullDeg).toBeLessThanOrEqual(25);
    for (const m of [set.frontGlass, set.glare]) {
      const s1 = frag();
      m.onBeforeCompile(s1 as never, undefined as never);
      const at = s1.fragmentShader.indexOf('#include <lights_fragment_end>');
      const fade = s1.fragmentShader.indexOf(`smoothstep( ${FRONT_GLASS_FLAG_SIN.clear.toFixed(6)}, ${FRONT_GLASS_FLAG_SIN.full.toFixed(6)}, length( nonPerturbedNormal.xy ) )`);
      expect(at).toBeGreaterThan(-1);
      expect(fade).toBeGreaterThan(at);
      // Before three sums the light: both specular terms are scaled.
      expect(fade).toBeLessThan(s1.fragmentShader.indexOf('vec3 totalSpecular'));
      expect(s1.fragmentShader.slice(fade, fade + 400)).toContain('reflectedLight.directSpecular *= flag;');
      expect(s1.fragmentShader.slice(fade, fade + 400)).toContain('reflectedLight.indirectSpecular *= flag;');
    }
    const s2 = frag();
    set.glassRim.onBeforeCompile(s2 as never, undefined as never);
    expect(s2.fragmentShader).not.toContain('nonPerturbedNormal.xy');
  });

  it('device resolution: unibody, iPad metal back, single-lens turret, polished Air', () => {
    clearMaterialCache();
    const p17 = dev('iphone-17-pro');
    const m17 = materialsForDevice(p17, body3dFor(p17), '#E8732F', 'auto', 0.25);
    expect(m17.back).toBe(m17.band);
    expect(m17.plateau).toBe(m17.band);
    const ipad = dev('ipad-pro-13-m4');
    const mi = materialsForDevice(ipad, body3dFor(ipad), '#3A3A3C', 'auto', 0.25);
    expect(mi.back).toBe(mi.band);
    const se = dev('iphone-se-3');
    const ms = materialsForDevice(se, body3dFor(se), '#232A31', 'auto', 0.25);
    expect(ms.plateau).toBe(ms.lensRing);
    const air = dev('iphone-air');
    expect(materialsForDevice(air, body3dFor(air), '#2E2E30', 'auto', 0.25).band.roughness).toBe(0.12);
    // back: 'auto' follows Body3D.back; an explicit value overrides it.
    const p16 = dev('iphone-16-pro');
    expect(materialsForDevice(p16, body3dFor(p16), '#3C3C3D', 'auto', 0.25).back.clearcoat).toBe(0);
    expect(materialsForDevice(p16, body3dFor(p16), '#3C3C3D', 'glossy', 0.25).back.clearcoat).toBe(1);
  });

  it('applyMaterials gives every mesh a material (and the band its two groups)', () => {
    for (const id of ['iphone-17-pro', 'iphone-14-pro', 'iphone-se-3', 'ipad-air-13']) {
      const d = dev(id);
      const { group } = build(d);
      applyMaterials(group, materialsForDevice(d, body3dFor(d), d.finishes[0].hex, 'auto', 0.25));
      for (const m of meshes(group)) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        expect(mats.length, `${id} ${m.name}`).toBeGreaterThan(0);
        for (const g of m.geometry.groups) expect(mats[g.materialIndex ?? 0], `${id} ${m.name} group`).toBeTruthy();
      }
    }
  });

  it('caches 6 sets and disposes the evicted one', () => {
    clearMaterialCache();
    const first = materialsFor('#111111', 'steel', 'glossy', 0.25);
    let disposed = 0;
    first.band.addEventListener('dispose', () => disposed++);
    for (let i = 0; i < 5; i++) materialsFor(`#22222${i}`, 'steel', 'glossy', 0.25);
    expect(disposed).toBe(0);
    expect(materialsFor('#111111', 'steel', 'glossy', 0.25)).toBe(first);
    for (let i = 0; i < 6; i++) materialsFor(`#33333${i}`, 'steel', 'glossy', 0.25);
    expect(disposed).toBe(1);
  });
});

describe('studio environment (owner decision 15: one CC0 studio HDRI, the hero softboxes stay lights)', () => {
  const bg = [0.4, 0.05, 0.9] as const;
  const at = (preset: (typeof LIGHT_PRESET_NAMES)[number], camAz: number, el: number) =>
    studioSet(preset, bg, lightDir(camAz - DEFAULT_KEY_AZIMUTH, el));
  const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  it('the HDRI decodes from the inlined asset: 2k RGBE, the same values as three\'s HDRLoader, a real studio (dark corners, bright lights)', () => {
    const d = hdriData();
    expect(HDRI.id).toBe('studio_small_09');
    expect([d.width, d.height]).toEqual([2048, 1024]);
    expect(d.rgbe.length).toBe(2048 * 1024 * 4);
    expect(hdriData()).toBe(d); // decoded once
    // Cross-check against three's own decoder on the shipped file (half floats, so within half precision).
    const file = readFileSync(new URL('../src/renderer/src/phone3d/assets/studio.hdr', import.meta.url));
    const loader = new HDRLoader();
    loader.setDataType(HalfFloatType);
    const ref = loader.parse(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)) as { width: number; height: number; data: Uint16Array };
    expect([ref.width, ref.height]).toEqual([d.width, d.height]);
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i < d.rgbe.length; i += 4 * 97) {
      const ours = rgbeToFloat(d.rgbe[i], d.rgbe[i + 1], d.rgbe[i + 2], d.rgbe[i + 3]);
      for (let c = 0; c < 3; c++) {
        const theirs = DataUtils.fromHalfFloat(ref.data[i + c]);
        expect(Math.abs(ours[c] - theirs)).toBeLessThanOrEqual(Math.max(1e-6, Math.abs(theirs) * 0.01));
      }
      const L = 0.2126 * ours[0] + 0.7152 * ours[1] + 0.0722 * ours[2];
      lo = Math.min(lo, L);
      hi = Math.max(hi, L);
    }
    expect(lo).toBeLessThan(0.05);
    expect(hi).toBeGreaterThan(20);
    // The GPU texture is the RGBE bytes as they are (4 B a texel), nearest filtered: the dome decodes them.
    const tex = hdriTexture();
    expect(tex.type).toBe(UnsignedByteType);
    expect(tex.minFilter).toBe(NearestFilter);
    tex.dispose();
  });

  it('the PMREM scene is the dome alone: no lights, the HDRI × the preset gain, keep and add baked from studioSet', () => {
    const map = new Texture({ width: 2048, height: 1024 });
    const s = studioScene('studio', bg, map as Texture & { image: { width: number; height: number } });
    const kinds: string[] = [];
    s.traverse((o) => {
      if (o !== s) kinds.push(o.name || o.type);
      expect((o as { isLight?: boolean }).isLight).not.toBe(true);
    });
    expect(kinds).toEqual(['studio:dome']);
    const dome = s.getObjectByName('studio:dome') as Mesh;
    const mat = dome.material as ShaderMaterial;
    expect(mat.uniforms.map.value).toBe(map);
    expect(mat.uniforms.mapSize.value.toArray()).toEqual([2048, 1024]);
    expect(mat.uniforms.yaw.value).toBeCloseTo((HDRI.yawDeg * Math.PI) / 180, 12);
    const tint = new Color().setStyle(HDRI_LOOK.studio.tint).multiplyScalar(HDRI_LOOK.studio.gain);
    expect(mat.uniforms.gainTint.value.x).toBeCloseTo(tint.r, 9);
    // A coarse dome: everything is read per pixel.
    expect(attr(dome.geometry, 'position').count).toBeLessThan(4000);
    const keep = mat.uniforms.setKeep.value as DataTexture;
    const add = mat.uniforms.setAdd.value as DataTexture;
    const { w, h } = SET_TEX;
    for (let k = 0; k < 400; k++) {
      const i = (k * 37) % w;
      const j = (k * 101) % h;
      const v = studioSet('studio', bg, equirectDir((i + 0.5) / w, (j + 0.5) / h));
      const o = (j * w + i) * 4;
      for (let c = 0; c < 3; c++) {
        expect(DataUtils.fromHalfFloat((keep.image.data as Uint16Array)[o + c])).toBeCloseTo(v.keep[c], 2);
        expect(DataUtils.fromHalfFloat((add.image.data as Uint16Array)[o + c])).toBeCloseTo(v.add[c], 2);
      }
    }
    // equirectDir inverts three's equirectUv (u round from +x toward +z, v up).
    const dir = equirectDir(0.3, 0.8);
    expect(Math.atan2(dir[2], dir[0]) / (2 * Math.PI) + 0.5).toBeCloseTo(0.3, 9);
    expect(Math.asin(dir[1]) / Math.PI + 0.5).toBeCloseTo(0.8, 9);
    expect(DEFAULT_KEY_AZIMUTH).toBe(defaultPhone3D().light.azimuth);
    for (const p of LIGHT_PRESET_NAMES) expect(HDRI_LOOK[p].gain, p).toBeGreaterThan(0);
  });

  it('flags cut the room at the sides; the floor falls off below the horizon and takes only a little of the backdrop colour', () => {
    for (const side of [-1, 1]) expect(lum(at('studio', side * FLAGS.azimuth, FLAGS.elevation).keep)).toBeLessThan(0.1);
    const up = at('studio', 0, 60).keep;
    expect(up).toEqual([1, 1, 1]);
    expect(lum(at('studio', 0, 0).keep)).toBeCloseTo(1, 6);
    const floor = at('studio', 0, -60).keep;
    expect(floor[2] / floor[1]).toBeLessThan(1.15);
    // Look v2 round 2: the floor falls to FLOOR_FALL.deep by FLOOR_FALL.toDeg (a back mirrors it as a top-to-bottom
    // gradient, the step's down-facing wall reads darker than the top face), smoothly.
    expect(lum(floor)).toBeGreaterThan(0.9 * FLOOR_FALL.deep);
    expect(lum(floor)).toBeLessThan(1.1 * FLOOR_FALL.deep);
    let prev = Infinity;
    for (let el = 0; el >= -FLOOR_FALL.toDeg - 5; el -= 2) {
      const v = lum(at('studio', 0, el).keep);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });

  it('boxes marked inEnv are painted into the set with soft edges (lights only where a flat face needs one)', () => {
    const env = LIGHT_PRESETS.studio.boxes.filter((b) => b.inEnv);
    expect(env.length).toBeGreaterThan(0);
    expect(LIGHT_PRESETS.studio.boxes.filter((b) => !b.inEnv).length).toBeGreaterThanOrEqual(5);
    expect(LIGHT_PRESETS.studio.boxes[0].inEnv).toBeUndefined();
    const set = (az: number, el: number) => lum(studioSet('studio', [0, 0, 0], lightDir(az, el)).add);
    for (const b of env) {
      const lit = set(b.azimuth, b.elevation);
      expect(lit, `${b.azimuth},${b.elevation}`).toBeGreaterThan(0.85 * b.radiance);
      expect(set(b.azimuth + 1.2 * b.halfW, b.elevation), `${b.azimuth}`).toBeLessThan(lit - 0.8 * b.radiance);
    }
  });

  it('3D finishes are Apple\'s compare-page swatches; flat keeps devices.ts; iPads fall back', () => {
    const fin = (id: string, f: string) => getDevice(id)!.finishes.find((x) => x.id === f)!;
    expect(finish3dHex(getDevice('iphone-17-pro')!, fin('iphone-17-pro', 'deep-blue'))).toBe('#32374A');
    expect(finish3dHex(getDevice('iphone-17-pro-max')!, fin('iphone-17-pro-max', 'cosmic-orange'))).toBe('#F77E2D');
    expect(finish3dHex(getDevice('iphone-17-pro')!, fin('iphone-17-pro', 'silver'))).toBe('#F5F5F5');
    expect(finish3dHex(getDevice('iphone-16')!, fin('iphone-16', 'ultramarine'))).toBe('#9AADF6');
    expect(appleFinishKey('productred')).toBe('red');
    const ipad = getDevice('ipad-pro-11-m4')!;
    expect(finish3dHex(ipad, ipad.finishes[0])).toBe(ipad.finishes[0].hex);
    // Every iPhone finish in devices.ts has an Apple swatch.
    for (const d of DEVICES.filter((x) => x.family === 'iphone')) {
      const w = APPLE_WRAPPER[d.id];
      if (!w) continue; // a model Apple's compare page does not list keeps its devices.ts swatch
      for (const f of d.finishes) expect(APPLE_SWATCHES[w][appleFinishKey(f.id)], `${d.id} ${f.id}`).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('the softboxes are RectAreaLights round the phone: LIGHT_DISTANCE long sides out (or their own distance), facing it, sized by their angle, turned by the light channel', () => {
    for (const preset of LIGHT_PRESET_NAMES) {
      const rig = studioLights(preset);
      const boxes = LIGHT_PRESETS[preset].boxes.filter((b) => !b.inEnv);
      expect(rig.children.length, preset).toBe(boxes.length);
      const center = [100, -50, 20] as const;
      const unit = 300; // body long side, world units
      for (const az of [-35, 50]) {
        placeStudio(rig, center, unit, az, 1.5);
        boxes.forEach((box, i) => {
          const l = rig.children[i] as RectAreaLight;
          expect(l).toBeInstanceOf(RectAreaLight);
          const p = l.getWorldPosition(new Vector3());
          const d = p.clone().sub(new Vector3(...center));
          expect(d.length()).toBeCloseTo((box.distance ?? LIGHT_DISTANCE) * unit, 6);
          // Its direction from the phone is the box's (azimuth offset from the key, elevation), turned by az.
          const want = lightDir(az + box.azimuth, box.elevation);
          expect(d.normalize().dot(new Vector3(...want))).toBeCloseTo(1, 6);
          // It faces the phone: a RectAreaLight emits along its local −z.
          const facing = new Vector3(0, 0, -1).applyQuaternion(l.getWorldQuaternion(new Quaternion()));
          expect(facing.dot(d)).toBeCloseTo(-1, 6);
          const size = boxSize(box);
          expect(l.width).toBeCloseTo(size.w * unit, 6);
          expect(l.height).toBeCloseTo(size.h * unit, 6);
          // × the preset's box gain against the room (HDRI_LOOK.boxes; look v2 round 2: half for studio, so the
          // room's structure shows on the back instead of the boxes' even wash).
          expect(l.intensity).toBeCloseTo(box.radiance * HDRI_LOOK[preset].boxes * 1.5, 9);
        });
      }
      // A key at 2.5 or more tone maps to white on any metal and washed Cosmic Orange to peach in round 1.
      expect(boxes[0].radiance, preset).toBeLessThanOrEqual(2.5);
      expect(boxes[0].elevation, preset).toBe(KEY_ELEVATION);
    }
  });

  it('aimStudio turns the environment to the key azimuth; bg quantizes to 16 levels', () => {
    const scene = new Scene();
    aimStudio(scene, -35);
    expect(scene.environmentRotation.y).toBeCloseTo((-35 * Math.PI) / 180, 12);
    expect(quantizeBg([0.5, 0.01, 1.2])).toEqual([0.5333333333333333, 0, 1]);
  });
});
