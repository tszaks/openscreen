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
| `types.ts` | The project model, defaults, migration of older projects, reset |

## Rendering and export

The editor's `CanvasCompositor` draws each frame in order: backdrop → content → cursor → ripples and taps → camera overlay → captions → keystrokes → annotations → device frame. Export runs **the same compositor** and pipes raw frames into ffmpeg (rawvideo → H.264), so the exported video always matches the preview. Audio follows the cuts through an ffmpeg filter graph (`atrim` / `atempo` / `concat`), with click sounds mixed in. Items on the audio tracks are cut, looped, faded and delayed to their output time (`atrim` / `aloop` / `afade` / `adelay`) and mixed over the same silent bed, so the file always ends where the video ends.

Headless export (`OpenScreen --export <bundle> --out file.mp4`) runs the real renderer with no window and no dialogs.

## iPhone and iPad capture

macOS only exposes a wired iPhone's screen to apps that opt in to CoreMediaIO screen devices, which Chromium never does. The `ios-capture` helper opts in, records with AVFoundation to a fragmented H.264 `screen.mov` (so a crash keeps everything recorded up to that point), and streams a live preview to the app.

## Project bundles

A recording is a folder named `<name>.openscreen`:

| File | Contents |
|---|---|
| `screen.mov` / `screen.webm` | The original recording, never modified |
| `cam.webm` | Camera overlay, if recorded |
| `project.json` | Every edit: clips, zooms, taps, captions, style, layout |
| `cursor.json`, `keystrokes.json` | Input tracks for Mac recordings |
| `transcript.json`, `audio.wav` | Created on demand for captions |
| `audio/` | Music and voiceover files added to the project's audio track (copies, so the bundle stays self-contained) |

Edits are non-destructive: the recording is never touched, and `project.json` can always be reset back to the raw take.
