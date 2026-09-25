import type { CursorSample, Project } from '../../shared/types';

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
      startRecording(sourceId: string): Promise<boolean>;
      stopRecording(): Promise<CursorSample[]>;
      saveBundle(videoBytes: ArrayBuffer, cursor: CursorSample[], project: Project): Promise<string>;
      displays(): Promise<{ id: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number }[]>;
      exportBegin(outPath: string, w: number, h: number, fps: number, audioIn?: string): Promise<boolean>;
      exportFrame(bytes: ArrayBuffer): Promise<boolean>;
      exportEnd(): Promise<boolean>;
    };
  }
}

export const api = window.openscreen;
