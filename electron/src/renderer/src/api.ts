import type { CursorSample, KeystrokeSample, Project, TranscriptWord } from '../../shared/types';
import type { IosDevice, IosFinished, IosWarning } from '../../shared/iosCapture';
import type { MenuAction, MenuPhase } from '../../shared/menu';

export type { IosDevice };

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
      /** Remove a take's bundle that never got a project.json. */
      discardBundle(dir: string): Promise<boolean>;
      /** A take ended by itself (cable pulled, helper died); returns the unsubscribe. */
      onIosEnded(cb: (e: { message: string | null }) => void): () => void;
      openBundle(): Promise<{ bundleDir: string; project: Project; cursor: CursorSample[]; keys: KeystrokeSample[]; videoPath: string; camPath?: string; videoUrl: string; camUrl?: string } | null>;
      saveProject(dir: string, project: Project): Promise<boolean>;
      writeText(path: string, text: string): Promise<boolean>;
      displays(): Promise<{ id: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number }[]>;
      pickBackground(): Promise<string | null>;
      wallpaperPath(): Promise<string | null>;
      /** A path Chromium can decode (HEIC becomes a cached JPEG); null if conversion failed. */
      prepareBackground(path: string): Promise<string | null>;
      transcribe(dir: string, videoFile: string): Promise<{ start: number; end: number; text: string; words: TranscriptWord[] }[]>;
      detectSilences(dir: string, videoFile: string, thresholdDb?: number, minDur?: number): Promise<{ start: number; end: number }[]>;
      audioPeaks(dir: string, videoFile: string, buckets?: number): Promise<number[]>;
      exportBegin(outPath: string, w: number, h: number, fps: number, audioIn: string | undefined, audioClips: { start: number; end: number; speed: number }[] | undefined, clicks: number[] | undefined, voiceCleanup: boolean, duration: number): Promise<boolean>;
      /** Rejects with ffmpeg's reason once ffmpeg has stopped. */
      exportFrame(bytes: ArrayBuffer): Promise<boolean>;
      /** Finishes the file; rejects (and deletes it) when the encode failed. */
      exportEnd(): Promise<boolean>;
      /** Stops ffmpeg and deletes the partial file. */
      exportAbort(): Promise<boolean>;
      /** Converts inMp4 to outGif, then deletes inMp4. */
      exportGif(inMp4: string, outGif: string): Promise<boolean>;
      /** Save dialog for the export; null when cancelled. */
      exportPickPath(bundleDir: string, kind: 'mp4' | 'gif'): Promise<string | null>;
      exportReveal(path: string): Promise<boolean>;
      /** Tell main what is on screen, so the menu enables what applies. */
      setMenuPhase(phase: MenuPhase, bundleDir?: string): void;
      /** Subscribe to app-menu clicks; returns the unsubscribe. */
      onMenu(cb: (action: MenuAction) => void): () => void;
    };
  }
}

export const api = window.openscreen;
