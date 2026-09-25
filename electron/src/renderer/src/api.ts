import type { CursorSample, KeystrokeSample, Project } from '../../shared/types';

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
      openBundle(): Promise<{ bundleDir: string; project: Project; cursor: CursorSample[]; keys: KeystrokeSample[]; videoPath: string; camPath?: string } | null>;
      saveProject(dir: string, project: Project): Promise<boolean>;
      writeText(path: string, text: string): Promise<boolean>;
      displays(): Promise<{ id: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number }[]>;
      pickBackground(): Promise<string | null>;
      wallpaperPath(): Promise<string | null>;
      transcribe(dir: string, videoFile: string): Promise<{ start: number; end: number; text: string }[]>;
      detectSilences(dir: string, videoFile: string, thresholdDb?: number, minDur?: number): Promise<{ start: number; end: number }[]>;
      audioPeaks(dir: string, videoFile: string, buckets?: number): Promise<number[]>;
      exportBegin(outPath: string, w: number, h: number, fps: number, audioIn?: string, audioClips?: { start: number; end: number; speed: number }[], clicks?: number[]): Promise<boolean>;
      exportFrame(bytes: ArrayBuffer): Promise<boolean>;
      exportEnd(): Promise<boolean>;
      exportGif(inMp4: string, outGif: string): Promise<boolean>;
    };
  }
}

export const api = window.openscreen;
