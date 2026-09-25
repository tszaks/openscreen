# openscreen

An open-source screen recorder in the spirit of Screen Studio — buttery auto-focus zoom on clicks, cursor smoothing, styled backgrounds, editor, captions. Recording iPhone and iPad screens is the headline feature.

## Stack

**Electron + TypeScript + React** — same stack as Screen Studio. The capture/UI layer is Electron; the motion model (autofocus segments, easing, cursor smoothing, timeline mapping, click ripples) is a pure shared library with unit tests — that's where the buttery feel lives.

## Layout

- `electron/` — the app
  - `src/shared/` — pure model layer: `autofocus.ts` (click clusters → focus segments + per-frame camera eval), `easing.ts` (smootherstep/spring curves), `cursor.ts` (Catmull-Rom smoothing), `timeline.ts` (clip ↔ output mapping), `ripples.ts`, `types.ts`
  - `src/main/` — Electron main: window, `desktopCapturer` sources, 120Hz cursor poller + uiohook global clicks, bundle save, ffmpeg export pipe
  - `src/preload/` — contextBridge API
  - `src/renderer/` — React UI: source picker → record HUD → editor (composited canvas preview, timeline with zoom markers, style swatches) → MP4 export
  - `test/` — vitest unit tests for the model layer
- `Modules/`, `App/`, `project.yml` — **legacy** native Swift scaffold kept for reference (SwiftPM modules + SwiftUI shell; the model-layer semantics there mirror `src/shared/`)

## Develop

```sh
cd electron
npm install
npm test            # model-layer unit tests
npm run build       # main (tsc) + renderer (vite)
npm run electron:dev
```

Requires ffmpeg on PATH (`brew install ffmpeg`) for MP4 export.

## What works (verified end-to-end on macOS)

- Screen/window capture via `desktopCapturer` + `getUserMedia` (60fps webm)
- Global cursor track at 120Hz + click events via uiohook
- Auto-focus zoom: clicks → smoothed glide-in → hold → glide-out; consecutive click clusters pan directly (no zoom-out detour)
- Click ripples, software cursor, styled backgrounds, rounded/shadowed frame
- Editor preview renders the fully composited frame; timeline shows zoom markers
- Export: frame-by-frame compositor render → raw RGBA → ffmpeg → h264 mp4

## Known gaps / next

- Wired iPhone capture path (continuity camera enumerate → getUserMedia)
- Audio: recording inputs exist; export passthrough written for 1:1 timelines (Swift side) — Electron port pending
- Captions: SFSpeech→burn-in exists on the Swift side; Electron port pending
- Global click hook needs Accessibility permission (uiohook)
