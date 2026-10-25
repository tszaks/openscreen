# OpenScreen 3D Phone: Final Implementation Spec

Branch `feat/3d-phone` (main 3dea11b + "add three.js", three 0.186.1). Worktree `/Users/tyler/Projects/Worktrees/openscreen-3d-phone` = **R**. **E** = `R/electron`. Paths below are relative to E unless they start with R/ or /.

This spec is built on the "parity" proposal, with every judge finding fixed and the best parts of "look" and "risk" added. Section 0 lists the fixes so a reviewer can check them.

## 0. Decisions, and the judge findings they fix

| # | Decision | Fixes / source |
|---|---|---|
| D1 | **Every 3D control in the editor sends an op.** `apply3d(op)` in the editor runs the shared `applyOp`. A test fails if the 3D panel or the lane files contain `setProj(`. A replay test checks the result is the same JSON. | parity (winner) |
| D2 | All 3D state is in ONE optional key, `project.phone3d`. The moves are at `phone3d.transitions[]`. **This is a deliberate change from the brief's top-level `project.transitions`.** Reasons: one absent check, one normalizer, one reset rule, and no name clash with future clip crossfades. Renaming it later is a mechanical change. | flagged by all judges: owner sign-off item |
| D3 | **Colour pipeline: HDR until the end, screen kept exact by a second attachment (revised).** In three r0.186, `WebGLPrograms.js:181` tone maps only when `currentRenderTarget === null`, and in a render target the output colour space is the working (linear) space (line 213). So inside our targets every lit material already writes **scene-linear HDR with no tone map**. We render into a 2-attachment target (`new WebGLRenderTarget(w, h, { count: 2, samples: 4, type: HalfFloatType })`, multisampled MRT is supported in r186). Lit materials write attachment 0 = HDR premultiplied colour and attachment 1 = `vec4(0)`. The screen writes attachment 0 = `vec4(0,0,0,a)` and attachment 1 = its premultiplied linear colour with alpha = its coverage. Motion blur, AA and DoF average both attachments in HDR. Only the output pass tone maps: `NeutralToneMapping(att0.rgb) + att1.rgb` (three's own `NeutralToneMapping` from `tonemapping_pars_fragment`, included explicitly, see §3.5). So a band highlight of 10 seen in 2 of 12 sub-samples averages to 1.67 and tone maps to about 0.95: a bright streak, not the 0.17 grey smear that per-material tone mapping gives. The screen goes sRGB → linear → sRGB untouched, so it stays exact. The earlier "tone map in each material" plan is dropped. | J1/J3 (parity, risk); critique: highlights clipped before blur |
| D4 | **The phone placement math moves to shared** so the CLI build (`tsconfig.main.json` includes only main, preload, shared, node) can use it. The pure parts of `renderer/src/mobile/deviceFrame.ts` and `mobile/layout.ts` (`computePhoneLayout`, `fitRect`) move to `shared/deviceGeometry.ts` and `shared/phoneLayout.ts`. The renderer files re-export them. A new `shared/phone3d/placement.ts` holds `phoneHome()`. | J1/J2/J3 (look, parity); risk's named move |
| D5 | **Zoom intervals have ONE source: the whole Editor `segments` memo (Editor.tsx:459-478) moves to shared as `focusSegmentsFor(p, cursor = [], durationFallback?)`.** It computes everything the memo computes: autofocus (`AutofocusPlanner` over `toOutputTime([clickDown samples, dwellFocusEvents(cursor) when dwell, ...p.zoom.motionEvents])`), tap zooms (`planTapZoom`), and manual zooms, in the exact order `[auto, taps, manual]` with the same stable sort by `inStart`. The memo calls it, so old projects zoom exactly as before. The CLI reads `cursor.json` (`.samples`, the same file main/index.ts:902 reads) in `buildContext`, `info` and `validate`, and puts it in `ApplyContext.cursor`. iPhone takes have no cursor samples, but `motionEvents` is in Project and autofocus defaults ON for non-imported takes (types.ts:360), so the old "CLI cannot see autofocus" gap was wrong. `extraZooms` is removed everywhere. | J1/J2/J3; critique: D5 reason wrong |
| D6 | **Past-end is a warning, not an error.** Hard errors are structural only, so a trim can never lock `applyOps`. | J3 (parity and risk) |
| D7 | `phone3d {enabled:true}` changes nothing else. When the frame is off, the `inactive` warning carries a fix op, `device {frame:true}`. | J1/J2 |
| D8 | **The spring is closed-form, with length L = max(D, settleTime).** When there is time, it is the real physics in seconds (stiffness = speed, damping = bounce). A move that is too short compresses the whole curve, so the shape stays and nothing kinks. "Fit length" sets D = settleTime. | fixes J1/J2 tail-blend kink; adapts look's length fit |
| D9 | **three is loaded lazily** (`import()`), only when `phone3dActive` is true, so flat projects never load three. Export and frames wait for the load before frame 0. The preview preloads it at mount when `proj.phone3d` exists, so the only flat-frame pop is on the very first enable. | risk |
| D10 | `frames` writes to `os.tmpdir()/openscreen-frames/<bundle>-<stamp>/` by default, not into the bundle. | J1/J2/J3 |
| D11 | The flat-identity gate compares **exports** (`ffmpeg -f framemd5`) from main and from the branch. It does not use `frames`, which main does not have. A mockCanvas draw-call log is captured from main's compositor before any compositor edit. | J2 |
| D12 | Sign rule: **+tilt leans the top away (layback)**. Every recipe uses this rule, and a test pins it. `turn-to-back` is a round trip by default and ends at 360. | J3 (risk sign bug, one-way outro) |
| D13 | **Restored in look round 3 (see "Look round 3" at the end of §3.4): the hero softboxes are RectAreaLights again, the set round the phone is the PMREM, the light channel turns both.** Round 2 had moved every box into the PMREM; a flat metal face mirrors one direction of an infinitely far environment at every point, so the backs and the turn-90 side read as one flat tone. Original text: Lighting is **procedural, in two parts (revised)**. (1) The 2 or 3 hero softboxes are `RectAreaLight`s (`RectAreaLightUniformsLib.init()` from `three/examples/jsm/lights`). LTC gives analytically sharp softbox edges at any resolution, and in r186 it covers clearcoat too (`lights_physical_pars_fragment` evaluates `LTC_Uv(Ncc, …)`). (2) A PMREM environment (`fromScene(envScene, 0, near, far, { size: 512 })`) holds only the fill: a dim vertical gradient dome (2 to 6%), a floor bounce tinted by the project's mean background colour, and a faint wide strip behind and above the camera so the front glass shows a diagonal sheen at FRONT. The hero boxes are NOT in the PMREM scene (no double counting). The `light` channel rotates the RectAreaLight group and `scene.environmentRotation` together. No HDRI is shipped. A CC0 Poly Haven HDRI is a later option only if the judge harness says the procedural look loses. | all three; critique: soft, sparse lighting |
| D14 | Band geometry is a **swept profile** along the continuous-corner outline with **hard creases** (the ring is duplicated at each crease) and a 0.08 to 0.12 mm fillet at each chamfer edge that catches a 1 to 2 px glint at 1080p. A dark recessed seam separates glass and band on both faces. Tangents run along the outline for brushed anisotropy. Shadow is a silhouette rendered from the light, with two blur widths that mirror `DEFAULT_FRAME_SHADOW`. | look; critique: missing edge glints |
| D15 | The 3D pass composites at the **`content` layer slot**. `decor()` skips `drawDeviceFrame` and keeps keystrokes. The camera bubble, text, title and captions stay flat on top. No new LayerId. | all three |
| D16 | Hit-testing uses an **exact homography of the screen plane**. This is the same result as a raycast against that plane, but it is pure shared math with no three import. A vitest test checks it against three's camera. Selection uses the convex hull of the projected body. | parity |
| D17 | One WebGL context per process (a module singleton). A lost GPU context aborts export. A flat export is never written silently. | all three |
| D18 | **4K for preset layouts.** `exportPreset: 'uhd4k'` scales a preset layout's canvas so its short side is 2160 (social-9x16 and shorts-hq → 2160×3840, landscape-16x9 → 3840×2160). `'p1080'` and `'original'` keep the preset's own size. App Store presets are never scaled (Apple needs exact sizes). The Classic layout keeps today's `exportCanvasSize` (source aspect). This goes through `projectCanvasSize`, `presetCompositor`, `planRenders` and the transcode size, so `export --preset social-9x16` gives a real 2160×3840 file. | critique: no 4K path for presets |
| D19 | **Anti-aliasing is jittered accumulation, not supersample × MSAA.** MSAA 4 at ss 1. Each accumulation sub-sample offsets the camera by a fixed Halton(2,3) sub-pixel amount through `camera.setViewOffset` (the method of three's SSAARenderPass and TAARenderPass). Motion-blur samples are AA samples at no extra cost. Export always takes at least 8 jittered samples, even when the phone is still. `supersample` 2 or 3 stays as an opt-in. Big ROIs render in tiles (§3.7), so GPU memory stays ≤ 340 MB at 4K (advisor, 2026-10-24: raised from 300 for the D14 shadow ROI). | critique: 4K memory plan fails (≈1.2 GB) |
| D20 | **The content LayerBox keeps `rect` = the placed home body** (`contentRect`, unchanged), so `placeLayer`, `resizeFromCorner`, `snapBox` and `nudgeLayer` math stays the same. A new optional `LayerBox.hull?: Point[]` (the projected body hull) is used for hit-testing and the drawn outline only. | critique: §3.8 broke move and resize |
| D21 | **Turn never runs away.** `expandShot` rebases the `before` turn to the equal angle (mod 360) nearest 0, in [-180, 180], and writes it as an explicit `from` on the shot's first move. `pose-jump` compares `turn` and `rotate` modulo 360, so a rebase is not a jump. Any number of shots stays inside `POSE_RANGE`. | critique: turn values only grow |
| D22 | **8-bit output is clean.** The output pass unpremultiplies, encodes sRGB, premultiplies again (no bright halo on edges), and adds a fixed ±0.5 LSB screen-space dither on the lit part only (never on the screen pixels, so FRONT stays exact). The shadow mask is R16F. | critique: premultiplied encode, banding |

Verified against code: `remapTime(t, oldTl, newTl, bias)` (shared/remap.ts:63), `remapZooms` anchors on `holdStart` (129), `remapProject` (142); `new Timeline(duration, clips)` (shared/timeline.ts:4); `isPhoneProject`, `resolveDevice`, `layoutPreset`, `projectCanvasSize`, `presetAllowsZoom`, `tapsToOutput`, `rangesToOutput` (shared/mobileProject.ts); `phoneLayerOn` (shared/phoneLayer.ts:22); `placeContent`, `mapRect` (shared/contentTransform.ts:41,53); `planTapZoom` (shared/autozoomTaps.ts:61); `smootherstep` (shared/easing.ts:14); `laneHeights(phone, music)` (shared/timelineView.ts:71); `parseHeadlessArgs` (shared/headless.ts:42); `OP_NAMES` (agentOps.ts:378); the bundle watcher fires only for `project.json` (main/index.ts ~800); the `.tabs[data-count='8']` CSS exists (styles.css:613); the compositor's `drawContent` (326), `decor` (434), `phoneSetup` (680). Added for this revision: `exportCanvasSize` uhd4k (shared/exportArgs.ts:15), `projectCanvasSize` ignores `exportPreset` when a preset is set (mobileProject.ts:82-84), polish forces `social-9x16` on phones (polish.ts:43), the Resolution control is only in the no-preset panel (ExportPanel.tsx:61-71, Editor.tsx:3343), `presetCompositor` (Editor.tsx:1145), `planRenders` sizes passes from `p.width` (exportJobs.ts:127-138); `placeLayer`/`nudgeLayer`/`resizeLimits` read `box.rect`/`box.base` (canvasLayers.ts:132-176), `overLayer`/`hitLayer` (202-210), `dragPreview` (Editor.tsx:597-612); `projRef.current` is updated in a passive effect (Editor.tsx:205-213); the `segments` memo (Editor.tsx:459-478) and `defaultZoom.autofocus = !imported` (types.ts:360); `onSeeked → renderAt` (Editor.tsx:969) and export reuses `compositor` (1180); `drawContent` sizes cursor, ripple and line width from canvas H (compositor.ts:355-380); `compositor.ts` imports `./api`, which reads `window.openscreen` at load (api.ts:172), and vitest runs with `environment: 'node'` (vite.config.ts:14); `cursor.json` is read by main/index.ts:902. three r186: `PMREMGenerator.fromScene(scene, sigma, near, far, { size })` (PMREMGenerator.js:107), `RenderTarget` `count`/`samples` (core/RenderTarget.js:40-41), `reversedDepthBuffer` (WebGLRenderer.js:83), `sRGBTransferOETF` (colorspace_pars_fragment), `NeutralToneMapping` (tonemapping_pars_fragment:170), `dithering()` (dithering_pars_fragment), RectAreaLight clearcoat LTC (lights_physical_pars_fragment), `layout(location = 0) out highp vec4 pc_fragColor` prefix (WebGLProgram.js:819).

---

## 1. Data model

### 1.1 Types: `src/shared/phone3d/model.ts` (pure; imports nothing from types.ts)

```ts
/** Degrees / fractions. Euler 'ZXY': R = Rz(rotate)·Rx(tilt)·Ry(turn).
 *  turn: spin about the phone's long axis, unwrapped (0→360 = one full spin), -720..720
 *  tilt: + leans the TOP AWAY from camera (layback), -85..85
 *  rotate: roll in the picture plane, + = clockwise, -180..180
 *  size: × the flat layout's body height, 0.2..3
 *  x, y: offset of the phone centre from its home, fraction of canvas W / H (+y = down), -1..1
 *  light: key-light azimuth OFFSET added to phone3d.light.azimuth, -180..180
 *  focus: depth-of-field strength, a multiplier on phone3d.dof.amount, 0..2 (0 = sharp, 1 = the setting).
 *         Animating it gives a focus pull. It does nothing while dof.on is false. */
export interface Pose { turn: number; tilt: number; rotate: number; size: number; x: number; y: number; light: number; focus: number }
export const FRONT: Pose = { turn: 0, tilt: 0, rotate: 0, size: 1, x: 0, y: 0, light: 0, focus: 1 };
export const POSE_KEYS = ['turn','tilt','rotate','size','x','y','light','focus'] as const;
export const POSE_RANGE = { turn:[-720,720], tilt:[-85,85], rotate:[-180,180], size:[0.2,3], x:[-1,1], y:[-1,1], light:[-180,180], focus:[0,2] } as const;
/** Channels compared modulo 360 (pose-jump, rebasing). */
export const ANGLE_KEYS = ['turn','rotate'] as const;

export type EasingName = 'smooth'|'linear'|'easeIn'|'easeOut'|'cinematic'|'spring'|'bezier';
export type Easing =
  | { kind: 'smooth'|'linear'|'easeIn'|'easeOut'|'cinematic' }
  | { kind: 'spring'; stiffness: number; damping: number }          // mass 1
  | { kind: 'bezier'; x1: number; y1: number; x2: number; y2: number };
export const SPRING_RANGE = { stiffness: [1, 1000], damping: [0.1, 200] } as const;
export const SPRING_DEFAULT = { stiffness: 180, damping: 18 };     // ζ≈0.67, one soft overshoot
export const MIN_TRANSITION = 0.1;

export interface PoseTransition {
  id: string;
  start: number;            // OUTPUT seconds
  end: number;              // OUTPUT seconds, end - start >= MIN_TRANSITION
  from?: Pose;              // Start keyframe; absent = linked (continues from the pose at `start`)
  to: Pose;                 // End keyframe, always a full pose (ops fill partial input)
  easing: Easing;
  recipe?: ShotRecipe;      // display only (lane label, info)
}

export type LightPreset = 'studio'|'soft'|'contrast'|'warm'|'night';
export interface Phone3D {
  enabled: boolean;                                   // false = render flat, keep settings
  pose: Pose;                                         // base pose (held before / without moves)
  camera: { fov: number /*8..60, 22*/; elevation: number /*0..30, 0*/ };
  light: { preset: LightPreset; azimuth: number /*-180..180, -35*/; intensity: number /*0..2, 1*/ };
  glass: number;                                      // front-glass sheen 0..1, 0.25
  back: 'auto'|'glossy'|'frosted';                    // auto: frosted on Pro models
  shadow: { on: boolean; kind: 'wall'|'floor'; opacity: number /*0..1,.4*/; softness: number /*0..1,.5*/ };
  dof: { on: boolean; amount: number /*0..1,.35*/; background: number /*0..1, 0*/ };
  float: { on: boolean; amount: number /*0..1,.4*/; period: number /*2..20 s, 6*/ };
  motionBlur: { on: boolean; shutter: number /*0..1 of a frame, .5*/; samples: number /*int 2..32, 12*/ };
  supersample: 1|2|3;                                 // export and frames only; preview 1; default 1 (D19: AA comes from jitter)
  transitions: PoseTransition[];                      // sorted by start, then id
}
export function defaultPhone3D(): Phone3D;            // values in the comments above; transitions []
```

**Model and finish have one source.** The 3D phone reads `resolveDevice(p)` (model, orientation) and `getFinish(device, p.device.finishId)` (hex). `phone3d` stores no model and no finish, so the Device tab still picks the phone.

### 1.2 `src/shared/types.ts` changes (only these)
- Add `phone3d?: Phone3D` to `Project` after `layerOrder?`, with the comment `/** 3D phone mockup. Absent = flat: the exact pre-3D render. */`.
- Do **not** add it to `defaultProject`. `resetProject` rebuilds from the defaults, so a reset drops 3D. `test/resetProject.test.ts` gets an assertion for this.
- In `normalizeProject`:
  `if (p.phone3d !== undefined) { const n = normalizePhone3D(p.phone3d); if (n) p.phone3d = n; else delete p.phone3d; }`

### 1.3 Normalize (`normalizePhone3D(raw): Phone3D | undefined` in model.ts)
- A non-object returns `undefined`, and the key is deleted.
- Otherwise the object is rebuilt in **declared key order** from `defaultPhone3D()`. Each number goes through `finite()` and a clamp, a bad enum becomes its default, and `samples` is rounded.
- Easing params are kept only for their own kind. A spring without numbers gets `SPRING_DEFAULT`. A malformed bezier becomes `cinematic`.
- Transitions: items are dropped when `start`/`end` is not finite or `end - start < MIN_TRANSITION`. A missing id becomes `t${index}` (deterministic, never `randomUUID`). Partial poses are merged over FRONT, so a pose saved before `focus` existed gets `focus: 1` (no visual change). The list is sorted by `(start, id)`.
- Invariants, all tested:
  - `N(N(x))` is JSON-equal to `N(x)`, so live reload (Editor.tsx ~394) cannot loop.
  - Old projects gain no key.
  - Hostile JSON is clamped or dropped.

### 1.4 When 3D is active: one gate
`phone3dActive(p): { active: boolean; reason?: 'disabled'|'not-iphone'|'frame-off'|'app-store'|'mac-iphone'|'frameless-layout' }` in model.ts. It is active only when all of these hold:
- `p.phone3d?.enabled`
- `isPhoneProject(p)`
- `p.device.frame`
- `!phoneLayerOn(p)`
- the preset is null, or `preset.layout === 'framed'`. The App Store `full-bleed` preset and frameless layouts render flat.

The compositor, the 3D tab, the warnings and `info` all call this one gate. App Store previews stay flat because of how the code is built.

### 1.5 Hard validation (errors) in `validateProject` (agentOps.ts ~198)
`if (p.phone3d !== undefined) errs.push(...phone3dProblems(p))`. `phone3dProblems` lives in `shared/phone3d/validate.ts` and reports these only:
- Every pose channel outside `POSE_RANGE`, in the base pose and in each `from`/`to`.
- Each settings field outside its range, or an unknown enum. `samples` must be an integer 2..32. `supersample` must be 1, 2 or 3.
- Transitions:
  - `start < 0`
  - `end - start < MIN_TRANSITION`
  - ids that are empty or not unique
  - spring values outside `SPRING_RANGE`
  - bezier `x1`/`x2` outside 0..1, `y1`/`y2` outside -1..2, or not finite
- Message format follows the existing ones, for example `phone3d.transitions[2].easing.stiffness must be 1..1000`.
- **Not errors** (these are warnings, §2.7): overlap, past the end, steep angle, off canvas, inactive.

### 1.6 Time domain and cuts
Transitions are in OUTPUT seconds, like `manualZooms`. Add this to `shared/remap.ts`:
```ts
/** A 3D move follows the moment it lands on (its End keyframe); its duration stays. */
export function remapTransitions(list: PoseTransition[], oldTl: Timeline, newTl: Timeline): PoseTransition[] {
  return list.flatMap((tr) => {
    const end = remapTime(tr.end, oldTl, newTl, 'end') ?? remapTime(tr.start, oldTl, newTl, 'start');
    if (end === null) return [];
    const len = tr.end - tr.start, start = Math.max(0, end - len);
    return end - start < MIN_TRANSITION ? [] : [{ ...tr, start, end }];
  }).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}
```
- Anchoring on the end keeps every move landing before the tap it serves.
- If the end anchor is gone, the move falls back to its start.
- `remapProject` gains `...(p.phone3d ? { phone3d: { ...p.phone3d, transitions: remapTransitions(p.phone3d.transitions, oldTl, newTl) } } : {})`, so the key is never created.
- Both agent `withClips` and editor `editClips` (Editor.tsx ~1399) already go through `remapProject`.

### 1.7 Undo
- Undo needs no new code. Every op returns a new Project, and the history effect (Editor.tsx ~201) records it.
- ScrubField and slider gestures use `historyRef.current.hold()` with `onCommit={sealHistory}`. Orbit and lane drags call `hold()` on pointerdown and `seal()` on pointerup.
- Auto 3D, shot tiles, Clear moves, Remove 3D and Reset 3D Pose go through `announce(msg, edit)`, which gives one step and a toast with Undo. A warning's Fix and Reset 3D Pose send their ops as one `apply3d` list, so they are one step too.

---

## 2. Pure math modules (`src/shared/phone3d/`, no DOM, no three)

### 2.1 `easing3d.ts`: `ease(e: Easing, u: number, durationSec: number): number`
`u` is clamped to 0..1 on input. f(0)=0 and f(1)=1 exactly; a spring may overshoot.

| kind | curve |
|---|---|
| smooth | `smootherstep` (shared/easing.ts), the same feel as zoom |
| linear | u |
| easeIn | cubic-bezier(0.42, 0, 1, 1) |
| easeOut | cubic-bezier(0, 0, 0.58, 1) |
| cinematic | cubic-bezier(0.7, 0, 0.16, 1) |
| bezier | `cubicBezier(x1,y1,x2,y2,u)`: 8 Newton steps, then 20 bisection steps if \|x'\| < 1e-6. Fixed counts keep it deterministic. |

**spring** uses mass 1, ω = √k and ζ = c / (2√k):
- under-damped: `x(τ) = 1 − e^{−ζωτ}(cos ω_dτ + (ζω/ω_d) sin ω_dτ)`, with ω_d = ω√(1−ζ²)
- critical (\|ζ−1\| < 1e-4): `x = 1 − e^{−ωτ}(1+ωτ)`
- over-damped: r₁,₂ = −ω(ζ ∓ √(ζ²−1)), `x = 1 + (r₂e^{r₁τ} − r₁e^{r₂τ})/(r₁ − r₂)`

How it is fitted to the move:
- `springSettleTime(k, c, tol = 1e-3)` is the smallest τ where the monotone envelope is ≤ tol. It uses 60 fixed bisection steps, on `e^{−ζωτ}/√(1−ζ²)` (under-damped), `e^{−ωτ}(1+ωτ)` (critical) or `1−x` (over-damped). Results are memoized per (k, c).
- `L = max(D, T)`, then `ease(u) = x(u·L) + u·(1 − x(L))`. The residual is ≤ 1e-3, so the end lands exactly.
- When D ≥ T, the move is real physics in seconds: the spring settles, then holds. When D < T, the curve is compressed, keeping its shape.
- The editor's "Fit length" button and the op flag `fitDuration:true` set `end = start + T`.

Tests (`test/easing3d.test.ts`):
- every kind has exact endpoints
- non-spring kinds are monotone
- cubic-bezier matches 11 hard-coded Chromium reference points within 1e-4
- spring 180/18 overshoots 2-12%
- ζ ≥ 1 never goes over 1
- a short move keeps the same peak overshoot as a long one
- 1000 repeat calls are bit-identical
- smooth and cinematic have zero end velocity

### 2.2 `pose.ts`
- `lerpPose(a, b, s)` interpolates each channel with no wrap, so 0→360 is a full spin. `s > 1` is allowed (spring overshoot).
- `resolveStarts(p3): Pose[]`: for each transition i in order, `start_i = tr.from ?? poseAtExcluding(i, tr.start)`. A linked start that overlaps an earlier move starts from the mid-flight pose, so the motion is continuous. It is O(n).
- `poseAt(p3, t)` (the core, no float):
  - no moves: `p3.pose`
  - `t` before the first start: the first move's resolved start
  - otherwise the last move with `start ≤ t` (when moves overlap, the later start wins): `t ≥ end` gives `to`, else `lerpPose(start_i, to, ease(...))`
- `poseAtWithFloat(p3, t)` adds the idle drift when `float.on`, with A = amount and ω = 2π/period:
  - `y += A·0.012·sin(ωt)`
  - `turn += A·4·sin(ωt + 1.1)`
  - `tilt += A·2.5·cos(ωt)`

  This is a pure function of t. Everyone outside pose.ts calls `poseAtWithFloat`.
- `poseTargetAt(p3, t, selectedId?)` decides which keyframe a pose edit changes. Sliders, orbit and the `setPose` op all use it:

  | situation | target |
  |---|---|
  | the editor's "Editing:" choice is **Base pose** (or the op says `target:'base'`) | the base pose `p3.pose`, even when moves exist |
  | a move is selected | its nearer end (`from` is materialized when it is linked) |
  | inside a move | its nearer end |
  | in the hold after move k | `k.to` |
  | before the first move | `first.from`, materialized |
  | no moves | the base pose |

  The base pose is what the phone holds before the first move when that move has a linked Start, and what every linked first move starts from. Editing it with moves present is how a user changes "where the phone rests" without touching each move.

- `facing(p3, t, cam)` returns the cosine between the screen normal and the view ray. `poseSpeed(p3, t)` returns the angular speed in °/s by central difference at a fixed 1/240 s.
- `poseDelta(a, b)` returns the per-channel difference with `ANGLE_KEYS` taken modulo 360 into (-180, 180]. `pose-jump` and the rebase rule (D21) use it.
- `rebaseTurn(pose)` returns the pose with `turn` moved by a whole number of turns into [-180, 180].

Tests (`test/pose3d.test.ts`):
- holds, linked continuity, continuity when moves overlap, a 720° spin
- float periodicity
- each `poseTargetAt` case, including `Base pose` with moves present
- the tilt sign: +tilt gives a top edge with a smaller projected width
- `poseDelta({turn:360}, {turn:0}).turn === 0`; `focus` lerps like the other channels

### 2.3 `placement.ts` and `projection.ts`
`phoneHome(p, canvas): { body: Rect; screen: Rect; device: DeviceModel; orientation } | null` copies the compositor's two framed iPhone cases exactly:
- framed preset: `computePhoneLayout(...).device`, then `placeContent(base, style.contentTransform, canvas)`
- no preset: `deviceBodyRect(paddedRect, device, {orientation})`, then `placeContent`

`test/placement3d.test.ts` renders the compositor through the WP0 harness (`test/helpers/compositorHarness.ts`, §6.1) and asserts `compositor.contentRect` equals `phoneHome().body` for 6 fixtures, **with 3D on and off**. `contentRect` does not change when 3D is on (D20).

`projection.ts` has its own small mat4 helpers:
- `cameraFor(home, pose, camera, canvas, body3d)`
  - perspective with vertical fov. Distance `d = (canvasH/2)/tan(fov/2)` in px units.
  - the model is scaled by `pxPerMm·pose.size`
  - **fit plane = the front glass plane (z = depth/2)**. At FRONT the screen quad equals the flat screen rect within 0.25 px, so turning 3D on does not move the recording. The body silhouette comes out about 0.5% smaller than the 2D frame, which is accepted (IoU ≥ 0.97).
  - `x`/`y` move the model in the plane of the front face by `x·W` and `y·H`
  - `elevation` orbits the camera down to look at the phone from slightly above (used by the floor shadow)
  - landscape adds `Rz(±90)` to match `frameGeometry` rotation
- `project(pt, cam) → [px, py, depth]`
- `screenQuad(p, t)` returns 4 corners plus `facing`
- `homography(quad)` / `invHomography`
- `canvasToScreenUV(px, py)` returns null when `facing < cos 80°` or the point is outside the continuous-corner screen outline
- `bodyHull(p, t)` returns the convex hull of 8 body corners plus the plateau top corners (from `body3dFor`, shared/devices3d.ts, which WP1 owns)
- `bodyBounds(p, t, times?)` is the bbox of the hull, unioned over the motion-blur sub-frame times
- `shadowHull(p, t, light)` projects the body hull onto the active catcher plane (wall `WALL_GAP_MM` = 1 mm behind the rearmost hull point at time t, or floor 1 mm under the lowest hull point; D14, owner decision 6) along the key-light direction (azimuth `light.azimuth + pose.light`, elevation 55°), then back to the canvas
- `renderRoi(p, t, times, opts)` = bbox of `bodyHull ∪ shadowHull` unioned over the sub-frame times, built from `shadowCatcherCorners` (the full shadow out to 3σ, `shadowSigma`: ambient σ = 0.0425·body long side·softness/0.5, contact σ = 0.22× that) padded by the max DoF CoC + 2 px, with the body box padded by CoC + 2 px only, clamped to the canvas, then **snapped outward to whole canvas pixels**. Integer `roi.x`/`roi.y` keep the FRONT screen texel-aligned and stop `drawImage` from resampling the phone.
- `depthRange(p, t, cam)` returns `{ near, far }`: with `d` the camera distance to the body centre and `R` the body bounding radius in px plus the catcher distance, `near = max(1, d − R)` and `far = d + R + catcherDepth`. The renderer sets these every frame (§3.7).
- `hullTravelPx(p, t, shutterSec, renderScale)` returns the largest distance a projected hull corner moves over the shutter, in render pixels. It drives the adaptive motion-blur count (§3.7). Pose only, so it is deterministic.

Tests (`test/projection3d.test.ts`; vitest may import three, shared code may not):
- the FRONT quad equals `screenRectFor` within 0.25 px for all 22 iPhones × 3 layouts
- 200 random poses match three's `PerspectiveCamera` with Euler `'ZXY'` within 0.01 px
- the homography round trip is within 1e-6
- turn 180 gives null
- `renderRoi` contains `shadowHull` for wall and floor at 5 light angles
- `depthRange` keeps the whole body and catcher between near and far for 200 random poses, and `near ≥ 0.25·d` when `size ≤ 1.5` and `fov ≤ 35`; at any fov, near is set only by what is on the canvas

### 2.4 `outline.ts`
`continuousRectPoints(w, h, r, segPerCorner)` samples Apple's 6-segment continuous-corner bezier table. The table moves out of `deviceFrame.ts continuousRectPath`, which then reads it from here. `deviceFrame.test.ts` stays green unchanged, and a new test checks that the path commands are identical.

### 2.5 `shots.ts`: recipes as data
```ts
export type ShotRecipe = 'spin-in'|'turn-to-back'|'hero-layback'|'float'|'settle';
export interface ShotKey { from?: Partial<Pose>; to: Partial<Pose>; frac: [number, number]; easing: Easing }
export const SHOTS: Record<ShotRecipe, { duration: number; keys: ShotKey[]; float?: true; summary: string; use: string }>;
```

| recipe | dur | keys (deltas from `before`; + tilt = layback) | easing |
|---|---|---|---|
| spin-in | 1.6 | from `{turn:-200, tilt:14, size:-0.45, y:0.06, light:-60, focus:+0.8}` → `{}` (starts soft, resolves sharp) | spring 120/16 |
| turn-to-back | 2.6 | [0,.45] → `{turn:+180, tilt:6, light:40}`; [.55,1] → `{turn:+360, tilt:0, light:0}` | cinematic, cinematic |
| hero-layback | 1.4 | → `{turn:-24, tilt:16, rotate:-4, size:-0.08, light:-25}` (with `return:'front'`, a second spring key goes back) | cinematic |
| settle | 1.0 | from `{tilt:8, size:+0.06, y:-0.03}` → `{}` | spring 220/20 |
| float | 0 | sets `phone3d.float.on` (no transitions) | — |

`expandShot(recipe, { start, duration?, intensity = 1, direction = 1, ret = 'front' }, before: Pose, newId)` returns `{ transitions, float? }`:
- keys scale to the duration
- angle and offset deltas are multiplied by `intensity` (0.25..2)
- `direction: -1` mirrors turn and rotate
- `ret: 'stay'` drops the return key of turn-to-back and hero-layback
- moves that overlap inside `[start, start + duration]` are replaced
- **turn rebase (D21)**: `before` is first replaced by `rebaseTurn(before)`. When that changes `turn`, the first key gets an explicit `from` = rebased `before` (plus its own `from` deltas). Visually nothing jumps (same angle mod 360), and `pose-jump` does not fire because it compares angles modulo 360. With `before.turn` in [-180, 180] and the largest recipe delta 360, every recipe ends in [-560, 560], inside `POSE_RANGE`.
- `focus` deltas are added and clamped to 0..2. Other channels are clamped to `POSE_RANGE` after the deltas, so no recipe can produce an invalid pose.

Tests:
- every recipe lands inside `POSE_RANGE`, from FRONT and from `before.turn` = ±700
- 10 turn-to-back shots in a row (both directions, and alternating with hero-layback) stay inside `POSE_RANGE` and `applyOps` never throws
- every round trip ends with facing equal to its start
- deterministic
- intensity and direction work
- the hero-layback tilt is positive

### 2.6 `direct.ts`: `planDirect(p, opts): { ops: EditOp[]; shots: {recipe, start, end, reason}[] }`
Options: `{ style: 'subtle'|'hero'|'bold'; scenes?: number[] /*SOURCE s; absent = do not use scene changes*/; replace: boolean; cursor?: CursorSample[] }`. The editor's Auto 3D and the CLI pass the same values (§5.1, §4.2), so they make the same plan. All times are OUTPUT seconds on the current (post-cut) timeline:
- `tl = new Timeline(p.recording.duration, p.clips)`
- taps from `tapsToOutput`, waits from `rangesToOutput`
- scenes mapped from source through the timeline the way taps are mapped
- zooms are NOT an input since look round 4: they do not play while the phone is 3D (`compositor.ts`), so they cannot clash with a move (`cursor` still feeds the self-check's `projectWarnings`, D5)
- D = `tl.outputDuration`

1. **Busy intervals.**
   - A tap is busy over `[t−0.6, max(t+0.8, settleT_out+0.3, t+duration+0.4)]`.
   - A typing run is busy from its first tap to its last tap, plus 0.8.
   - Zooms are not busy (fix round 1 of look round 4): a zoom never plays on the 3D screen, so blocking a shot for one left shots out for a clash that cannot happen.
   - Intervals closer than 1.2 s merge.
   - **Rule:** during busy time, facing ≥ cos 12°.
2. **Free windows** are the complement of busy time, each shrunk by 0.15 s at both ends. A window that overlaps a wait is `quiet`.
3. **Base pose:** subtle and hero use FRONT. Bold uses `{turn:-8, tilt:5}`, which is 9.4° and inside the 12° rule.
4. **Intro.** If D ≥ 4 and the first window starts at 0:
   - length ≥ 2.0: spin-in (hero or bold) over `[0, min(1.6, len−0.2)]`
   - length ≥ 1.0: settle
   - else, when the first busy start is ≥ 0.6 s (owner decision 12): a short settle over `[0, min(1.0, max(0.6, busyStart − 0.25))]`. It leans only 8° and lands on the base pose by the first busy start, never after it.
5. **Middle.** Windows are taken quiet first, then longer:
   - bold, window ≥ 4.5 s: turn-to-back
   - hero or bold, window ≥ 2.4 s: hero-layback with a return
   - subtle: no middle moves
   - direction alternates by shot index; `expandShot`'s turn rebase (D21) keeps any sequence in range
   - each move ends ≥ 0.25 s before the next busy start
   - caps: one middle shot per 6 s of output; total moving time ≤ 35% of D (hero/bold) or 20% (subtle)
6. **Scene-change wipe.** When a scene change s falls inside the window of a ≥ 180° turn, the shot is shifted so the eased turn passes 90° (edge-on) exactly at s. It uses 40 fixed bisection steps on `ease`, and the turn must stay inside the window. The edge-on phone hides the cut.
7. **Outro.**
   - hero/bold: if the tail window is ≥ 1.5 s, a one-way hero-layback ending at D − 0.1
   - subtle: `float` on
8. **Ops**, in this fixed order:
   1. `{op:'phone3d', enabled:true, pose: base, light:{preset: subtle ? 'soft' : 'studio'}, motionBlur:{on:true}}`
   2. `{op:'clearTransitions'}` when `replace`
   3. one `{op:'shot', recipe, at, duration, direction, intensity}` per shot
9. **Self-check.** Apply the ops to a copy (`applyOps`, which validates) and run `projectWarnings(copy, { cursor })`. Remove any shot that causes `tap-angle`, `off-canvas` or `overlap` (look round 4 removed `over-zoom`), then repeat (at most 4 rounds). A planned project has zero warnings. If `applyOps` throws (it must not; see D21), the planner drops the last shot and retries, and a test fails on any such retry.
   - Off-canvas is judged per moment and per edge (left, top, right, bottom) against the same project without the shots: a shot is blamed when any edge goes past the 2% margin and more than 0.5 px further past that edge than without the shots. A big overflow at one edge never excuses a new one at another. Inside moves the check reads every 60 fps frame.
   - A shot blamed only for off-canvas gets one more try in the other direction (the lean mirrored) before it is dropped.
10. **Always visible (owner decision 12).** A settle alone is only a quick 8° lean (its spring lands in about 0.2 s). So when the style's own moves do not fit (hero: no turning shot, that is no spin-in, hero-layback or turn-to-back; subtle: no shot at all) and there are no kept moves, the base pose becomes `POSED_REST` `{turn:-8, tilt:5}` (9.4°, inside the 12° rule) and the shots are planned on it, after a check that it stays inside 12° during busy time and adds no warning or edge overflow over the style's own base. Bold already rests at that angle. If the shots planned on the posed base include the style's own moves (a shot that pushed the phone off the canvas from straight on may fit from the posed angle), the style's moves fit and the plan has no note. Otherwise the plan carries `note`, built from the same self-check run as the shots it returns (so its reasons and its dropped count describe that plan): one line that says why the style's moves do not fit and what the phone does instead ("No moving shot fits: …" or "No turning shot fits: …"). Each reason in it comes from the planner check that actually refused that shot: the take length (a spin-in needs a 4 s take, a middle move 6 s), the free time the check reads (the spin-in's first window, the usable middle gap beside the planned shots, the free time at the end), the 1 s rest between shots, the moving-time cap, or the self-check dropping it. A stated shortfall is shown with enough decimals to read as under its limit (1.95 s, not 2.0 s). Every plan with no moving shot has a `note`. The `direct` op's note and the CLI's `direct` output (`note`) show it.

There is no randomness and no clock.

Tests (`test/direct.test.ts`):
- fixtures: no taps, dense taps, long waits, scene changes, a cut project
- planning twice gives the same result
- zero warnings
- every tap has facing ≥ cos 12°
- density caps hold
- wipe within 1/60 s
- a 2.5 s clip gets settle only
- a 500-seed property test with fixed seeds, using a seeded LCG in the test only
- a 120 s bold plan with long waits (many middle shots, alternating direction broken by hero-layback) never throws and stays inside `POSE_RANGE`
- `planDirect` with the editor's cursor samples equals the CLI's plan on the same bundle (both read `cursor.json`)

### 2.7 `warnings.ts`: `projectWarnings(p, opts?: { cursor?: CursorSample[] }): Warning[]`
```ts
export interface Warning { code: string; message: string; at?: number; end?: number; transitionId?: string; fix?: EditOp[] }
```

| code | rule | fix |
|---|---|---|
| `inactive` | `enabled` but `!phone3dActive`; the message gives the reason | frame-off: `[{op:'device',frame:true}]` |
| `tap-angle` | facing < cos 35° anywhere in a tap's `[t−0.3, t+0.3]`, sampled at 1/30 s | `editTransition` that pulls the move's end to `t−0.3`, or `setPose {at:t, turn:0, tilt:0}` |
| `tap-back` | facing < 0 during a tap: the taps are invisible | same |
| `off-canvas` | `bodyBounds` (sampled at 15 Hz plus every keyframe) more than 2% of the short side outside the canvas | `setPose` with clamped x/y/size |
| `overlap` | `tr[i].end > tr[i+1].start + 1e-3` (later wins) | `editTransition {id: later, start: earlier.end}` |
| ~~`over-zoom`~~ | removed in look round 4: zooms do not play on the 3D screen (compositor.ts), so a move can no longer run during one | — |
| `past-end` | `end > outputDuration` | `editTransition {by: D − end}` |
| `pose-jump` | an explicit `from` differs from the resolved pose before it by > 1° or 0.5%, using `poseDelta` (turn and rotate modulo 360, so a D21 rebase is not a jump) | `editTransition {from:null}` |
| `too-fast` | `poseSpeed` > 600°/s, or > 360°/s with motion blur off | — |
| `floor-flat` | floor shadow with `camera.elevation < 4` (invisible) | `phone3d {camera:{elevation:12}}` |
| `zoom-3d` | a manual zoom while the phone is 3D: it does not play (the screen always shows the whole recording). One per zoom, at its `inStart`. Zoom ops on a 3D project also add "zooms do not play while the phone is 3D" to their `changes` note; the editor's Zoom tab shows the same notice, fades the zoom lane and turns off Option-click and Add Zoom Here | — (the zooms play again with 3D off; removing them is the user's call) |

Warnings never block `applyOps`. A test applies each `fix` and checks the warning is gone. There is one positive and one negative test per code.

`focusSegmentsFor(p, cursor = [], durationFallback = p.recording.duration)` is a new file, `shared/focusSegments.ts` (it imports `autofocus.ts`, `autozoomTaps.ts`, `timeline.ts` and `mobileProject.ts`; a new file avoids an import cycle). It is the Editor `segments` memo (Editor.tsx:459-478) moved as is:
- `[]` when `!presetAllowsZoom(layoutPreset(p))`
- `taps = isPhoneProject(p) && p.zoom.fromTaps ? planTapZoom(tapsToOutput(p.taps, tl), tl.outputDuration || durationFallback, { scale: p.zoom.depth }) : []`
- `auto = p.zoom.autofocus ? new AutofocusPlanner({ ...defaultAutofocus, maxScale: p.zoom.depth }).planSegments(toOutputTime([...cursor.filter(clickDown), ...(p.zoom.dwell ? dwellFocusEvents(cursor) : []), ...p.zoom.motionEvents], tl), tl.outputDuration || durationFallback) : []`
- return `[...auto, ...taps, ...p.manualZooms].sort((a, b) => a.inStart - b.inStart)` (stable sort, same order as today)

The memo becomes `useMemo(() => focusSegmentsFor(proj, cursor, duration), [proj, cursor, duration])` (narrower deps are fine). `test/focusSegments.test.ts` checks the shared function equals a verbatim copy of today's memo body on fixtures with clicks, dwells, motion events, taps and manual zooms (an iPhone fixture with an empty cursor among them), and that the editor and the CLI pass the same cursor.

### 2.8 `orbit.ts`
`orbitPose(start, dxPt, dyPt, { shift, alt }): Pose`:
- 0.45° per screen point: dx → turn, dy → tilt
- Shift locks the dominant axis (decided once, from the first 4 pt)
- Alt pans x/y
- tilt clamps to ±85; turn clamps to `POSE_RANGE.turn`, so a long drag can never produce a pose that `setPose` refuses

Tests: Shift keeps the drag-start pose stable on the locked axis. Alt does not rotate.

### 2.9 `lighting.ts`
`LIGHT_PRESETS[preset] = { boxes: {azimuth, elevation, w, h, intensity, color}[], ambient, key: {elevation, intensity} }`. This is pure data, used by the renderer and by `info`.

---

## 3. Renderer (`src/renderer/src/phone3d/`, the only folder that imports three)

### 3.1 Modules

| File | Role |
|---|---|
| `loader.ts` | `ensurePhone3d(): Promise<Engine>`, `engineSync(): Engine \| null`, `onEngineReady(cb)`. A dynamic `import('./engine')` that Vite code-splits. |
| `engine.ts` | Module singleton: one `WebGLRenderer` (WebGL2, `alpha`, `premultipliedAlpha`, `antialias:false`, `preserveDrawingBuffer:false`, `reversedDepthBuffer: true`, which three uses only when `capabilities.reversedDepthBuffer` is true), one canvas resized with hysteresis, render targets, a `generation` counter, context-loss state, `gpuName()` (from `WEBGL_debug_renderer_info`). `render(job) → { canvas, roi } \| { lost: true }`. |
| `environment.ts` | (Look round 3: `studioLights`/`placeStudio` for the RectAreaLight softboxes, `studioScene`/`studioEnv` for the set; see §3.4.) Original: `studioLights(preset)`: the hero softboxes as `RectAreaLight`s (`RectAreaLightUniformsLib.init()` once). `studioEnv(preset, bgMean)`: PMREM of the fill scene only (gradient dome 2-6%, floor bounce tinted by the mean background colour, faint wide strip behind and above the camera) via `fromScene(envScene, 0, near, far, { size: 512 })` (about 25 MB HalfFloat). Cached per (preset, bgMean quantized to 16 levels) (LRU 4). |
| `geometry.ts` | `buildPhone(device, body3d): Group` in mm, cached by device id (LRU 3). |
| `materials.ts` | `materialsFor(hex, device.material, back, glass)` (LRU 6), `bandF0(hex, material)`, the `mrtOutput(mat, role)` patch (§3.5) and the screen `lodBias` patch (§3.6). |
| `screenTexture.ts` | Offscreen 2D canvas plus `CanvasTexture`: 1:1 sizing with hysteresis, `repeat`/`offset`, mipmaps, anisotropy. |
| `shadow.ts` | Silhouette from the light into an R16F target → 2-width separable blur (R16F) → catcher plane (wall or floor). |
| `passes.ts` | 2-attachment MSAA HalfFloat target (`count:2, samples:4`), 2-attachment accumulation target, DoF gather on both, optional ss box downsample (linear premultiplied), output pass (tone map, unpremultiply, sRGB, premultiply, dither), tiling. |
| `view.ts` | `renderPhone3D(args) → { canvas, roi }`: the one call the compositor makes. |

### 3.2 Device 3D data: new `src/shared/devices3d.ts` (devices.ts stays untouched; **owned by WP1**, because `projection.ts` needs depth and plateau data on day 1)
```ts
export interface Body3D {
  depthMm: number;                    // Apple tech-spec "Depth", camera bump excluded; URL in comment
  edge: 'flat'|'rounded';             // 12–16 flat; 17 / Air rounded
  back: 'frosted'|'glossy';           // Pro frosted, base glossy (phone3d.back overrides)
  plateau: { kind: 'square'|'bar'|'pill'|'single'; x: number; y: number; w: number; h: number; // fractions of back W/H from top-left of the BACK
             rMm: number; heightMm: number;
             lenses: { x: number; y: number; rMm: number }[];           // plateau fractions
             flash?: { x: number; y: number }; sensor?: { x: number; y: number } };
  buttonDepth: number;                // fraction of depth, 0.4 (look round 2; was 0.62)
  antennaLines: number[];             // fractions of height
  extraButtons?: SideButton[];        // e.g. the iPad top button missing from devices.ts
}
export const BODY3D: Record<string, Partial<Body3D>>;
export function body3dFor(device: DeviceModel): Body3D;   // fills by family/year; genericDevice → 2-lens base
```
- Provisional depths, all to be verified on support.apple.com before merge with the URL put in a comment:
  - 17 Pro and Pro Max 8.75; Air 5.64; 17 7.95
  - 16 Pro, Pro Max, 15 Pro and Pro Max 8.25
  - 16, Plus, 16e, 15, Plus, 14, Plus 7.80
  - 14 Pro and Pro Max 7.85; 13 family 7.65; SE 3 7.3
  - iPad Pro 13 5.1, Pro 11 5.3, Air 6.1, mini 6.3
- Plateau families: `pro-square` (13–16 Pro, 3 lenses in a triangle), `bar` (17 Pro, full width), `pill` (Air), dual diagonal (13–15), dual vertical (16), single (16e, SE, iPad).
- All are measured proportions, marked as approximations the way the `devices.ts` header already is.
- **No Apple logo, no artwork, no CAD.** The back is blank.

### 3.3 Procedural geometry (mm, portrait, y up, front = +z, centred)
- **Band**: a sweep of `continuousRectPoints(bodyW, bodyH, bodyRadius, 24)` (bodyRadius is the same as `frameGeometry`) along a profile of `(z, inset)` samples.
  - `flat`: straight wall with 0.35 mm 45° chamfers front and back. **Each crease ring is duplicated** so the wall, chamfer and face meet with hard normals (no smoothing across 45°). At each chamfer edge, a 0.08 to 0.12 mm fillet of 2 or 3 rings rounds the corner; it catches a crisp 1 to 2 px specular line at 1080p.
  - `rounded`: half-ellipse with radius 0.45·depth (smooth normals, no creases)
  - each ring is the outline inset (w−2i, h−2i, r−i)
  - normals come from the profile tangent between creases; tangents run along the outline, which brushed anisotropy needs
  - antenna lines are thin rings with their own material group
- **Seams**: a ring 0.12 mm wide and recessed 0.1 mm between glass and band, on the front and the back (colour #0a0a0a, roughness 0.6, metalness 0). It separates the parts the way real phones and Rotato's models do.
- **Front**: glass cap (`ShapeUtils.triangulateShape` of the outline inset by `rimMm`) at z = d/2. The screen mesh is the `screenRectFor`/`screenCornerRadius` outline in mm at +0.02, with planar UVs 0..1 over the screen rect (the texture maps into them with `repeat`/`offset`, §3.6). A glare overlay copy sits at +0.04. Screen, glare and lens glass are **overlay layers**: `depthWrite:false`, `polygonOffset:true`, `polygonOffsetFactor:-1`, `polygonOffsetUnits:-4`, and fixed `renderOrder` (glass cap 0, screen 1, glare 2, lens elements 3, lens cover 4), so they never z-fight with the surface under them. Caution, verified in r186: `WebGLState.setPolygonOffset` negates only the factor when the depth buffer is reversed (WebGLState.js:871), not the units. So `materials.ts` sets `polygonOffsetUnits = renderer.state.buffers.depth.getReversed() ? +4 : -4`, and the z-fight test (§6.2) runs both ways (reversed on and forced off).
- **Back**: glass cap at −d/2. The plateau is an extruded continuous-corner rect, `heightMm` tall, with a 0.4 mm fillet on its top edge and a matching fillet where it meets the back, mirrored in x because it is seen from the back. Each lens has:
  - a metal ring cylinder 1.2 mm proud, with a 0.1 mm fillet ring on its top edge
  - an inner barrel: an open `CylinderGeometry` with `side: BackSide`, dark rough metal, 1.5 mm deep
  - 2 or 3 stacked element discs at different depths inside the barrel (dark glass, rising roughness), so the lens parallaxes when the phone turns
  - a cover glass disc at the top with `iridescence 1`, `iridescenceIOR 1.8`, `iridescenceThicknessRange [250, 450]` for the green/purple AR tint
  - Flash and sensor are small discs.
- **Buttons**: for each `SideButton` plus `extraButtons`, a capsule with length = `length·bodyH`, width = `buttonDepth·depth`, protruding 0.55 mm (cameraControl: a flush 0.28 mm glass capsule).
- **Bottom**: a USB-C pill recess (8.3 × 2.5 mm) and two 6-hole grilles (`InstancedMesh`).
- **Island and notch** are not meshes. They are drawn into the screen texture by the existing 2D code, exported from deviceFrame.ts as `drawCutouts(ctx, rect, device, opts)`. At FRONT the 3D screen therefore matches 2D exactly.
- Budget: under 60k triangles per phone.

### 3.4 Materials (`MeshPhysicalMaterial`, colours via `Color.setStyle(hex)` with ColorManagement on)

One reflection lobe per real surface: real cover glass is one AR-coated surface, and a colour-under-glass back is a diffuse colour layer under one glass surface. No clearcoat on metal.

| Part | Params |
|---|---|
| Band, steel | metalness 1, `color = bandF0(hex,'steel')`, roughness 0.06 to 0.1 (start 0.08), no clearcoat |
| Band, titanium | metalness 1, `color = bandF0(hex,'titanium')`, roughness 0.32, anisotropy 0.5 along the tangent |
| Band, aluminum | metalness 1, `color = bandF0(hex,'aluminum')`, roughness 0.36 |
| Back, glossy | base color = finish lightened 8%, roughness 0.6, `specularIntensity 0` (the diffuse colour layer); clearcoat 1, clearcoatRoughness 0.02 (the glass) |
| Back, frosted | color = finish mixed 20% toward white, roughness 0.38 to 0.45 (start 0.42), `specularIntensity 1` (the etched surface); no clearcoat |
| Camera plateau (Pro) | glossy glass even when the back is frosted: the back's base colour, roughness 0.6, specularIntensity 0, clearcoat 1, clearcoatRoughness 0.02 |
| Front glass | #050506, roughness 0.02, ior 1.5, `specularIntensity 0.7` (AR coating), no clearcoat |
| Glare overlay | black, roughness 0.03, `AdditiveBlending`, `specularIntensity = glass`; not drawn when glass = 0 |
| Seam | #0a0a0a, roughness 0.6, metalness 0 |
| Lens cover glass | #050608, roughness 0.02, iridescence 1, iridescenceIOR 1.8, iridescenceThicknessRange [250, 450] |
| Lens barrel / elements | barrel #111, metalness 1, roughness 0.7; elements #07080a, roughness 0.05 → 0.3 by depth |
| Lens rings | `bandF0` of the finish darkened 25%, metalness 1, roughness 0.15 |
| Buttons | band material; cameraControl uses lens cover glass |
| Screen | `MeshBasicMaterial({ map, toneMapped:false })` with the `mrtOutput(mat,'screen')` and `lodBias` patches |

**`bandF0(hex, material)`** in materials.ts: the finish hexes in devices.ts are marketing swatches (Black #2E2E30, Space Black #403E3D, Deep Blue #3A4659), which as metal F0 give 3 to 5% reflectance, a near-black mirror that reads as matte plastic. So: convert the hex to linear (`Color.setStyle` with ColorManagement on); mix it toward the base metal F0 (titanium (0.54, 0.50, 0.45), steel (0.56, 0.57, 0.58), aluminium (0.91, 0.92, 0.92)) until its luminance reaches a floor (0.18 for titanium and steel, 0.30 for anodised aluminium); keep the hue. Swatches already above the floor are kept. The black, silver and orange finishes are pinned with turntable stills in the review harness.

`envMapIntensity = light.intensity`, and each RectAreaLight's intensity is scaled by `light.intensity` too. Every lit material gets the `mrtOutput(mat, 'lit')` patch (§3.5); none is tone mapped in its own shader.

**Look round 2 (judged changes; they override the table above where they differ).**
- Light: one PMREM environment (`environment.ts studioRadiance`) holds everything: an overhead gradient, a front fill on the camera's side, a white bounce card below, two dark flags at the sides, and the preset's softboxes painted in with soft edges (`lighting.ts LIGHT_PRESETS`: `boxes` in degrees, `set` levels). No RectAreaLights and nothing bright on the camera axis, so a metal back keeps its colour from turn 90 to 180 (measured: within 14% for Deep Blue, Silver, Cosmic Orange). The light channel turns the environment (`aimStudio`).
- Shadow: cast along `projection.ts shadowLightDir`: the project's key (the pose's `light` channel does not turn it), its sideways offset capped at `SHADOW_OFFSET` = the 2D frame shadow's offsetY × body long side, so edge-on it is a contact shadow, not a slab.
- Front glass: border and screen sheen share `FRONT_GLASS_ROUGHNESS` 0.2 and `frontGlassSpecular(glass)` (0.6 at 0.25): one sheet, no halo at the screen edge. The sheen is drawn on every moving sample.
- Lens cover: AR glass, specular 0.4 (about 1.5%), roughness 0.08, no iridescence; elements carry faint violet/green casts and a catchlight from a small lamp near the camera.
- 17 Pro unibody panel: diffuse colour = the metal's lifted F0 × 0.85, roughness 0.36, in a 0.05 mm metal seam (no black keyline). Plateaus rise on a smoothstep fillet over the measured inset (no vertical undercut). Buttons are crowned, `buttonDepth` 0.4.
- Shots: cubic ease-in-outs, peak under 300°/s at default lengths (spin-in 1.6 s, hero-layback 2.3 s with a 0.8 s hold, turn-to-back 2.4 s passing the back at half speed); motion samples 1 px apart at the 1080 reference, stratified in time.

**Look round 3 (judged changes; they override round 2 where they differ).**
- Light (D13 again): the preset's `boxes` are `RectAreaLight`s `LIGHT_DISTANCE` (2.6) body long sides from the phone's centre, sized by their angular size, facing it (`environment.ts studioLights`, `placeStudio`, per sample). The PMREM holds only the set (overhead gradient, front fill, bounce card, flags). The light channel turns the box group and `scene.environmentRotation` together. Studio adds a tall strip 60° right of the camera (a reflection that crosses the screen glass and the three-quarter back). The LTC tables are counted in the memory budget.
- Front glass: border and screen sheen still one sheet (roughness 0.15); it mirrors the softboxes only (`envMapIntensity` 0: the set reflected over the whole screen is a grey veil), at anti-reflective strength by default (`frontGlassSpecular(0.25)` = 0.35, about 1.4%).
- Materials: anodised aluminium roughness 0.3; unibody panel roughness 0.5, specular 0.6, nearly edge to edge (4.2 mm margin, 5 mm below the plateau's rise); lens elements with violet, green and amber coatings; flash = polished ring of the finish's metal round a pale frosted diffuser under a clear coat; LiDAR = a dark violet-black disc under a clear coat; Camera Control = a flush (0.06 mm) sapphire strip tinted by the finish.
- Geometry: a full-width plateau (17 Pro, Pro Max, Air) is part of the body. The band's back half, the back seam and glass edge move back by the plateau height across the top of the back, so the plateau's sides are the band. Its lower edge is one smootherstep rise across the full width over the measured top inset (`geometry.ts fullBarRise`); the band, the rise and the back share vertices on every rise row.
- Motion blur (§3.7 step 4): sample times stay stratified 1 px apart; each sample is weighed by a tent shutter (`passes.ts tentShutter`, weights sum to 1; the shadow silhouettes use the same weights), so a smear fades at both ends instead of printing two copies. The screen CONTENT is held where the frame's centre pose put it (`screenSteadiness`: facing ≥ 0.9, or within 0.15 s of a tap, easing out by facing 0.8 / 0.3 s; `projection.ts screenUvMap`), so taps land on crisp UI while the body and the screen's edge still blur.
- Shots: holds drift instead of freezing, joined to the moves either side at matching speed (`shots.ts driftEasings`). hero-layback 2.4 s (out 0.58, drift 0.8 through about 2.5° and 0.8% size, back 0.72, settle 0.3). turn-to-back 3.7 s: 150° in 1.4 s, a 0.7 s drift to 162°, then on to 360° in 1.6 s (peak about 215°/s); `return: stay` rests on the three-quarter back.
- Tap warnings name the moment that fails ("off front at 0.66 s, 0.30 s before the tap at 0.96 s"). A fix may not add another warning or turn any move faster than `COMFORT_DEG_S` (300°/s) unless it already did; whole-move shifts come before shortening. The agent CLI `export` refuses while a `tap-angle` or `tap-back` warning stands, unless `--force`.
- Touch indicator on the 3D screen: firmer dark edge and fuller fill (`tapIndicator.ts PHONE3D_TOUCH`); flat projects unchanged.

**Look round 4 (judged changes; they override round 3 where they differ).** Every judge in round 3 scored metal, glass and shadow 2 of 5: coloured finishes read as flat clay, the back as a sticker on a folded plate, the lenses as flat violet discs, the screen as a flat print, and the phone floated. Root causes and fixes:
- Light. Round 3's set was bright and even round the camera axis (top 0.8, horizon 0.45): a metal back mirrors that region, so every coloured finish was one even tone. Now the set is dark (top 0.3, horizon 0.04, front 0.02, floor card 0.15, flags 1) and the boxes carry the light: a wide box above the camera axis (lower edge 15°: a back facing the viewer falls off from a bright top), a white bounce card below it (downward faces and the step's edge catch a line), a brighter overhead strip (faces tilted up), a tall strip 60° left of the camera at 1.2 body lengths (a highlight slides across a three-quarter back), and a broad box behind on the key side at 1.6 (a back turned past three-quarters falls off in a gradient). A box may set its own `distance` (`lighting.ts SoftBox.distance`); a nearer box is seen from more different angles across a flat face, so its highlight falls off instead of filling the face. A unit test pins the dark set and the boxes above and below the camera.
- Metal. Anodised aluminium is a sealed dyed oxide: metal reflectance with roughness 0.34 under a clear seal (`ALUMINIUM_SEAL`: clearcoat 1, roughness 0.1) that draws crisp white lines of the boxes on the satin colour. Steel and titanium keep no coat.
- Back of the 17 Pro. The plateau rises on a crisp machined step (`geometry.ts stepProfile`: a 0.35 mm foot fillet, a 60° wall, a 0.9 mm rounded top edge; 2.1 mm across for the 2.55 mm plateau) instead of round 3's 4.8 mm smootherstep ramp. The panel runs 1.5 mm from the body outline (about 0.8 mm of flat metal beside it) and 2.5 mm below the step, with a 0.12 mm edge. Its material is the metal's own reflectance (metalness 0.7, a touch desaturated, roughness 0.46, satin clearcoat), so it tracks the aluminium's brightness in every pose: same colour, a different finish (measured: 2-15% lighter on Deep Blue and Cosmic Orange at turns 150 and 180, within 2% on Silver). No logo: the task forbids any Apple logo or asset, so the judges' logo request is not done.
- Lenses. The rings are thinner (glass radius 0.83 of the ring, was 0.78) and a deeper, less saturated shade of the finish (`LENS_RING`). Inside: a matte black hood, a thin dark retaining ring, and three coated elements that shade as domes (`LENS_DOME`: normals tilt up to 45° at the rim) on their true shallow depth, so a softbox reflects as small curved violet and green crescents ring inside ring; round 3's nearly flat elements mirrored one straight box edge across a flat violet disc.
- Front glass. Bare cover glass by default (`frontGlassSpecular(0.25)` = 1, 4% straight on; glass 1 → 4): a softbox reflects as a faint sheet that slides over the screen as the phone turns and tilts. The rounded rim (0.3 mm, the most the narrowest bezels allow) is polished glass that mirrors the whole studio (`GLASS_RIM`): a thin bright line round the front. (Corrected in fix round 1: round 4 said "at FRONT no box is near the axis; the GGX tails leave about 3e-4 linear". That was wrong. The box above the camera (azimuth 35, elevation 24, lower edge 15°) reflected in the top of a FRONT screen and lifted dark UI by up to 93 levels: 26.7 dB against flat at the default glass, against the 40 dB gate of §3.5/§6.2. No gate ran it, because every FRONT check used glass 0. Soft at the default azimuth and studio with the key mirrored to +35 veiled the whole screen.) Since fix round 1 the front glass (border and glare) fades by the angle between the screen's normal and the camera's axis (`materials.ts FRONT_GLASS_FLAG`, smoothstep on the sine): the studio's black flag round the lens. Fix round 2 widened it from 5°/20° to **nothing within 13°, full from 25°**: the 5° flag fixed only FRONT with the camera level, and review measured a grey veil where the screen must still be read: bold's resting pose BOLD_BASE (9.4°, where the phone sits for every tap) 31.2 dB light UI / 18.9 dB dark UI against glass 0 (maxDiff 48 levels, the Dynamic Island grey), FRONT under camera elevation 9° and 14° 22.6 and 16.4 dB dark, a 12° turn (the §2.6 busy-time limit) 16.2 dB dark. 13° covers the busy-time rule (12°), BOLD_BASE, the spin-in's landing (turn 4) and the floor fix's camera elevation (`warnings.ts FLOOR_FIX_ELEVATION`, 12°), with 1° so a pose exactly on 12° is not on the edge; the hero layback (about 28.6°) still shows the full sheen. Turns between 13° and 25° show part of it. So the screen is the glass-0 screen exactly for every preset and key azimuth at FRONT, at BOLD_BASE, at FRONT under the floor fix elevation, at BOLD_BASE under the floor fix elevation (the layback cancels part of the elevation: about 10.6°) and at a 12° turn. Not covered: a pose more than 13° off the camera's axis that the user picks while UI must be read (outside Auto 3D's busy-time rule); it shows the sheen by design. A sample inside the flag skips the glare draw (`projection.ts screenAxisSin`, the same number as the shader's). Measured (GPU harness): FRONT screen against flat at the default glass 86.0 dB (social 9:16), 77.1 dB (landscape), 76.0 dB (classic moved), 0 px different from glass 0; all 5 presets × key azimuth −90, −35, 0, 35, 90, 180: 0 px different from glass 0, worst 86.0 dB. Without the flag the same gates read 26.7 / 34.5 / 28.2 dB and worst 25.1 dB, so they fail first. Fix round 2 gates (GPU harness `front.glassSweep.{boldBase,floorFixElevation,boldBaseFloorFix,busyLimitTurn12}.screenIsGlass0`: the projected screen quad's interior, edges pulled in 4 px and the rounded corners skipped, light and dark UI, 5 presets × 6 key azimuths): 0 px different from glass 0 in all four. With the 5° flag all four fail (worst 18.3 dB whole frame, about a million pixels differ). CPU test `projection3d.test.ts` checks each of those poses, and the hero lean, on every layout against `FRONT_GLASS_FLAG_SIN`, and fails with 5°/20°. Outside the screen, the default glass still differs from glass 0 at those poses by at most 1 level on up to about 3,100 pixels. `motion.stillScreenEqualsDraft` is strict again (0 px differ); round 4 had loosened it to one level without the owner.
- Shadow. Two casts per pose (`shadow.ts`): the drop layer along the key, its offset capped at `SHADOW_OFFSET` = 0.08 of the body long side (owner decision 7: twice the 2D frame's 0.04, which hid the shadow behind the phone on a flat backdrop), and the contact layer cast straight onto the catcher (`projection.ts contactPointsWorld`), so a tight shade hugs the outline while the drop shadow falls away from the key. The catcher area holds both. Key elevation stays 32.
- Screen motion blur. `SCREEN_STEADY_FLOOR` 0.5: the screen content smears at most half as far as the body, so the UI stays readable through the spin-in's peak.
- Zoom. Zooms do not play on the 3D screen (`compositor.ts`: the zoom camera is the identity when the 3D phone draws); a real screen never crops its own content while the phone turns. They come back unchanged when 3D is off (flat identity holds). The `over-zoom` warning is gone with the conflict it described.
- Tap mark on the 3D screen: 0.75 × the size, a light fill, a faint hairline and a soft shadow, and kept inside the screen (`TouchIndicatorOptions.inside`); flat projects unchanged.
- Shots. `turn-to-back` with `return: stay` has its own keys (1.8 s): one ease to 3% past the three-quarter back, a soft settle onto it; it lands, so leave about 0.5 s after it. Every turn-to-back eases the phone back 10% (size) as it turns and returns to the base size on the front.

- Budgets (owner decision 10, median of 3, measured on the final look round 4 code with the WP4b GPU harness's budgets and memory suites; Apple M4 Max, not measured on 8 GB). Round 4 is faster than round 3 (one budgets run of round 3's last commit a504979: 4K moving p95 975 ms, 1080 moving p95 123 ms) because six of the twelve boxes are painted into the set; it still FAILS the 4K moving budget (701 ms against 200), 1080 moving (93 against 45), 4K still (62.5 against 60), preview without DoF (7.1 against 4) and 4K ss 2 still memory (610 MiB against 560). The cost is the six RectAreaLights evaluated per sample (up to 64 adaptive samples at 4K). Open for the owner: fewer lights or fewer samples trade look for speed.

| Measure | runs 1 / 2 / 3 | median | budget | result |
|---|---|---|---|---|
| Preview 1080, 3D pass p95 (ms) | 7.1 / 6.7 / 7.1 | 7.1 | <= 4 | FAIL |
| Preview 1080 with DoF, 3D pass p95 (ms) | 6.6 / 6.7 / 7.3 | 6.7 | <= 7 | PASS |
| Export 1080 still, 3D pass p50 (ms) | 14.5 / 14.8 / 14.1 | 14.5 | <= 20 | PASS |
| Export 1080 moving, 3D pass p95 (ms) | 95.1 / 93.0 / 86.0 | 93.0 | <= 45 | FAIL |
| Export 4K still, 3D pass p50 (ms) | 78.2 / 62.5 / 61.6 | 62.5 | <= 60 | FAIL |
| Export 4K moving, 3D pass p95, all frames (ms) | 848.7 / 633.1 / 700.9 | 700.9 | <= 200 (decision 10) | FAIL |
| Export 4K moving, adaptive-N frames, max (ms) | 1460.2 / 1118.7 / 1342.7 | 1342.7 | <= 400 | FAIL |
| Export 4K moving, 3D pass CPU p50 (ms) | 232 / 196.8 / 212.9 | 212.9 | (info) | PASS |
| Export 4K still, 3D pass CPU p50 (ms) | 143.5 / 126.9 / 93 | 126.9 | (info) | PASS |
| GPU memory 4K ss1, measured, still (MiB) | 389.5 / 387.1 / 388.7 | 388.7 | <= 400 | PASS |
| GPU memory 4K ss1, measured, moving (MiB) | 351.6 / 348.7 / 358.2 | 351.6 | <= 400 | PASS |
| GPU memory 4K ss2, measured, still (MiB) | 609.6 / 587.9 / 615 | 609.6 | <= 560 | FAIL |
| GPU memory 4K ss2, measured, moving (MiB) | 393.5 / 409 / 375.8 | 393.5 | <= 560 | PASS |

**Look round 4, fix round 1 (verification findings).** The round 4 text above called round 4 "faster than round 3"; that hid the real step back. Round 2's environment-only rig passed every speed budget on the same harness and machine, and the RectAreaLight rig (round 3, kept in round 4 as six lights) costs about 2 to 4 times as much. These are M4 Max numbers; the budgets are for an 8 GB M1, which would be slower again (not measured on 8 GB).

| Measure (ms, median of 3) | round 2 (env only) | round 4 | fix round 1 | budget |
|---|---|---|---|---|
| Preview 1080, 3D pass p95 | 2.9 (2.9 / 3.3 / 2.0) | 7.1 | 4.4 | 4 |
| Export 1080 moving p95 | 26.9 (30.8 / 26.9 / 25.5) | 93.0 | 75.2 | 45 |
| Export 4K still p50 | 25.7 (23.5 / 28.8 / 25.7) | 62.5 | 37.7 | 60 |
| Export 4K moving p95, all frames | 174.9 (174.9 / 155.7 / 176.4) | 700.9 | 324.0 | 200 |
| Export 4K moving, adaptive-N max | 182.7 (182.7 / 173.2 / 188.1) | 1342.7 | 548.8 | 400 |

Fix round 1 changes that change no look: metals (diffuse term exactly 0) and the glare skip each rect light's diffuse LTC integral (`passes.ts rectSpecularOnly`), the glare is not drawn inside the front glass flag, and the DoF target is made only by a frame that blurs. The 4K still and the preview gain most (the glare was a full six-light pass over the screen at FRONT). Round 4's three 4K moving runs spread 633-849 ms; fix round 1's agree within 2% (321.5 / 324.5 / 324.0), so part of round 4's gap may be run noise, not code.

Fix round 1 bench (GPU harness, final code, median of 3; Apple M4 Max; not measured on 8 GB):

| Measure | runs 1 / 2 / 3 | median | budget | result |
|---|---|---|---|---|
| Preview 1080, 3D pass p95 (ms) | 4.4 / 4.3 / 4.4 | 4.4 | <= 4 | FAIL |
| Preview 1080 with DoF, 3D pass p95 (ms) | 4.3 / 4.6 / 4.4 | 4.4 | <= 7 | PASS |
| Export 1080 still, 3D pass p50 (ms) | 10.2 / 9.4 / 9.0 | 9.4 | <= 20 | PASS |
| Export 1080 moving, 3D pass p95 (ms) | 75.2 / 76.8 / 72.2 | 75.2 | <= 45 | FAIL |
| Export 4K still, 3D pass p50 (ms) | 39.1 / 37.3 / 37.7 | 37.7 | <= 60 | PASS |
| Export 4K moving, 3D pass p95, all frames (ms) | 321.5 / 324.5 / 324.0 | 324.0 | <= 200 (decision 10) | FAIL |
| Export 4K moving, adaptive-N frames, max (ms) | 537.7 / 548.8 / 587.3 | 548.8 | <= 400 | FAIL |
| Export 4K moving, 3D pass CPU p50 (ms) | 118.9 / 132 / 147.3 | 132 | (info) | PASS |
| Export 4K still, 3D pass CPU p50 (ms) | 71.5 / 71 / 73.5 | 71.5 | (info) | PASS |
| GPU memory 4K ss1, measured, still (MiB) | 386.5 / 387.1 / 391.7 | 387.1 | <= 400 | PASS |
| GPU memory 4K ss1, measured, moving (MiB) | 365.5 / 351.6 / 350 | 351.6 | <= 400 | PASS |
| GPU memory 4K ss2, measured, still (MiB) | 615.5 / 618.1 / 616.1 | 616.1 | <= 560 | FAIL |
| GPU memory 4K ss2, measured, moving (MiB) | 391.3 / 346.3 / 407.7 | 391.3 | <= 560 | PASS |

Where the moving cost goes (4K, per sample, GPU timer, min of 7; a back view at turn about 150): 10.7 ms with the round 4 rig; 5.7 ms with the rect lights left out of the clearcoat lobe; 3.5 ms with that and two rect lights; 2.8 ms with no rect lights. The clearcoat lobe of the sealed aluminium (round 4) is half the cost: three r186's `RE_Direct_RectArea_Physical` evaluates a second LTC integral per light for it. The adaptive frames of the bench's 200° turn reach 46-56 samples, so the 200 ms all-frames budget needs about 3.5 ms per sample.

**Open for the owner (decision 10): pick a trade or relax the budget.** Each option measured with the budgets suite, three runs, median (the options were temporary shader switches for the measurement, not committed):

| Option | preview p95 | 1080 moving p95 | 4K still p50 | 4K moving p95 all | 4K adaptive max | budgets failed |
|---|---|---|---|---|---|---|
| O0 as shipped (round 4 look) | 4.2 | 89.6 | 46.6 | 318.7 | 549.1 | preview, 1080 moving, 4K moving, adaptive |
| O1 rect lights not in the clear seal (the seal mirrors the painted environment only) | 3.3 | 74.8 | 40.5 | 291.4 | 321.0 | 1080 moving, 4K moving |
| O2 O1 + only the key and one flat-face box as rect lights (the rest painted into the PMREM) | 2.5 | 51.6 | 39.6 | 215.6 | 223.1 | 1080 moving (52/45), 4K moving (216/200) |
| O4 no rect lights (round 2's environment-only rig) | 2.4 | 42.2 | 31.9 | 190.3 | 199.9 | none |

O1's look against the shipped look: `/tmp/openscreen-3d/look/fix/trade/seal-AB-back.png` (the back is darker; the flash diffuser turns grey without the seal's reflection of the boxes). O4 is the rig round 2's judges rejected (flat faces read as one flat tone). The other lever, a lower adaptive-N cap at 4K, makes fast turns strobe at 4K and is not measured. WP4b's acceptance line "§6.5 budgets met" is NOT met and stays open until the owner picks.

**GPU memory (decision 10), fix round 1.** 4K ss 2 still: 616 MiB against 560 (FAIL, open); ss 1 still 387 MiB against 400 (13 MiB margin). What grew since a06392b (ss 1 still 340, ss 2 still 578): the studio dome went from 96×48 to 512×256 segments (about 9 MB of vertex buffers while the PMREM is made) and six RectAreaLights with clearcoat make larger programs (with no rect lights the ss 1 still number drops about 20-25 MiB; run-to-run noise is about ±15 MiB). The avgC shadow target is 2 MB. The "still" number is a first-frames peak: the same frame repeated 30 more times reads 40-56 MiB lower, and the moving number after 121 frames is 391 MiB (ss 2), so most of the excess is memory the driver frees late, not memory the engine holds (counted: tile targets 117.5 MB, ss 2 screen texture 141 MB, shadow 20 MB, PMREM 25 MB). Options: count the steady state, or take O2/O4 (smaller programs). Not measured on 8 GB.

GPU: ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). Not measured on 8 GB (no M1 8 GB here). Memory = macOS `footprint` of the GPU process, 3D at 4K (phone filling the 2160x3840 canvas) minus the same canvas drawn flat, in MiB (2^20 B); "still" is after the first 3 frames, "moving" after a 121-frame 200-degree turn. Times: GPU timer queries per 3D pass.

**GPU memory, fix round 2 (correction and one more measured option; still open for the owner).** The fix round 1 text above calls the ss 2 still number "a first-frames peak" that the driver frees late. That does not hold: a probe that renders the same 4K ss 2 still 13 times and reads the footprint after the last one gives 653 / 640 / 648.5 MiB (three runs), and fix round 1's own 33-frame run gave 587. So "count the steady state" does NOT bring ss 2 under 560. The engine holds the same textures throughout (one screen texture allocation, 3502 × 7559 with mips, 141 MB; tile targets 116 MB). The footprint metric is also time-sensitive: 3 s and 9 s after the last frame the same process reads 127 and 22 MiB above the flat baseline (macOS compresses idle memory), so only numbers taken right after rendering are comparable. The 2D band size is not a lever (bands of 0.5, 2 and 8 Mpx: 649, 643, 655 MiB).

| Option (4K ss 2, median of 3) | ss 2 still MiB (budget 560) | ss 2 moving MiB | ss 2 still, 13 frames | ss 2 moving frame, wall ms | look |
|---|---|---|---|---|---|
| as shipped (tile targets up to 120 MB) | 616.1 (fix round 1) | 391.3 | 648.5 | 488 (647 / 488 / 478) | - |
| O5: at ss ≥ 2 the tile targets get 60 MB (twice the tiles) | 550.5 (541.0 / 551.9 / 550.5) PASS | 335.9 | 582 (one run) | 603 (603 / 474 / 699) | none expected (tiles only split the frame; no tile-identity gate measured yet) |

O5 passes the measured 3-frame budget by 9.5 MiB, inside run-to-run noise (about ±15 MiB), and fails it after 13 frames; it costs about a quarter more time per ss 2 moving frame (ss 2 has no speed budget; ss 1 is untouched). It was a temporary switch for the measurement, not committed. Fix round 2 bench on the final code (the 13°/25° flag; GPU harness, median of 3; Apple M4 Max; not measured on 8 GB). The flag only skips more glare draws, so it cannot add GPU work; the speed numbers read a little higher than fix round 1's (1080 moving 87 against 75, 4K moving 346 against 324) and the review's single run on fix round 1's code read 85 and 303, so this is run-to-run spread on a shared machine, not a change. Every result (pass or fail) is the same as fix round 1's:

| Measure | runs 1 / 2 / 3 | median | budget | result |
|---|---|---|---|---|
| Preview 1080, 3D pass p95 (ms) | 4.39 / 4.53 / 4.47 | 4.47 | <= 4 | FAIL |
| Preview 1080 with DoF p95 (ms) | 4.52 / 4.48 / 4.5 | 4.5 | <= 7 | PASS |
| Export 1080 still p50 (ms) | 9.83 / 11.11 / 9.23 | 9.83 | <= 20 | PASS |
| Export 1080 moving p95 (ms) | 87.21 / 84.1 / 97.42 | 87.21 | <= 45 | FAIL |
| Export 4K still p50 (ms) | 38.73 / 37.08 / 43.54 | 38.73 | <= 60 | PASS |
| Export 4K moving p95, all frames (ms) | 345.71 / 349.56 / 322.55 | 345.71 | <= 200 | FAIL |
| Export 4K moving, adaptive-N max (ms) | 538.02 / 640.9 / 571.14 | 571.14 | <= 400 | FAIL |
| GPU memory 4K ss1 still (MiB) | 388.4 / 387 / 391.6 | 388.4 | <= 400 | PASS |
| GPU memory 4K ss1 moving (MiB) | 352 / 352 / 346.8 | 352 | <= 400 | PASS |
| GPU memory 4K ss2 still (MiB) | 614.1 / 611.5 / 618.6 | 614.1 | <= 560 | FAIL |
| GPU memory 4K ss2 moving (MiB) | 394.5 / 414.9 / 410.3 | 410.3 | <= 560 | PASS |

So acceptance item 7 stays open: the owner relaxes the ss 2 budget, takes O5 knowing its margin, or takes O2/O4 (smaller programs, about 20-25 MiB less). Harness probe: `memprobe` suite in the scratch GPU harness; numbers in `/tmp/openscreen-3d/wf3/look/fix2/`.

### 3.5 Colour management (D3)
- `renderer.toneMapping = NoToneMapping`. Inside render targets three writes working-space linear and skips tone mapping anyway (D3).
- Texture `colorSpace = SRGBColorSpace`.
- **`mrtOutput(mat, role)`** (`onBeforeCompile`): adds `layout(location = 1) out highp vec4 pc_fragScreen;` after three's `pc_fragColor` declaration (WebGLProgram.js:819) and, at the end of `main`:
  - `role 'lit'` (every lit material, the seam, the shadow catcher): attachment 0 stays as three computed it (HDR, premultiplied, alpha = coverage); `pc_fragScreen = vec4(0.0)`.
  - `role 'screen'`: `pc_fragScreen = vec4(texel.rgb · a, a)` (linear, premultiplied); `gl_FragColor = vec4(0.0, 0.0, 0.0, a)`.
  - Every material drawn into the MRT target gets one of the two, so no attachment is ever left undefined. The silhouette pass for the shadow uses its own single-attachment target and is not patched.
- Accumulation and DoF average both attachments in linear HDR.
- **Output pass** = a `ShaderMaterial` (fullscreen triangle) with `dithering: true`. Its fragment source has `#include <tonemapping_pars_fragment>` and `#include <dithering_pars_fragment>` written in explicitly: verified in r186, the program prefix adds `tonemapping_pars_fragment` only when the effective tone mapping is not `NoToneMapping` (WebGLProgram.js:775), which is never true here, while `colorspace_pars_fragment` (with `sRGBTransferOETF`) is always in the prefix (line 781). `NeutralToneMapping` multiplies by `toneMappingExposure` itself, and the renderer sets that uniform on every program that declares it (WebGLRenderer.js:2751), so exposure is `renderer.toneMappingExposure` (1.0). Per pixel, in this order:
  1. (optional ss) box downsample of both attachments, linear premultiplied
  2. `lit = NeutralToneMapping(att0.rgb)`; `c = lit + att1.rgb`; `a = att0.a`
  3. unpremultiply: `u = a > 0 ? c / a : 0`
  4. encode: `u = sRGBTransferOETF(vec4(u, 1)).rgb`
  5. dither the lit part only: `u += dithering(vec3(0.0)) · (1 − att1.a)` (three's `dithering()` returns its input plus a fixed `gl_FragCoord` hash of about ±0.5 LSB, so this is just the noise; deterministic), so the screen pixels stay exact
  6. premultiply again: `gl_FragColor = vec4(u · a, a)` into the `premultipliedAlpha` canvas
- Encoding premultiplied values straight to sRGB is wrong: a half-covered silver edge (0.5, a 0.5) would encode to 0.735 with a 0.5 (rgb > a), an invalid premultiplied pixel that Chrome composites as a bright halo. Steps 3-6 fix it.
- Gates:
  - FRONT with glass 0, ss 1, phone still: screen region against flat PSNR ≥ 48 dB (expected near-exact, §3.6)
  - default glass 0.25: ≥ 40 dB
  - a 50%-covered white edge over black comes out at about 128 (± 2), not about 187

### 3.6 Screen texture
- Refactor the compositor's `drawContent` body (compositor.ts 326-390) into `drawScreenContent(ctx, dst, time, input, cam, opts: { clip: () => void; cursorOutsideClip: boolean; pxScale: number })`.
  - The flat path calls it with today's arguments, call order and `pxScale = 1`. The mockCanvas golden log proves no change.
  - Today the overlays are sized from the canvas height `H`, not the screen rect: cursor `d = H·cursorSize`, ripple `maxR = H·0.055`, ripple `lineWidth = max(1.5, H·0.002)` (compositor.ts:355-380). In `drawScreenContent` every H-based size is multiplied by `pxScale`, and the crop mapping (`source`, `sx`/`sy`/`cropW`/`cropH`, `pointScaleFor(rect)`, `toPx`) is computed against `dst` instead of canvas pixels.
  - The 3D path calls it on the texture canvas with `dst` = the flat screen rect moved into texture space (§ sizing below), `pxScale = texScreenH / flatScreenRect.h`, and everything clipped to the screen outline. That bakes in the video crop, zoom (`cam`), touch indicators, cursor trail and dot, and ripples, then `drawCutouts`. This fixes the spike, which skipped the cursor and ripples.
  - Test: at FRONT, the cursor and ripple radii on the texture, mapped back through the screen quad, equal the flat ones within 0.5 px.
- **Size: 1:1 texels to render pixels.** The texture covers the projected screen at exactly render resolution (× ss): `texScreenW/H = projected screen size · ss`, clamped to `min(maxTextureSize, 8192)`. No 1.25 factor and no 64-px buckets (both made FRONT soft: trilinear blended about 32% of the next mip).
  - At FRONT the texture region starts at the integer canvas pixel `floor(screenRect.x·ss), floor(screenRect.y·ss)`, and `dst` keeps the flat rect's fractional phase inside it. So the 2D draw onto the texture is the same resample, with the same sub-pixel phase, as the flat draw onto the canvas.
  - **Hysteresis**: the canvas is re-created only when the needed size changes by more than 8%. Otherwise the content is drawn at its exact size into the top-left area, and `texture.repeat`/`offset` map the screen mesh's 0..1 UVs onto that area.
  - With the integer-snapped ROI and view offset (§2.3, §3.7), the FRONT quad is texel-aligned, so bilinear sampling returns exact texels and the screen at FRONT is the flat screen.
- Oblique views: `generateMipmaps = true`, `LinearMipmapLinearFilter`, `anisotropy = getMaxAnisotropy()` (16), and a **−0.5 LOD bias** (`lodBias` patch: `onBeforeCompile` replaces the `map_fragment` sample with `texture(map, vMapUv, -0.5)`). A minification up to 8% (the hysteresis slack) therefore still samples mip 0.
- The 2D canvas filters in gamma space and GL filters in linear light; at FRONT this does not matter (no GL resample), and at oblique angles it is accepted.
- The texture uploads once per output frame. Motion-blur sub-samples reuse it, because the video frame is fixed at the frame's srcT.

### 3.7 Pipeline per output frame (`renderPhone3D`)
1. **ROI**: `renderRoi` (§2.3): body hull ∪ its shadow on the catcher, unioned over the sub-frame times, dilated by blur + DoF + 2 px, snapped outward to whole canvas pixels. Render size = `roi.w·ss × roi.h·ss` (ss = `supersample`, default 1). The ROI's long side at render scale is ≤ `min(MAX_RENDERBUFFER_SIZE, 8192)`; ss steps down if needed. 4K costs only the phone's area.
2. **Depth range**: `camera.near/far` from `depthRange` (§2.3), then `updateProjectionMatrix()`. A fixed near of 0.1 at a camera distance of about 9,900 px (4K, fov 22) would leave hundreds of units per depth step, and the screen (+0.02 mm), glare (+0.04 mm) and lens layers would shimmer. With the tight range, the reversed-depth buffer when available, and the overlay-layer rules (§3.3), they do not.
3. Update the screen texture (§3.6).
4. **Sample plan** (all from pose and fixed tables, so deterministic):
   - `travel = hullTravelPx(p, t, shutter/fps, renderScale)` when motion blur is on, else 0
   - `Nmotion = travel < 0.5 ? 1 : clamp(ceil(travel / 1.5), max(2, motionBlur.samples), 64)`. The user `samples` value is a minimum. Adjacent copies are then ≤ 1.5 px apart, so a 400°/s spin-in streaks instead of showing ghost copies.
   - `Naa = 8` in export and full-quality frames, 1 in preview and `--draft`
   - `N = max(Nmotion, Naa)` in export, frames and the paused-idle preview render; `N = 1` in the live preview (no blur, no jitter)
   - sample k: time `t_k = t + ((k+0.5)/N − 0.5)·shutter/fps` when `Nmotion > 1`, else `t`; jitter `j_0 = (0,0)`, `j_k = (H2(k) − 0.5, H3(k) − 0.5)` render px for k ≥ 1 (Halton bases 2 and 3, a fixed table)
5. **Per sample k**:
   - **Shadow**: an orthographic camera along the key light (azimuth `light.azimuth + pose_k.light`, elevation 55°) renders the white silhouette into a 1024² **R16F** target; two separable Gaussian widths from `shadowSigma` (contact 0.22× ambient; ambient = the 2D `DEFAULT_FRAME_SHADOW` blur at default softness), blurred on the catcher surface itself (or a light-view blur scaled by |L·n|), also R16F, so the blur does not band. Catcher: `wall` is a plane parallel to the canvas, 1 mm behind the rearmost hull point, drawn as exactly the `shadowCatcherCorners` quad; `floor` is a horizontal plane 1 mm under the lowest hull point (needs elevation). The catcher writes premultiplied black with α = opacity·mask into attachment 0. When `Nmotion = 1` the shadow is rendered once and reused.
   - **Scene**: `camera.setViewOffset(W·ss, H·ss, roi.x·ss + j_k.x, roi.y·ss + j_k.y, tile.w, tile.h)` (tile origin added, see Tiling), render into the 2-attachment MSAA target, resolve, and add into the 2-attachment accumulation target with weight 1/N.
   - **Screen exactness rule**: when `Nmotion = 1` (phone still), attachment 1 (the screen) is accumulated from sample 0 only (zero jitter) with weight 1; the jittered samples add only attachment 0. Jitter is a sub-pixel box filter and would soften UI text; the screen's edge is already anti-aliased by MSAA. When the phone moves, every sample adds both attachments (the screen blurs with the motion, as it should).
6. **DoF** (`dof.on` and `pose.focus > 0`): a gather on both attachments plus depth.
   - export: 64-tap fixed Vogel disc; preview: 16 taps
   - CoC = `dof.amount·pose.focus·0.02·H·|1/z_f − 1/z|/(1/z_f)`, focus on the screen centre's depth. `pose.focus` is the animated channel (0..2), so a focus pull is a move like any other.
   - `dof.background` is separate: the compositor blurs the drawn background with `ctx.filter = blur(background·0.012·H px)`, only when 3D is active
7. **Output pass** (§3.5): optional ss box downsample on the GPU, tone map, unpremultiply, sRGB, dither, premultiply. The output lands 1:1 in the engine canvas's top-left `roi.w × roi.h` area (the canvas itself is resized with hysteresis). Return `{ canvas, roi }`.
8. **Tiling**: when the render-scale ROI area × 80 B (4 MSAA samples × (2 × 8 B colour + 4 B depth)) exceeds 120 MB, steps 5-7 run per tile. Tiles are at most 1.5 Mpx with a long side ≤ 2048, a multiple of ss, and overlap their neighbours by the max DoF CoC + 2 px (the overlap is rendered and discarded). Each tile uses the same camera with its own `setViewOffset` window and writes its region of the engine canvas. The shadow targets are per frame, not per tile. A 1080×1920 preview ROI (about 1.4 Mpx) is one tile.

### 3.8 Compositor integration (`src/renderer/src/compositor.ts`)
- `render()` sets `const p3 = phone3dActive(project).active ? engineSync() : null`. When it is null and 3D is active, the preview draws flat for that frame and calls `ensurePhone3d()`; `onEngineReady` triggers `renderAt`. When 3D is not active, every existing line runs unchanged.
- The placement block still runs, so `rect`, `frameBody`, `cam`, `contentBase`, `contentRect` and the guides are unchanged. `contentRect` stays the placed home body with 3D on (`placement3d.test` asserts it).
- The `'content'` draw becomes `drawImage(out.canvas, 0, 0, roi.w, roi.h, roi.x, roi.y, roi.w, roi.h)`: a 1:1 copy at integer coordinates (source and destination sizes are equal; the engine canvas may be larger because of its resize hysteresis, and the output pass writes into its top-left `roi.w × roi.h`). The ss downsample already happened on the GPU (§3.7 step 7), so `drawImage` never resamples the phone. `decor()` skips `drawDeviceFrame` when `p3` is set.
- `FrameInputs` gains `render3d?: { ss: 1|2|3; quality: 'full'|'draft'; motionBlur: { samples: number; shutter: number } | null; fps: number; strict: boolean }`. `quality: 'full'` turns on the 8 jitter samples and the adaptive motion count (§3.7 step 4); `'draft'` is N = 1.
  - `renderFrames` and `frames` pass it with `strict: true`.
  - The preview passes none, except a paused-idle render (150 ms after the last edit or seek) that uses export quality, so a paused frame shows what will export.
- **Hit-testing**: when 3D is active, `screenMap` gains `quad` and `facing`. `canvasToSource` runs `canvasToScreenUV`, then the existing crop and zoom inverse. `sourceToCanvas` projects forward. Both return null when the phone faces away.
- **Layer box (D20)**: the `content` LayerBox keeps `rect` = the placed home body (`contentRect`) and `base` = `contentBase`, exactly as today. When 3D is active it also gets `hull` = `bodyHull(p, time)` (canvas px). Only hit-testing (`overLayer`) and the drawn selection outline use `hull`. If `rect` were the turned phone's bbox (a different size and aspect from `base`), `placeLayer` → `transformFor(box.base, rect)` would set `scale = bbox.w/base.w` on the first ⌘-drag, and `resizeFromCorner(layer.rect…)` and `nudgeLayer` would apply the pose offset twice. Snapping guides keep using `rect`.
- `shared/canvasLayers.ts`: `LayerBox` gains `hull?: Point[]` ("the drawn outline when it is not the rect, e.g. a turned 3D phone"). `overLayer(box, q)` uses point-in-convex-polygon on `hull` when present, else today's rect/round test. `hitLayer` is unchanged (topmost first). Tests: a ⌘-drag move of a turned 3D phone leaves `contentTransform.scale` unchanged; a 0-px move gives the same `contentTransform`; a corner resize scales from the home body; an arrow nudge moves by exactly the step; a point inside `rect` but outside `hull` misses.
- `bgMean` for the environment's floor bounce (§3.1): the compositor draws the backdrop into a 1×1 canvas once per background change (colour, gradient, image, blur) and passes the mean linear colour. It is a pure function of the project, so it is deterministic.
- `this.error3d: string | null` is set on a lost context in strict mode. `renderFrames` aborts with "3D renderer lost the GPU".
- Stats go to `window.__p3d` only when `?p3dstats` is set. No `performance.now` affects pixels.

### 3.9 Context loss, memory, determinism
- `webglcontextlost` calls `preventDefault` and increments `generation`. `webglcontextrestored` rebuilds the environments, geometry and materials lazily.
  - preview: flat frame plus one toast, "3D paused (GPU reset)"
  - strict: wait up to 3 s for a restore and re-render the same frame, else abort
- Dispose on cache eviction and on `beforeunload`.
- **GPU memory ≤ 340 MB at 4K with the default settings** (raised from 300 by the advisor on 2026-10-24: the D14-matching shadow pads the ROI to about 8 Mpx at 9:16 4K) (ss 1, motion blur on, DoF on), worked out for a 9:16 4K phone ROI of about 1700×3200 (5.4 Mpx), which tiles (§3.7 step 8):

  | Item | MB |
  |---|---|
  | MSAA tile, 1.5 Mpx × 80 B | 120 |
  | resolve targets (2 × 8 B + 4 B depth) per tile | 30 |
  | accumulation (2 × 8 B) per tile | 24 |
  | DoF output per tile | 12 |
  | engine canvas 5.4 Mpx × 4 B, double-buffered | 44 |
  | screen texture (4K screen) with mips | 25 |
  | PMREM 512 HalfFloat | 25 |
  | shadow R16F 1024² × 3 | 6 |
  | geometry, LTC tables | < 10 |
  | **total** | **≈ 296** |

  ss 2 is opt-in: it keeps the same tile size (more tiles, more time), and only the 2× screen texture adds memory (about +75 MB), so ss 2 at 4K is budgeted at ≤ 440 MB. The old plan (ss 2 into one 4x-MSAA target) needed about 1.2 GB and would lose the context on an 8 GB M1.
- `HeadlessResult` gains `gpu` (WP3 adds the field in shared/headless.ts and Headless.tsx; WP4b supplies the value from `engine.gpuName()`). SwiftShader prints a warning line.
- **Determinism**: pose and light are functions of output time; all sample patterns and iteration counts are fixed. A test greps `src/renderer/src/phone3d/**` and `src/shared/phone3d/**` for `Date.now|performance.now|Math.random` and fails on any hit outside the stats guard.

---

## 4. Agent layer

### 4.1 Ops
Add to `OP_NAMES` and the `applyOp` switch in agentOps.ts. All are refused with `OpError('3D phone needs an iPhone recording')` when `!isPhoneProject(p)`. Pose objects accept any subset of the 8 keys (`focus` included). Partial `from`/`to` fill from `poseAt` at the move's start, so stored keyframes are always full.

```jsonc
{"op":"phone3d","enabled":true}                     // first call seeds defaultPhone3D()
{"op":"phone3d","enabled":false}                    // flat, settings kept
{"op":"phone3d","clear":true}                       // deletes the key: exact flat again
{"op":"phone3d","pose":{"turn":-8},"camera":{"fov":24,"elevation":0},
 "light":{"preset":"studio","azimuth":-35,"intensity":1.1},"glass":0.3,"back":"auto",
 "shadow":{"on":true,"kind":"wall","opacity":0.4,"softness":0.6},
 "dof":{"on":true,"amount":0.3,"background":0.2},"float":{"on":true,"amount":0.4,"period":6},
 "motionBlur":{"on":true,"shutter":0.5,"samples":12},"supersample":2}   // sub-objects merge
{"op":"setPose","at":4.2,"turn":30,"tilt":10}        // edits poseTargetAt(at)
{"op":"setPose","at":4.2,"focus":0}                  // a focus pull keyframe (dof must be on to see it)
{"op":"setPose","target":"base","size":0.9}          // the base pose, even when moves exist; or {"id":"m2","end":"from"|"to", ...}
{"op":"addTransition","start":2,"end":3.2,"to":{"turn":180},"from":{"turn":0},
 "easing":"spring","stiffness":180,"damping":18}     // easing: name | full object | "bezier":[.7,0,.16,1]
{"op":"addTransition","start":2,"to":{"turn":180},"easing":"spring","fitDuration":true}
{"op":"editTransition","id":"m2","start":2.4,"end":3.6,"to":{"tilt":12},"easing":"cinematic"}
{"op":"editTransition","index":0,"from":null}         // link the Start keyframe
{"op":"editTransition","id":"m2","by":0.5}            // shift both ends (agents; the lane sends {start,end})
{"op":"editTransition","id":"m2","swap":true}         // Swap Start / End: from and to change places (both materialized)
{"op":"editTransition","id":"m2","resetEnd":true}     // Reset End to Start: to = the resolved start pose
{"op":"removeTransition","id":"m2"}  {"op":"clearTransitions"}
{"op":"shot","recipe":"turn-to-back","at":6,"duration":2.6,"intensity":1,"direction":1,"return":"front"}
{"op":"direct","style":"hero","replace":true,"scenes":true}  // replace:false = keep existing moves; scenes:false = ignore scene changes
{"op":"exportSettings","preset":"uhd4k"}             // existing op; now also 4K for preset layouts (D18)
```
- **Reset 3D Pose** (canvas menu) is not a new op. It is the pair `[{"op":"clearTransitions"},{"op":"setPose","target":"base","turn":0,"tilt":0,"rotate":0,"size":1,"x":0,"y":0,"light":0,"focus":1}]`, sent as one `applyOps` call (one undo step). AGENTS.md documents the same pair.
- `swap`: materializes a linked `from` first, then exchanges `from` and `to`. Swapping twice is the identity (except that a linked `from` stays materialized). `resetEnd`: `to = resolveStarts(p3)[i]`. Both may combine with other fields; `swap`/`resetEnd` run first. Tests (`agentOps` additions): swap twice on an explicit move gives JSON equal to the original; `resetEnd` then `facing` at `end` equals `facing` at `start`, and `poseDelta(to, start)` is all zero.
- `direct` reads `ctx.scenes` only when `scenes !== false`, and `ctx.cursor` always (D5).
- Each op returns a one-line note, for example `added 3D move m2 2.00–3.20 s (spring)` or `setPose edited End of m2`.
- Ids come from `ctx.newId`. Items are found with `locateItem` (id or index), and the list stays sorted.
- `ApplyContext.cursor?: CursorSample[]` holds `cursor.json` samples (D5). `buildContext` reads it whenever the ops include `direct` (missing file = `[]`); `info` and `validate` read it for warnings.
- `ApplyContext.scenes?: number[]` holds source seconds. `needsScenes(ops)` is true for a `direct` op without `scenes:false`. `buildContext` reads `src/node/scenes.ts sceneTimes(bundle, video, bin)`. That function is extracted from `review` (agentCli.ts:297, same ffmpeg `select='gt(scene,0.25)'` command) and caches its result in `<bundle>/analysis/scenes.json`, keyed by video mtime and size. The watcher ignores it (verified: it only reacts to `project.json`). `review` calls the same function.

### 4.2 Commands (agentCli.ts `main` switch plus `HELP`)

**`direct <bundle|latest> [--style subtle|hero|bold] [--keep] [--no-scenes] [--dry-run]`**
- A copy of `polish()`: `readProject` → analyze taps if `!p.tapsAnalyzed` → scenes (skipped with `--no-scenes`) → `cursor.json` → `planDirect` → `applyOps` → `writeProject`.
- Flags map 1:1 onto the op and the editor: `--style` = `style` = the Style control; `--keep` = `replace:false` = "Keep existing moves"; `--no-scenes` = `scenes:false` = "Use scene changes" off.
- Output:
  ```json
  {"ok":true,"bundle":"…","dryRun":false,"style":"hero",
   "shots":[{"recipe":"spin-in","start":0,"end":1.6,"reason":"intro; first tap at 2.3 s"}],
   "ops":[…],"changes":[…],"warnings":[],"outputDuration":31.2,"backup":"…/project.json.bak"}
  ```

**`frames <bundle|latest> (--at 0.5,2,4.25 | --every 0.5 | --moves) [--out dir] [--scale 0.5] [--sheet] [--draft] [--timeout s]`**
- `--moves` renders the start, middle and end of each move, plus every tap time.
- At most 200 times; times are OUTPUT seconds.
- The default quality is the export path (ss plus motion blur). `--draft` gives N = 1 and ss = 1.
- `--sheet` adds `sheet.png`, a labelled grid.
- Spawns `OpenScreen --export <bundle> --frames <csv> --out <dir> [...]` through `appCommand()`, the same way `exportCmd` does.
- Output:
  ```json
  {"ok":true,"out":"/…/openscreen-frames/demo-20261024-1530","size":{"w":1080,"h":1920},
   "files":[{"t":2,"path":"…/f-0002.000.png","pose":{…},"facing":0.98}],"sheet":"…/sheet.png","seconds":3.1,"gpu":"Apple M1"}
  ```
  A time past the end gives `{t, error:"past the end"}`.
- Implemented as a function in `src/node/framesCmd.ts`. agentCli adds only the case.

**Headless plumbing**
- `HeadlessJob` gains `frames?: number[]; scale?: number; sheet?: boolean; draft?: boolean`. With `--frames`, `--out` is a folder, and `--gif`/`--preset` are rejected.
- main adds IPC `headless:writePng(name, ArrayBuffer)`, which refuses any name that resolves outside `out`. It also adds `analyze:scenes(dir)`, which calls `scenes.ts`, used by the editor's Auto 3D.
- `renderer/src/headlessFrames.ts runFrames(comp, deps)` loops: `locate` → `seekVideo` → `comp.render(t, inputs + render3d)` → scale → `toBlob('image/png')` → `writePng`. No ffmpeg, no audio probe. Project writes and tap analysis stay off, as in headless export.

**`validate`** prints `{ok, problems, warnings}`. Exit 1 happens on problems only.

**`info` additions** (`summarize`):
- `phone3d: null | {active, reason?, enabled, model, finish, pose, camera, light, glass, back, shadow, dof, float, motionBlur, supersample}`
- `transitions: [{index, id, start, end, duration, linked, from (resolved), to, easing, recipe?}]`
- `warnings`
- `shotRecipes: [{name, duration, summary, use}]`

`apply`, `polish` and `direct` print `warnings`. `export` still refuses on problems and prints warnings to stderr as progress lines. All of them compute warnings with the bundle's `cursor.json` (D5), so `validate` reports the same warnings the editor shows (`zoom-3d` for manual zooms that do not play in 3D; the `over-zoom` warning is gone).

**4K export (D18)**
- `shared/exportArgs.ts`: new `presetCanvasSize(preset, exportPreset)`: App Store presets → the preset's size; `exportPreset === 'uhd4k'` → scale `2160 / min(preset.width, preset.height)`, both sides even; else the preset's size.
- `shared/mobileProject.ts projectCanvasSize`: `preset ? presetCanvasSize(preset, p.exportPreset) : exportCanvasSize(...)` (Classic unchanged).
- `shared/exportJobs.ts planRenders(presets, exportPreset)`: pass and transcode sizes go through `presetCanvasSize`; the editor's `presetCompositor` builds its canvas at that size.
- So `apply [{"op":"exportSettings","preset":"uhd4k"}]` then `export --preset social-9x16` writes 2160×3840, and the project's own layout preset exports at 4K too. `info.export` gains `canvas: {w,h}` so agents can check before exporting.
- Test: `presetCanvasSize` for every preset × the 3 values; App Store never scales; flat-identity fixtures (all `p1080`) are unchanged; a 2160×3840 flat frame downscaled to 1080×1920 matches the 1080×1920 frame at PSNR ≥ 40 dB (the layout is resolution-independent, as the multi-format pass already assumes).

### 4.3 AGENTS.md (R/AGENTS.md)
Add these rows to "### Parity with the editor", and add `direct` and `frames` to the Commands table.

| Editor control | Project field(s) | Op |
|---|---|---|
| 3D tab › 3D phone switch | `phone3d.enabled` | `phone3d {enabled}` |
| 3D tab menu › Remove 3D | `phone3d` (deleted) | `phone3d {clear:true}` |
| Auto 3D button | `phone3d`, `phone3d.transitions` | `direct` op / `direct` command |
| Auto 3D › Style (Subtle / Hero / Bold) | — | `direct {style}` / `--style` |
| Auto 3D › Keep existing moves | — | `direct {replace:false}` / `--keep` |
| Auto 3D › Use scene changes | — | `direct {scenes:false}` / `--no-scenes` |
| Shot gallery tile; timeline menu "Add 3D Shot ›" | `phone3d.transitions`, `phone3d.float` | `shot {recipe, at, intensity, direction}` |
| Shots › Duration, Return to front, Intensity, Mirror (Shift-click) | — | `shot {duration, return:'front'\|'stay', intensity, direction}` |
| Pose fields (Turn, Tilt, Rotate, Size, Horizontal, Vertical, Light, Focus); Face Front | keyframe from `poseTargetAt` | `setPose {at \| target \| id+end}` |
| Pose › Editing: Base pose | `phone3d.pose` | `setPose {target:'base'}` |
| Drag / Option-drag the 3D phone; double-click; arrow keys | same | `setPose {at}` |
| Canvas menu › Reset 3D Pose | `phone3d.pose`, `phone3d.transitions` | `clearTransitions` + `setPose {target:'base', …FRONT}` in one `apply` |
| Move › Swap Start / End; lane menu "Swap Start / End" | `transitions[i].from/to` | `editTransition {swap:true}` |
| Move › Reset End to Start; lane menu "Reset End to Start" | `transitions[i].to` | `editTransition {resetEnd:true}` |
| Export menu › Resolution (preset layouts: Preset size / 4K) | `exportPreset` | `exportSettings {preset:'uhd4k'\|'p1080'}` |
| Lens, Camera height | `phone3d.camera` | `phone3d {camera}` |
| Lighting preset, Angle, Intensity | `phone3d.light` | `phone3d {light}` |
| Glass, Back | `phone3d.glass/back` | `phone3d {glass, back}` |
| Shadow switch, Wall/Floor, Opacity, Softness | `phone3d.shadow` | `phone3d {shadow}` |
| Depth of field, Background blur | `phone3d.dof` | `phone3d {dof}` |
| Pose › Focus (animated depth of field) | keyframe `focus` from `poseTargetAt` | `setPose {focus}` / `addTransition {to:{focus}}` |
| Float | `phone3d.float` | `phone3d {float}` / `shot float` |
| Motion blur, Shutter, Samples; Quality 1×/2×/3× | `phone3d.motionBlur/supersample` | `phone3d {…}` |
| 3D lane Option-click; `T`; menu "Add 3D Move Here" | `phone3d.transitions[]` | `addTransition` |
| Drag move block / Start-End diamonds | `transitions[i].start/end` | `editTransition {start,end}` (agents may also use `{by}`) |
| Easing picker, Spring stiffness/damping, Fit length, Custom curve | `transitions[i].easing` | `editTransition {easing,…, fitDuration?}` |
| Link Start switch | `transitions[i].from` | `editTransition {from:null \| {…}}` |
| Right-click Remove / ⌫ | — | `removeTransition` |
| 3D tab menu › Clear moves | — | `clearTransitions` |
| Warning row › Fix | — | the warning's `fix` ops via one `apply` |
| (preview canvas) | — | command `frames` |

Also update the existing row "Export menu: resolution, frame rate" (AGENTS.md:161) to say `uhd4k` now also scales preset layouts to a 2160 short side (App Store presets excepted).

Also add a "3D phone" section covering:
- units and the sign rule
- OUTPUT time, and moves following cuts by their landing moment
- linked starts
- the recipe table
- the direct rules
- warning codes with their fix ops
- "App Store presets stay flat"
- `frames` before `export`

Update `R/docs/ARCHITECTURE.md` too.

### 4.4 The `openscreen` skill: `R/skills/openscreen/SKILL.md`
Install with `node electron/scripts/install-skill.mjs`. It symlinks into `~/.claude/skills/openscreen` and `~/.codex/skills/openscreen`, is idempotent, and only runs when a person runs it. It never runs from a build or a test. Written in `writing-for-agents` style:

1. **Front matter**: `name: openscreen`. The description triggers on "use openscreen", "make this (demo/video) world class", "3D phone mockup", and "edit/polish/export my recording".
2. **Step 0, find and prepare the CLI** (the skill is a symlink and is often used from another project's cwd, so nothing may assume the repo is the cwd):
   - `OS="$(cd "$(dirname "$(realpath <path of this SKILL.md>)")/../.." && pwd)"`, the skill's real folder is `R/skills/openscreen`, so `$OS` is the checkout. The skill shows the line for both homes (`~/.claude/skills/openscreen/SKILL.md`, `~/.codex/skills/openscreen/SKILL.md`). `install-skill.mjs` also prints the resolved `$OS` once as a check.
   - `A="node $OS/electron/scripts/openscreen-agent.mjs"`.
   - Run `$A ops`. If it fails, or `direct`, `frames` and `phone3d` are not all listed (dist/ is missing or stale), run `npm --prefix "$OS/electron" run build` once, then run `$A ops` again. Stop and report if it still fails.
3. **What "this" means**: a bundle path the user pasted (from **File → Copy Path for Agent**), else a bundle path in the conversation, else `latest`. Say which bundle was picked, by name and path, before editing.
4. **Loop**:
   1. `info`
   2. `review`, then read the stills
   3. `polish`
   4. `direct --style hero` (bold for promos, subtle for tutorials)
   5. `frames --moves --sheet --draft`, then **look at sheet.png**
   6. fix with `apply` (`setPose`, `editTransition`, `shot`, or a warning's `fix`)
   7. `validate` until warnings = 0, or each remaining one is explained
   8. `frames --moves` at full quality
   9. `export` (`--preset` for socials; for the 4K hero file, first `apply [{"op":"exportSettings","preset":"uhd4k"}]`)
5. **World-class checklist**:
   - face front at every tap
   - one idea per move
   - moves only in waits or at scene changes
   - intro under 1.8 s
   - at most 35% of runtime moving
   - spring for settles, cinematic for big turns
   - motion blur on for export
   - 4K only for the hero file
6. Recipe table (from `info.shotRecipes`) with when to use each one, plus an easing guide.
7. **Rules**:
   - never hand-edit project.json
   - times are OUTPUT seconds after cuts; clip ops go first
   - App Store presets stay flat
   - export runs 10-15× slower than real time, so judge with `frames`
8. AGENTS.md is the reference; do not copy it.

---

## 5. Editor UI

### 5.1 `apply3d` (Editor.tsx)
```ts
/** One op or a list (a warning's fix, Reset 3D Pose) = one state change, one undo step. */
const apply3d = (ops: EditOp | EditOp[], opts?: { announce?: string; ctx?: Partial<ApplyContext> }) => {
  const list = Array.isArray(ops) ? ops : [ops];
  const ids: string[] = [];                                    // fixed for this call
  const ctxFor = (): ApplyContext => {
    let i = 0;
    return { cursor, ...opts?.ctx, newId: () => (ids[i] ??= crypto.randomUUID(), ids[i++]) };
  };
  const run = (p: Project) => applyOps3d(p, list, ctxFor());  // applyOp per op, then validateProject → { project } | { error }
  const first = run(projRef.current);                          // eager: error toast + recorder
  if ('error' in first) { toast(first.error); return; }
  recorder?.push({ ops: list, ctx: { ...opts?.ctx, ids: [...ids] } });   // dev mode only (§6.6b)
  const commit = () => setProj((p) => {
    if (p === projRef.current) return first.project;          // common case
    const again = run(p);                                      // a queued update landed first
    return 'error' in again ? p : again.project;
  });
  opts?.announce ? announce(opts.announce, commit) : commit();
};
```
- **Validation like the CLI**: `applyOps3d` (shared, next to `applyOps`) runs `applyOp` for each op and then `validateProject` on the result. Any problem becomes a toast and the state does not change, the same refusal `applyOps` gives in the CLI. So the editor can never store a project the CLI would refuse.
- **No stale base**: `projRef.current` is only updated in a passive effect after commit (Editor.tsx:205-213). The functional updater re-applies the ops to the real latest state when another update is queued in the same batch, and the fixed `ids` list keeps the updater pure (React may call it twice; it gets the same ids both times). Relative ops are never sent per pointermove: lane drags send absolute `{start,end}` computed from the move as it was at pointerdown (§5.3), orbit sends an absolute pose computed from the drag-start pose (§5.4), and a warning's Fix sends all its ops in one `apply3d` call.
- Auto 3D: `scenes = useScenes ? await api.analyzeScenes(bundleDir) : undefined` → `apply3d({op:'direct', style, replace: !keepMoves, scenes: useScenes}, {announce:'3D shots added', ctx:{scenes}})`. The editor's `cursor` prop (from the same `cursor.json` the CLI reads) is always in the context, so the plan equals `direct` on the CLI.

### 5.2 3D tab: `renderer/src/phone3d/Phone3DPanel.tsx` + `phone3d.css`
- `InspectorTab` gains `'three'` with the label "3D". It is shown when `isPhone && !hasPhoneLayer`, so it never appears with the Phone tab and the most tabs at once stays 8 (`data-count='8'` CSS exists).
- Props: `{proj, apply3d, playhead, selectedTransition, onSelectTransition, onCommit, warnings, onSeek, autoBusy}`.
- Built from `Section`, `Switch`, `Segmented`, `Button` (ui.tsx) and `ScrubField` with `slider` (components/ScrubField.tsx). All colours come from tokens.

Sections, top to bottom:
1. **3D phone**
   - Switch.
   - `actions`: **Auto 3D** (busy label "Planning…"), plus a `…` menu: Remove 3D, Clear moves, Copy as edits.json.
   - Under the button, the Auto 3D options (remembered per project in editor state, not in the file): **Style** `Segmented` Subtle / Hero / Bold (default Hero), **Keep existing moves** switch (default off = replace), **Use scene changes** switch (default on). These are the `direct` op's `style`, `replace` and `scenes` fields and the CLI's `--style`, `--keep` and `--no-scenes`.
   - When inactive, a `hint` gives the reason. For App Store it reads "Flat in App Store layouts".
2. **Warnings** (only when there are any)
   - rows with `--caution`: time and message
   - clicking a row runs `seekOutput(at)`
   - a **Fix** button applies all the warning's `fix` ops in one `apply3d` call
3. **Shots**
   - 5 tiles cloned from `.canvas-tiles` (mobile.css L118-180)
   - each tile has a 64 px SVG glyph of the move's path, generated from `SHOTS`, plus the label and the duration
   - click inserts at the playhead; Shift-click mirrors (`direction:-1`)
   - Intensity is a Segmented control: Subtle 0.6 / Normal 1 / Bold 1.4
   - **Duration** ScrubField (seconds; empty = the recipe's default, shown as the placeholder) and **Return to front** switch (default on = `return:'front'`; off = `'stay'`, used by turn-to-back and hero-layback). Resizing lane blocks does not replace these, because turn-to-back and hero-layback expand into 2 moves.
4. **Pose**
   - the "Editing:" line is a small menu: the automatic target ("End of move 2 · 3.20 s", from `poseTargetAt`) or **Base pose** (the resting pose; reachable even when moves exist; sends `setPose {target:'base'}`)
   - ScrubFields: Turn °, Tilt °, Rotate °, Size %, Horizontal %, Vertical %, Light °, **Focus %** (0-200; dimmed with the hint "Depth of field is off" while `dof.on` is false)
   - "Face front" in `actions`
5. **Move** (shown when a move is selected)
   - Start and End ScrubFields (seconds)
   - Link Start switch
   - **Swap Start / End** and **Reset End to Start** buttons (`editTransition {swap:true}` / `{resetEnd:true}`), as on AwesomePost's transition block
   - Easing `Segmented columns={4}`: Smooth · Linear · Ease In · Ease Out · Cinematic · Spring · Custom
   - `EasingCurve.tsx`: a 160×96 SVG that samples the shared `ease()` at 64 points, with the overshoot band and a dot at the playhead (no loop)
   - Custom: two draggable bezier handles (pointer capture, `hold`/`seal`, x clamped to 0..1) and 4 numeric fields
   - Spring: Stiffness, Damping, a read-only Bounce (ζ), and **Fit length**
6. **Look**: Lens, Camera height, Lighting preset tiles (5), Angle, Intensity, Glass, Back (Auto/Glossy/Frosted).
7. **Shadow & focus**: Shadow switch, Wall/Floor, Opacity, Softness, Depth of field switch and amount (the base strength; the Pose section's Focus animates it per keyframe), Background blur.
8. **Float**: switch, amount, period.
9. **Export quality**: Motion blur switch, Shutter, Samples (the minimum; fast moves take more, §3.7), and Quality 1×/2×/3× (default 1×; anti-aliasing comes from jitter), with an estimated export time when samples > 16 or ss ≥ 2.

Each control's only write path is `apply3d`. Staff copy is terse.

**Export menu, Resolution for preset layouts (D18)**: `ExportPanel`'s preset branch (ExportPanel.tsx:61-69, today only a hint) gains a Resolution `Segmented`: "{preset.width}×{preset.height}" (`p1080`) / "4K {scaled size}" (`uhd4k`). Not shown for App Store presets. It writes through `apply3d({op:'exportSettings', preset})`, not `setProj`, so the agent op is the same path. The hint line shows the size that will be written.

### 5.3 3D lane: `renderer/src/phone3d/TransitionLane.tsx`
- Built from the `AudioTrackLane.tsx` pattern (pointer capture, `dragLatched` from shared/audioTracks, `onSelect` on a pointerup with no move) and `TapsLane.tsx`.
- Labelled "3D", under Zoom and above Taps. Shown only when `proj.phone3d` exists.
- Blocks are `.moveblock`: `--accent-tint` fill, inset `--accent-ring`, the label is the recipe or easing name when the block is ≥ 48 px wide, and overlap or warning states use `--caution` hatching.
- Each edge has a 9 px diamond (Start/End). A linked Start shows a hollow diamond.
- Edge drag → `editTransition {start|end}` (minimum 0.1 s). Body drag → `editTransition {start, end}`. Both are **absolute**: computed from the move as it was at pointerdown plus the total pointer offset (the existing "works from the layer as it was grabbed" rule), never `{by}` per pointermove, so a dropped or batched event cannot add up wrongly.
- Both snap to frames (1/outputFPS), the playhead and tap markers within 6 px. Both use `hold()`/`seal()`.
- Click selects. It clears selectedClip, selectedTap and selectedAudio, opens the 3D tab's Move section, and double-clicking a diamond seeks to it.
- Option-click on an empty part of the lane: `addTransition {start:t, end:t+1.2, to:{turn: held.turn + 25}}`.
- Right-click a block: Easing ›, Link Start, Swap Start / End, Reset End to Start, Duplicate, Remove. `timelineMenu` (Editor.tsx ~2146) gains "Add 3D Move Here" and "Add 3D Shot ›".
- **Grid refactor**:
  - `laneHeights(phone, music, three = false)` adds a 26 px row after zoom
  - `.ed-timeline` labels and lanes get an inline `gridTemplateRows` built from `laneHeights`
  - remove the per-combo CSS (styles.css ~1805 and ~2142, mobile.css 203-210)
  - `naturalTimelineHeight` and the `timelineH` floor follow automatically
  - `test/timelineView.test.ts` gets cases for this
- Keys: ⌫ removes the selected move (in the Delete chain, after layer). Esc deselects. Plain `T` adds a move at the playhead.

### 5.4 Drag-to-orbit on the preview
- `shared/previewPointer.ts` gets `{kind:'orbit'}`. Priority: crop > placeTap > corner handle (resize = `contentTransform`) > **orbit only when 3D is active AND `hitLayer(layers, p)` returns the `content` box (it is the topmost layer at that point) AND the point is inside its `hull`** > layer move. A camera bubble, text, title card or caption drawn over the phone wins, as today. ⌘-drag on content keeps the old move. Cursor: `grab`/`grabbing`.
- Tests (`previewPointer` additions): a text layer over the phone still moves; ⌘-drag on content moves it; a press inside the content `rect` but outside the `hull` does not orbit; with 3D off nothing changes.
- A drag runs `orbitPose` from the drag-start pose (absolute), then `apply3d({op:'setPose', at: playhead, ...})` live under `hold()`. When a move is selected, the playhead jumps to the edited keyframe on pointerdown, so what you see is what you edit.
- Double-click: Face front. Arrows: turn/tilt by 1° (Shift 10°) when 3D is selected.
- `drawEditorGuides` draws the projected hull outline, an orbit ring and a "Turn 32° · Tilt 8°" pill, in the `#FF8A3D` literal. These are preview only, never in the compositor.
- Tap placing uses the homography-aware `canvasToSource`. When it returns null, a toast says "Turn the phone to the front to place taps."
- Canvas context menu adds "Reset 3D Pose": `apply3d([{op:'clearTransitions'}, {op:'setPose', target:'base', ...FRONT}], {announce:'3D pose reset'})` (§4.1).

### 5.5 Light/dark, reduced motion, deps
- Both schemes come from tokens.css.
- `prefers-reduced-motion`: gallery glyphs and the curve dot are static, and the tab glide is instant. Rendered video does not change.
- `renderAt` deps (Editor.tsx ~767) add `selectedTransition` (guides) and the idle-quality tick.
- `frameInputsAt(outT, srcT, render3d?)` replaces the two copies of the input object in `renderAt` and `renderFrames`.
- **No preview redraws during export or frames**: `renderFrames` seeks the video, and the `'seeked'` listener calls `renderAt(playheadRef.current)` (Editor.tsx:969) on the same compositor the export uses (Editor.tsx:1180). With 3D that doubles GPU work per frame and flips the engine between preview settings (N = 1) and export settings (N ≥ 8) every frame, re-sizing targets. An `exportingRef` (set for the whole of `exportVideo`, `exportFormats` and `runFrames`) makes `renderAt` and `onSeeked` return early, and when `headless` is set they never draw. The §6.5 bench runs with this guard, and a counter test checks one engine render call per exported frame.

---

## 6. Quality gates

1. **Flat identity (written first).**
   - `scripts/golden/makeFixtures.mjs` builds 7 bundles: display, window, iOS social 9:16, iOS 16:9, iOS landscape, App Store, Mac+iPhone (the gate pins x264 to one thread; `--out` is a parent folder). They use ffmpeg `testsrc2` (590×1278, 30 fps, 8 s) and a handmade project.json with taps, waits and one zoom. The videos are not committed.
   - **Compositor harness** (`test/helpers/compositorHarness.ts`, WP0). No test can import compositor.ts as it is: it imports `./api`, which reads `window.openscreen` at load (api.ts:172); vitest runs with `environment: 'node'` (vite.config.ts:14); the constructor calls `document.createElement('canvas')` (compositor.ts:144); `drawBlurredBackground` and the backdrop grain make scratch canvases (`OffscreenCanvas` when defined, else `document.createElement`); `backgroundImage` uses `new Image` (compositor.ts:52). The harness, in this order:
     1. `vi.mock('../src/renderer/src/api', () => ({ api: { prepareBackground: async (p) => p } }))`
     2. stubs a global `document` whose `createElement('canvas')` returns a canvas-like object (`width`, `height`, `getContext('2d')` → a `mockCanvas` context that logs calls), leaves `OffscreenCanvas` undefined, and stubs `Image` (never loads; `complete = false`)
     3. builds a `CanvasCompositor(project, canvasSize, segments)` and calls `render(t, inputs)` with fake video objects (`videoWidth`, `videoHeight`)
   - WP0 commits the harness first, runs it on a detached worktree of main 3dea11b to capture the logs, then commits the logs. Optional cleanup in WP4b's refactor commit: inject `prepareBackground` instead of importing `./api`, so the harness needs one stub fewer; the golden log must stay identical.
   - `test/compositorGolden.test.ts`: the mockCanvas call log per fixture matches the log **captured from main's compositor** and committed before WP4b starts.
   - `test/phone3dCompat.test.ts`:
     - normalize round trip has no `phone3d` key and is byte-equal to the committed baseline
     - `applyOps(old, [])` and `remapProject` are unchanged
   - `scripts/golden/flatIdentity.mjs` exports every fixture with main's build and with the branch build, then compares `ffmpeg -f framemd5`. Required: identical.
2. **3D goldens** through `frames` on `test/fixtures/3d-golden`:
   - FRONT (ss 1, phone still): screen quad within 0.25 px; screen PSNR ≥ 48 dB at glass 0 and ≥ 40 dB at the default (GPU harness `front.<layout>.screenPsnr.defaultGlass≥40`, and `front.glassSweep.*` over every light preset × key azimuth −90..180, since fix round 1); body IoU ≥ 0.97 against the 2D frame mask. With the 1:1 texel-aligned path (§3.6) the screen interior is expected to be exact, so 48 dB has margin. If, when WP4b's screen path first runs on the WP0 fixtures, a fixture cannot reach 48 dB, the cause is found first; only a measured, explained shortfall may set the gate to the measured value − 1 dB, and that is reported to the owner, never quietly lowered.
   - cursor and ripple radii on the 3D screen at FRONT match flat within 0.5 px (§3.6)
   - each recipe at 5 times: SSIM ≥ 0.98 and PSNR ≥ 38 dB against committed PNGs (Apple silicon only; golden protocol below)
   - **ROI border**: for every recipe at 5 times, wall and floor shadow, the alpha on the ROI's border pixels is < 1/255 (nothing is cut by the ROI)
   - **No z-fight**: FRONT and a 30° turn, each rendered twice, with reversed depth on and forced off: the screen-region pixels are bit-identical between runs, with no speckle against a reference
   - **Edges**: a 50%-covered white edge over black outputs about 128 (± 2), not about 187 (§3.5)
   - **Banding**: a 4K wall-shadow gradient has no run of identical 8-bit values longer than 64 px along its falloff (dither on)
   - **Materials**: turntable stills of the black, silver and orange finishes show a visible band highlight (band luminance at the highlight ≥ 0.5 after tone mapping)
3. **Determinism and motion.**
   - t = 3.3 rendered twice, then in reverse seek order: identical bytes
   - `frames` at t against export frame `round(t·fps)` from a `.mov` master: PSNR ≥ 50 dB
   - motion-blur frames differ from `--draft` only while the pose moves
   - **No strobing**: for every recipe at its fastest frame, adjacent sub-sample copies of the projected hull are ≤ 2 px apart (computed from the sample plan, §3.7 step 4)
   - jitter: a still FRONT frame in export has its screen region identical to the `--draft` frame (screen exactness rule), and its band edge differs (AA applied)

   **Golden protocol** (the recipe PNGs in `test/golden/3d/*`): WP4b renders them with the real engine only after the WP4a turntable sign-off; WP6 reviews them in the review harness and commits them; from then on they gate every later change to the renderer. Until they are committed, WP4b's acceptance checks every §6.2 gate except "against committed PNGs". A deliberate look change regenerates them through the same steps, in its own commit, with the before/after pairs in the review harness.
4. **Review harness**: `scripts/review3d.mjs <bundle>` writes `/tmp/openscreen-review/<run>/index.html` with:
   - flat vs 3D side by side
   - a contact strip and a 3 s clip per recipe
   - the `direct` plan drawn over the taps
   - warnings and perf numbers
   - **blinded A/B pairs** against the owner's AwesomePost and Rotato captures (kept in /tmp, never committed)
   - rubric 1–5: silhouette, metal, glass, screen sharpness at an angle, motion feel, spring, shadow, legibility at taps, DoF taste, would ship
   - Pass: Tyler plus 3 model judges prefer ours or tie in ≥ 60% of pairs, and no axis is below 3.
5. **Performance budgets** (M1 base 8 GB; `scripts/bench3d.mjs` through CDP, like the spike's cdp.mjs; the export-during-preview guard of §5.5 on). Every 4K number is measured on the real 4K file: `apply [{"op":"exportSettings","preset":"uhd4k"}]` then `export --preset social-9x16` on a 3D fixture, which must produce 2160×3840 (D18).

| Measure | Budget |
|---|---|
| Preview 1080×1920 | ≥ 55 fps; 3D pass p95 ≤ 4 ms (≤ 7 ms with DoF) |
| Export 1080p, 3D pass, defaults (ss 1, 8 jitter samples, blur on) | ≤ 20 ms/frame while still; ≤ 45 ms p95 while moving |
| Export 4K (2160×3840), 3D pass, defaults | ≤ 60 ms/frame while still; ≤ 150 ms p95 while moving (adaptive N up to 64 on the fastest frames is reported separately, max ≤ 400 ms) |
| `frames` | first PNG ≤ 6 s cold; then ≤ 250 ms (1080p draft), ≤ 1.5 s (4K full) |
| WebGL contexts | 1 across 100 compositor rebuilds |
| GPU memory | ≤ 340 MB at 4K with defaults (§3.9 table); ≤ 440 MB at 4K ss 2 |
| Engine renders per exported frame | exactly 1 (counter) |
| Flat project | three not loaded (checked with the module registry) |

6. **Equal test.**
   - **(a) Automatic**, in `test/opsParity.test.ts` (one owner: WP6; WP2 sends its source-parse cases to WP6):
     - every `OP_NAMES` entry appears in AGENTS.md
     - every `case '…'` in `applyOp` is in `OP_NAMES` (source parse)
     - every op field used by an editor control in §4.3 (`direct.style/replace/scenes`, `shot.duration/return`, `setPose.target`, `editTransition.swap/resetEnd`, `exportSettings.preset`) appears in AGENTS.md's parity rows
     - `Phone3DPanel.tsx`, `TransitionLane.tsx` and `EasingCurve.tsx` contain no `setProj(`
     - every Editor 3D handler calls `apply3d`
   - **(b) Replay**: in dev mode the editor's recorder saves each `apply3d` call as `{ ops, ctx }`, where `ctx` holds the generated ids in order plus the `scenes` and `cursor` it used. Fixture logs are committed. The test replays each entry with `applyOps3d(p, ops, { ...ctx, newId: () => ctx.ids[i++] })` and checks the final JSON equals the editor's saved project. Because the editor validates exactly as the CLI does (§5.1), no recorded state can be one the CLI refuses.
   - **(c) Judged** (protocol in `R/docs/EQUAL_TEST.md`): one recording and one brief ("15 s world-class 3D promo"). Tyler gets 10 minutes in the editor; a fresh agent gets only the skill and the CLI. Blind judges use the rubric. Pass: the agent is within 0.5 points, both have 0 warnings, and the agent never needed an editor-only action. Every gap becomes a missing op or control and is fixed before ship.

---

## 7. Work packages

**File ownership is exclusive: every file below has exactly one owner, and no file is unowned.** `Editor.tsx` passes from one package to the next: WP3 makes one scoped change and merges, then WP4b makes one scoped change and merges, then WP5 owns the rest. A package that needs something in a file it does not own sends the change (or the test case) to the owner. Every merge runs `npm run typecheck`, `npm test`, `npm run build`, every suite that reads the changed files (including `scripts/`), and the flat-identity gate.

### WP0: Baselines (day 1, before anything touches the compositor)
- **Owns:** `scripts/golden/{makeFixtures,flatIdentity}.mjs`, `test/fixtures/compat/*`, `test/fixtures/3d-golden/*` (project JSONs; videos made by makeFixtures, not committed), `test/helpers/compositorHarness.ts` (§6.1), `test/compositorGolden.test.ts` plus its committed log, `test/phone3dCompat.test.ts` baseline JSON, `test/goldenScripts.test.ts`, mockCanvas extensions.
- **Acceptance:**
  - [ ] The harness is committed first and builds a `CanvasCompositor` in vitest with no DOM.
  - [ ] Logs and JSON are captured by running the harness on a detached main 3dea11b worktree, then committed.
  - [ ] The flatIdentity script runs main against itself and passes.

### WP1: Model and math (blocks the others; API frozen at the end of day 1)
- **Owns:**
  - `src/shared/phone3d/{model,validate,easing3d,pose,placement,projection,outline,orbit,lighting}.ts`
  - `src/shared/devices3d.ts` (the `Body3D` type, depth table, plateau data, `body3dFor`) and `test/devices3d.test.ts`, moved here from WP4a because `projection.ts` (`cameraFor`'s fit plane at z = depth/2, `bodyHull` with the plateau top) and WP2's off-canvas warning and `direct` need them on day 1
  - new `src/shared/deviceGeometry.ts` and `src/shared/phoneLayout.ts` (moved pure code)
  - re-export edits in `mobile/deviceFrame.ts` (plus `drawCutouts` export and the outline table) and `mobile/layout.ts`
  - the `types.ts` field and normalize hook
  - `remap.ts`
  - new `src/shared/focusSegments.ts` (`focusSegmentsFor`, D5) and `test/focusSegments.test.ts`
  - `src/shared/canvasLayers.ts` (`LayerBox.hull`, hull hit-testing in `overLayer`) and its tests (D20, §3.8)
  - tests: `phone3dModel`, `easing3d`, `pose3d`, `placement3d`, `projection3d`, `orbit`, remap additions, `resetProject` addition, `deviceFrame` path equality
- **Acceptance:**
  - [ ] Compat baseline unchanged; normalize is idempotent; an old pose gains `focus: 1` only inside `phone3d`.
  - [ ] Spring endpoints exact, no kink on short moves.
  - [ ] Projection matches three within 0.01 px; FRONT quad within 0.25 px; `renderRoi` contains the shadow; `depthRange` holds.
  - [ ] `phoneHome` equals the compositor's contentRect (3D on and off).
  - [ ] `focusSegmentsFor` equals today's memo body on the fixtures.
  - [ ] A ⌘-drag move of a turned phone keeps `contentTransform.scale`; a 0-px move keeps `contentTransform`.
  - [ ] The provisional depth table ships with a URL slot per row; the values may be used until WP4a's check (below) confirms them.
  - [ ] `deviceFrame.test.ts` and `layout.test.ts` are untouched and green.
  - [ ] No `three` import under `src/shared`.

### WP2: Ops, recipes, planner, warnings (after WP1)
- **Owns:**
  - `src/shared/agentOps.ts` (ops, `OP_NAMES`, `validateProject` hook, `applyOps3d`, `needsScenes`, `ApplyContext.scenes` and `ApplyContext.cursor`, `editTransition` `swap`/`resetEnd`, `direct` `scenes`)
  - `src/shared/phone3d/{shots,direct,warnings}.ts`
  - tests: `shots`, `direct`, `warnings3d`, `agentOps` additions. Its source-parse cases for `opsParity` go to WP6, which owns that file.
- **Acceptance:**
  - [ ] Every §4.1 JSON shape works, including `null` clears, `swap`, `resetEnd`, the Reset 3D Pose pair, and the non-iPhone refusal.
  - [ ] Every warning has positive and negative tests, and every `fix` clears its warning.
  - [ ] `direct` is deterministic with 0 warnings on 5 fixtures, the 500-seed test and the 120 s bold test; 10 turn-to-back shots in a row stay in range.
  - [ ] `applyOps3d` refuses exactly what `applyOps` refuses.
  - [ ] Old projects through `applyOps` are unchanged.

### WP3: CLI, headless frames, scenes, 4K presets (after WP1; stubs WP2's ops until it lands)
- **Owns:**
  - `src/node/agentCli.ts` (`direct`, `frames` case, `info`/`validate`/`apply` warnings with `cursor.json`, `buildContext` reading `cursor.json`, `info.export.canvas`, `HELP`)
  - `src/node/{scenes,framesCmd}.ts`
  - `src/shared/headless.ts` (frames fields and `HeadlessResult.gpu`; WP4b supplies the value), `src/main/index.ts`, `src/preload/*`, `src/renderer/src/api.ts`, `src/renderer/src/Headless.tsx`, `src/renderer/src/headlessFrames.ts`
  - `src/shared/exportArgs.ts` (`presetCanvasSize`), `src/shared/mobileProject.ts` (`projectCanvasSize`), `src/shared/exportJobs.ts` (`planRenders` sizes), D18
  - **one scoped Editor.tsx change**: `frameInputsAt` extraction; the headless frames branch; the `segments` memo calling `focusSegmentsFor(proj, cursor, duration)`; `presetCompositor` using `presetCanvasSize`; the `exportingRef` guard in `renderAt`/`onSeeked` and no drawing when headless (§5.5)
  - tests: `parseHeadlessArgs` frames cases, CLI arg parsing, `presetCanvasSize`, the 4K-downscale layout check
- **Acceptance:**
  - [ ] `frames --at` / `--every` / `--moves` / `--sheet` work, and `--draft` is ≥ 3× faster.
  - [ ] On a flat fixture, `frames` gives PNGs equal to frames of the export.
  - [ ] Writes outside `out` are refused.
  - [ ] Project writes and tap analysis are off in frames mode.
  - [ ] `direct --dry-run` writes nothing; `--keep` and `--no-scenes` map to `replace:false` and `scenes:false`.
  - [ ] `validate` exits 1 only on problems, and its warnings equal the editor's on the fixtures (same cursor).
  - [ ] The scenes cache is shared by the CLI and the IPC.
  - [ ] `export --preset social-9x16` with `exportPreset: 'uhd4k'` writes 2160×3840; App Store presets keep their size; flat identity unchanged.
  - [ ] No preview `renderAt` runs during an export or frames run.

### WP4a: Geometry, materials, environment (after WP1)
- **Owns:** `src/renderer/src/phone3d/{geometry,materials,environment}.ts`, `test/phone3dGeometry.test.ts` (three in node), `scripts/phone3d-turntable.mjs` (a look-development page). The device data (`shared/devices3d.ts`) is WP1's; WP4a sends corrections to WP1.
- **Acceptance:**
  - [ ] Every depth in WP1's table is checked against Apple's tech-spec page before merge, with the URL in a comment; corrections go to WP1.
  - [ ] All 22 iPhones and 5 iPads build, each under 60k triangles, with creases, fillets, seams and lens barrels (§3.3).
  - [ ] Mesh bbox matches mm within 0.05.
  - [ ] Normals are unit length; hard normals at every crease; tangents are present.
  - [ ] `bandF0` keeps hue and meets the luminance floors; materials match the §3.4 table (no clearcoat on metal or front glass).
  - [ ] RectAreaLight softboxes plus the 512 PMREM set; the boxes are not in the PMREM scene (look round 3, D13).
  - [ ] No logo and no Apple asset.
  - [ ] Turntable stills of 17 Pro, 16, Air and SE, and of the black, silver and orange finishes, are signed off in the review harness. This sign-off releases the golden protocol (§6.2).

### WP4b: Engine and compositor (after WP0 and WP1; RoundedBox stub until WP4a lands)
- **Owns:**
  - `src/renderer/src/phone3d/{loader,engine,screenTexture,shadow,passes,view}.ts`
  - `src/renderer/src/compositor.ts` (sole owner)
  - **one scoped Editor.tsx change**: `render3d` in `renderFrames`; waiting for `ensurePhone3d()` before frame 0 in `renderFrames`, `exportFormats` and the frames run (D9); `error3d` abort; `onEngineReady` → `renderAt`; idle full-quality render
  - supplies `engine.gpuName()` for WP3's `HeadlessResult.gpu`
  - generates the recipe golden PNGs after the WP4a sign-off and hands them to WP6 (§6.2 golden protocol)
- **Acceptance:**
  - [ ] The `drawScreenContent` refactor (with `pxScale`) lands as its own commit that passes `compositorGolden` and flat identity.
  - [ ] All §6.2–6.3 gates pass (the "against committed PNGs" gate from the moment WP6 commits them).
  - [ ] One context across 100 rebuilds.
  - [ ] `WEBGL_lose_context` recovers in preview and aborts export.
  - [ ] Flat projects do not load three.
  - [ ] The App Store preset renders flat.
  - [ ] §6.5 budgets met, including 4K on the real 2160×3840 file, GPU memory ≤ 340 MB, and one engine render per exported frame. (Open since look round 3: see "Look round 4, fix round 1" and "GPU memory, fix round 2"; the owner picks a trade or relaxes decision 10. Fix round 2 re-measured, median of 3: still not met.)

### WP5: Editor UI (after WP2 op shapes and the WP3/WP4b Editor merges; can start on stubs)
- **Owns:**
  - `src/renderer/src/Editor.tsx` (the rest: `apply3d` with validation and the recorder, tab, lane wiring, selection, keys, menus including Reset 3D Pose, orbit, guides)
  - `src/renderer/src/phone3d/{Phone3DPanel,TransitionLane,EasingCurve,ShotGallery}.tsx` and `phone3d.css`
  - `src/renderer/src/components/ExportPanel.tsx` (Resolution for preset layouts, D18)
  - `src/shared/{timelineView,previewPointer}.ts`
  - the `styles.css` and `mobile/mobile.css` grid cleanup
  - tests: `timelineView`, `previewPointer` additions (orbit only when content is topmost)
- **Acceptance:**
  - [ ] Every §4.3 row works by hand, including Style / Keep / Use scene changes, shot Duration and Return to front, Base pose, Focus, Swap Start / End, Reset End to Start, Reset 3D Pose, and the preset Resolution control.
  - [ ] Panel files have no `setProj(`.
  - [ ] Every gesture is one undo step; Auto 3D gives a toast with Undo; a warning's Fix is one step.
  - [ ] An op the CLI would refuse is refused in the editor with a toast and no state change.
  - [ ] Lane drags send absolute `{start,end}`.
  - [ ] Lane snapping works.
  - [ ] Agent edits reload live within about 1 s.
  - [ ] The paused frame is full quality.
  - [ ] Light, dark and reduced motion are checked in screenshots of the real app (/tmp).
  - [ ] The App Store hint shows.

### WP6: Docs, skill, review and equal test (starts day 1, signs off last)
- **Owns:** `R/AGENTS.md`, `R/docs/{ARCHITECTURE,EQUAL_TEST}.md`, `R/skills/openscreen/SKILL.md`, `scripts/{install-skill,review3d,bench3d}.mjs`, `test/golden/3d/*` (commits the PNGs WP4b generates), and all of `test/opsParity.test.ts` (WP2 sends its source-parse cases).
- **Acceptance:**
  - [ ] Parity test is green, including the new op fields.
  - [ ] The skill installs into both homes. Run from a cwd outside the repo (for example `/tmp`), "use openscreen, make this world class" finds the CLI through the skill's real path, builds dist/ when `ops` lacks `direct`/`frames`/`phone3d`, picks the bundle (pasted path, else `latest`), and runs the full loop on a fixture.
  - [ ] The review page has blinded pairs and meets the 60% bar.
  - [ ] Bench numbers are recorded.
  - [ ] The equal test is run, with every gap closed.

**Order:** WP0 + WP1 → WP2, WP3, WP4a, WP4b in parallel → WP5, with WP6 running throughout. Integration order: WP0, WP1, WP2, WP4a, WP3 (Editor change 1), WP4b (Editor change 2), WP5, then the WP6 gates. Golden PNGs: WP4a sign-off → WP4b renders → WP6 commits → they gate later changes.

**Owner sign-off items:**
1. `phone3d.transitions` instead of top-level `transitions` (D2).
2. No HDRI in v1 (D13).
3. The provisional depth and plateau numbers, which must be verified before merge.
4. `exportPreset: 'uhd4k'` now also scales preset layouts (D18). An existing project that has a layout preset AND a hidden `uhd4k` value (set earlier in the Classic layout; the control was hidden for presets) will export at 4K instead of the preset's 1080-class size. Pixels are otherwise the same layout. The alternative is a new field, which is more complex; this spec recommends reusing `uhd4k`.
5. `focus` is an 8th pose channel with range 0..2 (depth-of-field strength over time). `dof.amount` stays the base strength.

## Rejected critique

No gap was rejected outright: each one was checked against the code (or three r186's source) and held. These were adopted with a change, and the reason is given:
- **`shared/canvasLayers.ts` goes to WP1, not WP5.** The critique asked for WP5. But WP4b's compositor writes `LayerBox.hull` and merges before WP5, so the type and the hull hit-test must exist first. WP1 already blocks every package and owns the pure shared math, so it is the only owner that keeps the order valid.
- **`focus` range is 0..2, not 0..1.** With 0..1 and default 1, a pose could only reduce blur below the setting, so "spin-in starts soft" would be impossible. 0..2 keeps 1 = the setting and allows both a softer start and a sharp end.
- **Jitter does not apply to the screen while the phone is still.** The AA critique (jitter every sample) and the sharpness critique (exact texels at FRONT) conflict: sub-pixel jitter is a box filter that softens UI text. The screen attachment uses only the unjittered sample when the phone is still; the lit parts get all the jittered samples. Dither likewise skips the screen pixels.
- **MRT and tiling together.** The two-attachment MSAA target doubles colour memory. To keep the 4K budget the tiling threshold is set from 80 B/px (not the critique's 32 B/px) and tiles are at most 1.5 Mpx.
- **Tone-mapping functions are not "already in every shader".** The critique said `NeutralToneMapping` and `toneMappingExposure` come with every built-in fragment shader. In r186 the prefix adds `tonemapping_pars_fragment` only when tone mapping is active for that draw (WebGLProgram.js:775), and with `NoToneMapping` and render targets it never is. The output pass includes the chunk explicitly; the renderer still feeds its `toneMappingExposure` uniform. Still no copied Khronos GLSL.
- **Polygon offset under reversed depth.** The critique's `polygonOffsetUnits:-4` is wrong when the reversed depth buffer is active: r186 negates only the factor (WebGLState.js:871). The spec flips the units sign in that case and tests both ways.
- **The two 4K-scale critiques and the two LayerBox critiques** were the same gaps reported twice; each is fixed once (D18, D20).

## Owner decisions (made by the advisor on 2026-10-24 under Tyler's "I want it done"; Tyler can reverse any)
1. D2 accepted: moves live at `phone3d.transitions`.
2. D13 accepted: no HDRI in v1. If the look judges say procedural lighting loses, a CC0 Poly Haven studio HDRI is the fallback.
3. Depth and plateau numbers: WP1 fills `devices3d.ts` from Apple's official tech-spec pages (apple.com/iphone/compare and support.apple.com tech specs), with the URL per row. Values from memory are not allowed to merge.
4. D18 accepted (reuse `uhd4k` for preset layouts). Flagged to Tyler: an old project with a hidden `uhd4k` and a layout preset will export at 4K.
5. `focus` as an 8th pose channel (0..2) accepted.
6. Shadow follows D14 (matches the 2D DEFAULT_FRAME_SHADOW): wall 1 mm behind the rearmost hull point, ROI padded by blur + CoC + 2. This overrides the §2.3/§3.7 shadow numbers. The 4K GPU budget is 340 MB (440 MB at ss 2); keep the double buffer and the 3-sigma blur.
7. Key-light elevation (hard shadow about 15% of body height below the phone vs the 2D 4%) is a LOOK decision for the look-check stage: judges compare renders; WP4b keeps the light elevation a single constant so it is a one-line change.
8. (after WF2) §4.2 4K-downscale check: the 40 dB gate applies to the picture OUTSIDE text boxes (captions, titles, annotations, keycaps), measured with a mask from the compositor's own text rects. Inside text boxes the gate is layout: each text box's position and size match within 1 px at 1080 scale. Do not touch letterSpacing or font rendering to pass it.
9. (after WF2) The preview hold during export/frames applies to 3D projects only. Flat projects keep today's behaviour exactly (flat identity proves it is safe). §5.5 wording follows this.
10. (after WF2) Performance budgets are ours and quality wins over speed: 4K moving p95 ≤ 200 ms over all frames (adaptive-N frames still reported separately, max ≤ 400 ms). GPU memory is the MEASURED process GPU footprint (not the engine's own count, MiB vs MB stated): ≤ 400 MiB at 4K defaults, ≤ 560 MiB at 4K ss 2, median of 3 runs. M1 8 GB not available: state "not measured on 8 GB" in the bench output.
11. (after WF2) Screen texture: always clamp to min(GPU MAX_TEXTURE_SIZE, MAX_SCREEN_TEXTURE). At ss ≥ 2 an oblique screen may use up to the density it needs (up to about 1.54x FRONT); remove the wrong-reason cap and comment.
12. (after WF2) Auto 3D (`direct`) must always give a visible 3D result on any iPhone take ≥ 3 s, including short clips dense with taps: if a full intro does not fit before the first tap, plan a shorter intro (≥ 0.6 s) or start from a posed base pose that faces front by the first tap. 0 shots with no reason given is a bug.
13. (WF3) wp3b MAY make one additive, read-only change in compositor.ts: a public `textBoxes: {kind:'caption'|'keycap'|'annotation'|'title', rect}[]` filled during render(), no change to any draw call (compositorGolden log must stay identical). wp3b may also fold exportRender3d/render3dFor into one shared function in a new shared/renderer file and change both call sites minimally. Everything else in compositor.ts belongs to the LOOK track; the integrator resolves overlaps keeping both intents.
14. (WF3, 4K-downscale gate, device-frame ring) Neither A nor C. The half-pixel overlaps in mobile/deviceFrame.ts are correct per output pixel at every size (content anti-aliasing is also one output pixel wide at 4K), so do NOT change deviceFrame.ts and do NOT change any existing render. Rule: exclude from the PSNR mask only a band of 1.5 px (at 1080 scale) centred on the screen-hole edge and on the outer body edge, and ADD a geometric layout check that the frame body rect and the screen rect (from the compositor's contentRect / screenMap) match within 1 px at 1080 scale. Prove the gate still fails on a real frame change (e.g. move the frame 2 px, or change the bezel width) in a test. Everything else stays at 40 dB.
15. (after WF3, look) The procedural-only lighting lost on metal and glass (judges, 4 rounds: back reads as painted plastic, glass as a grey veil). Per decision 2's fallback, ship ONE CC0 Poly Haven studio HDRI (license verified 2026-10-25: polyhaven.com/license, CC0, redistribution in products allowed) as the reflection environment, at most 2k, stored in the repo with a LICENSE/SOURCE note; keep the RectAreaLight hero boxes for crisp highlights. Pick the HDRI by rendering 3 candidates (e.g. studio_small_09, photo_studio_loft_hall, studio_kontrast_04) and judging. Also fix: the front glass sheen must be Fresnel (angle-dependent), never a uniform veil; the Dynamic Island and screen blacks must stay true black at FRONT; the back panel and plateau must read as real machined aluminium and glass (structured reflections, correct Apple finish colours from apple.com); flash and LiDAR are glass-covered, not flat discs; lens reflections come from the HDRI at high enough resolution (no blocky glyphs); the screen gets the same motion blur as the body (physically correct). Still no Apple logo.
16. (after WF3, budgets) Decision 10's speed numbers were ours and quality wins. New budgets (median of 3, measured process GPU footprint): preview p95 ≤ 8 ms (60 fps holds); export 1080 moving p95 ≤ 120 ms; export 4K moving p95 ≤ 800 ms, adaptive-N max ≤ 1500 ms; 4K still ≤ 80 ms; GPU memory ≤ 400 MiB at 4K ss 1, ≤ 700 MiB at 4K ss 2. FRONT still vs draft within 1 level with glass on (screen bit-exact at glass 0) is accepted.
17. (after WF3, R4) Approved: the title card is laid out at the preset's own 1080-class size and scaled to the canvas (/tmp/openscreen-3d/wf3/wp3b/R4-title-scale.patch); scale = 1 at 1080, so flat identity must still be 7/7.
18. (after WF3, Auto 3D taste) World-class means restraint. direct must cap shot density: at most 1 big move (spin, turn-to-back, layback) per 20 s for bold, per 30 s for clean, never two big moves within 6 s, at most 3 turn-to-backs per video unless explicitly asked; the rest of the time the phone holds a calm pose (float allowed). Long takes (> 90 s) get a note recommending a trim to the best 15-45 s, and the plan focuses moves on scene changes. frames --moves gets a time range (--from/--to) and, when moves exceed the cap, samples evenly instead of refusing, saying so in the output.
19. (after WF3, culprit) Advisor ruling 3 in /tmp/openscreen-3d/wf3/advisor/requests.md stands: an off-canvas run names a move only if that move adds per-edge overflow; else the float or base pose is the culprit. Keep direct.test line 428.
20. (after WF3, zoom in 3D) Reverses the look round-4 change "zooms do not play on the 3D screen". Zoom-to-tap is a core OpenScreen feature and must work in 3D, the world-class way: a zoom segment (autofocus, tap zoom, manual zoom; same focusSegmentsFor source) pushes the 3D CAMERA in toward the zoom centre on the phone's screen (the phone stays whole and keeps its pose; the screen texture stays 1:1 and sharp because the camera gets closer, with the texture resolution following the on-canvas size). Same easing and timing as flat zooms. Shots and zooms combine: during a zoom the pose may not leave front by more than the steep-angle limit (warning + direct respects it). Flat projects unchanged. Ops/editor: the existing zoom controls drive it (no new control); info/validate report it; AGENTS.md says so.
21. (WF4, decision 20 split) The PLAN track owns all of it in shared code: add the `zoom-angle` warning (facing < cos 35° inside any focusSegmentsFor zoom span inStart..outEnd, sampled at 1/30 s; fix = move the End before the zoom, or setPose turn/tilt 0 at the zoom), make direct treat zoom spans as angle ≤ 35° constraints (not busy), AND remove the obsolete `zoom-3d` warning and the agentOps "zooms do not play on the 3D screen" note, with their tests updated to decision 20. LOOK2 owns only the renderer push-in. UIDOCS updates the docs to match.
22. (WF4) `info.zooms: [{start, focus, end, source: 'auto'|'tap'|'manual', x, y}]` in OUTPUT seconds from focusSegmentsFor (inStart, hold start, outEnd) is required by decision 20 so agents can keep shots off zooms. Owner: the PLAN track (src/node/agentCli.ts). If wp/plan lands without it, the INTEGRATOR adds it from the uidocs request in /tmp/openscreen-3d/wf4/uidocs/requests.md, with a test. UIDOCS documents it.
