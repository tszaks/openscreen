import { app, BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
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
    async (_e, args: { videoBytes: ArrayBuffer; cursor: CursorSample[]; project: Project }) => {
      const dir = join(recordingsRoot(), `rec-${Date.now()}.openscreen`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'screen.webm'), Buffer.from(args.videoBytes));
      writeFileSync(join(dir, 'cursor.json'), JSON.stringify({ samples: args.cursor }, null, 2));
      writeFileSync(join(dir, 'project.json'), JSON.stringify(args.project, null, 2));
      return dir;
    },
  );

  // ffmpeg re-encode: pipe rendered RGBA frames → h264 mp4. The renderer
  // sends raw frame buffers; main streams them into ffmpeg stdin.
  ipcMain.handle('export:begin', async (_e, args: { outPath: string; w: number; h: number; fps: number; audioIn?: string }) => {
    const { spawn } = await import('node:child_process');
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
    const ff = spawn('ffmpeg', argv);
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
