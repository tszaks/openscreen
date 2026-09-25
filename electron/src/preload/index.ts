import { contextBridge, ipcRenderer } from 'electron';

const api = {
  listSources: () => ipcRenderer.invoke('sources:list'),
  permissionsStatus: () => ipcRenderer.invoke('permissions:status'),
  openScreenSettings: () => ipcRenderer.invoke('permissions:openScreenSettings'),
  startRecording: (sourceId: string) => ipcRenderer.invoke('recording:start', sourceId),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  saveBundle: (videoBytes: ArrayBuffer, cursor: unknown, project: unknown, camBytes?: ArrayBuffer, keys?: unknown) =>
    ipcRenderer.invoke('bundle:save', { videoBytes, camBytes, cursor, project, keys }),
  openBundle: () => ipcRenderer.invoke('bundle:open'),
  saveProject: (dir: string, project: unknown) =>
    ipcRenderer.invoke('bundle:saveProject', { dir, project }),
  writeText: (path: string, text: string) => ipcRenderer.invoke('file:writeText', { path, text }),
  displays: () => ipcRenderer.invoke('display:info'),
  pickBackground: () => ipcRenderer.invoke('background:pick'),
  wallpaperPath: () => ipcRenderer.invoke('background:wallpaper'),
  transcribe: (dir: string, videoFile: string) =>
    ipcRenderer.invoke('captions:transcribe', { dir, videoFile }),
  detectSilences: (dir: string, videoFile: string, thresholdDb?: number, minDur?: number) =>
    ipcRenderer.invoke('audio:detectSilences', { dir, videoFile, thresholdDb, minDur }),
  audioPeaks: (dir: string, videoFile: string, buckets?: number) =>
    ipcRenderer.invoke('audio:peaks', { dir, videoFile, buckets }),
  exportBegin: (outPath: string, w: number, h: number, fps: number, audioIn?: string, audioClips?: unknown, clicks?: number[]) =>
    ipcRenderer.invoke('export:begin', { outPath, w, h, fps, audioIn, audioClips, clicks }),
  exportFrame: (bytes: ArrayBuffer) => ipcRenderer.invoke('export:frame', bytes),
  exportEnd: () => ipcRenderer.invoke('export:end'),
  exportGif: (inMp4: string, outGif: string) => ipcRenderer.invoke('export:gif', { inMp4, outGif }),
};

export type OpenScreenApi = typeof api;

contextBridge.exposeInMainWorld('openscreen', api);
