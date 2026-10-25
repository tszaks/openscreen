// The 3D phone's shadow (SPEC §3.7 step 5, D14): two layers drawn on the
// catcher plane as premultiplied black. The drop (ambient) layer is the
// phone's silhouette cast onto the catcher along the key light, blurred with
// the flat frame's shadow width; the contact layer is the silhouette cast
// STRAIGHT onto the catcher, blurred to 0.22× that at 0.7× the opacity, so a
// tight shade hugs the outline on every side while the drop shadow falls away
// from the key (look round 4: one cast for both left no visible shadow).
//
// The silhouette is rendered IN CATCHER-PLANE COORDINATES: every vertex is
// projected onto the catcher along the light (a planar shadow matrix), and an
// orthographic camera looks straight at the catcher area. So the mask's
// texels are square on the catcher, the Gaussian σ (given in world units on
// the catcher by shadowSigma) is applied isotropically, and the catcher quad
// samples the mask with plain UVs. The catcher area is exactly
// shadowCatcherCorners (shadow bbox + 3σ), so renderRoi, which holds that
// area, can never cut the shadow.
//
// Masks are R16F so the wide blur does not band: the silhouette at 1024²
// (4× MSAA), the contact blur at 1024², the ambient blur at 512² (its σ is
// ~35 texels at 1024; at half size the kernel is half as long and the
// 2 × 2 average on the way down is free).
//
// Motion (§3.7 steps 5 and 8): a moving frame's shadow is the average of its
// sub-samples' shadows. Each distinct sub-sample pose casts its silhouette
// once, into the frame's one catcher area (the union of every sample's), and
// the silhouettes are averaged before the blur; the blur is linear, so that
// is the average of the blurred shadows. So the masks are made once per
// frame, before any tile, with one silhouette per sub-sample: no tile renders
// a mask again, and a fast move's shadow is as smooth as the phone's blur.
import * as THREE from 'three';
import {
  shadowCatcherCorners,
  shadowLightDir,
  shadowSigma,
  SHADOW_CONTACT,
  type Cam3D,
  type Scene3D,
} from '../../../shared/phone3d/projection';

export const SILHOUETTE_SIZE = 1024;
export const AMBIENT_SIZE = 512;
/** Longest blur kernel half-width in taps; wider blurs step over texels (bilinear), deterministically. */
const MAX_HALF_TAPS = 64;

const SILHOUETTE_VERT = /* glsl */ `
uniform mat4 uShadow;
void main() {
  vec4 p = vec4( position, 1.0 );
  #ifdef USE_INSTANCING
  p = instanceMatrix * p;
  #endif
  gl_Position = projectionMatrix * viewMatrix * uShadow * modelMatrix * p;
}`;
const SILHOUETTE_FRAG = /* glsl */ `
layout(location = 0) out highp vec4 o0;
void main() { o0 = vec4( 1.0 ); }`;

/** Adds a resolved silhouette into the average (blend ONE, ONE) with weight uW. */
const ADD_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D uSrc;
uniform float uW;
layout(location = 0) out highp vec4 o0;
void main() { o0 = vec4( texelFetch( uSrc, ivec2( gl_FragCoord.xy ), 0 ).r * uW, 0.0, 0.0, 1.0 ); }`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D uSrc;
uniform vec2 uDir;      // one source texel along the blur axis, in uv
uniform vec2 uOutSize;  // the target size, texels
uniform float uSigma;   // σ in source texels
uniform float uStep;    // tap spacing in source texels (≥ 1)
uniform int uHalf;      // taps each side
layout(location = 0) out highp vec4 o0;
float g( float x ) { return exp( -0.5 * x * x / ( uSigma * uSigma ) ); }
void main() {
  vec2 uv = gl_FragCoord.xy / uOutSize;
  float sum = texture( uSrc, uv ).r;
  float wsum = 1.0;
  // Taps i and i + 1 share one bilinear fetch between them, weighted by their sum: half the fetches.
  for ( int j = 0; j < ${MAX_HALF_TAPS / 2}; j++ ) {
    int i = 2 * j + 1;
    if ( i > uHalf ) break;
    float xa = float( i ) * uStep;
    float xb = float( i + 1 ) * uStep;
    float wa = g( xa );
    float wb = i + 1 <= uHalf ? g( xb ) : 0.0;
    float w = wa + wb;
    float x = ( xa * wa + xb * wb ) / w;
    sum += ( texture( uSrc, uv + uDir * x ).r + texture( uSrc, uv - uDir * x ).r ) * w;
    wsum += 2.0 * w;
  }
  o0 = vec4( sum / wsum, 0.0, 0.0, 1.0 );
}`;

/** The catcher: premultiplied black, alpha = the two layers composited (1 − (1 − a)(1 − c)), into attachment 0 only. */
const CATCHER_VERT = /* glsl */ `
uniform vec3 uAxisU;
uniform vec3 uAxisV;
uniform vec4 uRange; // u0, u1, v0, v1
out vec2 vUv;
void main() {
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vUv = vec2( ( dot( w.xyz, uAxisU ) - uRange.x ) / ( uRange.y - uRange.x ), ( dot( w.xyz, uAxisV ) - uRange.z ) / ( uRange.w - uRange.z ) );
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const CATCHER_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D uAmbient;
uniform highp sampler2D uContact;
uniform float uOpAmbient;
uniform float uOpContact;
in vec2 vUv;
layout(location = 0) out highp vec4 o0;
layout(location = 1) out highp vec4 o1;
void main() {
  float a = clamp( texture( uAmbient, vUv ).r, 0.0, 1.0 ) * uOpAmbient;
  float c = clamp( texture( uContact, vUv ).r, 0.0, 1.0 ) * uOpContact;
  float alpha = 1.0 - ( 1.0 - a ) * ( 1.0 - c );
  o0 = vec4( 0.0, 0.0, 0.0, alpha );
  o1 = vec4( 0.0 );
}`;

const FULLSCREEN_VERT = /* glsl */ `
void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;

function r16(size: number, samples = 0): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(size, size, {
    type: THREE.HalfFloatType,
    format: THREE.RedFormat,
    samples,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: THREE.NoColorSpace,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  });
}

/** Where the catcher is and how its mask maps onto it, for one sample. */
export interface CatcherFrame {
  kind: 'wall' | 'floor';
  /** World-space in-plane axes and the plane's normal (toward the camera side). */
  axisU: THREE.Vector3;
  axisV: THREE.Vector3;
  normal: THREE.Vector3;
  /** The plane: wall z = plane, floor y = plane. */
  plane: number;
  /** The catcher area along axisU / axisV. */
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  /** World → catcher-plane projection along the light. */
  shadowMatrix: THREE.Matrix4;
  /** Gaussian σ on the catcher, world units. */
  sigma: { ambient: number; contact: number };
  corners: THREE.Vector3[];
}

/** Minimum light z for a wall (matches shared/phone3d/projection shadowPointsWorld). */
const MIN_WALL_LZ = 0.1;

/** World → catcher-plane projection along the light L (toward the light): wall z = plane, floor y = plane. */
export function planarShadowMatrix(kind: 'wall' | 'floor', plane: number, L: readonly [number, number, number]): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (kind === 'wall') {
    const lz = Math.max(L[2], MIN_WALL_LZ);
    const ax = L[0] / lz;
    const ay = L[1] / lz;
    return m.set(1, 0, -ax, plane * ax, 0, 1, -ay, plane * ay, 0, 0, 0, plane, 0, 0, 0, 1);
  }
  const ax = L[0] / L[1];
  const az = L[2] / L[1];
  return m.set(1, -ax, 0, plane * ax, 0, 0, 0, plane, 0, -az, 1, plane * az, 0, 0, 0, 1);
}

/** The light direction a sample's shadow is cast along: the shared shadowLightDir (the project's key, its offset
 *  capped at the 2D frame shadow's; the pose's light channel does not turn it). */
export function sampleLight(s: Scene3D, cam: Cam3D): [number, number, number] {
  return shadowLightDir(s, cam) as [number, number, number];
}

/**
 * The catcher, its mask mapping and the planar shadow matrix at one sample:
 * the same catcher area and light direction the shared projection uses
 * (shadowCatcherCorners, shadowLightDir), so the ROI and the drawn shadow agree.
 */
export function catcherFrame(s: Scene3D, cam: Cam3D): CatcherFrame {
  const corners = shadowCatcherCorners(s, cam).map((c) => new THREE.Vector3(c[0], c[1], c[2]));
  const L = sampleLight(s, cam);
  const sigma = shadowSigma(s, cam);
  if (s.p3.shadow.kind === 'wall') {
    const zw = corners[0].z;
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    return {
      kind: 'wall',
      axisU: new THREE.Vector3(1, 0, 0),
      axisV: new THREE.Vector3(0, 1, 0),
      normal: new THREE.Vector3(0, 0, 1),
      plane: zw,
      u0: Math.min(...xs),
      u1: Math.max(...xs),
      v0: Math.min(...ys),
      v1: Math.max(...ys),
      shadowMatrix: planarShadowMatrix('wall', zw, L),
      sigma,
      corners,
    };
  }
  const yf = corners[0].y;
  const xs = corners.map((c) => c.x);
  // axisV = −z, so the camera looking down (−y) sees u = x to the right and v = −z up.
  const vs = corners.map((c) => -c.z);
  return {
    kind: 'floor',
    axisU: new THREE.Vector3(1, 0, 0),
    axisV: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    plane: yf,
    u0: Math.min(...xs),
    u1: Math.max(...xs),
    v0: Math.min(...vs),
    v1: Math.max(...vs),
    shadowMatrix: planarShadowMatrix('floor', yf, L),
    sigma,
    corners,
  };
}

/**
 * One catcher for a whole frame: the plane, light and blur of the frame's
 * middle sample `mid`, its area grown to hold every sample's own catcher area
 * (each holds that sample's whole blurred shadow, so the union holds the
 * average). The ROI unions the same per-sample areas (renderRoi over the
 * sub-frame times), so it holds this one too.
 */
export function frameCatcher(s: Scene3D, cams: readonly Cam3D[], mid: number): CatcherFrame {
  const base = catcherFrame(s, cams[mid]);
  if (cams.length === 1) return base;
  let { u0, u1, v0, v1 } = base;
  for (const c of cams) {
    const f = catcherFrame(s, c);
    u0 = Math.min(u0, f.u0);
    u1 = Math.max(u1, f.u1);
    v0 = Math.min(v0, f.v0);
    v1 = Math.max(v1, f.v1);
  }
  const P = base.plane;
  const at = (u: number, v: number) => (base.kind === 'wall' ? new THREE.Vector3(u, v, P) : new THREE.Vector3(u, P, -v));
  return { ...base, u0, u1, v0, v1, corners: [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)] };
}

/** The blur kernel for σ (source texels): taps each side and their spacing, so at most MAX_HALF_TAPS taps per side. */
export function blurKernel(sigmaTexels: number): { half: number; step: number } {
  const reach = Math.ceil(3 * Math.max(0, sigmaTexels));
  if (reach <= 0) return { half: 0, step: 1 };
  const step = Math.max(1, reach / MAX_HALF_TAPS);
  return { half: Math.min(MAX_HALF_TAPS, Math.ceil(reach / step)), step };
}

/** The shadow pass: masks, blur passes and the catcher mesh. One per engine. */
export class ShadowPass {
  readonly catcher: THREE.Mesh;
  private readonly sil = r16(SILHOUETTE_SIZE, 4);
  /** The (weighted) sum of the frame's silhouettes: cast along the key (drop), and straight on (contact). */
  private readonly avg = r16(SILHOUETTE_SIZE);
  private readonly avgC = r16(SILHOUETTE_SIZE);
  private readonly tc = r16(SILHOUETTE_SIZE);
  private readonly ta = r16(AMBIENT_SIZE);
  /** The frame's blurred masks, and what they were last rendered for (equal inputs give equal masks: reused). */
  private readonly contact = r16(SILHOUETTE_SIZE);
  private readonly ambient = r16(AMBIENT_SIZE);
  private key = '';
  /** Blurred mask sets made so far (one per frame at most); stats and tests. */
  maskRenders = 0;
  /** Silhouettes cast so far (two per distinct sub-sample pose of each frame whose masks were made: drop and contact). */
  silhouettes = 0;
  private readonly silMat: THREE.ShaderMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
  private readonly addMat: THREE.ShaderMaterial;
  private readonly catcherMat: THREE.ShaderMaterial;
  private readonly orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20);
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly silScene = new THREE.Scene();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.silMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SILHOUETTE_VERT,
      fragmentShader: SILHOUETTE_FRAG,
      uniforms: { uShadow: { value: new THREE.Matrix4() } },
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.silScene.overrideMaterial = this.silMat;
    this.blurMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: {
        uSrc: { value: null },
        uDir: { value: new THREE.Vector2() },
        uOutSize: { value: new THREE.Vector2() },
        uSigma: { value: 1 },
        uStep: { value: 1 },
        uHalf: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.addMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: ADD_FRAG,
      uniforms: { uSrc: { value: null }, uW: { value: 1 } },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(tri, this.blurMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.catcherMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: CATCHER_VERT,
      fragmentShader: CATCHER_FRAG,
      uniforms: {
        uAmbient: { value: null },
        uContact: { value: null },
        uOpAmbient: { value: 0.4 },
        uOpContact: { value: 0.28 },
        uAxisU: { value: new THREE.Vector3(1, 0, 0) },
        uAxisV: { value: new THREE.Vector3(0, 1, 0) },
        uRange: { value: new THREE.Vector4(0, 1, 0, 1) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const quadGeo = new THREE.BufferGeometry();
    quadGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    quadGeo.setIndex([0, 1, 2, 0, 2, 3]);
    this.catcher = new THREE.Mesh(quadGeo, this.catcherMat);
    this.catcher.frustumCulled = false;
    this.catcher.renderOrder = -10;
    this.catcher.matrixAutoUpdate = false;
  }

  /**
   * Makes the frame's masks for `frame` (frameCatcher) from `poses` sub-sample
   * poses: `place(i)` puts the phone (`phone`, moved into the silhouette scene
   * for the pass and put back) at pose i. Each pose casts its silhouette once,
   * along its own light (`lights[i]`), onto the frame's one catcher plane; the
   * silhouettes are averaged (by `weights`, the sample plan's tent shutter;
   * equal without), then blurred once. `modelKey` names the phone
   * model; with the same model, catcher, lights and poses as last time, the
   * masks are reused as they are (a still phone, the paused preview, playback
   * without moves). Does not place the catcher: use() does.
   */
  render(
    phone: THREE.Object3D,
    frame: CatcherFrame,
    modelKey: string,
    poses: number,
    place: (i: number) => void,
    lights: readonly (readonly [number, number, number])[],
    weights?: readonly number[],
  ): void {
    const r = this.renderer;
    const n = Math.max(1, Math.floor(poses));
    const mats: string[] = [];
    for (let i = 0; i < n; i++) {
      place(i);
      phone.updateMatrixWorld(true);
      mats.push(phone.matrixWorld.elements.join(','), lights[i].join(','));
    }
    const key = [modelKey, n, mats.join(';'), weights?.join(',') ?? '', frame.plane, frame.u0, frame.u1, frame.v0, frame.v1, frame.sigma.ambient, frame.sigma.contact].join('|');
    if (key === this.key) return;
    this.key = key;
    this.maskRenders++;
    const parent = phone.parent;
    // Silhouette: an orthographic camera looking straight at the catcher area.
    const P = frame.normal.clone().multiplyScalar(frame.plane + 10);
    const basis = new THREE.Matrix4().makeBasis(frame.axisU, frame.axisV, frame.normal).setPosition(P);
    const cam = this.orthoCam;
    cam.matrixAutoUpdate = false;
    cam.matrix.copy(basis);
    cam.left = frame.u0;
    cam.right = frame.u1;
    cam.bottom = frame.v0;
    cam.top = frame.v1;
    cam.near = 1;
    cam.far = 20;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    this.silScene.add(phone);
    // Each pose casts twice: along its key (the drop layer) and straight onto the catcher (the contact layer), each
    // silhouette added into its layer's sum with the pose's weight.
    const straight: [number, number, number] = frame.kind === 'wall' ? [0, 0, 1] : [0, 1, 0];
    for (const dst of [this.avg, this.avgC]) {
      r.setRenderTarget(dst);
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);
    }
    for (let i = 0; i < n; i++) {
      place(i);
      phone.updateMatrixWorld(true);
      for (const [L, dst] of [
        [lights[i], this.avg],
        [straight, this.avgC],
      ] as const) {
        (this.silMat.uniforms.uShadow.value as THREE.Matrix4).copy(planarShadowMatrix(frame.kind, frame.plane, L));
        r.setRenderTarget(this.sil);
        r.setClearColor(0x000000, 0);
        r.clear(true, false, false);
        r.render(this.silScene, cam);
        this.silhouettes++;
        this.addMat.uniforms.uSrc.value = this.sil.texture;
        this.addMat.uniforms.uW.value = weights ? weights[i] : 1 / n;
        this.quad.material = this.addMat;
        r.setRenderTarget(dst);
        r.render(this.quadScene, this.quadCam);
      }
    }
    if (parent) parent.add(phone);
    else this.silScene.remove(phone);

    // Blur: σ in texels along each axis (the mask is square, the catcher area is not).
    const du = frame.u1 - frame.u0;
    const dv = frame.v1 - frame.v0;
    const blur = (from: THREE.Texture, srcSize: number, dst: THREE.WebGLRenderTarget, dir: 'u' | 'v', sigmaWorld: number) => {
      const span = dir === 'u' ? du : dv;
      const sigma = (sigmaWorld * srcSize) / span;
      const k = blurKernel(sigma);
      const u = this.blurMat.uniforms;
      u.uSrc.value = from;
      (u.uDir.value as THREE.Vector2).set(dir === 'u' ? 1 / srcSize : 0, dir === 'v' ? 1 / srcSize : 0);
      (u.uOutSize.value as THREE.Vector2).set(dst.width, dst.height);
      u.uSigma.value = Math.max(1e-3, sigma);
      u.uStep.value = k.step;
      u.uHalf.value = k.half;
      this.quad.material = this.blurMat;
      r.setRenderTarget(dst);
      r.render(this.quadScene, this.quadCam);
    };
    const S = SILHOUETTE_SIZE;
    blur(this.avgC.texture, S, this.tc, 'u', frame.sigma.contact);
    blur(this.tc.texture, S, this.contact, 'v', frame.sigma.contact);
    // The ambient blur reads the 1024 silhouette at 512-texel centres: a free 2 × 2 average.
    blur(this.avg.texture, S, this.ta, 'u', frame.sigma.ambient);
    blur(this.ta.texture, AMBIENT_SIZE, this.ambient, 'v', frame.sigma.ambient);
  }

  /** Places the catcher for `frame` (the one render() made the masks for) and points it at the masks. */
  use(frame: CatcherFrame, opacity: number): void {
    const u = this.catcherMat.uniforms;
    u.uContact.value = this.contact.texture;
    u.uAmbient.value = this.ambient.texture;
    this.placeCatcher(frame, opacity);
  }

  /** Forget the cached masks (their targets were re-created, or the context was lost). */
  invalidate(): void {
    this.key = '';
  }

  /** The catcher quad in world space, its mask mapping and its opacity. */
  private placeCatcher(frame: CatcherFrame, opacity: number): void {
    const pos = this.catcher.geometry.getAttribute('position') as THREE.BufferAttribute;
    frame.corners.forEach((c, i) => pos.setXYZ(i, c.x, c.y, c.z));
    pos.needsUpdate = true;
    this.catcher.geometry.computeBoundingSphere();
    const u = this.catcherMat.uniforms;
    (u.uAxisU.value as THREE.Vector3).copy(frame.axisU);
    (u.uAxisV.value as THREE.Vector3).copy(frame.axisV);
    (u.uRange.value as THREE.Vector4).set(frame.u0, frame.u1, frame.v0, frame.v1);
    u.uOpAmbient.value = Math.min(1, Math.max(0, opacity));
    u.uOpContact.value = Math.min(1, Math.max(0, opacity * SHADOW_CONTACT.opacity));
  }

  bytes(): number {
    const S = SILHOUETTE_SIZE * SILHOUETTE_SIZE;
    const A = AMBIENT_SIZE * AMBIENT_SIZE;
    // Silhouette (4 MSAA samples + resolve), the two sums, the contact intermediate and mask (1024²), the ambient
    // intermediate and mask (512²); all 2 B per texel.
    return S * 2 * 5 + S * 2 * 4 + A * 2 * 2;
  }

  dispose(): void {
    for (const t of [this.sil, this.avg, this.avgC, this.tc, this.ta, this.contact, this.ambient]) t.dispose();
    this.silMat.dispose();
    this.addMat.dispose();
    this.blurMat.dispose();
    this.catcherMat.dispose();
    this.quad.geometry.dispose();
    this.catcher.geometry.dispose();
  }
}
