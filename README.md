# openscreen

An open-source screen recorder in the spirit of Screen Studio, with polished auto-zoom and cursor effects. Recording iPhone and iPad screens is the headline feature.

## Status

Early scaffold — capture pipeline, cursor smoothing, zoom planning, timeline editing, compositor, and exporter are implemented as SwiftPM modules with tests. The SwiftUI app shell (source picker → recording → editor → export) is wired up.

## Architecture

SwiftPM multi-module package so contributors can work module-by-module:

| Module | Job |
|---|---|
| `OpenScreenCore` | Project/bundle model, geometry math |
| `CaptureKit` | ScreenCaptureKit + AVFoundation recorders, cursor monitor, iOS device capture |
| `CursorKit` | Cursor path smoothing (Catmull-Rom), click clustering, auto-zoom planning |
| `RenderKit` | Background/frame/cursor compositor, editor preview renderer |
| `EditKit` | Timeline: split, trim, speed, reorder clips |
| `ExportKit` | Frame-accurate offline render → mp4 |
| `CaptionsKit` | On-device speech → caption cues, SRT/VTT writers |
| `AppFeature` | SwiftUI shell: picker, recording HUD, editor, export |

The app target is generated with [xcodegen](https://github.com/yonaskolb/XcodeGen) (`project.yml`) and links the `AppFeature` product from the local package.

## Build & test

```sh
swift build          # all modules
swift test           # unit tests (no screen-recording permission needed)
xcodegen generate    # regenerate OpenScreen.xcodeproj
xcodebuild -project OpenScreen.xcodeproj -scheme OpenScreen build
```

On first run macOS will prompt for Screen Recording permission; camera/mic prompts appear when those toggles are on. The **Synthetic demo** source exercises the full pipeline without any permissions.

## Layout

- `SPEC.md` — feature matrix, architecture decisions, milestones
- `Sources/` — SwiftPM modules
- `Tests/` — unit tests for core math, cursor, and timeline
- `App/OpenScreenApp/` — app entry point, Info.plist, entitlements
- `project.yml` — xcodegen spec for the app shell
