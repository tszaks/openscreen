# OpenScreen — Technical Specification

An open-source macOS screen recorder in the spirit of Screen Studio / ScreenCharm:
record your screen or an iPhone/iPad over USB, then get a polished, auto-edited
video — smooth cursor, smart zoom, styled background, captions — without
touching a timeline unless you want to.

## Goals

- **Fidelity target:** get as close as possible to Screen Studio's output quality
  and workflow with permissively-licensed code.
- **Headline differentiator:** wired iPhone/iPad capture (continuity camera) as a
  first-class recording source, with motion-diff autofocus since iOS taps don't
  reach the global input hook.
- **Native feel, Electron stack:** TypeScript + React, matching Screen Studio's
  own stack. The motion model lives in a pure shared library.

## Feature matrix (updated 2026-09-25)

| Capability | Screen Studio | ScreenCharm | OpenScreen |
|---|---|---|---|
| Display / window capture | yes | yes | yes |
| iPhone/iPad over USB | no | yes (spike) | **yes — headline** |
| Webcam overlay | yes | yes | yes (PiP, shape/position/size) |
| Mic audio | yes | yes | yes (re-timed through cuts via atrim/atempo/concat) |
| Auto-zoom on clicks | yes | yes | yes (smootherstep easing; pan-without-detour) |
| Dwell / motion autofocus | partial | no | yes (cursor linger + video frame-diff) |
| Cursor smoothing / style | yes | yes | yes (Catmull-Rom, size/color/trail) |
| Styled backgrounds | yes | yes | yes (solid/gradient/image/blur/wallpaper) |
| Timeline editor | yes | basic | yes (split/trim/reorder/speed/silence-cut/undo) |
| Captions | yes | yes | yes (whisper.cpp, auto-downloading model; SRT/VTT) |
| Transcript editing | partial | no | yes (seek/cut cue/cut fillers) |
| Text annotations | yes | no | yes (3 bands, colored) |
| Keystroke overlay | yes | yes | yes |
| GIF export | yes | yes | yes (two-pass palettegif) |
| Shareable link / cloud | yes | no | no |

## Architecture

Everything lives under `electron/`:

- `src/shared/` — pure model layer, no Electron/DOM imports: autofocus segment
  planning + per-frame camera evaluation, smootherstep easing, Catmull-Rom cursor
  smoothing, timeline clip→output mapping, ripples, keystrokes, caption parsing,
  dwell/motion focus detection. Vitest-covered; this is where the feel lives.
- `src/main/` — Electron main: window + IPC, `desktopCapturer` sources, uiohook
  global click/key capture, 120Hz cursor poller, `.openscreen` bundle IO, ffmpeg
  pipe for frame-encoded export (rawvideo → libx264) and audio filter graphs
  (silencedetect, atrim/atempo/concat, lavfi click sfx, amix), whisper-cli
  transcription with auto-downloading ggml model.
- `src/preload/` — contextBridge API surface.
- `src/renderer/` — React: source picker → 3-2-1 countdown → recording HUD →
  editor. The editor's `CanvasCompositor` draws bg → content → cursor → ripples →
  cam PiP → captions → keystrokes → annotations → device bezel per frame; the
  same compositor feeds the ffmpeg pipe during export.

## Bundle format

`rec-<ts>.openscreen/` package: `screen.webm`, `cam.webm?`, `cursor.json`,
`keystrokes.json`, `project.json`, `audio.wav` (on demand), `transcript.json`,
`export-*.mp4|gif`, `.srt` sidecars.
