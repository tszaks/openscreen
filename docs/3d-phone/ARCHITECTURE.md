# 3D phone: architecture

How the 3D phone mockup is built, where each part lives, and the rules that
keep it safe. The design and its reasons are in [SPEC.md](SPEC.md) (its
"Owner decisions" at the end override older text). How an agent drives it is
in [AGENTS.md](../../AGENTS.md#3d-phone-iphone-and-ipad-takes). Paths below are
relative to `electron/src/`.

## The one rule: flat stays flat

All 3D state is one optional key, `project.phone3d`. A project without it
renders, exports and normalizes exactly as it did before the feature existed:

- `normalizeProject` adds no key; `defaultProject` has none, so Reset drops 3D.
- three.js is loaded only when a project's 3D phone is **active**
  (`renderer/src/phone3d/loader.ts`, a dynamic import Vite splits into its own
  chunk).
- When 3D is not active, every line of the compositor's old path runs
  unchanged.

Three gates prove it on every merge: `test/compositorGolden.test.ts` (the 2D
canvas call log of 7 fixtures equals the log captured from `main` before any
compositor change), `test/phone3dCompat.test.ts` (normalize, `applyOps(old,
[])` and the remap are byte-equal), and `scripts/golden/flatIdentity.mjs`
(the 7 fixtures exported by `main` and by this branch are identical frame by
frame, `ffmpeg -f framemd5`).

## Layers

```
shared/phone3d/   pure math and data: no DOM, no three, no clock, no randomness
  model.ts        Phone3D, Pose, defaults, ranges, normalizePhone3D
  validate.ts     structural errors (validateProject calls it)
  easing3d.ts     the 7 easings; closed-form spring fitted to the move length
  pose.ts         poseAt / poseAtWithFloat, linked starts, poseTargetAt, poseDelta
  placement.ts    phoneHome (the flat frame's place) and phone3dActive (the gate)
  projection.ts   camera, projection, homography, hulls, shadow, render ROI, depth range
  outline.ts      the continuous-corner table (shared with the 2D frame)
  lighting.ts     the 5 light presets as data
  orbit.ts        drag-to-orbit: screen points → pose (absolute)
  shots.ts        shot recipes as data, expandShot
  ops.ts          the 3D edit ops (applyPhone3dOp), PHONE3D_OP_FIELDS
  direct.ts       Auto 3D planner (planDirect)
  warnings.ts     projectWarnings, each fix verified
shared/devices3d.ts   depth, edge, back and camera plateau per model (Apple sources per row)
shared/focusSegments.ts  every zoom the editor plays (one list for editor, CLI, planner)
shared/remap.ts       remapTransitions: moves follow cuts by their End
shared/agentOps.ts    op dispatch, `direct`, applyOps3d, ApplyContext.cursor/scenes

renderer/src/phone3d/   the only folder that imports three
  loader.ts       ensurePhone3d / engineSync / onEngineReady (lazy chunk)
  engine.ts       ONE WebGLRenderer per process, caches, context loss, stats
  geometry.ts     the procedural phone in mm (band sweep, creases, plateau, lenses)
  materials.ts    MeshPhysicalMaterial per part, the MRT output patch, band F0
  environment.ts  RectAreaLight softboxes + a PMREM fill (no HDRI)
  screenTexture.ts  the recording drawn 1:1 into the screen texture
  shadow.ts       silhouette on the catcher plane, two blur widths
  passes.ts       HDR MSAA target, accumulation, DoF, output pass, tiling
  view.ts         renderPhone3D: the one call the compositor makes

renderer/src/compositor.ts       draws the 3D phone in the `content` layer slot
renderer/src/headlessFrames.ts   the renderer half of `frames`
node/scenes.ts      scene changes (ffmpeg), cached in <bundle>/analysis/scenes.json
node/framesCmd.ts   the `frames` command
node/phone3dPlan.ts the CLI's one import point for the planner and warnings
node/agentCli.ts    `direct`, `frames`, warnings in info / validate / apply
```

The editor UI (the 3D tab, the 3D lane, drag-to-orbit, `apply3d`) is spec §5;
it sends the same ops through `applyOps3d` (below).

## Data model

`Phone3D` = `enabled`, the base `pose`, `camera`, `light`, `glass`, `back`,
`shadow`, `dof`, `float`, `motionBlur`, `supersample`, and `transitions` (the
moves). Model and finish are not stored: the 3D phone reads the Device tab's
model and finish (`resolveDevice`, `getFinish`), so there is one source.

- A **pose** has 8 channels: `turn`, `tilt`, `rotate` (degrees; Euler
  `ZXY`), `size`, `x`, `y`, `light`, `focus`. + tilt leans the top away.
- A **move** is `{id, start, end, from?, to, easing, recipe?}` in output
  seconds. Without `from` its Start is linked: it continues from where the
  phone is. Moves are kept sorted by `(start, id)`.
- `normalizePhone3D` rebuilds any JSON in declared key order from the
  defaults, clamps numbers, drops broken moves, and is idempotent
  (`N(N(x)) = N(x)`), so the editor's live reload cannot loop.
- **Errors vs warnings**: `validate.ts` reports structural problems only
  (ranges, enums, ids, a move under 0.1 s). Everything that depends on
  timing, angles or the canvas (overlap, past the end, a tap seen at an
  angle, off canvas, inactive) is a warning, so a trim can never lock a
  project.

## Time

Moves live in **output** seconds, like manual zooms. When clips change,
`remapProject` moves each one by the moment it lands on (its End), keeping its
length, so it still lands before the tap it serves. `poseAt(p3, t)` is the
core: the base pose with no moves, the first move's Start before it, else the
last move started at or before `t`, eased. `poseAtWithFloat` adds the idle
drift, a pure function of `t`. Everything outside `pose.ts` calls
`poseAtWithFloat`, so the preview, `frames`, the export, the warnings and the
planner agree on where the phone is.

## One gate

`phone3dActive(p)` (placement.ts) decides if 3D draws: enabled, an iPhone or
iPad take, device frame on, no Mac + iPhone phone layer, and no layout preset
or a framed one. The compositor, the warnings, `info` and the editor all call
it. App Store presets are full-bleed, so they stay flat by construction.

## One write path

Every 3D change goes through the shared ops (`applyPhone3dOp` in ops.ts, plus
`direct` in agentOps.ts):

- The CLI runs them with `applyOps` (all-or-nothing, then `validateProject`).
- The editor's `apply3d` runs `applyOps3d`, which refuses exactly what
  `applyOps` refuses, so the editor can never store a project the CLI would
  refuse. A list (a warning's fix, Reset 3D Pose) is one undo step.
- The ops refuse unknown fields and out-of-range values; they never clamp.
- The planner (`direct.ts`) and the warning fixes (`warnings.ts`) check
  their output by applying these same ops to a copy.

`test/opsParity.test.ts` holds this together: every op is in AGENTS.md,
every field an editor control sends is accepted and documented, the numbers
in AGENTS.md match the code, and once the editor UI lands, no 3D control may
call `setProj` directly.

## Auto 3D

`planDirect(p, {style, replace, scenes, cursor})` finds busy time (taps,
typing runs, every zoom from `focusSegmentsFor`), keeps the phone within 12°
of front during it, and places recipes (`shots.ts`) in the free windows:
intro, outro, middle shots, a turn passing edge-on at a scene change. It
returns ops (`phone3d`, `clearTransitions`, one `shot` each), applies them to
a copy, drops any shot that causes a warning, and re-plans (up to 4 rounds).
The editor and the CLI pass the same inputs (the bundle's `cursor.json` and
the shared scene cache), so they make the same plan.

## Rendering

The compositor keeps its placement math unchanged (`contentRect` stays the
flat home body), and in the `content` layer slot draws the engine's output
instead of the flat recording and frame. The camera bubble, text, title and
captions stay flat on top.

Per output frame (`view.ts`):

1. **ROI**: the body hull plus its shadow over the motion-blur sub-frame
   times, padded for depth of field, snapped out to whole pixels. Only that
   area renders, so 4K costs the phone's area, not the canvas.
2. **Sample plan** from the pose only: N = max(motion samples, 8 jittered
   anti-aliasing samples) in export and `frames`; 1 in the live preview and
   `--draft`. Motion samples grow with how far the hull travels, so fast
   turns streak instead of ghosting.
3. **Screen texture**: the compositor draws the recording (crop, zoom, taps,
   cursor, ripples, island) into an offscreen canvas at one texel per render
   pixel; at FRONT the 3D screen is the flat screen.
4. **Shadow**: the silhouette is cast onto the catcher (a wall 1 mm behind the
   phone, or a floor), blurred with the 2D frame shadow's two widths.
5. **Scene** into a 2-attachment half-float MSAA target: attachment 0 holds
   lit surfaces in HDR, attachment 1 holds only the screen. Samples
   accumulate; depth of field gathers both.
6. **Output pass**: tone map the lit part only (`NeutralToneMapping`), add
   the screen untouched, unpremultiply, encode sRGB, dither the lit part,
   premultiply. Big ROIs render in tiles to stay inside the GPU memory budget.

Colour: highlights stay HDR through blur and AA and are tone mapped once at
the end, so a moving band highlight streaks bright instead of smearing grey;
the screen never passes through the tone map, so it stays exact.

## Determinism and failure

- Pose, light and every sample pattern are functions of output time and
  fixed tables; `test/phone3dPurity.test.ts` fails on any clock or random
  call in the 3D folders. The same frame renders the same bytes in any seek
  order, and `frames` at `t` equals export frame `round(t·fps)`.
- One WebGL context per process. A lost context in the preview draws flat
  with one notice and recovers; in export and `frames` it waits up to 3 s for
  a restore, else the job fails with "3D renderer lost the GPU" (a flat file
  is never written silently).
- Export and `frames` wait for the engine before frame 0; while they run, the
  editor's preview of a 3D project does not draw.

## Tools around it

| Script (in `electron/scripts/`) | What it is for |
|---|---|
| `golden/makeFixtures.mjs`, `golden/flatIdentity.mjs` | the flat-identity gate |
| `phone3d-turntable.mjs` | look development: turntable stills of models and finishes |
| `review3d.mjs <bundle>` | the review page: flat vs 3D, every recipe, the Auto 3D plan over the taps, warnings, timings, blinded A/B pairs against reference captures, the rubric and its tally |
| `bench3d.mjs <bundle>` | the performance budgets (SPEC §6.5, owner decision 10) through the real app |
| `install-skill.mjs` | links `skills/openscreen` into `~/.claude/skills` and `~/.codex/skills` (run by a person, never by a build or a test) |

How `review3d.mjs` keeps the A/B pairs blind: ours is rendered again for each
pair on the 3D layout preset whose shape is nearest the reference's (square,
4:5, 9:16 or 16:9), at export quality; then both sides are re-encoded by the
same ffmpeg to one container (PNG for stills, H.264 mp4 for clips, no sound,
no metadata), one size (1080 px wide) and one shape (centre-cropped when the
shapes differ by 12% or less, else padded, which `pairShapes[].leak` and a
stderr warning report). A clip is never paired with a still. File names are
`pair-NN-L` / `pair-NN-R`. What it cannot equalise is the content: a
reference must be a clean render of a phone (an export), not a screenshot of
another app's editor, or judges see the difference at once.

Recipe takes on the review page use a tap-free source window (every tap with
its length, read from `project.json`), played at normal speed. The window
stays inside one kept stretch of source between cuts (`keptRuns` in
`review3d.mjs`): `trim` keeps the take's cuts, so a window across a cut would
give a shorter take. A wait inside a cut does not count. A take that comes out
shorter than asked, or no stretch long enough, is a failure on the page.

The judged half of the equal test is [EQUAL_TEST.md](../EQUAL_TEST.md).
