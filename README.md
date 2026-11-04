<div align="center">

<img src="electron/build/icon.png" width="128" height="128" alt="OpenScreen icon">

# OpenScreen

**Polished iPhone, iPad and Mac demo videos, recorded, edited and exported in minutes.**

[![Download for macOS](https://img.shields.io/badge/Download-macOS-111111?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/tszaks/openscreen/releases/latest)

[![Latest release](https://img.shields.io/github/v/release/tszaks/openscreen?label=release&color=FF8A3D)](https://github.com/tszaks/openscreen/releases/latest)
[![CI](https://github.com/tszaks/openscreen/actions/workflows/ci.yml/badge.svg)](https://github.com/tszaks/openscreen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Apple silicon](https://img.shields.io/badge/Mac-Apple%20silicon-lightgrey)

</div>

<p align="center">
  <img src="docs/images/editor.png" alt="The OpenScreen editor with an iPhone recording, a device frame, a backdrop and detected taps on the timeline" width="900">
</p>

OpenScreen is a free, open-source screen recorder for Mac, built for app demos. Plug in an iPhone with a cable and record it, or record your Mac's screen. OpenScreen finds every tap, zooms in where the action is, frames the device and exports a video that's ready for the App Store, social media or your website.

## Features

**iPhone and iPad, over a cable**
- Record a wired iPhone or iPad with a live preview. The status bar switches to Apple's clean 9:41 demo look while you record.
- **Automatic tap detection.** Taps, swipes, long presses and typing are found from the video itself and shown as ripples you can move or remove.
- **Zoom to tap.** The camera glides in on each tap and back out once the screen settles.
- **Device frames** for current iPhone and iPad models, in their real finishes. The model is detected from the recording.

**Mac screen recording**
- Record a display or a window, with your microphone and an optional camera overlay.
- Smooth auto-zoom on clicks and where your cursor lingers, with natural easing.
- Cursor smoothing, click ripples and a keystroke overlay.

**A full editor**
- A native Mac design in light and dark, following your system appearance.
- Split, trim, reorder and change the speed of clips, with each clip's frames shown on the timeline. Undo everything.
- A resizable workspace and a zoomable timeline: pinch to work down to a fraction of a second.
- 24 backdrops, plus your own images or desktop wallpaper.
- Captions with on-device transcription, transcript editing, and smart cutting of silences and filler words.
- Right-click menus, project naming, and a one-step reset back to the original recording.

**Export anywhere**
- App Store previews at Apple's exact specs (886 × 1920, 30 fps).
- Reels, TikTok and Shorts (9:16), feed (4:5), square and widescreen layouts, with optional title cards.
- Looping landing-page videos (MP4 + WebM + poster) and GIFs.
- Several formats in one click.

## Install

1. Download **OpenScreen** from the [latest release](https://github.com/tszaks/openscreen/releases/latest) and drag it to Applications.
2. Open it. It's signed and notarized by Apple, and it keeps itself up to date.

**Requirements:** a Mac with Apple silicon.

**To record an iPhone or iPad:** connect it with a data cable, unlock it, tap **Trust**, and allow Camera access for OpenScreen when macOS asks.

**For captions (optional):** `brew install whisper-cpp`. The speech model downloads automatically the first time.

## Automate it

Everything in the editor can also be driven from the command line, so an agent or a script can record a phone, review the take, edit it and export it without opening a window:

```sh
node electron/scripts/openscreen-agent.mjs record start
node electron/scripts/openscreen-agent.mjs record stop
node electron/scripts/openscreen-agent.mjs polish latest --style clean
node electron/scripts/openscreen-agent.mjs export latest --out demo.mp4
```

Every command prints one JSON object. See [AGENTS.md](AGENTS.md) for the full reference.

## Build from source

```sh
git clone https://github.com/tszaks/openscreen.git
cd openscreen/electron
npm install
npm test               # unit tests
npm run electron:dev   # build and launch
```

You'll need Node.js 22.12 or later, and Xcode's command line tools (`xcode-select --install`) for the iPhone capture helper. For exports during development, install ffmpeg (`brew install ffmpeg`); release builds bundle it.

How it fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## FAQ

**Does OpenScreen phone home?**
One thing does: the packaged app checks GitHub Releases for a new version when it starts (`electron-updater`, in `electron/src/main/index.ts`). That request goes to GitHub, not to a server of ours, and there is no analytics or crash reporting. Builds you run from source (`npm run electron:dev`) do not check for updates. The only other network request is the speech model download for captions (see below), and only when you ask for captions for the first time.

**Where do my recordings go?**
Each take is a folder named `rec-<timestamp>.openscreen` in `~/Movies/OpenScreen` (set `OPENSCREEN_RECORDINGS_DIR` to move it). Your original recording is never changed. Edits are saved in `project.json` next to it. Nothing is uploaded.

**Which permissions does it ask for?**
Screen Recording (to record a display or window), Camera (an iPhone or iPad connected by cable shows up as a camera, and the camera overlay uses it), Microphone (only when you turn it on) and Accessibility (for click and keystroke detection on Mac recordings). iPhone recording works without Accessibility.

**How does captioning work?**
Transcription runs on your Mac with `whisper-cpp` (`brew install whisper-cpp`). The first time, OpenScreen downloads the 148 MB `ggml-base.en.bin` model from Hugging Face into `~/models`. Set `OPENSCREEN_WHISPER_MODEL` to use a model you already have. The model is English only.

**Does it run on Intel Macs, Windows or Linux?**
No. Releases are built for Apple silicon Macs only.

## Configuration

These environment variables are optional.

| Variable | What it does | Default |
|---|---|---|
| `OPENSCREEN_RECORDINGS_DIR` | Where recordings are saved and where the agent CLI looks | `~/Movies/OpenScreen` |
| `OPENSCREEN_APP` | Path to an `OpenScreen.app` for the agent CLI's `export` and `open` commands | This checkout's Electron |
| `OPENSCREEN_WHISPER_MODEL` | Path to a whisper.cpp model file for captions | `~/models/ggml-base.en.bin` |

## Contributing

Bug reports, ideas and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first. Security problems go through [SECURITY.md](SECURITY.md). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Docs: [agent guide](AGENTS.md) · [architecture](docs/ARCHITECTURE.md) · [changelog](CHANGELOG.md)

## License

[MIT](LICENSE) © Tyler Szakacs
