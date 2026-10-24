// Pure parts of the 3D renderer (SPEC §3.5-3.7, D19, D22): the sample plan,
// the tile plan, the screen-texture plan and its UV mapping, the shadow's
// catcher frame, and the material patches. three is imported (node, no GPU).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  AA_SAMPLES,
  halton,
  JITTER,
  MAX_SAMPLES,
  mrtOutput,
  lodBias,
  needsRealloc,
  planSamples,
  planTiles,
  TILE_MAX_PX,
  TILE_MAX_SIDE,
} from '../src/renderer/src/phone3d/passes';
import { planScreenTexture, screenUvMatrix } from '../src/renderer/src/phone3d/screenTexture';
import { blurKernel, catcherFrame } from '../src/renderer/src/phone3d/shadow';
import {
  camAt,
  hullTravelPx,
  modelToWorld,
  bodyPointsMm,
  scene3d,
  screenQuadAt,
  shadowPointsWorld,
  subFrameTimes,
  project as projectPt,
  type Quad,
} from '../src/shared/phone3d/projection';
import { defaultPhone3D, FRONT, type Pose } from '../src/shared/phone3d/model';
import { phoneProject, with3d, move } from './helpers/phone3dFixtures';
import { projectCanvasSize } from '../src/shared/mobileProject';

describe('sample plan (§3.7 step 4)', () => {
  it('Halton(2,3) jitter: sample 0 unjittered, the rest fixed in (−0.5, 0.5)', () => {
    expect(halton(1, 2)).toBe(0.5);
    expect(halton(2, 2)).toBe(0.25);
    expect(halton(1, 3)).toBeCloseTo(1 / 3, 15);
    expect(halton(4, 3)).toBeCloseTo(4 / 9, 15);
    expect(JITTER[0]).toEqual([0, 0]);
    expect(JITTER).toHaveLength(MAX_SAMPLES);
    for (const [x, y] of JITTER.slice(1)) {
      expect(Math.abs(x)).toBeLessThan(0.5);
      expect(Math.abs(y)).toBeLessThan(0.5);
    }
    expect(new Set(JITTER.map((j) => j.join())).size).toBe(MAX_SAMPLES);
  });

  it('live preview / draft: one sample, no jitter, no motion', () => {
    const p = planSamples({ t: 2, travelPx: 300, motion: { samples: 12, shutterSec: 1 / 60 }, full: false });
    expect(p).toEqual({ n: 1, nMotion: 1, times: [2], jitter: [[0, 0]], screenFromFirst: false });
  });

  it('a still phone in export: 8 jittered AA samples at the same time, the screen from sample 0 only', () => {
    const p = planSamples({ t: 2, travelPx: 0.3, motion: { samples: 12, shutterSec: 1 / 60 }, full: true });
    expect(p.n).toBe(AA_SAMPLES);
    expect(p.nMotion).toBe(1);
    expect(p.times.every((x) => x === 2)).toBe(true);
    expect(p.screenFromFirst).toBe(true);
    expect(planSamples({ t: 2, travelPx: 50, motion: null, full: true }).nMotion).toBe(1);
  });

  it('moving: the user samples are a minimum, adjacent copies ≤ 1.5 px apart, capped at 64; times span the shutter', () => {
    const sh = 1 / 60;
    expect(planSamples({ t: 1, travelPx: 3, motion: { samples: 12, shutterSec: sh }, full: true }).nMotion).toBe(12);
    const fast = planSamples({ t: 1, travelPx: 45, motion: { samples: 12, shutterSec: sh }, full: true });
    expect(fast.nMotion).toBe(30);
    expect(fast.n).toBe(30);
    expect(fast.screenFromFirst).toBe(false);
    expect(45 / fast.nMotion).toBeLessThanOrEqual(1.5);
    expect(fast.times).toEqual(subFrameTimes(1, sh, 30));
    expect(Math.min(...fast.times)).toBeGreaterThan(1 - sh / 2);
    expect(Math.max(...fast.times)).toBeLessThan(1 + sh / 2);
    expect(planSamples({ t: 1, travelPx: 1e4, motion: { samples: 2, shutterSec: sh }, full: true }).n).toBe(MAX_SAMPLES);
    expect(planSamples({ t: 1, travelPx: 1, motion: { samples: 1, shutterSec: sh }, full: true }).nMotion).toBe(2);
  });

  it('no strobing (§6.3): on a fast 360° spin every sample plan keeps adjacent hull copies ≤ 2 px apart', () => {
    const p = with3d(phoneProject(), { transitions: [move('spin', 1, 1.6, { turn: 360 }, { easing: { kind: 'linear' } })] });
    const s = scene3d(p, projectCanvasSize(p))!;
    const sh = 0.5 / 30;
    for (let t = 1.05; t < 1.6; t += 0.1) {
      const travel = hullTravelPx(s, t, sh);
      const plan = planSamples({ t, travelPx: travel, motion: { samples: 12, shutterSec: sh }, full: true });
      expect(travel).toBeGreaterThan(20);
      // Largest per-step move of any hull corner between adjacent sample times.
      const pts = bodyPointsMm(s, true);
      let worst = 0;
      for (let k = 1; k < plan.times.length; k++) {
        const a = camAt(s, plan.times[k - 1]);
        const b = camAt(s, plan.times[k]);
        for (const q of pts) {
          const [ax, ay] = projectPt(q, a);
          const [bx, by] = projectPt(q, b);
          worst = Math.max(worst, Math.hypot(bx - ax, by - ay));
        }
      }
      expect(worst).toBeLessThanOrEqual(2);
    }
  });
});

describe('tiles (§3.7 step 8)', () => {
  it('a 1080×1920 preview ROI is one tile', () => {
    expect(planTiles(1000, 1500, 1, 4)).toEqual([{ x: 0, y: 0, w: 1000, h: 1500, px: 0, py: 0, pw: 1000, ph: 1500 }]);
  });

  for (const [w, h, ss, ov] of [
    [1700, 3200, 1, 6],
    [2400, 4000, 1, 0],
    [3400, 6400, 2, 10],
    [5100, 9600, 3, 3],
  ] as const) {
    it(`${w}×${h} at ss ${ss}: cores tile the area exactly once, each window within the limits`, () => {
      const tiles = planTiles(w, h, ss, ov);
      expect(tiles.length).toBeGreaterThan(1);
      const cover = new Map<string, number>();
      let area = 0;
      for (const t of tiles) {
        area += t.w * t.h;
        expect(t.pw * t.ph).toBeLessThanOrEqual(TILE_MAX_PX);
        expect(Math.max(t.pw, t.ph)).toBeLessThanOrEqual(TILE_MAX_SIDE);
        expect(t.x % ss).toBe(0);
        expect(t.y % ss).toBe(0);
        if (t.x + t.w < w) expect(t.w % ss).toBe(0);
        expect(t.px).toBe(Math.max(0, t.x - ov));
        expect(t.px + t.pw).toBe(Math.min(w, t.x + t.w + ov));
        cover.set(`${t.x},${t.y}`, (cover.get(`${t.x},${t.y}`) ?? 0) + 1);
      }
      expect(area).toBe(w * h);
      expect([...cover.values()].every((n) => n === 1)).toBe(true);
    });
  }

  it('targets: re-create on growth, or when the need falls below half in both axes', () => {
    expect(needsRealloc(null, 10, 10)).toBe(true);
    expect(needsRealloc({ w: 100, h: 100 }, 101, 100)).toBe(true);
    expect(needsRealloc({ w: 100, h: 100 }, 60, 40)).toBe(false);
    expect(needsRealloc({ w: 100, h: 100 }, 49, 49)).toBe(true);
  });
});

describe('screen texture (§3.6): 1:1 texels, phase-locked at FRONT', () => {
  const p = with3d(phoneProject());
  const s = scene3d(p, projectCanvasSize(p))!;

  /** The texture texel (x right, y down) a render pixel centre reads, through the mesh UV and the texture matrix. */
  function texelAt(quad: Quad, landscape: number, layout: ReturnType<typeof planScreenTexture>, texW: number, texH: number, px: number, py: number) {
    // Canvas-local U (right) / V (up) over the FRONT quad, then back to the model's portrait (u, v).
    const U = (px - quad[0].x) / (quad[1].x - quad[0].x);
    const V = 1 - (py - quad[0].y) / (quad[3].y - quad[0].y);
    const c = Math.round(Math.cos(-landscape));
    const sn = Math.round(Math.sin(-landscape));
    const u = 0.5 + c * (U - 0.5) - sn * (V - 0.5);
    const v = 0.5 + sn * (U - 0.5) + c * (V - 0.5);
    const m = screenUvMatrix(layout.dst, texW, texH, landscape).elements; // column-major
    const st = { s: m[0] * u + m[3] * v + m[6], t: m[1] * u + m[4] * v + m[7] };
    return { x: st.s * texW, y: (1 - st.t) * texH };
  }

  for (const [label, proj] of [
    ['portrait 9:16', with3d(phoneProject())],
    ['landscape 16:9', with3d(phoneProject({ width: 2622, height: 1206, presetId: 'landscape-16x9' }))],
    ['classic, moved', with3d({ ...phoneProject({ presetId: 'none' }), style: { ...phoneProject({ presetId: 'none' }).style, contentTransform: { x: 0.47, y: 0.52, scale: 0.83 } } })],
  ] as const) {
    it(`${label}: every render pixel centre reads a texel centre, and the content keeps the flat rect's phase`, () => {
      const sc = scene3d(proj, projectCanvasSize(proj))!;
      const cam = camAt(sc, 0);
      const { quad } = screenQuadAt(sc, 0, cam);
      for (const ss of [1, 2]) {
        const L = planScreenTexture(quad, sc.home.screen, ss);
        expect(L.aligned).toBe(true);
        expect(L.scale).toBe(ss);
        expect(L.dst.w).toBe(sc.home.screen.w * ss);
        const texW = L.w + 37; // hysteresis: the canvas may be larger than the area used
        const texH = L.h + 11;
        const F = sc.home.screen;
        for (const [fx, fy] of [
          [0.1, 0.1],
          [0.5, 0.37],
          [0.93, 0.88],
        ]) {
          // A render pixel centre (render px = canvas px × ss) inside the screen.
          const rx = Math.floor((F.x + fx * F.w) * ss) + 0.5;
          const ry = Math.floor((F.y + fy * F.h) * ss) + 0.5;
          const q = texelAt(quad, cam.landscape, L, texW, texH, rx / ss, ry / ss);
          expect(Math.abs(q.x - Math.round(q.x - 0.5) - 0.5)).toBeLessThan(1e-6);
          expect(Math.abs(q.y - Math.round(q.y - 0.5) - 0.5)).toBeLessThan(1e-6);
          // And it is the texel that the flat draw put at that canvas pixel: texel = render px − floor(F·ss).
          expect(q.x - 0.5).toBeCloseTo(rx - 0.5 - Math.floor(F.x * ss), 5);
          expect(q.y - 0.5).toBeCloseTo(ry - 0.5 - Math.floor(F.y * ss), 5);
        }
      }
    });
  }

  it('an oblique screen is never minified past the hysteresis slack, and respects the size limit', () => {
    for (const pose of [
      { ...FRONT, turn: 40 },
      { ...FRONT, tilt: 30, size: 1.6 },
      { ...FRONT, turn: -70, rotate: 20 },
    ] as Pose[]) {
      const cam = camAt(s, 0, pose);
      const { quad } = screenQuadAt(s, 0, cam);
      const L = planScreenTexture(quad, s.home.screen, 1);
      expect(L.aligned).toBe(false);
      const edge = Math.max(Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y), Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y));
      expect(L.dst.w).toBeGreaterThanOrEqual(edge - 1e-6);
      const small = planScreenTexture(quad, s.home.screen, 3, 1024);
      expect(Math.max(small.w, small.h)).toBeLessThanOrEqual(1024);
    }
  });
});

describe('shadow catcher frame (§3.7 step 5)', () => {
  for (const kind of ['wall', 'floor'] as const) {
    for (const az of [-120, -35, 0, 60, 170]) {
      it(`${kind}, light ${az}°: the planar shadow matrix casts the hull exactly where the shared projection does`, () => {
        const p3 = { ...defaultPhone3D(), shadow: { ...defaultPhone3D().shadow, kind }, light: { ...defaultPhone3D().light, azimuth: az }, camera: { fov: 22, elevation: kind === 'floor' ? 14 : 0 } };
        const p = { ...phoneProject(), phone3d: p3 };
        const s = scene3d(p, projectCanvasSize(p))!;
        const cam = camAt(s, 0, { ...FRONT, turn: 25, tilt: 8 });
        const f = catcherFrame(s, cam);
        const shared = shadowPointsWorld(s, cam);
        bodyPointsMm(s, true).forEach((q, i) => {
          const w = modelToWorld(q, cam);
          const v = new THREE.Vector3(w[0], w[1], w[2]).applyMatrix4(f.shadowMatrix);
          expect(v.x).toBeCloseTo(shared[i][0], 6);
          expect(v.y).toBeCloseTo(shared[i][1], 6);
          expect(v.z).toBeCloseTo(shared[i][2], 6);
          // ...and inside the catcher area the mask covers.
          const u = v.dot(f.axisU);
          const vv = v.dot(f.axisV);
          expect(u).toBeGreaterThan(f.u0);
          expect(u).toBeLessThan(f.u1);
          expect(vv).toBeGreaterThan(f.v0);
          expect(vv).toBeLessThan(f.v1);
        });
        expect(f.axisU.clone().cross(f.axisV).dot(f.normal)).toBeCloseTo(1, 12);
      });
    }
  }

  it('blur kernel: 3σ reach, at most 64 taps a side, spacing ≥ 1 texel', () => {
    expect(blurKernel(0)).toEqual({ half: 0, step: 1 });
    expect(blurKernel(8)).toEqual({ half: 24, step: 1 });
    const wide = blurKernel(60);
    expect(wide.half).toBeLessThanOrEqual(64);
    expect(wide.half * wide.step).toBeGreaterThanOrEqual(180);
  });
});

describe('material patches (§3.5, §3.6)', () => {
  const compile = (m: THREE.Material) => {
    const shader = { fragmentShader: 'uniform vec3 diffuse;\nvoid main() {\n\tgl_FragColor = vec4(1.0);\n\t#include <map_fragment>\n}\n', vertexShader: '', uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    return shader.fragmentShader;
  };
  it('lit: attachment 1 = 0; screen: attachment 1 = premultiplied colour, attachment 0 = (0,0,0,a); both declare location 1', () => {
    const lit = compile(mrtOutput(new THREE.MeshStandardMaterial(), 'lit'));
    expect(lit.startsWith('layout(location = 1) out highp vec4 pc_fragScreen;')).toBe(true);
    expect(lit).toMatch(/pc_fragScreen = vec4\( 0\.0 \);\n}\n$/);
    const scr = compile(mrtOutput(new THREE.MeshBasicMaterial(), 'screen'));
    expect(scr).toContain('pc_fragScreen = vec4( gl_FragColor.rgb * gl_FragColor.a, gl_FragColor.a );');
    expect(scr).toContain('gl_FragColor = vec4( 0.0, 0.0, 0.0, gl_FragColor.a );');
    // The writes come last in main, after everything three computed.
    expect(scr.lastIndexOf('gl_FragColor = vec4( 0.0')).toBeGreaterThan(scr.indexOf('#include <map_fragment>'));
  });
  it('is idempotent and keys the program cache per role; lodBias samples the map with a −0.5 bias', () => {
    const m = new THREE.MeshBasicMaterial();
    mrtOutput(m, 'screen');
    const once = compile(m);
    mrtOutput(m, 'screen');
    expect(compile(m)).toBe(once);
    expect(m.customProgramCacheKey()).toContain('mrt:screen');
    const b = compile(lodBias(new THREE.MeshBasicMaterial()));
    expect(b).toContain('texture( map, vMapUv, -0.500 )');
    expect(b).not.toContain('#include <map_fragment>');
  });
});
