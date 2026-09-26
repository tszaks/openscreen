import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const api = {
  listSources: () => ipcRenderer.invoke('sources:list'),
  permissionsStatus: () => ipcRenderer.invoke('permissions:status'),
  openScreenSettings: () => ipcRenderer.invoke('permissions:openScreenSettings'),
  startRecording: (sourceId: string) => ipcRenderer.invoke('recording:start', sourceId),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  saveBundle: (videoBytes: ArrayBuffer, cursor: unknown, project: unknown, camBytes?: ArrayBuffer, keys?: unknown) =>
    ipcRenderer.invoke('bundle:save', { videoBytes, camBytes, cursor, project, keys }),
  saveBundleWithVideoFile: (dir: string, cursor: unknown, project: unknown, camBytes?: ArrayBuffer, keys?: unknown) =>
    ipcRenderer.invoke('bundle:saveWithVideoFile', { dir, camBytes, cursor, project, keys }),
  iosList: () => ipcRenderer.invoke('ios:list'),
  iosStart: (deviceId: string) => ipcRenderer.invoke('ios:start', deviceId),
  iosStop: () => ipcRenderer.invoke('ios:stop'),
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
  exportBegin: (outPath: string, w: number, h: number, fps: number, audioIn?: string, audioClips?: unknown, clicks?: number[], voiceCleanup?: boolean) =>
    ipcRenderer.invoke('export:begin', { outPath, w, h, fps, audioIn, audioClips, clicks, voiceCleanup }),
  exportFrame: (bytes: ArrayBuffer) => ipcRenderer.invoke('export:frame', bytes),
  exportEnd: () => ipcRenderer.invoke('export:end'),
  exportGif: (inMp4: string, outGif: string) => ipcRenderer.invoke('export:gif', { inMp4, outGif }),
  setMenuPhase: (phase: string, bundleDir?: string) => ipcRenderer.send('menu:phase', { phase, bundleDir }),
  onMenu: (cb: (action: string) => void) => {
    const listener = (_e: IpcRendererEvent, action: string) => cb(action);
    ipcRenderer.on('menu:action', listener);
    return () => {
      ipcRenderer.removeListener('menu:action', listener);
    };
  },
};

export type OpenScreenApi = typeof api;

contextBridge.exposeInMainWorld('openscreen', api);
