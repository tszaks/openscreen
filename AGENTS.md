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

```sh
A="node /abs/path/electron/scripts/openscreen-agent.mjs"

$A devices                          # is a phone plugged in?
$A record start                     # optional: record the phone yourself…
$A record status
$A record stop                      # …writes project.json; bundle path in the output
$A latest                           # or take the newest recording made in the app

$A review latest                    # contact sheets + review.json — LOOK at the sheet PNGs
$A info latest                      # clips, captions, taps, style, … (times, ids, indexes)
$A polish latest --style clean --title "Headline" --subtitle "Sub"
$A apply latest edits.json          # precise edits (see below)
$A export latest --out /abs/out.mp4 # renders with the real app, headless
$A review /abs/out.mp4              # watch your own output and iterate
$A undo latest                      # swap project.json <-> project.json.bak
```

### Commands

| Command | What it does |
|---|---|
| `devices [--wait ms]` | Connected iPhones/iPads, via the app's `ios-capture` helper. Empty list + `hint` when none. |
| `record start [--device id\|name]` | Starts a wired iPhone screen recording into a new `rec-<ts>.openscreen` in the recordings folder, detached. Waits for the first frame. Fails clearly when no phone is connected or it is locked. |
| `record status` | `idle`, `recording` (with `elapsed`), `finished`, `failed`, or `dead`. |
| `record stop` | Finishes the take (the helper's normal finalize; the movie is fragmented, so even a crash keeps what was recorded), then writes `project.json` with the same defaults the app gives an iPhone take. |
| `latest` / `list` | Newest bundle / all bundles in `~/Movies/OpenScreen` (or `$OPENSCREEN_RECORDINGS_DIR`). In the app, **File → Copy Path for Agent** copies the open project's path. |
| `info <bundle>` | Summary JSON: source size/duration, output duration, canvas, device, clips (with ids, source and output ranges), captions, transcript, chapters, annotations, manual zooms, taps, waits, style, layout, camera, `phone` (Mac + iPhone takes: the phone movie, its size, length, `offset`, detected `model`, whether it is `drawn`, and every `phoneOverlay` field; `null` otherwise), audio, tracks (music and voiceover items with their output `start`/`end`, file range, volume, fades, loop, and `missing` when the file is gone), export settings, `problems`. |
| `validate <bundle>` | `{"ok":true,"problems":[]}` or the list of problems (exit 1). |
| `review <bundle\|video> [--every 2s] [--out dir] [--max-sheets 10] [--transcribe] [--no-taps]` | Writes `review/` in the bundle (or `<video>.review/`): `sheet-NN.png` contact sheets (timestamped tiles, 6×2 for portrait, 4×3 for landscape; interval grows so there are at most ~10 sheets), up to 12 `scene-NNN.jpg` keyframes from scene detection, and `review.json` (duration, orientation, device, stills from freezedetect, silences from silencedetect, taps and waits from the editor's own tap analysis, the transcript, every image path with its timestamps). Works on an exported mp4 too. |
| `apply <bundle> <edits.json\|-\|'[…]'> [--dry-run]` | Applies edit ops in order. All-or-nothing: if any op fails or the result doesn't validate, nothing is written. Writes `project.json.bak` first. |
| `polish <bundle> [--style clean\|bold] [--title T] [--subtitle S] [--reanalyze] [--dry-run]` | One-shot good defaults (see below). Deterministic; prints the ops it applied. |
| `undo <bundle>` | Swaps `project.json` and `project.json.bak` (so a second undo redoes). One level. |
| `export <bundle> [--out f.mp4\|f.gif\|folder] [--gif] [--preset id[,id…]] [--app /path/OpenScreen.app] [--timeout s]` | Renders through the real app with no window and no dialogs, then `ffprobe`s the file (`probe` in the output). `--preset` writes every listed export preset into a folder. Without `--app` it uses `$OPENSCREEN_APP`, else this checkout's Electron (`electron/`). |
| `open <bundle> [--app …]` | Opens the project in the editor for a human (`OpenScreen --open <bundle>`). Later `apply`s show up live. |
| `ops` | Every op name. |

### Time domains (important)

- **Source seconds** — the raw recording: `trim`, `cut`, `speed`, clip
  `sourceStart/sourceEnd`, taps, waits, and every time in `review.json` of a
  bundle.
- **Output seconds** — the edited timeline: captions, chapters, annotations,
  manual zooms, `split`, and where an audio item `start`s. `info` shows each clip's `outputStart/outputEnd` so
  you can convert. After a `trim` or `cut`, output-time items move with their
  footage automatically (the editor's own remap).

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
LayoutSection, TapsLane, ExportPanel) and the op that does the same thing:

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
| Zoom tab: Auto-focus, Dwell, Zoom to taps, Zoom depth | `zoom.autofocus/dwell/fromTaps/depth` | `zoomSettings {…}` |
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
| Text overlays: add, edit text, position band, delete | `annotations` | `addAnnotation`, `editAnnotation {text?, band?, hex?, start?, end?}`, `removeAnnotation` |
| Camera tab: show, shape (Round/Square), size (Small 0.22 / Large 0.36 / fine 0.1..0.5); drag the bubble on the preview | `cameraOverlay` (`position` = centre as a fraction of the canvas; older projects have only `corner`) | `camera {enabled?, x?, y?, circular?, sizeFraction?, corner?}` (`x`/`y` 0..1 place it freely; `corner` alone puts it back in a corner) |
| Phone tab (Mac + iPhone takes): show, layout, corner, size, device frame, shadow, phone sound | `phoneOverlay` | `phone {enabled?, layout?: side-by-side-right\|side-by-side-left\|corner, corner?, size? (0.3..1), frame?, shadow?, sound?, modelId?, finishId?}` (`null` resets a model or finish to detected; fails on a take with no phone video) |
| Background tab: swatches, image, wallpaper, blur, blurred recording | `style.background`, `layout.background` | `background {swatch\|solid\|gradient\|image(+blur)\|blurred:true}` (wallpaper: pass the image path) |
| Frame: padding, corner radius, shadow, shadow opacity | `style.*` | `style {paddingFraction?, cornerRadius?, shadowRadius?, shadowOpacity?}` |
| Crop | `style.cropRect` | `crop {rect: {x,y,w,h} \| null}` |
| Device tab: frame on/off, model, finish | `device.frame/modelId/finishId` | `device {frame?, modelId?, finishId?}` (`null` resets to detected) |
| Touch indicators: show, style, colour, size | `tapStyle` | `tapStyle {show?, style?, color?, sizePt?}` |
| Taps lane: add, drag/place, delete, re-detect | `taps` | `addTap {t,x,y,kind?}`, `moveTap {index\|id, t?, x?, y?}`, `removeTap`, `clearTaps`, `analyzeTaps` |
| Waits: speed up 3×, cut | `clips` (from `waits`) | `speedUpWaits {speed?, which?}`, `cutWaits {which?}` (`which`: all\|edge\|interior); `setWaits` |
| Canvas (layout preset), title card | `layout.presetId`, `layout.titleCard` | `layout {presetId?, background?}`, `titleCard {title, subtitle} \| {enabled:false}` |
| Export menu: resolution, frame rate | `exportPreset`, `outputFPS` | `exportSettings {preset?, fps?}` |
| Export MP4 / GIF | — | `export --out x.mp4` / `export --gif` |
| Export formats (multi-preset) | — | `export --preset square,feed-4x5 --out folder` |
| Undo | — | `undo` (one level, file-based) |
| Anything else | any field | `set {path: "/json/pointer", value}` — the value's JSON type must match; `/recording` is read-only |

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
