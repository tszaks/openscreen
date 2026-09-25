import { contextBridge, ipcRenderer } from 'electron';

const api = {
  listSources: () => ipcRenderer.invoke('sources:list'),
  startRecording: (sourceId: string) => ipcRenderer.invoke('recording:start', sourceId),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  saveBundle: (videoBytes: ArrayBuffer, cursor: unknown, project: unknown) =>
    ipcRenderer.invoke('bundle:save', { videoBytes, cursor, project }),
  displays: () => ipcRenderer.invoke('display:info'),
  exportBegin: (outPath: string, w: number, h: number, fps: number) =>
    ipcRenderer.invoke('export:begin', { outPath, w, h, fps }),
  exportFrame: (bytes: ArrayBuffer) => ipcRenderer.invoke('export:frame', bytes),
  exportEnd: () => ipcRenderer.invoke('export:end'),
};

export type OpenScreenApi = typeof api;

contextBridge.exposeInMainWorld('openscreen', api);
