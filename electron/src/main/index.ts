import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCursorTracker, type CursorTracker } from './cursor';
import type { CursorSample, Project } from '../shared/types';

let win: BrowserWindow | null = null;
let tracker: CursorTracker | null = null;

const recordingsRoot = () =>
  join(app.getPath('videos'), 'OpenScreen');

const ffmpegPath = async () => {
  try {
    const mod = await import('ffmpeg-static');
    const p = (mod.default ?? (mod as unknown as string)) as string;
    if (p) return p.replace('app.asar', 'app.asar.unpacked');
  } catch {}
  return 'ffmpeg';
};

// Extract 16kHz mono wav from a bundle video for analysis (shared by
// transcription and silence detection).
const extractWav = async (dir: string, videoFile: string) => {
  const { execFile } = await import('node:child_process');
  const wav = join(dir, 'audio.wav');
  const bin = await ffmpegPath();
  await new Promise<void>((resolve, reject) =>
    execFile(
      bin,
      ['-y', '-i', join(dir, videoFile), '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', wav],
      (e) => (e ? reject(e) : resolve()),
    ),
  );
  return wav;
};

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

  // Current macOS desktop wallpaper path (for the 'wallpaper' background).
  ipcMain.handle('background:wallpaper', async () => {
    if (process.platform !== 'darwin') return null;
    const { execFile } = await import('node:child_process');
    return new Promise<string | null>((resolve) => {
      execFile(
        'osascript',
        ['-e', 'tell application "Finder" to get POSIX path of (get desktop picture as alias)'],
        (_err, stdout) => resolve(stdout.trim() || null),
      );
    });
  });

  // Transcribe a bundle's audio via whisper-cli → caption cues (source time).
  ipcMain.handle('captions:transcribe', async (_e, args: { dir: string; videoFile: string }) => {
    const { execFile } = await import('node:child_process');
    const { existsSync, readFileSync } = await import('node:fs');
    const wav = await extractWav(args.dir, args.videoFile);
    const jsonOut = join(args.dir, 'transcript.json');
    const run = (cmd: string, argv: string[]) =>
      new Promise<void>((resolve, reject) =>
        execFile(cmd, argv, (e) => (e ? reject(e) : resolve())),
      );
    const model = process.env.OPENSCREEN_WHISPER_MODEL ?? join(app.getPath('home'), 'models', 'ggml-base.en.bin');
    await run('whisper-cli', [
      '-m', model, '-f', wav, '--output-json', '--output-file', jsonOut.replace(/\.json$/, ''),
      '-t', '4',
    ]);
    if (!existsSync(jsonOut)) throw new Error('whisper produced no output');
    const parsed = JSON.parse(readFileSync(jsonOut, 'utf8'));
    // whisper-cli --output-json emits { transcription: [{ offsets: {from,to}, text }] }
    const segs = parsed.transcription ?? parsed.result ?? [];
    return segs
      .map((s: { offsets?: { from: number; to: number }; timestamps?: { from: string; to: string }; text: string }) => {
        const from = s.offsets?.from ?? 0;
        const to = s.offsets?.to ?? 0;
        return { start: from / 1000, end: to / 1000, text: (s.text ?? '').trim() };
      })
      .filter((c: { start: number; end: number; text: string }) => c.end > c.start && c.text);
  });

  // Silence detection: ffmpeg silencedetect on the bundle audio →
  // [{start,end}] silent ranges in source seconds.
  ipcMain.handle(
    'audio:detectSilences',
    async (_e, args: { dir: string; videoFile: string; thresholdDb?: number; minDur?: number }) => {
      const { execFile } = await import('node:child_process');
      const wav = await extractWav(args.dir, args.videoFile);
      const noise = `-${Math.abs(args.thresholdDb ?? 35)}dB`;
      const dur = String(args.minDur ?? 0.4);
      const bin = await ffmpegPath();
      const stderr = await new Promise<string>((resolve, reject) =>
        execFile(
          bin,
          ['-i', wav, '-af', `silencedetect=n=${noise}:d=${dur}`, '-f', 'null', '-'],
          (e, _so, se) => (e && !se ? reject(e) : resolve(se ?? '')),
        ),
      );
      const silences: { start: number; end: number }[] = [];
      let cur: number | null = null;
      for (const m of stderr.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
        if (m[1] === 'start') cur = parseFloat(m[2]);
        else if (cur !== null) {
          silences.push({ start: cur, end: parseFloat(m[2]) });
          cur = null;
        }
      }
      return silences;
    },
  );

  // ffmpeg re-encode: pipe rendered RGBA frames → h264 mp4. The renderer
  // sends raw frame buffers; main streams them into ffmpeg stdin.
  ipcMain.handle('export:begin', async (_e, args: { outPath: string; w: number; h: number; fps: number; audioIn?: string }) => {
    const { spawn } = await import('node:child_process');
    const ffmpegBin = await ffmpegPath();
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
