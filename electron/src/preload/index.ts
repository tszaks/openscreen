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
  iosPreview: (deviceId: string) => ipcRenderer.invoke('ios:preview', deviceId),
  iosUnpreview: () => ipcRenderer.invoke('ios:unpreview'),
  onIosPreviewState: (cb: (p: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, p: unknown) => cb(p);
    ipcRenderer.on('ios:previewState', listener);
    return () => {
      ipcRenderer.removeListener('ios:previewState', listener);
    };
  },
  onIosPreviewFrame: (cb: (f: { id: string; jpeg: Uint8Array }) => void) => {
    const listener = (_e: IpcRendererEvent, f: { id: string; jpeg: Uint8Array }) => cb(f);
    ipcRenderer.on('ios:previewFrame', listener);
    return () => {
      ipcRenderer.removeListener('ios:previewFrame', listener);
    };
  },
  recoverInterrupted: () => ipcRenderer.invoke('recovery:scan'),
  openBundleDir: (dir: string) => ipcRenderer.invoke('bundle:openDir', dir),
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
  exportBegin: (outPath: string, w: number, h: number, fps: number, audioIn?: string, audioClips?: unknown, clicks?: number[], voiceCleanup?: boolean, duration?: number, master?: boolean) =>
    ipcRenderer.invoke('export:begin', { outPath, w, h, fps, audioIn, audioClips, clicks, voiceCleanup, duration, master }),
  exportFrame: (bytes: ArrayBuffer) => ipcRenderer.invoke('export:frame', bytes),
  exportEnd: () => ipcRenderer.invoke('export:end'),
  exportAbort: () => ipcRenderer.invoke('export:abort'),
  exportGif: (inMp4: string, outGif: string) => ipcRenderer.invoke('export:gif', { inMp4, outGif }),
  exportPickPath: (bundleDir: string, kind: 'mp4' | 'gif') => ipcRenderer.invoke('export:pickPath', { bundleDir, kind }),
  exportReveal: (path: string) => ipcRenderer.invoke('export:reveal', path),
  setCaptureShield: (on: boolean) => ipcRenderer.send('app:captureShield', on),
  exportPickFolder: (bundleDir: string) => ipcRenderer.invoke('export:pickFolder', { bundleDir }),
  exportMasterPath: (key: string) => ipcRenderer.invoke('export:masterPath', key),
  exportDiscardMaster: (path: string) => ipcRenderer.invoke('export:discardMaster', path),
  exportHasAudio: (path: string) => ipcRenderer.invoke('export:hasAudio', path),
  exportTranscode: (presetId: string, input: string, outBase: string, duration: number) =>
    ipcRenderer.invoke('export:transcode', { presetId, input, outBase, duration }),
  onTranscodeProgress: (cb: (e: { presetId: string; fraction: number }) => void) => {
    const listener = (_e: IpcRendererEvent, p: { presetId: string; fraction: number }) => cb(p);
    ipcRenderer.on('export:transcodeProgress', listener);
    return () => {
      ipcRenderer.removeListener('export:transcodeProgress', listener);
    };
  },
  /** Watch a bundle's project.json for outside changes; returns the unsubscribe. */
  watchProject: (dir: string, cb: (text: string) => void) => {
    const listener = (_e: IpcRendererEvent, p: { dir: string; text: string }) => {
      if (p.dir === dir) cb(p.text);
    };
    ipcRenderer.on('bundle:projectChanged', listener);
    ipcRenderer.send('bundle:watch', dir);
    return () => {
      ipcRenderer.removeListener('bundle:projectChanged', listener);
      ipcRenderer.send('bundle:unwatch', dir);
    };
  },
  /** Headless export: what to open and where to export, or null in the GUI. */
  /** The bundle passed as `--open <bundle>`, or null. */
  openOnLaunch: () => ipcRenderer.invoke('app:openOnLaunch'),
  headlessJob: () => ipcRenderer.invoke('headless:job'),
  headlessOpen: () => ipcRenderer.invoke('headless:open'),
  headlessProgress: (done: number, total: number, detail: string) => ipcRenderer.send('headless:progress', { done, total, detail }),
  headlessDone: (result: unknown) => ipcRenderer.send('headless:done', result),
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
