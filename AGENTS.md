# Driving OpenScreen from an agent

OpenScreen can be run entirely by an agent: record an iPhone, watch the
recording, edit it, export it, and check the result. Everything goes through
one command-line entry point that prints **one JSON object on stdout** per
command, reports errors as `{"ok":false,"error":"…"}`, and exits `0` (ok),
`1` (failed) or `2` (bad usage). Progress, when a command has any, goes to
**stderr** as JSON lines. Nothing ever prompts.

```
node <checkout>/electron/scripts/openscreen-agent.mjs <command> …
```

Use the absolute path to `electron/scripts/openscreen-agent.mjs` in your
checkout. It works from any working
directory. It needs a build first: `cd electron && npm run build` (creates
`electron/dist/`, which the script loads). `npm run agent -- <command>` from
`electron/` does the same thing.

`<bundle>` is a recording folder (`…/rec-<ts>.openscreen`), or the word
`latest`.

## The loop

`osa` below is a shell function for the CLI. A function works in zsh (the
macOS shell) and bash; a variable holding `node …` does not work in zsh, which
runs it as one program name. Each agent tool call is a new shell, so define
`osa` (and any bundle path) in the same call as the commands, or write
`node /abs/path/electron/scripts/openscreen-agent.mjs` out in full.

```sh
osa() { node /abs/path/electron/scripts/openscreen-agent.mjs "$@"; }

osa devices                         # is a phone plugged in?
osa record start                    # optional: record the phone yourself…
osa record status
osa record stop                     # …writes project.json; bundle path in the output
osa latest                          # or take the newest recording made in the app
osa import ~/Desktop/demo.mov       # or start from a video you already have

osa review latest                   # contact sheets + review.json — LOOK at the sheet PNGs
osa info latest                     # clips, captions, taps, style, … (times, ids, indexes)
osa polish latest --style clean --title "Headline" --subtitle "Sub"
osa direct latest --style hero      # iPhone takes: a few 3D shots around the taps and zooms (see "3D phone")
osa apply latest edits.json         # precise edits (see below)
osa frames latest --moves --sheet   # still PNGs from the real renderer — LOOK at sheet.png
osa validate latest                 # problems (must be 0) and warnings (aim for 0)
osa export latest --out /abs/out.mp4 # renders with the real app, headless
osa review /abs/out.mp4             # watch your own output and iterate
osa undo latest                     # swap project.json <-> project.json.bak
```

### Commands

| Command | What it does |
|---|---|
| `devices [--wait ms]` | Connected iPhones/iPads, via the app's `ios-capture` helper. Empty list + `hint` when none. |
| `record start [--device id\|name]` | Starts a wired iPhone screen recording into a new `rec-<ts>.openscreen` in the recordings folder, detached. Waits for the first frame. Fails clearly when no phone is connected or it is locked. |
| `record status` | `idle`, `recording` (with `elapsed`), `finished`, `failed`, or `dead`. |
| `record stop` | Finishes the take (the helper's normal finalize; the movie is fragmented, so even a crash keeps what was recorded), then writes `project.json` with the same defaults the app gives an iPhone take. |
| `import <file> [--name N]` | Imports a video (mp4, mov, m4v, webm, mkv) as a new bundle `<name>.openscreen` in the recordings folder, named after the file (`Name 2`, `Name 3`… when taken), exactly as **File → Import Video…** and dropping a file on the app do. The original is only read. A file the editor can't play is converted with the bundled ffmpeg (`converted`: `none`, `audio` = the sound re-encoded to AAC, or `full` = H.264 + AAC). An iPhone or iPad screen size (e.g. 1179×2556, 1206×2622) gets `sourceKind: "iosDevice"`, so the device frame, 9:16 canvas and tap analysis apply; anything else is `display`. Prints `bundle`, `name`, `sourceKind`, `size`, `duration`, `video`, `converted`, `hasAudio`; progress (`{"stage":"copy"\|"convert","progress":0..1}`) on stderr. A failed import leaves nothing behind. |
| `latest` / `list` | Newest bundle / all bundles in `~/Movies/OpenScreen` (or `$OPENSCREEN_RECORDINGS_DIR`). In the app, **File → Copy Path for Agent** copies the open project's path. |
| `info <bundle>` | Summary JSON: source size/duration, output duration, canvas, device, clips (with ids, source and output ranges), captions, transcript, chapters, annotations, manual zooms, `zooms` (every zoom that plays: tap, auto-focus and manual, with output `start`, `focus` (the camera is at the zoom), `end`, `source` `auto`\|`tap`\|`manual`, and centre `x`/`y`; `[]` on App Store layouts), taps, waits, style, layout, camera, `phone` (Mac + iPhone takes: the phone movie, its size, length, `offset`, detected `model`, whether it is `drawn`, and every `phoneOverlay` field; `null` otherwise), audio, `content` (the recording's hand move and resize, `style.contentTransform`, or `null`), `layers` (the canvas layers bottom to top), tracks (music and voiceover items with their output `start`/`end`, file range, volume, fades, loop, and `missing` when the file is gone), `export` (`preset`; `fps`, the frame rate the export writes: a layout preset's own, else `outputFPS`; and `canvas: {w,h}`, the size the export writes), `phone3d` (`null`, or every 3D setting plus `active`, the `reason` when it renders flat, and the `model` and `finish` it draws), `transitions` (the 3D moves: `index`, `id`, output `start`/`end`, `duration`, `linked`, `from` = the resolved Start, `to`, `easing`, `recipe`), `shotRecipes` (name, default `duration`, `summary`, `use`), `problems`, `warnings`. |
| `validate <bundle>` | `{"ok":true,"problems":[],"warnings":[]}`. Exit 1 only when there are `problems` (the project is broken; `apply` and `export` refuse it). `warnings` never fail: they are 3D quality issues, each with a `fix` when one exists (see "3D phone"). |
| `review <bundle\|video> [--every 2s] [--out dir] [--max-sheets 10] [--transcribe] [--no-taps]` | Writes `review/` in the bundle (or `<video>.review/`): `sheet-NN.png` contact sheets (timestamped tiles, 6×2 for portrait, 4×3 for landscape; interval grows so there are at most ~10 sheets), up to 12 `scene-NNN.jpg` keyframes from scene detection, and `review.json` (duration, orientation, device, stills from freezedetect, silences from silencedetect, taps and waits from the editor's own tap analysis, the transcript, every image path with its timestamps). Works on an exported mp4 too. |
| `apply <bundle> <edits.json\|-\|'[…]'> [--dry-run]` | Applies edit ops in order. All-or-nothing: if any op fails or the result doesn't validate, nothing is written. Writes `project.json.bak` first. |
| `polish <bundle> [--style clean\|bold] [--title T] [--subtitle S] [--reanalyze] [--dry-run]` | One-shot good defaults (see below). Deterministic; prints the ops it applied. |
| `direct <bundle> [--style subtle\|hero\|bold] [--keep] [--no-scenes] [--dry-run]` | iPhone takes: plans 3D phone shots around the taps, waits and scene changes (zooms are not busy time, but a `spin-in` or `turn-to-back` never runs during one) and applies them (the editor's **Auto 3D**; same plan for the same project). Runs tap analysis first when the take has none, and scene detection unless `--no-scenes` (cached in `analysis/scenes.json`). `--keep` keeps the existing 3D moves and plans around them. Prints `shots` (`recipe`, output `start`/`end`, `reason`), `note` when the style's own moves do not fit (why, and what the phone does instead) or the take is over 90 s (trim it to its best 15-45 s), the `ops` it applied, `changes`, `warnings` (0 on a fresh plan), `outputDuration`, `backup`. |
| `frames <bundle> (--at 0.5,2,4.25 \| --every 0.5 \| --moves) [--from s] [--to s] [--out dir] [--scale 0.5] [--sheet] [--draft] [--debug] [--timeout s] [--app …]` | Still PNGs at **output** seconds, drawn by the real app headless with the export's own code, so each PNG is the export frame `round(t·fps)`. `--moves` = the start, middle and end of every 3D move plus every tap. `--from`/`--to` (output s) limit `--moves` and `--every` to a time range. At most 200 stills: `--moves` with more samples them evenly and says so in `note`. `--debug` adds each still's `textBoxes` and `deviceFrame` (layout checks; large). Default quality is the export's (3D anti-aliasing and motion blur); `--draft` is one 3D sample, about 3× faster. `--sheet` adds `sheet.png`, a labelled grid. Default folder: `<tmp>/openscreen-frames/<bundle>-<stamp>/` (never the bundle). Prints `out`, `size`, `fps`, `phone3d`, `files` (`t`, `frame`, `at`, `path`, and with 3D the drawn `pose` and `facing`: 1 = screen straight at the camera, below 0 = its back), `sheet`, `seconds`, `gpu`. A time at or past the end gives `{t, error:"past the end"}`. Refuses an invalid project, like `export`. |
| `undo <bundle>` | Swaps `project.json` and `project.json.bak` (so a second undo redoes). One level. |
| `export <bundle> [--out f.mp4\|f.gif\|folder] [--gif] [--preset id[,id…]] [--app /path/OpenScreen.app] [--timeout s] [--force]` | Renders through the real app with no window and no dialogs, then probes the file (`probe`: `file`, `duration`, `width`, `height`, `fps`, `codec`, `hasAudio`, `bytes`). `--preset` writes every listed export preset into a folder. Without `--app` it uses `$OPENSCREEN_APP`, else this checkout's Electron (`electron/`). Refuses an invalid project. A 3D project with a `tap-angle` or `tap-back` warning (a tap the viewer cannot read) is refused (exit 1, the warnings and their `fix` in the output) until it is fixed or `--force` is given; other 3D warnings go to stderr as `{"warning":…}` lines and never block. A 3D project that loses the GPU mid-export fails with "3D renderer lost the GPU"; it never writes a flat file instead. |
| `open <bundle> [--app …]` | Opens the project in the editor for a human (`OpenScreen --open <bundle>`). Later `apply`s show up live. |
| `ops` | Every op name. |

### Time domains (important)

- **Source seconds** — the raw recording: `trim`, `cut`, `speed`, clip
  `sourceStart/sourceEnd`, taps, waits, and every time in `review.json` of a
  bundle.
- **Output seconds** — the edited timeline: captions, chapters, annotations,
  manual zooms, `split`, where an audio item `start`s, every 3D time (moves,
  `setPose {at}`, `shot {at}`, warning `at`/`end`) and every `frames` time.
  `info` shows each clip's `outputStart/outputEnd` so
  you can convert. After a `trim` or `cut`, output-time items move with their
  footage automatically (the editor's own remap). A 3D move follows the
  moment it **lands on** (its End) and keeps its length, so it still lands
  before the tap it was made for. When the footage under its End is cut
  away it ends where its Start's footage went; when both are cut away the
  move is removed.

Put timeline edits (trim/cut/speed) **before** caption/zoom ops in the same
file, and write caption/zoom times against the timeline *after* the cuts.

Audio items (music, voiceover) are different: they stay where they are in
output time when clips are cut or sped up, the way music on its own track
does, and always play at normal speed. Their `sourceIn`/`sourceOut` are
seconds into the sound file itself.

### edits.json

A JSON array of ops (or `{"ops":[…]}`). Items are picked by `id` or 0-based
`index` (both shown by `info`).

```json
[
  {"op": "trim", "start": 1.0, "end": 60},
  {"op": "cut", "ranges": [{"start": 20, "end": 24}]},
  {"op": "speed", "start": 30, "end": 40, "speed": 3},
  {"op": "addZoom", "at": 3, "x": 0.5, "y": 0.12, "scale": 1.8, "hold": 1.5},
  {"op": "addCaption", "start": 0.2, "end": 3, "text": "Your verse, right on the home screen"},
  {"op": "addChapter", "start": 0, "title": "Intro"},
  {"op": "addAnnotation", "start": 5, "end": 8, "text": "Tap here", "band": 2, "hex": "#ffffff"},
  {"op": "background", "swatch": "ocean"},
  {"op": "addAudio", "file": "music/theme.mp3", "start": 0, "fadeIn": 1, "fadeOut": 2, "volume": 0.6},
  {"op": "audioTrack", "duck": true},
  {"op": "set", "path": "/style/cornerRadius", "value": 32}
]
```

`addAudio` copies the file (mp3, m4a, aac, wav, aiff; a relative path is
read from the edits file's folder) into the bundle's `audio/` folder, so the
project keeps working when the original moves. It goes on the first audio
track, which is created when there is none.

`x`/`y` are normalized (0..1) positions on the recording, `0,0` top-left.

Background swatch names (the Background tab's tiles, defined in
`electron/src/shared/backdrops.ts`): soft `aurora sunset peach lilac sage dusk`,
dark `mono ocean midnight graphite nebula deep-sea forest ember slate`, light
`studio paper cloud mist blush`, vivid `electric citrus lagoon bloom`.

### Parity with the editor

Every editing control in the editor (Editor.tsx, mobile/DevicePanel,
LayoutSection, TapsLane, ExportPanel, and the 3D tab and lane in
phone3d/Phone3DPanel and phone3d/TransitionLane) and the op that does the
same thing. Every 3D control in the editor sends exactly these ops through the
same code (`applyOps3d`), so the editor refuses what the CLI refuses:

| Editor control | Project field(s) | Op |
|---|---|---|
| Split at playhead (S) | `clips` | `split {at}` (output s) |
| Trim clip start/end to playhead | `clips[i].sourceStart/End` | `trimClip {index\|id, sourceStart?, sourceEnd?}`; whole-recording: `trim {start,end}` |
| Drag to reorder clips | `clips` order | `reorder {from,to}` |
| Delete clip | `clips` | `deleteClip {index\|id}` |
| Clip speed | `clips[i].speed` | `clipSpeed {index\|id, speed}`; a source range: `speed {start,end,speed}`; raw list: `setClips` |
| Option-click timeline: manual zoom | `manualZooms[]` (center, scale, timings) | `addZoom {at, x, y, scale?, hold?}` |
| Move / retarget / rescale a zoom | `manualZooms[i]` | `moveZoom {index, at?, x?, y?, scale?, hold?}` |
| Right-click zoom: remove | `manualZooms` | `removeZoom {index}`, `clearZooms` |
| Zoom tab: Auto-focus, Dwell, Zoom to taps, Zoom depth (with the 3D phone on: the camera push-in) | `zoom.autofocus/dwell/fromTaps/depth` | `zoomSettings {…}` |
| Cursor tab: show, opacity, size, trail, colour | `style.cursorShow/cursorOpacity/cursorSize/cursorTrail/cursorHex` | `cursor {show?, opacity? (0..1), size?, trail?, hex?}` |
| Audio tab: click sounds, voice cleanup | `audio.clickSounds/voiceCleanup` | `audio {clickSounds?, voiceCleanup?}` |
| Add Music or Voiceover… (Audio tab, timeline right-click) | `tracks[t].items` | `addAudio {file, start?, volume?, fadeIn?, fadeOut?, loop?, sourceIn?, sourceOut?, fit?, name?}` |
| Music lane: drag a block | `items[i].start` (output s) | `moveAudio {index\|id, start, track?}` |
| Music lane: drag a block's edges | `items[i].sourceIn/sourceOut` (file s) | `trimAudio {index\|id, sourceIn?, sourceOut?, track?}` (start stays; the editor's left-edge drag also moves `start` by the same amount) |
| Audio tab: item volume, fade in, fade out, Loop to fill | `items[i].gain/fadeIn/fadeOut/loop` | `editAudio {index\|id, volume?, fadeIn?, fadeOut?, loop?, name?}` |
| Right-click a block: Fit to Video | `items[i]` | `fitAudio {index\|id}` (starts at 0; a longer file is cut at the end, a shorter one loops) |
| Right-click a block: Remove (or ⌫) | `items` | `removeAudio {index\|id}` |
| Mute track, Track volume, Lower the recording's sound under music | `tracks[t].muted/volume/duck` | `audioTrack {track?, muted?, volume?, duck?, name?}` (ducking turns the recording down 12 dB while the track plays) |
| Smart cut (silences + fillers) | `clips` | `smartCut {thresholdDb?, minDur?}`; silences only: `cutSilences` (same ffmpeg silencedetect + planner) |
| Transcript: cut a cue | `clips` | `cutCue {index\|id}` |
| Transcript edit mode: cut selected words | `clips` | `cutWords {index\|id, from, to}` |
| Cut filler words | `clips` | `cutFillers` |
| Transcribe | `captions` | `captionsFromTranscript {transcribe?:true}` (needs whisper-cpp) |
| Import SRT/VTT | `captions` | `importCaptions {file\|text}` |
| Edit / remove caption | `captions[i]` | `addCaption`, `editCaption`, `removeCaption`, `clearCaptions`, `setCaptions` |
| Chapters: suggest, rename, remove, clear | `chapters` | `suggestChapters`, `addChapter`, `editChapter`, `removeChapter`, `clearChapters` |
| Text overlays: add, edit text, position band (a quick placement), delete; drag a text on the preview to move it, its corners to resize it; Show (after hiding it) | `annotations` (`transform` = hand move/resize from its band, `hidden`) | `addAnnotation`, `editAnnotation {text?, band?, hex?, start?, end?, x?, y?, scale?, hidden?, reset?}` (`band` or `reset:true` clear the hand move), `removeAnnotation` |
| Camera tab: show, shape (Round/Square), size (Small 0.325 / Large 0.465 / fine 0.1..0.5); drag the bubble on the preview, or its corners to resize it | `cameraOverlay` (`position` = centre as a fraction of the canvas; older projects have only `corner`) | `camera {enabled?, x?, y?, circular?, sizeFraction?, corner?}` (`x`/`y` 0..1 place it freely; `corner` alone puts it back in a corner) |
| Click the recording on the preview: drag it to move, drag a corner to resize (aspect locked; Option: about the centre), double-click to reset; Style tab > Frame > Position & size: Reset | `style.contentTransform` (`x`/`y` = centre as a fraction of the canvas, `scale` = size against where the layout fits it; absent = the layout's place) | `content {x?, y?, scale? (0.1..4)}`; `content {reset:true}` (anything left out keeps its current value; at least 10% of the recording always stays on the canvas; App Store previews ignore it) |
| Phone tab (Mac + iPhone takes): show, layout and corner (quick placements), size, device frame, shadow, phone sound; drag the phone on the preview, or its corners to resize it | `phoneOverlay` (`transform` = hand move/resize from where its layout puts it) | `phone {enabled?, layout?: side-by-side-right\|side-by-side-left\|corner, corner?, size? (0.3..1), frame?, shadow?, sound?, modelId?, finishId?, x?, y?, scale?, reset?}` (`null` resets a model or finish to detected; `layout`, `corner` or `reset:true` clear the hand move; fails on a take with no phone video) |
| Background tab: swatches, image, wallpaper, blur, blurred recording | `style.background`, `layout.background` | `background {swatch\|solid\|gradient\|image(+blur)\|blurred:true}` (wallpaper: pass the image path) |
| Frame: padding, corner radius, shadow, shadow opacity | `style.*` | `style {paddingFraction?, cornerRadius?, shadowRadius?, shadowOpacity?}` |
| Crop | `style.cropRect` | `crop {rect: {x,y,w,h} \| null}` |
| Device tab: frame on/off, model, finish | `device.frame/modelId/finishId` | `device {frame?, modelId?, finishId?}` (`null` resets to detected) |
| Touch indicators: show, style, colour, size | `tapStyle` | `tapStyle {show?, style?, color?, sizePt?}` |
| Taps lane: add, drag/place, delete, re-detect | `taps` | `addTap {t,x,y,kind?}`, `moveTap {index\|id, t?, x?, y?}`, `removeTap`, `clearTaps`, `analyzeTaps` |
| Waits: speed up 3×, cut | `clips` (from `waits`) | `speedUpWaits {speed?, which?}`, `cutWaits {which?}` (`which`: all\|edge\|interior); `setWaits` |
| Canvas (layout preset), title card; drag the title on the preview, or its corners to resize it | `layout.presetId`, `layout.titleCard` (`transform`, `hidden`) | `layout {presetId?, background?}`, `titleCard {title, subtitle, x?, y?, scale?, hidden?, reset?} \| {enabled:false}` |
| Right-click a layer on the preview: Bring to Front, Send to Back, Reset Position & Size, Hide; ⌘] / ⌘[ (⇧: all the way); arrows nudge 1 px (⇧ 10 px); ⌫ hides (never the recording); double-click resets | `layerOrder` (bottom to top; absent = the order they always drew in), each layer's transform, `hidden`/`enabled` | `layer {id: content\|camera\|phone\|title\|text:<annotation id or index>, restack?: front\|back\|forward\|backward, reset?: true, hide?: true}` |
| 3D tab › 3D phone switch | `phone3d.enabled` | `phone3d {enabled}` (the first 3D edit seeds every default) |
| 3D tab menu › Remove 3D | `phone3d` (deleted) | `phone3d {clear:true}` (exactly flat again) |
| 3D tab menu › Clear moves | `phone3d.transitions` | `clearTransitions` |
| Auto 3D button | `phone3d`, `phone3d.transitions` | `direct` op / `direct` command |
| Auto 3D › Style (Subtle / Hero / Bold) | — | `direct {style}` / `--style` |
| Auto 3D › Keep existing moves | — | `direct {replace:false}` / `--keep` |
| Auto 3D › Use scene changes | — | `direct {scenes:false}` (off) / `--no-scenes` |
| Shot gallery tile (click at the playhead); timeline menu "Add 3D Shot ›" | `phone3d.transitions`, `phone3d.float` | `shot {recipe, at}` |
| Shots › Intensity (Subtle 0.6 / Normal 1 / Bold 1.4), Duration, Return to front; Shift-click a tile = mirror | — | `shot {intensity, duration, return:'front'\|'stay', direction:-1}` |
| Pose fields (Turn, Tilt, Rotate, Size, Horizontal, Vertical, Light, Focus); Face Front | the keyframe the playhead edits (see "Which keyframe a pose edit changes") | `setPose {at, turn?, tilt?, rotate?, size?, x?, y?, light?, focus?}`; one end of one move: `setPose {id, end:'from'\|'to', …}` |
| Pose › Editing: Base pose | `phone3d.pose` | `setPose {target:'base', …}` |
| Drag the 3D phone on the preview (Shift: one axis), Option-drag (move), double-click (Face Front), arrow keys (1°, Shift 10°) | same keyframe | `setPose {at, …}` |
| Canvas menu › Reset 3D Pose | `phone3d.pose`, `phone3d.transitions` | `[{"op":"clearTransitions"},{"op":"setPose","target":"base","turn":0,"tilt":0,"rotate":0,"size":1,"x":0,"y":0,"light":0,"focus":1}]` in one `apply` |
| 3D lane Option-click; `T`; menu "Add 3D Move Here" | `phone3d.transitions[]` | `addTransition {start, end?, to, from?, easing?, stiffness?, damping?, bezier?, fitDuration?}` |
| Drag a move block or its Start/End diamonds | `transitions[i].start/end` | `editTransition {id, start, end}` (agents may also shift with `{by}`) |
| Move › Start, End | `transitions[i].start/end` | `editTransition {start?, end?}` |
| Move › Easing (Smooth, Linear, Ease In, Ease Out, Cinematic, Spring, Custom); Spring stiffness/damping; Fit length; Custom curve handles | `transitions[i].easing` | `editTransition {easing, stiffness?, damping?, bezier?, fitDuration?}` |
| Move › Link Start | `transitions[i].from` | `editTransition {from:null}` (linked) / `{from:{…}}` (explicit) |
| Move › Swap Start / End; lane menu "Swap Start / End" | `transitions[i].from/to` | `editTransition {swap:true}` |
| Move › Reset End to Start; lane menu "Reset End to Start" | `transitions[i].to` | `editTransition {resetEnd:true}` |
| Lane menu › Duplicate | `phone3d.transitions[]` | `addTransition` with the move's `from`, `to`, `easing` at the new time |
| Right-click a move › Remove, or ⌫ | `phone3d.transitions[]` | `removeTransition {id\|index}` |
| Look › Lens, Camera height | `phone3d.camera` | `phone3d {camera:{fov?, elevation?}}` |
| Look › Lighting preset, Angle, Intensity | `phone3d.light` | `phone3d {light:{preset?, azimuth?, intensity?}}` |
| Look › Glass, Back (Auto / Glossy / Frosted) | `phone3d.glass/back` | `phone3d {glass?, back?}` |
| Shadow & focus › Shadow switch, Wall / Floor, Opacity, Softness | `phone3d.shadow` | `phone3d {shadow:{on?, kind?, opacity?, softness?}}` |
| Shadow & focus › Depth of field switch and amount, Background blur | `phone3d.dof` | `phone3d {dof:{on?, amount?, background?}}` |
| Pose › Focus (depth of field over time: a focus pull) | keyframe `focus` | `setPose {focus}` / `addTransition {to:{focus}}` |
| Float switch, amount, period | `phone3d.float` | `phone3d {float:{on?, amount?, period?}}` / `shot {recipe:'float'}` |
| Export quality › Motion blur, Shutter, Samples; Quality 1× / 2× / 3× | `phone3d.motionBlur`, `phone3d.supersample` | `phone3d {motionBlur:{on?, shutter?, samples?}, supersample?}` |
| Warning row › Fix | whatever the fix changes | the warning's `fix` list, as one `apply` |
| (looking at the preview canvas) | — | command `frames` |
| Export menu: resolution, frame rate; for a layout preset: Resolution (preset size, e.g. 1080×1920 / 4K, e.g. 2160×3840; not shown for App Store presets), and the hint under it states the size the export writes | `exportPreset`, `outputFPS` | `exportSettings {preset?, fps?}` (the editor's preset Resolution runs this same op; `uhd4k` also scales a layout preset to a 2160 px short side, e.g. social-9x16 → 2160×3840; App Store presets keep Apple's exact size; `p1080` and `original` keep the preset's size. `info.export.canvas` shows the size before you export. `fps` applies only with no layout preset, as in the editor, which shows no frame rate there: a layout preset exports at its own rate (30 fps for every social preset; an iPhone take starts on `social-9x16`), and `fps` on one is refused. `info.export.fps` is the rate the export writes) |
| Export MP4 / GIF | — | `export --out x.mp4` / `export --gif` |
| Export formats (multi-preset) | — | `export --preset square,feed-4x5 --out folder` |
| Undo | — | `undo` (one level, file-based) |
| Anything else | any field | `set {path: "/json/pointer", value}` — the value's JSON type must match; `/recording` is read-only |

Zooms (manual, tap and auto-focus) play while the 3D phone is on (`phone3d`): a zoom pushes the 3D camera in toward the zoom centre on the phone's screen, with the same timing and easing as a flat zoom. The phone stays whole and keeps its pose. The zoom ops and the editor's zoom controls are the same as for a flat project. During a zoom the screen must face within 35° of front (`zoom-angle`); `info.zooms` lists when each zoom plays, so keep steep moves off those spans. Auto 3D (`direct`) plans shots through zooms, except a `spin-in` or `turn-to-back` (more than 35° off front).

Not in the editor, so not ops: keystroke overlay and click ripples have no
switch (they are drawn whenever the recording has keystrokes/clicks); use
`cursor`/`audio` for what is adjustable.

### Mac + iPhone takes

A display or window recorded with **Also record → iPhone or iPad** on has a
second movie, `phone.mov`, next to `screen.webm`. It is a layer, like the
camera: `recording.phoneOffset` is how many seconds after the Mac video the
phone started (negative: before), and the phone plays at **source time −
phoneOffset**, so `trim`/`cut`/`speed` carry it along with no extra work.
Outside its own take it holds its first or last frame.

`phoneOverlay.layout`: `side-by-side-right` / `side-by-side-left` put the
phone beside the Mac screen, which shrinks to make room (on a portrait
canvas they stack: Mac screen on top with the phone below for `right`, phone
on top for `left`); `corner` keeps the Mac screen full size and puts the
phone over `corner`. `size` is how much of the largest size the layout
allows. The phone's own sound goes into exports only with `sound: true`
(default off); the Mac's sound is always there. Its taps are not drawn.

### polish

`polish` is a fixed list of ops (printed in its output):

- iPhone recording: run tap analysis (first time, or `--reanalyze`), vertical
  9:16 canvas unless one is already chosen, device frame on, gradient
  background (`clean`: Ocean, `bold`: Sunset), padding/corners/shadow, tap
  indicators (`ripple`/white or `pulse`/accent), zoom to taps + auto-focus,
  cut dead air at the very start and end, speed up still stretches in the
  middle (3× / 4×), captions from `transcript.json` when there are none, and a
  title card when `--title` is given.
- Screen recording: background, frame style, auto-focus + dwell zoom, cursor size.

## 3D phone (iPhone and iPad takes)

The device frame can become a lit 3D phone that turns, leans, moves and
settles, with a shadow, depth of field and motion blur. The screen in it is
the same recording, crop, zoom, taps and cursor as the flat frame. Everything
is in one optional key, `project.phone3d`; without it the project renders
exactly as it always did. Edit it only with the ops below (or `direct`).

### When it draws

3D draws only when all of these hold; otherwise the phone renders flat and
`info.phone3d.active` is `false` with a `reason`:

| `reason` | Why it is flat | What to do |
|---|---|---|
| `disabled` | `phone3d.enabled` is false | `phone3d {enabled:true}` |
| `not-iphone` | not an iPhone or iPad take | nothing: every 3D op refuses it |
| `frame-off` | the device frame is off | `device {frame:true}` (the `inactive` warning carries this fix) |
| `app-store` | an App Store layout preset | none: App Store previews stay flat (Apple needs the exact screen); use a social preset for 3D |
| `mac-iphone` | a Mac + iPhone take | none: the phone layer stays flat |
| `frameless-layout` | a layout preset with no device frame | pick a framed layout preset |

### Zooms in 3D

A zoom (Zoom to taps, auto-focus, or a manual zoom; the same list the flat
editor plays) pushes the 3D camera in toward the zoom centre on the phone's
screen, with the zoom's own timing and easing. The phone keeps its pose and
stays whole; the screen stays 1:1 and sharp. Nothing new to set: the Zoom tab
and the zoom ops (`zoomSettings`, `addZoom`, `moveZoom`, `removeZoom`) drive
it. A flat project is unchanged. `info.zooms` lists every zoom that plays
(output `start`, `focus`, `end`, `source`), so you can place shots off them.

A zoom says "look here", so the screen must face the viewer while it plays:

- During every zoom the phone stays within **35° of front** (the tap rule).
  A move that leans further gives `zoom-angle` (the zoom's span and the worst
  moment), with a `fix` list.
- Steep shots (`spin-in`, `turn-to-back`) never overlap a zoom.
  `hero-layback` leans about 40° at Normal intensity: end its lean (the
  first 1.4 s at its default length) before the zoom starts, so only its
  swing back to front runs into the zoom.
- A tap zoom starts just before its tap and ends about a second after it,
  so a gap between two taps is also a gap between their zooms. Auto-focus
  and manual zooms can sit anywhere: `apply --dry-run` lists every
  `zoom-angle` before anything is written.
- Auto 3D (`direct`) follows these rules by itself.

### Pose: units and signs

A pose has 8 channels. `FRONT` = `{turn:0, tilt:0, rotate:0, size:1, x:0, y:0, light:0, focus:1}`; at FRONT
the 3D screen sits exactly on the flat screen, so turning 3D on does not move
the recording.

| Channel | Unit, range | Meaning |
|---|---|---|
| `turn` | degrees, -720..720 | spin about the phone's long axis; **+ turns the screen toward the viewer's right**. Unwrapped: 0 → 360 is one full spin |
| `tilt` | degrees, -85..85 | **+ leans the top away from the camera** (layback, the hero look); − leans it toward you |
| `rotate` | degrees, -180..180 | roll in the picture, + = clockwise |
| `size` | × the flat frame's height, 0.2..3 | 1 = the flat frame's size |
| `x`, `y` | fraction of canvas width / height, -1..1 | offset from the phone's home; + `y` = down |
| `light` | degrees, -180..180 | added to `light.azimuth`: swing the key light during a move |
| `focus` | × `dof.amount`, 0..2 | depth of field over time (0 = sharp, 1 = the setting); a focus pull. Does nothing while `dof.on` is false |

Warnings compare `turn` and `rotate` modulo 360 (turn 360 looks like turn 0).

### Settings (the `phone3d` op; sub-objects merge)

| Field | Range (default) | What it does |
|---|---|---|
| `enabled` | bool (true) | false = render flat, keep every setting |
| `pose` | pose (FRONT) | the **base pose**: held when there are no moves, and where a linked first move starts |
| `camera.fov` | 8..60° (22) | lens: low = flat telephoto look, high = strong perspective |
| `camera.elevation` | 0..30° (0) | camera height; a floor shadow needs ≥ 4 |
| `light.preset` | `studio` `soft` `contrast` `warm` `night` (`studio`) | studio = clean product light; soft = low contrast; contrast = hard key and bright edges; warm = golden key, cool rim; night = dim, edge-lit |
| `light.azimuth` | -180..180° (-35) | key light direction |
| `light.intensity` | 0..2 (1) | light and reflection strength |
| `glass` | 0..1 (0.25) | front-glass sheen over the screen (0 = none) |
| `back` | `auto` `glossy` `frosted` (`auto`) | back glass; auto = frosted on Pro models |
| `shadow` | `on` (true), `kind` `wall`\|`floor` (`wall`), `opacity` 0..1 (0.4), `softness` 0..1 (0.5) | contact shadow on a wall behind the phone, or a floor under it |
| `dof` | `on` (true), `amount` 0..1 (0.35), `background` 0..1 (0) | depth of field on the phone; `background` blurs the backdrop |
| `float` | `on` (false), `amount` 0..1 (0.4), `period` 2..20 s (6) | idle drift in height, turn and tilt, added on top of every pose |
| `motionBlur` | `on` (true), `shutter` 0..1 of a frame (0.5), `samples` integer 2..32 (12) | `samples` is the minimum; fast moves take more by themselves |
| `supersample` | 1, 2 or 3 (1) | export and `frames` only; anti-aliasing already comes from 8 jittered samples, so 2 or 3 only for a hero still |

### Moves (`phone3d.transitions`)

A move is `{id, start, end, from?, to, easing, recipe?}` in **output seconds**,
at least 0.1 s long, kept sorted by start.

- **End** (`to`) is the pose the move lands on. **Start** (`from`) is
  optional: without it the Start is **linked** and the move starts from
  wherever the phone is at `start`, so nothing jumps. Prefer linked Starts.
  An explicit Start that differs from where the phone is gives `pose-jump`.
- Before the first move the phone holds that move's Start; after a move it
  holds its End; when two moves overlap, the later start wins (and `overlap`
  warns).
- Partial poses are filled from the pose at the move's start, so stored
  keyframes are always full poses.
- `recipe` only labels a move made by `shot`.

Easing: `smooth` (default; the zoom's feel), `linear`, `easeIn`, `easeOut`,
`cinematic` (slow, fast, slow: big turns), `spring` (`stiffness` 1..1000,
`damping` 0.1..200; default 180/18 = one soft overshoot: settles and
landings), `bezier` (`[x1, y1, x2, y2]`, x 0..1, y -1..2, like CSS). A spring
runs as real physics when the move is at least as long as the spring's settle
time; a shorter move squeezes the same curve. `fitDuration:true` sets the
move's length to the settle time.

#### Which keyframe a pose edit changes

`setPose {at}` (and the editor's pose fields, drag-to-orbit and arrow keys)
edits one keyframe, chosen by the time:

| `at` is… | `setPose` edits |
|---|---|
| any time, with `target:"base"` | the base pose, even when moves exist (it shows only with no moves, or before and during a linked first move) |
| (no moves) | the base pose |
| before the first move | the first move's Start (made explicit) |
| inside a move | that move's nearer end (a linked Start is made explicit) |
| in the hold after a move | that move's End |

`setPose {id|index, end:"from"|"to", …}` edits one end of one move directly.
The output note says what was edited (`setPose edited End of m2`).

After `direct`, the base pose shows nowhere: Auto 3D's intro (`spin-in`,
`settle`) has its own Start, and the phone holds each move's End after it.
Auto 3D also writes the rest pose into the End of **every planned shot that
returns to rest** (and, for `bold`'s turns, into an explicit Start). So to
change the pose the whole video rests at, pick one:

1. `direct --style bold` when its rest (turn -8°, tilt 5°) is what you want:
   every planned move is built around it. Bold also plans `turn-to-back` in
   long waits.
2. Edit the End of the intro's last move and read its note. Each intro
   recipe writes two moves (the move, then a settle back onto the pose), so
   that is `setPose {index:1, end:"to", …}`. When later moves still hold the
   old pose, the note names them and ends with the ops that give them the
   new one:
   `setPose edited End of m2; End of m6 (index 5) still holds the old pose
   (turn 0, tilt 0), so the phone goes back to it there. For one rest pose,
   apply: [{"op":"setPose","index":5,"end":"to","turn":-8,"tilt":5}]`.
   Apply that list as it is (a pose whole turns away keeps its whole turns).
   Without it, the phone rests at the new pose only until the first planned
   shot, then at the old one for the rest of the video.

Re-running `direct` after a base edit does not keep it: the planner sets the
base itself (front for `subtle` and `hero`, -8°/5° for `bold`).
`setPose {at}` in one hold changes that hold only. Set the rest before adding
shots by hand: a `shot` returns to the pose it starts from, so a shot added
first returns to the old pose. A base edit that shows nowhere says so in its
note (`…which shows nowhere: the first move m1 has its own Start…`). With no
shots planned, set the base before placing shots by hand: a `shot` starts
from it.

### Ops

```jsonc
{"op":"phone3d","enabled":true}                     // first 3D edit: seeds every default (3D on)
{"op":"phone3d","enabled":false}                    // flat, settings kept
{"op":"phone3d","clear":true}                       // deletes phone3d: exactly flat again
{"op":"phone3d","pose":{"turn":-8},"camera":{"fov":24},"light":{"preset":"studio","azimuth":-35,"intensity":1.1},
 "glass":0.3,"back":"auto","shadow":{"kind":"wall","opacity":0.4,"softness":0.6},"dof":{"amount":0.3,"background":0.2},
 "float":{"on":true},"motionBlur":{"shutter":0.5,"samples":12},"supersample":2}
{"op":"setPose","at":4.2,"turn":30,"tilt":10}       // the keyframe at 4.2 s (table above)
{"op":"setPose","at":4.2,"focus":0}                 // a focus-pull keyframe (dof must be on to see it)
{"op":"setPose","target":"base","size":0.9}         // the base pose
{"op":"setPose","id":"m2","end":"from","turn":0}    // one end of one move
{"op":"addTransition","start":2,"end":3.2,"to":{"turn":180},"easing":"cinematic"}
{"op":"addTransition","start":2,"to":{"tilt":10},"easing":"spring","stiffness":180,"damping":18,"fitDuration":true}
{"op":"addTransition","start":5,"end":6,"from":{"turn":0},"to":{"turn":-24},"bezier":[0.7,0,0.16,1]}
{"op":"editTransition","id":"m2","start":2.4,"end":3.6,"to":{"tilt":12},"easing":"cinematic"}
{"op":"editTransition","index":0,"from":null}       // link the Start
{"op":"editTransition","id":"m2","by":0.5}          // shift both ends
{"op":"editTransition","id":"m2","swap":true}       // Start and End change places
{"op":"editTransition","id":"m2","resetEnd":true}   // End = the resolved Start (a move that goes nowhere)
{"op":"removeTransition","id":"m2"}
{"op":"clearTransitions"}
{"op":"shot","recipe":"turn-to-back","at":6,"intensity":1,"direction":1,"return":"front"}
{"op":"direct","style":"hero","replace":true,"scenes":false}
```

- Every 3D op refuses a take that is not an iPhone or iPad
  (`3D phone needs an iPhone recording`).
- They refuse unknown fields (`phone3d: unknown field "fov"` — it belongs in
  `camera`) and out-of-range values; nothing is clamped silently.
- Any 3D edit on a project without `phone3d` (`phone3d`, `setPose`,
  `addTransition`, `shot`) seeds the defaults first, with 3D on.
  `clearTransitions` and `phone3d {clear:true}` on a flat project change
  nothing.
- `addTransition` without `end` or `fitDuration` lasts 1.2 s. `easing` may be
  a name, a full object (`{"kind":"spring","stiffness":120,"damping":14}`), or
  left out with `bezier: [x1,y1,x2,y2]`. Spring numbers you leave out come
  from the move's current spring, else 180/18.
- `swap` and `resetEnd` run before the other fields of the same op.
- Move ids are made for you: read them from the op's note or
  `info.transitions`.
- `direct` as an op defaults to `style:"hero"`, `replace:true`,
  `scenes:true`; in `apply` it runs the same scene detection as the
  `direct` command (unless `scenes:false`) and always reads `cursor.json`.
- **Reset 3D Pose** is not an op; it is this pair in one `apply`:
  `[{"op":"clearTransitions"},{"op":"setPose","target":"base","turn":0,"tilt":0,"rotate":0,"size":1,"x":0,"y":0,"light":0,"focus":1}]`.
- `set` works on `/phone3d/...` too (moves are re-sorted; bad values are
  refused), but the ops above check more.

### Shot recipes (`shot`)

| Recipe | Default length | What it does | Use it for |
|---|---|---|---|
| `spin-in` | 1.6 s | spins in from the back, small and soft, carries 4° past the pose and settles back onto it (2 moves) | the intro, before the first tap |
| `turn-to-back` | 3.7 s (`return:"stay"`: 1.8 s) | turns to a three-quarter view of the back, drifts slowly across it, then on round to the front (a full 360°; 3 moves). One-way it lands on the three-quarter back (2 moves) | a long wait, or a scene change (the edge-on moment hides the cut); bold promos; one-way as an outro |
| `hero-layback` | 2.4 s (`return:"stay"`: 1.38 s) | leans back into a three-quarter hero angle, keeps drifting gently while it holds, then swings back just past the pose and settles (4 moves; one-way: the lean and the hold) | a wait of 2.4 s or more; one-way (`return:"stay"`) as the outro |
| `settle` | 1.0 s | drops in slightly large and leaned back, carries just past the pose and settles onto it (2 moves) | a gentle intro, or any intro under 2 s |
| `float` | — | turns on `phone3d.float` (no moves) | calm tutorials |

- `at` is where the shot starts (output s). `duration` is the length of what
  is kept; the keys scale to it.
- `intensity` (0.25..2, default 1; the editor's Subtle 0.6 / Normal 1 / Bold
  1.4) scales every angle, offset and size change, but not `focus` and not
  the turn of `turn-to-back` (it must still reach the back and come round).
- `direction: -1` mirrors turn and rotate. `return: "stay"` keeps only the
  outbound move of `turn-to-back` and `hero-layback`, stretched over the
  shot.
- Moves that overlap the shot are replaced. The shot starts from the pose the
  phone has at `at` and gets an explicit Start only when that is needed to
  avoid a jump. Turns never run away: a shot first moves its starting turn by
  whole turns into -180..180 (the same picture), so any number of shots stays
  inside the range.
- Every recipe stays under 600°/s at its default length, so it does not
  trigger `too-fast`. Shortening one can.

### Auto 3D (`direct`)

`direct` (command or op; the editor's Auto 3D) plans shots with one rule:
**while something happens on screen, the phone faces the viewer; it moves
only in the free time between.** It is deterministic: the same project gives
the same plan.

1. **Busy time**: each tap from 0.6 s before it to at least 0.8 s after it
   (longer for a swipe, a long press, or a tap that is still settling), and
   each typing run. Zooms are not busy: a zoom pushes the 3D camera in, so a
   shot may run through one if it stays within 35° of front.
   Busy spans closer than 1.2 s merge. While busy, the phone stays within 12°
   of straight on.
2. **Free windows**: the rest, shrunk by 0.15 s next to busy time. A window
   that overlaps a wait is quiet and is used first.
3. **Base pose**: FRONT for subtle and hero; bold rests at
   `{turn:-8, tilt:5}` (9.4° off, inside the 12° rule).
4. **Intro** (a free window at 0): hero and bold use `spin-in` when the
   output is at least 4 s and the window at least 2 s; otherwise `settle`
   when the window is at least 1 s; otherwise, when the first busy time
   starts at 0.6 s or later, a short `settle` (0.6 to 1 s) that lands before
   it.
5. **Outro** (hero, bold): a one-way `hero-layback` ending 0.1 s before the
   end, when the last window is at least 1.5 s.
6. **Middle** (hero, bold): `turn-to-back` (bold, windows ≥ 4.5 s) or
   `hero-layback` (windows ≥ 2.4 s); windows with a scene change first, then
   waits; directions alternate; at most one middle shot per 6 s of output;
   total moving time at most 35% of the output (subtle: 20%; subtle adds no
   middle shots and ends with `float`). Shots keep at least 1 s apart and end
   at least 0.25 s before the next busy time.
   **Restraint**: the big moves (`spin-in`, `turn-to-back`, `hero-layback`,
   the outro included) are at most one per 20 s (bold) or 30 s (hero,
   subtle), start to start, never two within 6 s, and at most 3
   `turn-to-back`s per video (kept moves count). The rest of the time the
   phone holds its pose. A `spin-in` or `turn-to-back` never runs during a
   zoom (the screen must stay within 35° of front there).
7. **Scene changes**: when a scene change falls inside a turn's window,
   the turn is placed so the phone is edge-on exactly at the cut (a
   `hero-layback` reaches its angle at the cut). Moves at scene changes are
   planned before the closing move; a scene change in busy time (right after
   the tap that caused it) gets its move as soon as the phone is free. A take
   over 90 s gets a `note` that recommends trimming it to its best 15-45 s,
   and its middle moves go only to scene changes and waits (when it has any).
8. **Ops**, in order: `phone3d` (on, the base pose, light `soft` for subtle
   else `studio`, motion blur on), `clearTransitions` (unless `--keep` /
   `replace:false`; kept moves count as busy time), then one `shot` per shot.
9. **Self-check**: the plan is applied to a copy and every shot that causes a
   warning is dropped (a shot that pushes the phone past a canvas edge first
   gets one try leaning the other way), so a fresh plan has 0 warnings.
10. **Always visible**: on an iPhone take, Auto 3D always gives a visible 3D
   result. When the style's own moves do not fit (hero and bold: no
   `spin-in`, `hero-layback` or `turn-to-back`; subtle: no shot at all), the
   output has a `note` that says which check refused each move and what the
   phone does instead. Hero with no kept moves then rests at
   `{turn:-8, tilt:5}` (9.4°, inside the 12° rule) instead of straight on;
   bold already rests there. A plan with no moving shot always has a `note`.

`shots[].reason` says why each shot is where it is. On a long take, trim to
the best 15-45 s first (the `note` says so); `polish` speeds up the waits.
The waits are the quiet windows Auto 3D puts its big moves in, and polish
plays them 3x faster, so after polish a short take can be left with no
window long enough (a `hero-layback` needs 2.4 s, a `turn-to-back` 4.5 s).
Example: a 15 s trim with one 5.7 s wait gets a bold `turn-to-back` inside
the wait, but after polish the wait plays in 1.9 s, so bold gets only a
`settle` and a `note` that no turning shot fits. For a short take that
should get one big move, set that wait's clip back to normal speed before
`direct` (`clipSpeed {index, speed: 1}`; `info` lists the clips), or add the
shot by hand. Do not run `direct` first and polish after: a move keeps its
length when its footage speeds up, so it no longer fits the wait.

World class means restraint: most of the video is the phone holding a calm
pose. `direct` keeps the restraint rule (6) by itself. When you add or keep
shots by hand, keep the same limits: at most one big move (`spin-in`,
`turn-to-back`, `hero-layback`) per 30 s (per 20 s with `--style bold`),
never two within 6 s, at most 3 `turn-to-back`s, and no steep angle during a
zoom (`info.zooms`). No warning checks the counts, so count them yourself,
**by shot, not by row**:

- One shot writes 2 to 4 rows in `info.transitions` (spin-in 2, hero-layback
  4 or one-way 2, turn-to-back 3 or one-way 2, settle 2), and every row
  carries the shot's `recipe`. The rows of one shot follow each other with
  no gap: each row's `start` is the `end` of the row before it. So a new
  shot begins at a row whose `recipe` differs from the row before, or whose
  `start` is later than the row before's `end`. Example: rows `spin-in`
  0–1.05, `spin-in` 1.05–1.4, `hero-layback` 21.4–21.97, 21.97–22.78,
  22.78–23.5, 23.5–23.8 are 2 shots (one spin-in, one layback), not 6.
- `direct`'s `shots` lists one entry per shot it planned (not the ones you
  add by hand).
- To remove a shot, remove **all** of its rows in one `apply`, by `id`
  (`[{"op":"removeTransition","id":"…"}, …]`; ids do not shift, indexes
  do). Removing one row leaves half a shot, for example a spin-in with no
  settle.

### Warnings

`validate`, `info`, `apply`, `polish` and `direct` print `warnings`; `export`
and `frames` print them to stderr. They never block anything. Each has a
`code`, a `message`, often `at`/`end` (output s) and `transitionId`, and a
`fix` (a list of ops) when one clears it: every `fix` is checked on a copy
before it is offered. Apply a fix as one `apply` call (`fix` is already an
edits list).

| Code | When | `fix` |
|---|---|---|
| `inactive` | 3D is on but renders flat (the message gives the reason). It is then the only warning | frame off: `[{"op":"device","frame":true}]`; else none |
| `tap-angle` | the screen is more than 35° off straight on during a tap (from 0.3 s before it to 0.3 s after it ends) | the first that works of: pull the move's End to 0.3 s before the tap; `setPose {at: tap, turn: <nearest whole turn>, tilt:0}`; both; shift a move that starts during the tap to after it (`editTransition {by}`) |
| `tap-back` | the phone shows its back during a tap: the tap is invisible | same as `tap-angle` |
| `zoom-angle` | the screen is more than 35° off straight on during a zoom (manual, tap or auto-focus; from its glide in to its glide out): the zoom pushes the 3D camera in toward the screen, so it must face the viewer | the first that works of: shift the move off the zoom (`editTransition {by}`); pull its End to the zoom's start; `setPose` facing front |
| `off-canvas` | the phone pokes more than 2% of the canvas's short side outside the canvas. The cause, in this order: the idle float when the keyframes alone (float off) keep the phone inside, even if a move brought it near the edge (the message says so; no `transitionId`); else the move that pushes it further out than the same timeline without that move (`transitionId`); else the pose it rests at (no `transitionId`) | float: a lower `phone3d {float:{amount}}`; else `setPose` with smaller `size` or moved `x`/`y` at the worst moment |
| `overlap` | a move starts before the one before it ends (the later wins) | `editTransition {id, start: <earlier end>}` (or `{by}` when that would leave it under 0.1 s) |
| `past-end` | a move ends after the video ends | `editTransition {by: <end of video − end>}` (or `{start:0, end:<end of video>}` when it is longer than the video) |
| `pose-jump` | a move's explicit Start differs from where the phone is by more than 1° or 0.5% (turn and rotate modulo 360) | `editTransition {id, from:null}` |
| `too-fast` | a move turns faster than 600°/s (360°/s with motion blur off): it strobes | none: make it longer or smaller (`duration`, `intensity`) |
| `floor-flat` | a floor shadow with camera height under 4° (invisible) | `phone3d {camera:{elevation:12}}` |

### Look before you export

An export renders every frame (minutes); `frames` renders the few that
matter in seconds, with the export's own code. Use `frames --moves --sheet
--draft` while iterating and **look at `sheet.png`**: is the screen readable
at every tap, does each move read as one idea, does anything leave the
canvas, is the phone near front during every zoom? Each file's `facing` is 1
when the screen is straight at the camera and below 0 when it shows its back.
On a long video, `--from S --to E` limits the stills to a range of output
seconds. Then `frames --moves` at full quality
(motion blur, anti-aliasing) before the one export. For a 4K hero file on a
layout preset: `apply [{"op":"exportSettings","preset":"uhd4k"}]` (the
editor's Export menu › Resolution › 4K), check `info.export.canvas`, then
export.

### Example: "make this world class" (an iPhone take)

Run each block in one call (shell state does not carry over between calls).
Put your checkout in place of `/abs/path` in `osa`, and your bundle's
absolute path in `B`:

```sh
osa() { node /abs/path/electron/scripts/openscreen-agent.mjs "$@"; }
B=/abs/path/rec-1792855925414.openscreen
osa info "$B"     # duration, taps, waits, export (preset, fps), phone3d (null = flat)
osa review "$B"   # LOOK at review/sheet-*.png: what is the story, which source seconds are the best moments?
```

Keep only the best moments (source seconds; a 637 s take becomes a 15–30 s
social video), then polish and direct. The numbers below are this take's
own, from a real run; on another take, pick yours from `info` and `review`:

```sh
osa() { node /abs/path/electron/scripts/openscreen-agent.mjs "$@"; }
B=/abs/path/rec-1792855925414.openscreen
osa apply "$B" '[{"op":"trim","start":2,"end":56},{"op":"cut","ranges":[{"start":24,"end":48}]}]'   # 30 s of source
osa polish "$B" --style clean --title "Your money, answered" --subtitle "Ask Vero"   # outputDuration {before: 30, after: 26.2}: inside 15–30 s
osa direct "$B" --style hero              # shots: spin-in 0–1.6 only; warnings: []
osa info "$B"                             # taps in output seconds (via clips): …12.93, 14.06 | 17.19, 17.73, 18.59, 20.66 | 23.59…
osa frames "$B" --moves --sheet --draft   # LOOK at sheet.png
```

`direct` planned no shot after the intro: once each tap's busy time is
taken off, no free window is long enough for a `hero-layback` (2.4 s). Do
not add one by hand: restraint (see "Auto 3D") is at most one big move
per 30 s (per 20 s with `--style bold`), this is a 26 s video made with
`--style hero`, and the spin-in is its one big move. The quiet middle gets
`float` (a slow drift, not a move) instead.
Fix what the sheet shows in one `fixes.json`, saved in the folder you run
the commands from (times are output seconds, after the cuts):

```json
[
  {"op": "editTransition", "index": 0, "end": 1.05},
  {"op": "editTransition", "index": 1, "start": 1.05, "end": 1.4},
  {"op": "setPose", "index": 1, "end": "to", "turn": -8, "tilt": 5, "size": 0.92},
  {"op": "shot", "recipe": "float"},
  {"op": "phone3d", "light": {"preset": "contrast"}, "dof": {"background": 0.3}}
]
```

The first two ops make the intro quicker (the spin-in is two moves: the spin and its settle, so both are
retimed; shortening only the spin would overlap the settle). The third makes the phone rest a little off front
and smaller. After
`direct`, the rest pose is the End of the intro's last move (index 1: each
intro recipe writes the move and a settle) **and of every planned shot
that returns to rest**, so edit those Ends. Here `direct` planned only the
intro, so one edit is enough (a shot you add by hand after it starts from
the new rest and returns to it: ops run in order). When `direct` did plan
later shots,
the `setPose` note names each one that still holds the old pose and gives the
ops to apply (see "Which keyframe a pose edit changes"). A
`setPose {target:"base"}` here would show nowhere.

Check the edits with `--dry-run` before you apply them. Times copied from
another take, or from before a cut, put moves on top of taps or zooms; the
dry run says so (`tap-back`, `tap-angle`, `zoom-angle`, `overlap`) and
changes nothing:

```sh
osa() { node /abs/path/electron/scripts/openscreen-agent.mjs "$@"; }
B=/abs/path/rec-1792855925414.openscreen
osa apply "$B" fixes.json --dry-run       # warnings: [] (on this take); else fix the op it names and retry
osa apply "$B" fixes.json                 # read `changes` and `warnings` in the output
osa validate "$B"                         # problems: [] — warnings: [] (or apply each `fix`)
osa frames "$B" --moves --sheet           # full quality: LOOK again
osa export "$B" --out /abs/promo.mp4      # probe: duration, size, fps
osa review /abs/promo.mp4                 # watch what viewers will see; iterate
```

A world-class result: the screen faces front at every tap and through every
zoom; restraint (at
most one big move per 30 s (per 20 s with `--style bold`), counted by shot;
a calm pose between); one idea per move; moves only in waits or at scene changes;
an intro under 1.8 s; at most a third of the runtime moving; springs for
settles and cinematic for big turns; motion blur on; 0 warnings; 4K only
for the hero file.

## Caveats

- **Audio tracks** are mixed into every export (MP4, presets, the
  multi-format batch, headless); a GIF has no sound. A recording with no
  audio stream still exports with its music. Volume is 0..1 for items and
  tracks.
- **Export speed**: the export renders every frame in the real renderer
  (seek → draw → ffmpeg), about 10–15× slower than real time for a 1080×1920
  canvas. A 26 s video took ~5 min. Use `--timeout` for long ones (default
  1800 s).
- The headless export uses its own temporary profile and never shows a
  window; it can run while the app is open. It never writes `project.json`.
- **Live reload**: if the project is open in the app while you `apply`, the
  editor reloads it within about a second. If it has unsaved edits of its
  own, it asks (Load From Disk / Keep Mine) instead of overwriting either.
- An imported video has no cursor, click or keystroke track: `info` shows
  `recording.imported: true`, auto-focus and dwell zooms start off and do
  nothing, and the editor hides the Cursor tab. Manual zooms (`addZoom`),
  captions, music and everything else work as on a recording.
- `record start` needs the phone unlocked and trusted; `--mic` is not
  supported (the helper records the phone's own audio). Only one agent
  recording at a time. The GUI and an agent recording can't use the phone at
  the same moment.
- `review` of a bundle reports **source** times; the edited timeline is
  `outputDuration`. After exporting, `review out.mp4` shows what viewers see.
- Transcripts need `whisper-cpp` (`brew install whisper-cpp`); without it,
  `review` says so and caption ops that need a transcript fail clearly.
- `undo` keeps a single backup; each `apply`/`polish` overwrites it.
- The headless app can also be run directly:
  `OpenScreen.app/Contents/MacOS/OpenScreen --export <bundle> --out f.mp4 [--gif] [--preset a,b] [--timeout s]`
  prints `{"progress":…}` lines then one `{"ok":…}` line and exits 0/1.
- Environment overrides: `OPENSCREEN_RECORDINGS_DIR` (where bundles live),
  `OPENSCREEN_APP` (app used by `export`), `OPENSCREEN_STATE_DIR` (recording
  state file), `OPENSCREEN_IOS_HELPER`, `OPENSCREEN_FFMPEG`.
