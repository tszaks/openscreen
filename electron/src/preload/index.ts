import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

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
  saveBundle: (videoBytes: ArrayBuffer, cursor: unknown, project: unknown, camBytes?: ArrayBuffer, keys?: unknown, phoneDir?: string) =>
    ipcRenderer.invoke('bundle:save', { videoBytes, camBytes, cursor, project, keys, phoneDir }),
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
  importAudio: (dir: string, path?: string) => ipcRenderer.invoke('audio:import', dir, path),
  importPick: () => ipcRenderer.invoke('import:pick'),
  importVideo: (path: string) => ipcRenderer.invoke('import:start', path),
  importCancel: () => ipcRenderer.invoke('import:cancel'),
  onImportProgress: (cb: (p: { stage: 'copy' | 'convert'; fraction: number }) => void) => {
    const listener = (_e: IpcRendererEvent, p: { stage: 'copy' | 'convert'; fraction: number }) => cb(p);
    ipcRenderer.on('import:progress', listener);
    return () => {
      ipcRenderer.removeListener('import:progress', listener);
    };
  },
  /** The path of a File dropped on the window (Electron no longer puts it on File.path). */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  audioFilePeaks: (dir: string, file: string, buckets?: number) => ipcRenderer.invoke('audio:filePeaks', { dir, file, buckets }),
  exportBegin: (outPath: string, w: number, h: number, fps: number, audioIn?: string, audioClips?: unknown, clicks?: number[], voiceCleanup?: boolean, duration?: number, master?: boolean, music?: unknown, duck?: unknown, phone?: unknown) =>
    ipcRenderer.invoke('export:begin', { outPath, w, h, fps, audioIn, audioClips, clicks, voiceCleanup, duration, master, music, duck, phone }),
  exportFrame: (bytes: ArrayBuffer) => ipcRenderer.invoke('export:frame', bytes),
  exportEnd: () => ipcRenderer.invoke('export:end'),
  exportAbort: () => ipcRenderer.invoke('export:abort'),
  exportGif: (inMp4: string, outGif: string) => ipcRenderer.invoke('export:gif', { inMp4, outGif }),
  exportPickPath: (bundleDir: string, kind: 'mp4' | 'gif', name?: string) => ipcRenderer.invoke('export:pickPath', { bundleDir, kind, name }),
  exportReveal: (path: string) => ipcRenderer.invoke('export:reveal', path),
  setCaptureShield: (on: boolean) => ipcRenderer.send('app:captureShield', on),
  monitorShow: (token: string, displayId: string | undefined, size: unknown, spot?: unknown) => ipcRenderer.invoke('monitor:show', { token, displayId, size, spot }),
  monitorMove: (x: number, y: number) => ipcRenderer.send('monitor:move', { x, y }),
  monitorResize: (size: unknown) => ipcRenderer.invoke('monitor:resize', size),
  monitorClose: (token: string) => ipcRenderer.invoke('monitor:close', token),
  exportPickFolder: (bundleDir: string, name?: string) => ipcRenderer.invoke('export:pickFolder', { bundleDir, name }),
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
  showContextMenu: (items: unknown[]) => ipcRenderer.invoke('contextMenu:show', items),
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
