// The 3D phone's shadow (SPEC §3.7 step 5, D14): the phone's silhouette
// cast onto the catcher along the key light, blurred with the two widths of
// the flat frame's shadow (DEFAULT_FRAME_SHADOW: ambient, and a tight
// contact layer at 0.22× the blur and 0.7× the opacity), then drawn on the
// catcher plane as premultiplied black.
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
// Slots (§3.7 step 8: the shadow targets are per frame, not per tile): a
// moving frame's shadow follows up to SHADOW_SLOTS poses over the shutter.
// Each pose's blurred contact and ambient masks live in their own slot, so
// view.ts renders every slot once per frame, before the tile loop, and each
// tile's samples only point the catcher at the matching slot (use()). The
// silhouette and the two intermediate blur targets are scratch, shared by
// all slots. Slot 0 is made up front (a still phone needs only it); the
// others on the first moving frame.
import * as THREE from 'three';
import {
  keyLightDir,
  shadowCatcherCorners,
  shadowSigma,
  SHADOW_CONTACT,
  type Cam3D,
  type Scene3D,
} from '../../../shared/phone3d/projection';

export const SILHOUETTE_SIZE = 1024;
export const AMBIENT_SIZE = 512;
/** Most shadow poses (mask slots) per frame while the phone moves. */
export const SHADOW_SLOTS = 6;
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

/**
 * The catcher, its mask mapping and the planar shadow matrix at one sample:
 * the same catcher area and light direction the shared projection uses
 * (shadowCatcherCorners, keyLightDir), so the ROI and the drawn shadow agree.
 */
export function catcherFrame(s: Scene3D, cam: Cam3D): CatcherFrame {
  const corners = shadowCatcherCorners(s, cam).map((c) => new THREE.Vector3(c[0], c[1], c[2]));
  const L = keyLightDir(s.p3.light.azimuth + cam.pose.light);
  const sigma = shadowSigma(s, cam);
  const m = new THREE.Matrix4();
  if (s.p3.shadow.kind === 'wall') {
    const zw = corners[0].z;
    const lz = Math.max(L[2], MIN_WALL_LZ);
    const ax = L[0] / lz;
    const ay = L[1] / lz;
    m.set(1, 0, -ax, zw * ax, 0, 1, -ay, zw * ay, 0, 0, 0, zw, 0, 0, 0, 1);
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
      shadowMatrix: m,
      sigma,
      corners,
    };
  }
  const yf = corners[0].y;
  const ax = L[0] / L[1];
  const az = L[2] / L[1];
  m.set(1, -ax, 0, yf * ax, 0, 0, 0, yf, 0, -az, 1, yf * az, 0, 0, 0, 1);
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
    shadowMatrix: m,
    sigma,
    corners,
  };
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
  private readonly tc = r16(SILHOUETTE_SIZE);
  private readonly ta = r16(AMBIENT_SIZE);
  /** Blurred masks per slot, and what each was last rendered for (equal inputs give equal masks: reused). */
  private readonly slots: { contact: THREE.WebGLRenderTarget; ambient: THREE.WebGLRenderTarget; key: string }[] = [];
  /** Mask renders (silhouette + 4 blurs) so far; stats and tests. */
  maskRenders = 0;
  private readonly silMat: THREE.ShaderMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
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
    this.slot(0);
  }

  /** Slot `i`'s targets, made on first use. */
  private slot(i: number): { contact: THREE.WebGLRenderTarget; ambient: THREE.WebGLRenderTarget; key: string } {
    if (!Number.isInteger(i) || i < 0 || i >= SHADOW_SLOTS) throw new Error(`phone3d: shadow slot ${i} out of range`);
    while (this.slots.length <= i) this.slots.push({ contact: r16(SILHOUETTE_SIZE), ambient: r16(AMBIENT_SIZE), key: '' });
    return this.slots[i];
  }

  /**
   * Renders slot `slot`'s masks for `frame` from the phone (`phone` is moved
   * into the silhouette scene for the pass and put back). `modelKey` names the
   * phone model; with the same model, catcher, light and pose (the phone's
   * world matrix) as that slot last had, its masks are reused as they are (a
   * still phone, the paused preview, playback without moves). Does not place
   * the catcher: use() does, per sample.
   */
  render(phone: THREE.Object3D, frame: CatcherFrame, modelKey: string, slot = 0): void {
    const r = this.renderer;
    const target = this.slot(slot);
    const key = [modelKey, phone.matrixWorld.elements.join(','), frame.shadowMatrix.elements.join(','), frame.u0, frame.u1, frame.v0, frame.v1, frame.sigma.ambient, frame.sigma.contact].join('|');
    if (key === target.key) return;
    target.key = key;
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
    (this.silMat.uniforms.uShadow.value as THREE.Matrix4).copy(frame.shadowMatrix);
    this.silScene.add(phone);
    r.setRenderTarget(this.sil);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this.silScene, cam);
    if (parent) parent.add(phone);
    else this.silScene.remove(phone);

    // Blur: σ in texels along each axis (the mask is square, the catcher area is not).
    const du = frame.u1 - frame.u0;
    const dv = frame.v1 - frame.v0;
    const blur = (src: THREE.Texture, srcSize: number, dst: THREE.WebGLRenderTarget, dir: 'u' | 'v', sigmaWorld: number) => {
      const span = dir === 'u' ? du : dv;
      const sigma = (sigmaWorld * srcSize) / span;
      const k = blurKernel(sigma);
      const u = this.blurMat.uniforms;
      u.uSrc.value = src;
      (u.uDir.value as THREE.Vector2).set(dir === 'u' ? 1 / srcSize : 0, dir === 'v' ? 1 / srcSize : 0);
      (u.uOutSize.value as THREE.Vector2).set(dst.width, dst.height);
      u.uSigma.value = Math.max(1e-3, sigma);
      u.uStep.value = k.step;
      u.uHalf.value = k.half;
      r.setRenderTarget(dst);
      r.render(this.quadScene, this.quadCam);
    };
    const S = SILHOUETTE_SIZE;
    blur(this.sil.texture, S, this.tc, 'u', frame.sigma.contact);
    blur(this.tc.texture, S, target.contact, 'v', frame.sigma.contact);
    // The ambient blur reads the 1024 silhouette at 512-texel centres: a free 2 × 2 average.
    blur(this.sil.texture, S, this.ta, 'u', frame.sigma.ambient);
    blur(this.ta.texture, AMBIENT_SIZE, target.ambient, 'v', frame.sigma.ambient);
  }

  /** Places the catcher for `frame` (the pose slot `slot` was rendered at) and points it at that slot's masks. */
  use(slot: number, frame: CatcherFrame, opacity: number): void {
    const target = this.slot(slot);
    const u = this.catcherMat.uniforms;
    u.uContact.value = target.contact.texture;
    u.uAmbient.value = target.ambient.texture;
    this.placeCatcher(frame, opacity);
  }

  /** Forget the cached masks (their targets were re-created, or the context was lost). */
  invalidate(): void {
    for (const t of this.slots) t.key = '';
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

  /** Slots made so far (1 until the first moving frame, then up to SHADOW_SLOTS). */
  get slotCount(): number {
    return this.slots.length;
  }

  bytes(): number {
    const S = SILHOUETTE_SIZE * SILHOUETTE_SIZE;
    const A = AMBIENT_SIZE * AMBIENT_SIZE;
    // Scratch: silhouette (4 MSAA samples + resolve), contact and ambient intermediates; per slot: contact and
    // ambient masks; all 2 B per texel.
    return S * 2 * 5 + S * 2 + A * 2 + this.slots.length * (S * 2 + A * 2);
  }

  dispose(): void {
    for (const t of [this.sil, this.tc, this.ta, ...this.slots.flatMap((x) => [x.contact, x.ambient])]) t.dispose();
    this.slots.length = 0;
    this.silMat.dispose();
    this.blurMat.dispose();
    this.catcherMat.dispose();
    this.quad.geometry.dispose();
    this.catcher.geometry.dispose();
  }
}
