import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const api = {
  listSources: () => ipcRenderer.invoke('sources:list'),
  permissionsStatus: () => ipcRenderer.invoke('permissions:status'),
  openScreenSettings: () => ipcRenderer.invoke('permissions:openScreenSettings'),
  sourceAlive: (sourceId: string) => ipcRenderer.invoke('sources:alive', sourceId),
  requestAccessibility: () => ipcRenderer.invoke('permissions:requestAccessibility'),
  requestCamera: () => ipcRenderer.invoke('permissions:requestCamera'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  setBusy: (reason: string | null) => ipcRenderer.send('app:busy', reason),
  startRecording: (sourceId: string, displayId?: string) => ipcRenderer.invoke('recording:start', { sourceId, displayId }),
  stopRecording: (videoStartedAtMs?: number) => ipcRenderer.invoke('recording:stop', { videoStartedAtMs }),
  saveBundle: (videoBytes: ArrayBuffer, cursor: unknown, project: unknown, camBytes?: ArrayBuffer, keys?: unknown) =>
    ipcRenderer.invoke('bundle:save', { videoBytes, camBytes, cursor, project, keys }),
  saveBundleWithVideoFile: (dir: string, cursor: unknown, project: unknown, camBytes?: ArrayBuffer, keys?: unknown) =>
    ipcRenderer.invoke('bundle:saveWithVideoFile', { dir, camBytes, cursor, project, keys }),
  iosList: () => ipcRenderer.invoke('ios:list'),
  iosStart: (deviceId: string) => ipcRenderer.invoke('ios:start', deviceId),
  iosStop: () => ipcRenderer.invoke('ios:stop'),
  discardBundle: (dir: string) => ipcRenderer.invoke('bundle:discard', dir),
  onIosEnded: (cb: (e: { message: string | null }) => void) => {
    const listener = (_e: IpcRendererEvent, ended: { message: string | null }) => cb(ended);
    ipcRenderer.on('ios:ended', listener);
    return () => {
      ipcRenderer.removeListener('ios:ended', listener);
    };
  },
  openBundle: () => ipcRenderer.invoke('bundle:open'),
  saveProject: (dir: string, project: unknown) =>
    ipcRenderer.invoke('bundle:saveProject', { dir, project }),
  writeText: (path: string, text: string) => ipcRenderer.invoke('file:writeText', { path, text }),
  displays: () => ipcRenderer.invoke('display:info'),
  pickBackground: () => ipcRenderer.invoke('background:pick'),
  wallpaperPath: () => ipcRenderer.invoke('background:wallpaper'),
  prepareBackground: (path: string) => ipcRenderer.invoke('background:prepare', path),
  transcribe: (dir: string, videoFile: string) =>
    ipcRenderer.invoke('captions:transcribe', { dir, videoFile }),
  detectSilences: (dir: string, videoFile: string, thresholdDb?: number, minDur?: number) =>
    ipcRenderer.invoke('audio:detectSilences', { dir, videoFile, thresholdDb, minDur }),
  analyzeTaps: (dir: string, videoFile: string) => ipcRenderer.invoke('taps:analyze', { dir, videoFile }),
  audioPeaks: (dir: string, videoFile: string, buckets?: number) =>
    ipcRenderer.invoke('audio:peaks', { dir, videoFile, buckets }),
  exportBegin: (outPath: string, w: number, h: number, fps: number, audioIn?: string, audioClips?: unknown, clicks?: number[], voiceCleanup?: boolean, duration?: number) =>
    ipcRenderer.invoke('export:begin', { outPath, w, h, fps, audioIn, audioClips, clicks, voiceCleanup, duration }),
  exportFrame: (bytes: ArrayBuffer) => ipcRenderer.invoke('export:frame', bytes),
  exportEnd: () => ipcRenderer.invoke('export:end'),
  exportAbort: () => ipcRenderer.invoke('export:abort'),
  exportGif: (inMp4: string, outGif: string) => ipcRenderer.invoke('export:gif', { inMp4, outGif }),
  exportPickPath: (bundleDir: string, kind: 'mp4' | 'gif') => ipcRenderer.invoke('export:pickPath', { bundleDir, kind }),
  exportReveal: (path: string) => ipcRenderer.invoke('export:reveal', path),
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
