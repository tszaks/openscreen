# Changelog

All notable changes to OpenScreen are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and OpenScreen uses [Semantic Versioning](https://semver.org/).

Versions 1.5.0 and 1.5.1 were merged to `main` but have no tag or GitHub release yet. The latest published release is 1.4.1.

## [Unreleased]

## [1.5.1] - 2026-10-15

### Added
- Undo toasts after Reset and other destructive edits.

### Changed
- Toasts sit in the preview area, close with Esc only when hovered or focused, and drop their Undo as soon as it is stale.

## [1.5.0] - 2026-10-01

### Added
- Record the Mac screen and an iPhone or iPad together. The phone is a layer with side-by-side and corner layouts.
- A free-position camera bubble with snap guides, Round and Square shapes, and Small and Large sizes.
- Move and resize the recording, the camera, the phone, text and the title card by hand, with one stacking order for all layers.
- Import Video: bring in an existing video from the File menu, the toolbar, a drop on the window, or `import` in the agent CLI.
- A "Just me" camera source.

## [1.4.1] - 2026-10-01

### Added
- Cursor tab: a Show cursor switch and an Opacity slider.

## [1.4.0] - 2026-10-01

### Added
- A music and voiceover track under the recording.
- Solid color backgrounds with a color picker.
- A timeline switch for automatic zooms.
- A new app icon.

## [1.3.0] - 2026-10-01

### Added
- Apple-style redesign of the editor, with light and dark appearance.
- Recordings with no audio track are handled.

### Changed
- Electron updated from 33 to 41 for security fixes. Node.js 22.12 or later is now required to build.

## [1.2.0] - 2026-10-01

### Added
- Resizable inspector and timeline, timeline zoom, and right-click menus.
- 20 backdrop presets grouped Soft, Dark, Light and Vivid.
- Reset Project, and rename a project by double-clicking its title.

## [1.1.1] - 2026-09-30

### Fixed
- Social-preset export no longer fails on silent recordings.

## [1.1.0] - 2026-09-30

### Added
- Agent editing: a command-line entry point to record, review, edit and export, headless export, and live reload of a project edited from outside.

### Fixed
- Transcription skips silent recordings so it cannot invent captions.

## [1.0.0] - 2026-09-26

First public release: wired iPhone and iPad recording, automatic tap detection with zoom to tap, device frames, Mac screen recording, and export presets. Signed, notarized builds with updates from GitHub Releases.

[Unreleased]: https://github.com/tszaks/openscreen/compare/v1.4.1...HEAD
[1.4.1]: https://github.com/tszaks/openscreen/releases/tag/v1.4.1
[1.4.0]: https://github.com/tszaks/openscreen/releases/tag/v1.4.0
[1.3.0]: https://github.com/tszaks/openscreen/releases/tag/v1.3.0
[1.2.0]: https://github.com/tszaks/openscreen/releases/tag/v1.2.0
[1.1.1]: https://github.com/tszaks/openscreen/releases/tag/v1.1.1
[1.1.0]: https://github.com/tszaks/openscreen/releases/tag/v1.1.0
[1.0.0]: https://github.com/tszaks/openscreen/releases/tag/v1.0.0
