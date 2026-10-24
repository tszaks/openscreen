// WP4a: the procedural phone's geometry, materials and studio environment
// (spec §3.3, §3.4, D13, D14), built with three in node (no WebGL needed).

import { describe, expect, it } from 'vitest';
import {
  BufferGeometry,
  Color,
  CustomBlending,
  InstancedMesh,
  Mesh,
  MeshPhysicalMaterial,
  RectAreaLight,
  Scene,
  SRGBColorSpace,
  ShaderLib,
  Vector3,
  type Group,
} from 'three';
import { DEVICES, genericDevice, getDevice, type DeviceModel } from '../src/shared/devices';
import { body3dFor } from '../src/shared/devices3d';
import { continuousRectPoints } from '../src/shared/phone3d/outline';
import { LIGHT_DISTANCE, LIGHT_PRESETS } from '../src/shared/phone3d/lighting';
import { LIGHT_PRESET_NAMES } from '../src/shared/phone3d/model';
import {
  CHAMFER_MM,
  FILLET_MM,
  PHONE_PARTS,
  RENDER_ORDER,
  SEAM_D_MM,
  clearPhoneCache,
  phoneDims2d,
  phoneModel,
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
} from '../src/renderer/src/phone3d/materials';
import { aimStudio, fillRadiance, fillScene, lightDir, quantizeBg, studioLights } from '../src/renderer/src/phone3d/environment';

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
      expect(Math.abs(bb.min.z + b3.depthMm / 2)).toBeLessThan(0.05);
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
      // On the band, the tangent runs along the outline: perpendicular to the normal, in the xy plane.
      const n = attr(band.geometry, 'normal');
      const t = attr(band.geometry, 'tangent');
      for (let i = 0; i < n.count; i++) {
        expect(Math.abs(n.getX(i) * t.getX(i) + n.getY(i) * t.getY(i) + n.getZ(i) * t.getZ(i))).toBeLessThan(1e-4);
        expect(Math.abs(t.getZ(i))).toBeLessThan(1e-9);
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

  it('lens barrels: at least 0.2 mm deep, three element groups and a retaining ring', () => {
    for (const id of ['iphone-16-pro', 'iphone-13', 'iphone-se-3', 'iphone-16e', 'iphone-17-pro-max']) {
      const { group } = build(dev(id));
      const barrel = part(group, 'lensBarrel')[0];
      const bb = barrel.geometry.boundingBox!;
      expect(bb.max.z - bb.min.z, id).toBeGreaterThanOrEqual(0.2);
      const els = part(group, 'lensElements')[0];
      expect(new Set(els.geometry.groups.map((g) => g.materialIndex))).toEqual(new Set([0, 1, 2, 3]));
      // Element discs sit at three different depths between the cover and the barrel floor.
      const cz = part(group, 'lensCover')[0].geometry.boundingBox!.min.z;
      const ez = els.geometry.boundingBox!;
      expect(ez.min.z).toBeGreaterThan(cz - 1e-9);
      expect(ez.max.z).toBeLessThan(bb.max.z);
    }
  });

  it('17 Pro: aluminium unibody back with an inlaid glass panel and its seam; no back seam at the band', () => {
    const { group, dims } = build(dev('iphone-17-pro'));
    expect(dims.unibody).toBe(true);
    expect(part(group, 'backPanel').length).toBe(1);
    expect(part(group, 'seam').map((m) => m.name).sort()).toEqual(['seam', 'seam:panel']);
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
        if (luminance(src) >= floor) expect(out.getHex()).toBe(src.getHex());
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
    expect(bandF0('#DDDEDF', 'aluminum').getHex()).toBe(new Color().setStyle('#DDDEDF').getHex());
    const black = bandF0('#3C3C3D', 'titanium');
    expect(luminance(black)).toBeCloseTo(0.18, 3);
    expect(Math.max(black.r, black.g, black.b) - Math.min(black.r, black.g, black.b)).toBeLessThan(0.05);
    // Deep Blue stays blue (saturation kept), not the grey that mixing toward the base F0 gave.
    const blue = bandF0('#3A4659', 'aluminum');
    expect(hue(blue).s).toBeGreaterThan(0.85 * hue(new Color().setStyle('#3A4659')).s);
    expect(hue(blue).h * 360).toBeGreaterThan(205);
    expect(hue(blue).h * 360).toBeLessThan(225);
  });

  it('matches the material table: no clearcoat on metal or front glass', () => {
    clearMaterialCache();
    const steel = materialsFor('#403E3D', 'steel', 'frosted', 0.25);
    expect(steel.band.metalness).toBe(1);
    expect(steel.band.roughness).toBe(0.08);
    expect(steel.band.clearcoat).toBe(0);
    const ti = materialsFor('#3C3C3D', 'titanium', 'frosted', 0.25);
    expect(ti.band.roughness).toBe(0.32);
    expect(ti.band.anisotropy).toBe(0.5);
    const al = materialsFor('#2F2F31', 'aluminum', 'glossy', 0.25);
    expect(al.band.roughness).toBe(0.36);
    expect(al.band.clearcoat).toBe(0);
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
    // Front glass: AR-coated, one lobe.
    expect(ti.frontGlass.clearcoat).toBe(0);
    expect(ti.frontGlass.roughness).toBe(0.02);
    expect(ti.frontGlass.specularIntensity).toBe(0.7);
    expect(ti.frontGlass.ior).toBe(1.5);
    expect(ti.frontGlass.color.getHexString()).toBe('050506');
    // Glare = the glass setting, additive, coverage untouched.
    expect(ti.glare.specularIntensity).toBe(0.25);
    expect(ti.glare.blending).toBe(CustomBlending);
    expect(ti.glare.visible).toBe(true);
    expect(materialsFor('#3C3C3D', 'titanium', 'frosted', 0).glare.visible).toBe(false);
    // Lens cover: iridescent AR tint.
    expect(ti.lensCover.iridescence).toBe(0.6);
    expect(ti.lensCover.iridescenceIOR).toBe(1.38);
    expect(ti.lensCover.iridescenceThicknessRange).toEqual([250, 450]);
    expect(ti.lensElements.map((m) => m.roughness)).toEqual([0.05, 0.17, 0.3]);
    expect(ti.lensRing.metalness).toBe(1);
    expect(ti.lensRing.roughness).toBe(0.15);
    expect(ti.seam.color.getHexString()).toBe('0a0a0a');
    for (const m of [ti.band, ti.lensRing, ti.lensBarrel]) expect(m.clearcoat).toBe(0);
  });

  it('overlay layers: no depth write, polygon offset whose units flip under reversed depth', () => {
    clearMaterialCache();
    const fwd = materialsFor('#C2BCB2', 'titanium', 'frosted', 0.25, { reversedDepth: false });
    const rev = materialsFor('#C2BCB2', 'titanium', 'frosted', 0.25, { reversedDepth: true });
    for (const [set, units] of [[fwd, -4], [rev, 4]] as const) {
      for (const m of [set.screen, set.glare, set.lensCover]) {
        expect(m.depthWrite).toBe(false);
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
    expect(s2.fragmentShader).toContain(LOD_MAP_FRAGMENT);
    expect(s2.fragmentShader).not.toContain('#include <map_fragment>');
    expect(s2.fragmentShader).toContain('pc_fragScreen = vec4( gl_FragColor.rgb * gl_FragColor.a, gl_FragColor.a );');
    expect(s2.fragmentShader).toContain('gl_FragColor = vec4( 0.0, 0.0, 0.0, gl_FragColor.a );');
    // Patches compose once and key the program cache.
    lodBias(set.screen);
    expect(set.screen.customProgramCacheKey()).toBe('mrt-screen|lodbias');
    // Every lit material in the set is patched; only the screen is the screen role.
    for (const m of set.all) {
      expect(m.customProgramCacheKey(), m.type).toMatch(m === set.screen ? /^mrt-screen/ : /^mrt-lit$/);
    }
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

describe('studio environment (D13)', () => {
  it('hero softboxes are RectAreaLights from the preset, aimed at the phone', () => {
    for (const preset of LIGHT_PRESET_NAMES) {
      const unit = 150;
      const g = studioLights(preset, unit, 1);
      const boxes = LIGHT_PRESETS[preset].boxes;
      expect(g.children).toHaveLength(boxes.length);
      g.updateMatrixWorld(true);
      g.children.forEach((l, i) => {
        expect(l).toBeInstanceOf(RectAreaLight);
        const light = l as RectAreaLight;
        expect(light.width).toBeCloseTo(boxes[i].w * unit, 9);
        expect(light.height).toBeCloseTo(boxes[i].h * unit, 9);
        expect(light.position.length()).toBeCloseTo(LIGHT_DISTANCE * unit, 6);
        const [x, y, z] = lightDir(boxes[i].azimuth, boxes[i].elevation);
        expect(light.position.x / (LIGHT_DISTANCE * unit)).toBeCloseTo(x, 9);
        expect(light.position.y / (LIGHT_DISTANCE * unit)).toBeCloseTo(y, 9);
        expect(light.position.z / (LIGHT_DISTANCE * unit)).toBeCloseTo(z, 9);
        // It emits along its −z, which lookAt (the camera/light convention) aims at the origin.
        const fwd = new Vector3(0, 0, -1).applyQuaternion(light.quaternion);
        expect(fwd.dot(light.position.clone().normalize().negate())).toBeCloseTo(1, 6);
      });
      expect(g.children[0].name).toBe('key');
    }
  });

  it('the PMREM fill scene holds only the dome and the sheen strip (no hero boxes)', () => {
    const s = fillScene('studio', [0.4, 0.05, 0.9]);
    const kinds: string[] = [];
    s.traverse((o) => {
      if (o !== s) kinds.push(o.name || o.type);
      expect(o).not.toBeInstanceOf(RectAreaLight);
    });
    expect(kinds.sort()).toEqual(['fill:dome', 'fill:sheen']);
    // Base dome: 2–6% (studio ambient 0.05: horizon 0.02, top 0.05); the floor is tinted by the background.
    const bg = [0.4, 0.05, 0.9] as const;
    expect(fillRadiance('studio', bg, [0, 1, 0], false)[0]).toBeCloseTo(0.05, 9);
    expect(fillRadiance('studio', bg, [0, 0, 1], false)[0]).toBeCloseTo(0.02, 9);
    const floor = fillRadiance('studio', bg, [0, -1, 0], false);
    expect(floor[2]).toBeGreaterThan(floor[0]);
    expect(floor[0]).toBeGreaterThan(floor[1]);
    // Bounce cards: soft, either side of the phone as seen at the default key azimuth (−35),
    // dim next to a softbox (22+), and absent straight behind the camera.
    const side = (az: number) => fillRadiance('studio', bg, lightDir(az + 35, 10))[0];
    expect(side(-105)).toBeGreaterThan(0.5);
    expect(side(105)).toBeGreaterThan(0.4);
    expect(side(0)).toBeLessThan(0.05);
    expect(fillRadiance('night', bg, lightDir(-105 + 35, 10))[0]).toBeLessThan(side(-105));
    // The dome mesh carries exactly these values, all finite.
    const dome = s.getObjectByName('fill:dome') as Mesh;
    const pos = attr(dome.geometry, 'position');
    const col = attr(dome.geometry, 'color');
    for (let i = 0; i < pos.count; i += 7) {
      const v = fillRadiance('studio', [0.4, 0.05, 0.9], [pos.getX(i) / 10, pos.getY(i) / 10, pos.getZ(i) / 10]);
      expect(col.getX(i)).toBeCloseTo(v[0], 5);
    }
    const strip0 = s.getObjectByName('fill:sheen') as Mesh;
    const sc = attr(strip0.geometry, 'color');
    for (let i = 0; i < sc.count; i++) expect(Number.isFinite(sc.getX(i)) && sc.getX(i) >= 0).toBe(true);
    // The sheen strip is in front (camera side), above centre.
    const strip = s.getObjectByName('fill:sheen')!;
    expect(strip.position.z).toBeGreaterThan(0);
    expect(strip.position.y).toBeGreaterThan(0);
  });

  it('aimStudio turns the boxes and the environment together; bg quantizes to 16 levels', () => {
    const scene = new Scene();
    const g = studioLights('studio');
    aimStudio(g, scene, -35);
    expect(g.rotation.y).toBeCloseTo((-35 * Math.PI) / 180, 12);
    expect(scene.environmentRotation.y).toBeCloseTo((-35 * Math.PI) / 180, 12);
    expect(quantizeBg([0.5, 0.01, 1.2])).toEqual([0.5333333333333333, 0, 1]);
  });
});
