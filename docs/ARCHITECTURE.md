# Architecture

OpenScreen is an Electron app written in TypeScript and React. Everything lives under `electron/`.

```
electron/
├── src/
│   ├── shared/     Pure model layer (no Electron or DOM imports), unit-tested
│   ├── main/       Electron main process: windows, capture, files, ffmpeg, menus
│   ├── node/       Node-only helpers shared by main and the agent CLI
│   ├── preload/    The contextBridge API the renderer sees
│   └── renderer/   React UI: picker → recording → editor → export
├── native/
│   └── ios-capture/  Swift helper for wired iPhone and iPad capture
├── scripts/
│   └── openscreen-agent.mjs  Command-line entry point for agents
└── test/           Vitest suites
```

## The model layer (`src/shared/`)

Everything that decides how a video *looks and moves* is a pure function here, so it can be tested without a window:

| Module | What it does |
|---|---|
| `autofocus.ts` | Turns clicks, dwells and motion into focus segments, then evaluates the camera per frame |
| `easing.ts` | Smootherstep and spring curves for zoom transitions |
| `cursor.ts` | Catmull-Rom cursor smoothing |
| `timeline.ts` | Maps between source time and output time across cuts and speed changes |
| `taps.ts` | Infers taps, swipes, long presses and typing from iPhone frames |
| `autozoomTaps.ts` | Plans zoom-to-tap segments for phone recordings |
| `devices.ts` | iPhone and iPad models, frames and auto-detection |
| `backdrops.ts` | Backdrop presets shared by the editor and the agent CLI |
| `exportPresets.ts` | App Store, social and landing-page export formats and their rules |
| `agentOps.ts` | Every editor edit as a validated, serialisable operation |
| `audioTracks.ts` | Music and voiceover tracks: where each item plays in output time, its volume and fades, ducking, and the edits the timeline lane makes |
| `phoneLayer.ts` | Mac + iPhone takes: the phone layer's time mapping (source time − offset), where the Mac screen and phone sit for each layout, and what to keep when one side of a dual take fails |
| `contentTransform.ts` | The recording moved and resized by hand: the layout's fitted rect placed by `style.contentTransform` (centre + scale, kept at least 10% on the canvas), and the aspect-locked corner resize the recording and the camera bubble share |
| `previewPointer.ts` | What a press on the editor's preview does, in order: crop, place a tap, a selected item's corner handle, the camera bubble, the recording, empty canvas |
| `types.ts` | The project model, defaults, migration of older projects, reset |

## Rendering and export

The editor's `CanvasCompositor` draws each frame in order: backdrop → content → cursor → ripples and taps → camera overlay → phone layer → captions → keystrokes → annotations → device frame. Export runs **the same compositor** and pipes raw frames into ffmpeg (rawvideo → H.264), so the exported video always matches the preview. Audio follows the cuts through an ffmpeg filter graph (`atrim` / `atempo` / `concat`), with click sounds mixed in. With "Phone sound" on, a Mac + iPhone take's phone audio is shifted onto the Mac's clock and goes through the same cuts. Items on the audio tracks are cut, looped, faded and delayed to their output time (`atrim` / `aloop` / `afade` / `adelay`) and mixed over the same silent bed, so the file always ends where the video ends.

Headless export (`OpenScreen --export <bundle> --out file.mp4`) runs the real renderer with no window and no dialogs.

## iPhone and iPad capture

macOS only exposes a wired iPhone's screen to apps that opt in to CoreMediaIO screen devices, which Chromium never does. The `ios-capture` helper opts in, records with AVFoundation to a fragmented H.264 `screen.mov` (so a crash keeps everything recorded up to that point), and streams a live preview to the app.

## Mac + iPhone

With a display or window selected, **Also record → iPhone or iPad** starts the helper on the phone first (it answers on the phone's first frame, with that frame's capture time), then the Mac recorders. The phone records into its own bundle; when the take is saved, its `screen.mov` moves into the Mac bundle as `phone.mov`, with `phoneOffset` = phone start − Mac start. Either side failing never costs the other (`phoneLayer.dualOutcome`): a phone that won't start, stops early or fails leaves the Mac take intact with a notice, and a Mac take that can't be saved leaves the phone's bundle to open as an iPhone take.

## Camera: the recording monitor and the bubble

With **Also record → Camera** on, a display, window or iPhone take shows a **recording monitor** (**Show me while recording**, on by default): a small floating window with what is being recorded (a live thumbnail of the captured screen, or the iPhone's preview) beside the face camera, Small or Large, Round or Square, either side, draggable, the source tile switchable off to leave just the face. The renderer opens it with `window.open`, so its tiles are clones of the tracks already being recorded (capped at 30 fps and 640 px; nothing is captured twice) and the iPhone tile draws the helper's preview frames. Main makes it frameless, transparent, always on top, unfocusable, on every Space, and hidden from screen capture: the camera is recorded separately and composited in the editor, so a captured monitor would show the face twice. Every choice and where it was left are remembered (`shared/recordingMonitor.ts`).

In the project the camera is a **bubble**: `cameraOverlay.position` is its centre as a fraction of the canvas, `sizeFraction` its diameter against the visible recording, `circular` Round or Square (`shared/cameraOverlay.ts`; older projects keep drawing in their `corner` until moved). When a take stops, the monitor's face size and shape become the bubble's, and on a display take so does its position: the bubble lands over the spot of the recording the face covered on screen. In the editor the bubble is dragged on the preview, snapping to the canvas centre lines, safe-inset edges and the recording's edges, one undo step per drag; preview and export draw it through the same compositor. The camera plays at source time − `recording.cameraOffset` (an iPhone take's camera is timed against the helper's first frame).

## Moving and resizing the recording

The layout decides where the recording fits (padding, crop, device frame, canvas preset, the phone layer). `style.contentTransform` then moves that fitted rect's centre and scales it about its centre, aspect kept; absent, the recording sits exactly where the layout fits it, so older projects draw unchanged. The compositor places the frame body (or, unframed, the screen) and carries the screen, shadow, zoom, touch indicators, keystrokes, captions and text along. With the phone layer side by side the Mac screen moves alone and the phone keeps its place; over the Mac screen's corner, the phone moves with it. The camera bubble is sized against the fitted rect, so resizing the recording leaves it alone. App Store previews (full-bleed) ignore the transform.

In the editor, clicking the recording selects it (accent outline, four corner handles, never exported): the body drags with the camera's snap guides (canvas centre lines, safe-inset edges and the bubble's edges), a corner resizes it from the opposite corner (Option: from the centre), snapping at 100%, and a double-click resets it. The bubble gets the same corner handles. Each gesture is one undo step. `shared/previewPointer.ts` sets who gets a press: crop mode, then placing a selected tap, then a selected item's handles, then the bubble, then the recording.

## "Just me"

The **Just me** source records a camera on its own (`sourceKind: 'camera'`) with the microphone on by default and a mirrored preview. The editor leaves out the Cursor tab, click and dwell zooms and taps, and offers a Wide 16:9 or Vertical 9:16 canvas with the camera cropped to fill its frame (`shared/justMe.ts`).

## Project bundles

A recording is a folder named `<name>.openscreen`:

| File | Contents |
|---|---|
| `screen.mov` / `screen.webm` | The original recording, never modified |
| `cam.webm` | Camera overlay, if recorded |
| `phone.mov` | The iPhone screen recorded alongside a Mac take, if any |
| `project.json` | Every edit: clips, zooms, taps, captions, style, layout |
| `cursor.json`, `keystrokes.json` | Input tracks for Mac recordings |
| `transcript.json`, `audio.wav` | Created on demand for captions |
| `audio/` | Music and voiceover files added to the project's audio track (copies, so the bundle stays self-contained) |

Edits are non-destructive: the recording is never touched, and `project.json` can always be reset back to the raw take.
