import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCursorTracker, type CursorTracker } from './cursor';
import type { CursorSample, Project } from '../shared/types';

let win: BrowserWindow | null = null;
let tracker: CursorTracker | null = null;

const recordingsRoot = () =>
  join(app.getPath('videos'), 'OpenScreen');

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'OpenScreen',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  ipcMain.handle('sources:list', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 240, height: 140 },
      fetchWindowIcons: true,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      thumbnailDataUrl: s.thumbnail.toDataURL(),
    }));
  });

  ipcMain.handle('recording:start', async (_e, _sourceId: string) => {
    tracker = createCursorTracker(120);
    await tracker.start();
    return true;
  });

  ipcMain.handle('recording:stop', async () => {
    const samples = tracker?.stop() ?? [];
    tracker = null;
    return samples;
  });

  // Save a finished recording: webm blob + cursor track + project.json.
  ipcMain.handle(
    'bundle:save',
    async (_e, args: { videoBytes: ArrayBuffer; camBytes?: ArrayBuffer; cursor: CursorSample[]; project: Project }) => {
      const dir = join(recordingsRoot(), `rec-${Date.now()}.openscreen`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'screen.webm'), Buffer.from(args.videoBytes));
      if (args.camBytes && args.camBytes.byteLength > 0) {
        writeFileSync(join(dir, 'cam.webm'), Buffer.from(args.camBytes));
      }
      writeFileSync(join(dir, 'cursor.json'), JSON.stringify({ samples: args.cursor }, null, 2));
      writeFileSync(join(dir, 'project.json'), JSON.stringify(args.project, null, 2));
      return dir;
    },
  );

  // Persist editor changes back into an existing bundle.
  ipcMain.handle('bundle:saveProject', async (_e, args: { dir: string; project: Project }) => {
    writeFileSync(join(args.dir, 'project.json'), JSON.stringify(args.project, null, 2));
    return true;
  });

  // Reopen a saved .openscreen bundle in the editor.
  ipcMain.handle('bundle:open', async () => {
    const picked = await dialog.showOpenDialog(win!, {
      title: 'Open recording',
      defaultPath: recordingsRoot(),
      properties: ['openDirectory'],
      filters: [{ name: 'OpenScreen bundles', extensions: ['openscreen'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const dir = picked.filePaths[0];
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    const cursor = JSON.parse(readFileSync(join(dir, 'cursor.json'), 'utf8')).samples ?? [];
    const videoPath = join(dir, project.recording?.screenVideoFile ?? 'screen.webm');
    const camPath = project.recording?.cameraVideoFile
      ? join(dir, project.recording.cameraVideoFile)
      : undefined;
    return { bundleDir: dir, project, cursor, videoPath, camPath };
  });

  // Pick an image file for the background.
  ipcMain.handle('background:pick', async () => {
    const picked = await dialog.showOpenDialog(win!, {
      title: 'Background image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    return picked.canceled ? null : picked.filePaths[0];
  });

  // ffmpeg re-encode: pipe rendered RGBA frames → h264 mp4. The renderer
  // sends raw frame buffers; main streams them into ffmpeg stdin.
  ipcMain.handle('export:begin', async (_e, args: { outPath: string; w: number; h: number; fps: number; audioIn?: string }) => {
    const { spawn } = await import('node:child_process');
    // Prefer the bundled ffmpeg (packaged app), fall back to PATH (dev).
    let ffmpegBin = 'ffmpeg';
    try {
      const mod = await import('ffmpeg-static');
      const p = (mod.default ?? (mod as unknown as string)) as string;
      if (p) ffmpegBin = p.replace('app.asar', 'app.asar.unpacked');
    } catch {}
    const argv = [
      '-y',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${args.w}x${args.h}`,
      '-r', String(args.fps),
      '-i', 'pipe:0',
      // audio passthrough when the timeline is uncut — mux the webm's
      // audio straight through instead of re-encoding silence
      ...(args.audioIn ? ['-i', args.audioIn, '-map', '0:v', '-map', '1:a?', '-c:a', 'aac', '-shortest'] : []),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '18',
      args.outPath,
    ];
    const ff = spawn(ffmpegBin, argv);
    const errChunks: Buffer[] = [];
    ff.stdin.on('error', (e) => console.error('ffmpeg stdin:', e));
    ff.stderr.on('data', (d: Buffer) => {
      errChunks.push(d);
      if (errChunks.length > 30) errChunks.shift();
    });
    ff.on('error', (e) => console.error('ffmpeg spawn:', e));
    ff.on('exit', (code) => {
      if (code !== 0) console.error('ffmpeg exited', code, Buffer.concat(errChunks).toString());
    });
    (globalThis as any).__ffmpeg = ff;
    return true;
  });

  ipcMain.handle('export:frame', async (_e, bytes: ArrayBuffer) => {
    const ff = (globalThis as any).__ffmpeg;
    if (!ff) return false;
    return ff.stdin.write(Buffer.from(bytes));
  });

  ipcMain.handle('export:end', async () => {
    const ff = (globalThis as any).__ffmpeg;
    if (!ff) return false;
    return new Promise<boolean>((resolve) => {
      ff.on('exit', () => resolve(true));
      ff.stdin.end();
    });
  });

  ipcMain.handle('display:info', () =>
    screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      size: d.size,
      scaleFactor: d.scaleFactor,
    })),
  );

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
