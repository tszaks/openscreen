import { contextBridge, ipcRenderer } from 'electron';

const api = {
  listSources: () => ipcRenderer.invoke('sources:list'),
  startRecording: (sourceId: string) => ipcRenderer.invoke('recording:start', sourceId),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  saveBundle: (videoBytes: ArrayBuffer, cursor: unknown, project: unknown, camBytes?: ArrayBuffer) =>
    ipcRenderer.invoke('bundle:save', { videoBytes, camBytes, cursor, project }),
  openBundle: () => ipcRenderer.invoke('bundle:open'),
  saveProject: (dir: string, project: unknown) =>
    ipcRenderer.invoke('bundle:saveProject', { dir, project }),
  displays: () => ipcRenderer.invoke('display:info'),
  pickBackground: () => ipcRenderer.invoke('background:pick'),
  wallpaperPath: () => ipcRenderer.invoke('background:wallpaper'),
  transcribe: (dir: string, videoFile: string) =>
    ipcRenderer.invoke('captions:transcribe', { dir, videoFile }),
  exportBegin: (outPath: string, w: number, h: number, fps: number, audioIn?: string) =>
    ipcRenderer.invoke('export:begin', { outPath, w, h, fps, audioIn }),
  exportFrame: (bytes: ArrayBuffer) => ipcRenderer.invoke('export:frame', bytes),
  exportEnd: () => ipcRenderer.invoke('export:end'),
};

export type OpenScreenApi = typeof api;

contextBridge.exposeInMainWorld('openscreen', api);
