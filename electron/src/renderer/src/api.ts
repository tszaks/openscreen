import type { CursorSample, KeystrokeSample, Project, TranscriptWord, WaitRange } from '../../shared/types';
import type { TapSuggestion } from '../../shared/taps';
import type { IosDevice, IosFinished, IosPreview, IosWarning } from '../../shared/iosCapture';
import type { ContextMenuItem, MenuAction, MenuPhase } from '../../shared/menu';
import type { PresetId } from '../../shared/exportPresets';
import type { MusicInput } from '../../shared/audioTracks';

export type { IosDevice, IosPreview };

/** What bundle:open and bundle:openDir resolve with. */
export interface OpenedBundle {
  bundleDir: string;
  project: Project;
  cursor: CursorSample[];
  keys: KeystrokeSample[];
  videoPath: string;
  camPath?: string;
  videoUrl: string;
  camUrl?: string;
}

export interface SourceInfo {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** desktopCapturer display_id for screens (may be missing). */
  displayId?: string;
  thumbnailDataUrl: string;
}

/** A saved take: the project as written (with the file's real duration). */
export interface SavedBundle {
  dir: string;
  project: Project;
  videoUrl: string;
  camUrl?: string;
}

declare global {
  interface Window {
    openscreen: {
      listSources(): Promise<SourceInfo[]>;
      permissionsStatus(): Promise<{ screen: string; hooks: boolean }>;
      openScreenSettings(): Promise<boolean>;
      /** False once a window or display being recorded no longer exists. */
      sourceAlive(sourceId: string): Promise<boolean>;
      /** Shows the macOS Accessibility prompt; resolves true if already granted. */
      requestAccessibility(): Promise<boolean>;
      requestCamera(): Promise<boolean>;
      /** Quit and reopen (macOS applies a Screen Recording grant only then). */
      relaunch(): Promise<void>;
      /** What is running that closing/quitting would throw away, or null. */
      setBusy(reason: 'recording' | 'saving' | 'exporting' | null): void;
      /** Starts cursor tracking; `startedAtMs` is the epoch time of its t=0. */
      startRecording(sourceId: string, displayId?: string): Promise<{ startedAtMs: number; hooks: boolean }>;
      /** Stops tracking; samples are shifted so t=0 is `videoStartedAtMs`. */
      stopRecording(videoStartedAtMs?: number): Promise<{ samples: CursorSample[]; keys: KeystrokeSample[] }>;
      saveBundle(videoBytes: ArrayBuffer, cursor: CursorSample[], project: Project, camBytes?: ArrayBuffer, keys?: KeystrokeSample[]): Promise<SavedBundle>;
      saveBundleWithVideoFile(dir: string, cursor: CursorSample[], project: Project, camBytes?: ArrayBuffer, keys?: KeystrokeSample[]): Promise<SavedBundle>;
      /** Wired iPhone/iPad screens. `ready` is false until the helper's first scan. */
      /** `warning` is set mid-take (e.g. "stalled" when the phone may be locked). */
      iosList(): Promise<{ devices: IosDevice[]; ready: boolean; error: string | null; warning: IosWarning | null }>;
      /** Starts recording into a new bundle's screen.mov; resolves on the first frame. */
      iosStart(deviceId: string): Promise<{ bundleDir: string; width: number; height: number }>;
      /** `partial` when the take failed but its file still plays. */
      iosStop(): Promise<IosFinished & { partial?: boolean }>;
      /** Show a device live; resolves with the preview's state. Frames and
       *  state changes arrive through onIosPreviewFrame/onIosPreviewState. */
      iosPreview(deviceId: string): Promise<IosPreview | null>;
      /** Stop the preview (during a take, once the take ends). */
      iosUnpreview(): Promise<boolean>;
      onIosPreviewState(cb: (p: IosPreview | null) => void): () => void;
      /** A JPEG of the previewed device's screen, ~360 px, up to ~12 a second. */
      onIosPreviewFrame(cb: (f: { id: string; jpeg: Uint8Array }) => void): () => void;
      /** Give interrupted takes a project so they open; resolves with their bundles. */
      recoverInterrupted(): Promise<string[]>;
      /** Open a bundle in the recordings folder by path. */
      openBundleDir(dir: string): Promise<OpenedBundle>;
      /** Remove a take's bundle that never got a project.json. */
      discardBundle(dir: string): Promise<boolean>;
      /** A take ended by itself (cable pulled, helper died); returns the unsubscribe. */
      onIosEnded(cb: (e: { message: string | null }) => void): () => void;
      openBundle(): Promise<OpenedBundle | null>;
      saveProject(dir: string, project: Project): Promise<boolean>;
      writeText(path: string, text: string): Promise<boolean>;
      displays(): Promise<{ id: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number }[]>;
      pickBackground(): Promise<string | null>;
      wallpaperPath(): Promise<string | null>;
      /** A path Chromium can decode (HEIC becomes a cached JPEG); null if conversion failed. */
      prepareBackground(path: string): Promise<string | null>;
      transcribe(dir: string, videoFile: string): Promise<{ start: number; end: number; text: string; words: TranscriptWord[] }[]>;
      detectSilences(dir: string, videoFile: string, thresholdDb?: number, minDur?: number): Promise<{ start: number; end: number }[]>;
      /** Tap/swipe suggestions and still stretches (source seconds) for a phone recording. */
      analyzeTaps(dir: string, videoFile: string): Promise<{ taps: TapSuggestion[]; deadTime: WaitRange[] }>;
      audioPeaks(dir: string, videoFile: string, buckets?: number): Promise<number[]>;
      /** Pick a music or voiceover file and copy it into the bundle's audio/ folder; null when cancelled. */
      importAudio(dir: string): Promise<{ id: string; file: string; name: string; duration: number } | null>;
      /** Waveform of a sound file inside the bundle (whole file). */
      audioFilePeaks(dir: string, file: string, buckets?: number): Promise<number[]>;
      exportBegin(outPath: string, w: number, h: number, fps: number, audioIn: string | undefined, audioClips: { start: number; end: number; speed: number }[] | undefined, clicks: number[] | undefined, voiceCleanup: boolean, duration: number, master?: boolean, music?: MusicInput[], duck?: { start: number; end: number }[]): Promise<boolean>;
      /** Rejects with ffmpeg's reason once ffmpeg has stopped. */
      exportFrame(bytes: ArrayBuffer): Promise<boolean>;
      /** Finishes the file; rejects (and deletes it) when the encode failed. */
      exportEnd(): Promise<boolean>;
      /** Stops ffmpeg and deletes the partial file. */
      exportAbort(): Promise<boolean>;
      /** Converts inMp4 to outGif, then deletes inMp4. */
      exportGif(inMp4: string, outGif: string): Promise<boolean>;
      /** Save dialog for the export; null when cancelled. */
      /** `name`: the project's display name, for the suggested file name. */
      exportPickPath(bundleDir: string, kind: 'mp4' | 'gif', name?: string): Promise<string | null>;
      exportReveal(path: string): Promise<boolean>;
      /** Hide OpenScreen's window from screen capture (during countdown and recording). */
      setCaptureShield(on: boolean): void;
      /** Folder picker for a multi-format export; null when cancelled. */
      exportPickFolder(bundleDir: string, name?: string): Promise<string | null>;
      /** A temp path for a rendered master (.mov). */
      exportMasterPath(key: string): Promise<string>;
      /** Deletes a master made by exportMasterPath. */
      exportDiscardMaster(path: string): Promise<boolean>;
      exportHasAudio(path: string): Promise<boolean>;
      /** Transcodes a master into one preset's files; resolves with their paths.
       *  Rejects with ffmpeg's reason, or 'cancelled' after exportAbort. */
      exportTranscode(presetId: PresetId, input: string, outBase: string, duration: number): Promise<string[]>;
      /** Subscribe to transcode progress (0..1); returns the unsubscribe. */
      onTranscodeProgress(cb: (e: { presetId: PresetId; fraction: number }) => void): () => void;
      /** project.json changed on disk (not by our own save); returns the unsubscribe. */
      watchProject(dir: string, cb: (text: string) => void): () => void;
      /** The bundle given as `--open <bundle>` on the command line, or null. */
      openOnLaunch(): Promise<string | null>;
      /** The headless export job (`OpenScreen --export`), or null for a normal launch. */
      headlessJob(): Promise<{ bundleDir: string; out: string; gif: boolean; presets?: string[] } | null>;
      /** Open the headless job's bundle (it may be outside the recordings folder). */
      headlessOpen(): Promise<OpenedBundle>;
      headlessProgress(done: number, total: number, detail: string): void;
      headlessDone(result: { ok: boolean; out?: string; files?: string[]; frames?: number; seconds?: number; error?: string }): void;
      /** Pop a native right-click menu; resolves with the picked item's id, or null. */
      showContextMenu(items: ContextMenuItem[]): Promise<string | null>;
      /** Tell main what is on screen, so the menu enables what applies. */
      setMenuPhase(phase: MenuPhase, bundleDir?: string): void;
      /** Subscribe to app-menu clicks; returns the unsubscribe. */
      onMenu(cb: (action: MenuAction) => void): () => void;
    };
  }
}

export const api = window.openscreen;
