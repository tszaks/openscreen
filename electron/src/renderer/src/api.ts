import type { CursorSample, KeystrokeSample, Project, TranscriptWord } from '../../shared/types';
import type { IosDevice, IosFinished } from '../../shared/iosCapture';

export type { IosDevice };

export interface SourceInfo {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnailDataUrl: string;
}

declare global {
  interface Window {
    openscreen: {
      listSources(): Promise<SourceInfo[]>;
      permissionsStatus(): Promise<{ screen: string; hooks: boolean }>;
      openScreenSettings(): Promise<boolean>;
      startRecording(sourceId: string): Promise<boolean>;
      stopRecording(): Promise<{ samples: CursorSample[]; keys: KeystrokeSample[] }>;
      saveBundle(videoBytes: ArrayBuffer, cursor: CursorSample[], project: Project, camBytes?: ArrayBuffer, keys?: KeystrokeSample[]): Promise<string>;
      saveBundleWithVideoFile(dir: string, cursor: CursorSample[], project: Project, camBytes?: ArrayBuffer, keys?: KeystrokeSample[]): Promise<string>;
      /** Wired iPhone/iPad screens. `ready` is false until the helper's first scan. */
      iosList(): Promise<{ devices: IosDevice[]; ready: boolean; error: string | null }>;
      /** Starts recording into a new bundle's screen.mov; resolves on the first frame. */
      iosStart(deviceId: string): Promise<{ bundleDir: string; width: number; height: number }>;
      iosStop(): Promise<IosFinished>;
      openBundle(): Promise<{ bundleDir: string; project: Project; cursor: CursorSample[]; keys: KeystrokeSample[]; videoPath: string; camPath?: string } | null>;
      saveProject(dir: string, project: Project): Promise<boolean>;
      writeText(path: string, text: string): Promise<boolean>;
      displays(): Promise<{ id: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number }[]>;
      pickBackground(): Promise<string | null>;
      wallpaperPath(): Promise<string | null>;
      transcribe(dir: string, videoFile: string): Promise<{ start: number; end: number; text: string; words: TranscriptWord[] }[]>;
      detectSilences(dir: string, videoFile: string, thresholdDb?: number, minDur?: number): Promise<{ start: number; end: number }[]>;
      audioPeaks(dir: string, videoFile: string, buckets?: number): Promise<number[]>;
      exportBegin(outPath: string, w: number, h: number, fps: number, audioIn?: string, audioClips?: { start: number; end: number; speed: number }[], clicks?: number[], voiceCleanup?: boolean): Promise<boolean>;
      exportFrame(bytes: ArrayBuffer): Promise<boolean>;
      exportEnd(): Promise<boolean>;
      exportGif(inMp4: string, outGif: string): Promise<boolean>;
    };
  }
}

export const api = window.openscreen;
