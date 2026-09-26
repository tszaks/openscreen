# openscreen

An open-source screen recorder in the spirit of Screen Studio — buttery auto-focus zoom on clicks and dwell, cursor smoothing, styled backgrounds, a full editor, captions, transcript editing. Recording iPhone and iPad screens is the headline feature.

## Stack

**Electron + TypeScript + React** — same stack as Screen Studio. The capture/UI layer is Electron; the motion model (autofocus segments, easing, cursor smoothing, timeline mapping, click ripples, keystroke overlay) is a pure shared library with unit tests — that's where the buttery feel lives.

## Layout

- `electron/` — the app
  - `src/shared/` — pure model layer: `autofocus.ts` (click/dwell/motion clusters → focus segments + per-frame camera eval), `easing.ts` (smootherstep/spring curves), `cursor.ts` (Catmull-Rom smoothing), `timeline.ts` (clip ↔ output mapping), `ripples.ts`, `keystrokes.ts`, `captions.ts`, `types.ts`
  - `src/main/` — Electron main: window, `desktopCapturer` sources, 120Hz cursor poller + uiohook global clicks/keys, bundle save, ffmpeg export pipe + audio filters, whisper transcription, `ios.ts` (drives the iPhone capture helper)
  - `native/ios-capture/` — Swift CLI helper for wired iPhone/iPad screen capture (built by `npm run build:helper`)
  - `src/preload/` — contextBridge API
  - `src/renderer/` — React UI: source picker → record HUD → editor (composited canvas preview, waveform timeline, style + annotation panels) → MP4/GIF export
  - `test/` — vitest unit tests for the model layer

## Features

- Screen/window capture via `desktopCapturer` + `getUserMedia` (60fps webm); mic audio; webcam PiP
- iPhone/iPad screen capture over a USB cable, like QuickTime's "New Movie Recording → iPhone": a small Swift helper opts into CoreMediaIO screen devices (`kCMIOHardwarePropertyAllowScreenCaptureDevices`), which Chromium never does, and records them with AVFoundation to an H.264 `screen.mov` with the device's audio. Plus a device-frame bezel and **Detect touches** autofocus (frame-diff motion centroid tracking, since iOS taps don't reach the global hook). Continuity Camera is different: it is the phone's *camera* used as a webcam, not its screen, so it's listed under "Other cameras".
- Auto-focus zoom: click/dwell clusters → smoothed glide-in → hold → glide-out with smootherstep easing; consecutive clusters pan directly. Manual zooms via Alt+click on the timeline.
- Cursor: Catmull-Rom smoothing, size/color/trail controls; click ripples; click SFX mixed into export audio
- Editor: clip split/trim/reorder/speed, silence auto-cut (ffmpeg silencedetect), transcript panel (click-to-seek, cut cue, cut fillers), undo/redo
- Captions: whisper transcription (model auto-downloads on first use) or SRT/VTT import, burned into preview + exported as an `.srt` sidecar
- Style: solid/gradient/image backgrounds (with blur + macOS wallpaper), padding/corner/shadow, text annotations, keystroke overlay
- Export: compositor → raw RGBA → bundled ffmpeg → h264 mp4 with re-timed audio (atrim/atempo/concat); GIF via two-pass palettegif
- Projects save/reopen as `.openscreen` bundles; 3-2-1 record countdown; permission banners for Screen Recording / Accessibility

## Develop

```sh
cd electron
npm install
npm test            # model-layer unit tests
npm run build       # iOS capture helper (swiftc) + main (tsc) + renderer (vite)
npm run electron:dev
```

The helper needs Xcode's command line tools (`xcode-select --install`). To record an iPhone or iPad: plug it in with a cable, unlock it, tap Trust, and allow Camera access for OpenScreen when macOS asks.

ffmpeg on PATH (`brew install ffmpeg`) for MP4/GIF export; `brew install whisper-cpp` for transcription. `npm run dist` builds a dmg + zip with bundled ffmpeg.

## Known gaps / next

- Signing + notarization: config is staged (hardened runtime, camera/mic entitlements) — needs an Apple Developer ID cert, then flip `mac.notarize` and set `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`
- Auto-update: wired via electron-updater → GitHub Releases (`tszaks/openscreen`); goes live on the first published release
- Windows/Linux ports
- Whisper binary isn't bundled in the dmg yet (model downloads automatically; binary needs `brew install whisper-cpp`)
