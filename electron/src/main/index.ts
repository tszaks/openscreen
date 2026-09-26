import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, screen, shell, systemPreferences } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCursorTracker, type CursorTracker } from './cursor';
import { startFfmpegJob, type FfmpegJob } from './ffmpegJob';
import { disposeIosHelper, listIosDevices, onIosEnded, startIosRecording, stopIosRecording } from './ios';
import { buildAppMenu } from './menu';
import type { MenuPhase } from '../shared/menu';
import { normalizeProject, type CursorSample, type KeystrokeSample, type Project } from '../shared/types';
import { tokensToWords, type WhisperToken } from '../shared/transcript';
import { buildExportArgs, ffmpegFailure } from '../shared/exportArgs';
import { WALLPAPER_JXA, planWallpaper } from '../shared/wallpaper';
import {
  alignToVideoStart,
  cursorModeFor,
  findWhisperCli,
  correctDuration,
  parseFfmpegDuration,
  parseFfmpegProgressTime,
  parseFfmpegVideoSize,
  partialPath,
  withProbedDuration,
} from '../shared/recording';

// Dev runs take the name from package.json ("openscreen"); the menu wants the product name.
app.setName('OpenScreen');

let win: BrowserWindow | null = null;
let tracker: CursorTracker | null = null;
let exportJob: FfmpegJob | null = null;
let trackerStartedAtMs = 0;
// The in-flight iPhone take's bundle, so a failed take can be salvaged or removed.
let iosBundleDir: string | null = null;

// What the renderer is in the middle of ('recording', 'saving', …), so
// closing or quitting can ask before throwing it away.
let rendererBusy: string | null = null;
let quitConfirmed = false;
// export:begin sets exportJob; export:end/abort clear it.
const exportRunning = () => exportJob !== null;
const busyReason = () => rendererBusy ?? (exportRunning() ? 'exporting' : null);

/** True when nothing is running, or the user chose to throw it away. */
const confirmDiscard = (action: 'close' | 'quit') => {
  const reason = busyReason();
  if (!reason) return true;
  const what =
    reason === 'exporting'
      ? ['An export is still running.', 'it stops the export and leaves an unfinished file']
      : reason === 'saving'
        ? ['A recording is still being saved.', 'the recording may be lost']
        : ['A recording is in progress.', 'the recording is lost'];
  const verb = action === 'quit' ? 'Quit' : 'Close';
  const opts = {
    type: 'warning' as const,
    buttons: ['Keep Working', `${verb} Anyway`],
    defaultId: 0,
    cancelId: 0,
    message: what[0],
    detail: `If you ${verb.toLowerCase()} now, ${what[1]}.`,
  };
  const choice = win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts);
  return choice === 1;
};

/** Stop cursor tracking (and its input hook) if a take is left running. */
const stopTracker = () => {
  tracker?.stop();
  tracker = null;
};

/** ffmpeg's banner for a file (it exits non-zero with no output; that's fine). */
const probe = async (file: string) => {
  const { execFile } = await import('node:child_process');
  const bin = await ffmpegPath();
  return new Promise<string>((resolve) => execFile(bin, ['-hide_banner', '-i', file], (_e, _so, se) => resolve(se ?? '')));
};

/**
 * A file's real duration: from its header, or, when the header has none
 * (MediaRecorder WebM), by reading every packet without decoding.
 */
const probeDuration = async (file: string): Promise<number | null> => {
  const fromHeader = parseFfmpegDuration(await probe(file));
  if (fromHeader !== null) return fromHeader;
  const { execFile } = await import('node:child_process');
  const bin = await ffmpegPath();
  const stderr = await new Promise<string>((resolve) =>
    execFile(bin, ['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'], (_e, _so, se) => resolve(se ?? '')),
  );
  return parseFfmpegProgressTime(stderr);
};

/**
 * MediaRecorder WebM has no duration and no cues. Remux it (stream copy, so
 * it is quick and lossless) so players get a real duration and fast seeks.
 * Returns the probed duration; on any failure the original file is kept.
 */
const finalizeWebm = async (file: string): Promise<number | null> => {
  const { execFile } = await import('node:child_process');
  const bin = await ffmpegPath();
  const raw = file.replace(/\.webm$/, '.raw.webm');
  try {
    renameSync(file, raw);
    await new Promise<void>((resolve, reject) =>
      execFile(bin, ['-y', '-v', 'error', '-i', raw, '-c', 'copy', file], (e) => (e ? reject(e) : resolve())),
    );
    const d = parseFfmpegDuration(await probe(file));
    if (d === null) throw new Error('remuxed file has no duration');
    rmSync(raw, { force: true });
    return d;
  } catch (e) {
    console.error('webm finalize failed, keeping the original:', e);
    if (existsSync(raw)) renameSync(raw, file);
    return probeDuration(file);
  }
};

const fileUrl = (p: string) => pathToFileURL(p).href;

// What the renderer is showing, so the menu enables only what applies.
let menuState: { phase: MenuPhase; bundleDir?: string } = { phase: 'picker' };
const refreshMenu = () => Menu.setApplicationMenu(buildAppMenu(() => win, menuState));

const recordingsRoot = () =>
  join(app.getPath('videos'), 'OpenScreen');

const newBundleDir = () => join(recordingsRoot(), `rec-${Date.now()}.openscreen`);

// Bundle dirs coming back from the renderer must be ones we created.
const isInRecordingsRoot = (dir: string) => {
  const rel = relative(recordingsRoot(), resolve(dir));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

// Write everything but the screen video into a bundle (shared by both save paths).
const writeBundleSidecars = (
  dir: string,
  args: { camBytes?: ArrayBuffer; cursor: CursorSample[]; keys?: KeystrokeSample[]; project: Project },
) => {
  if (args.camBytes && args.camBytes.byteLength > 0) {
    writeFileSync(join(dir, 'cam.webm'), Buffer.from(args.camBytes));
  }
  writeFileSync(join(dir, 'cursor.json'), JSON.stringify({ samples: args.cursor }, null, 2));
  writeFileSync(join(dir, 'keystrokes.json'), JSON.stringify({ keys: args.keys ?? [] }, null, 2));
  writeFileSync(join(dir, 'project.json'), JSON.stringify(args.project, null, 2));
};

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
    minWidth: 1100,
    minHeight: 700,
    title: 'OpenScreen',
    // Hidden title bar: the renderer's top bars are the drag region and leave
    // room on the left for the traffic lights (centered in the 52px bar).
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 19 },
    backgroundColor: '#0E0E10',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(join(__dirname, '../renderer/index.html'));
  win.on('close', (e) => {
    if (!quitConfirmed && !confirmDiscard('close')) e.preventDefault();
  });
  // The take lived in this renderer: stop tracking and any iPhone take.
  const abandonTake = () => {
    rendererBusy = null;
    stopTracker();
    if (iosBundleDir) {
      const dir = iosBundleDir;
      iosBundleDir = null;
      stopIosRecording()
        .catch(() => {})
        .finally(() => rmSync(dir, { recursive: true, force: true }));
    }
  };
  win.webContents.on('render-process-gone', abandonTake);
  win.on('closed', () => {
    abandonTake();
    win = null;
    menuState = { phase: 'picker' };
    refreshMenu();
  });
}

app.whenReady().then(() => {
  refreshMenu();
  ipcMain.on('menu:phase', (_e, next: { phase: MenuPhase; bundleDir?: string }) => {
    menuState = { phase: next.phase, bundleDir: next.bundleDir };
    refreshMenu();
  });

  // Permission status so the UI can warn before a doomed recording:
  // screen capture needs Screen Recording; click/keystroke tracking needs
  // Accessibility (and the uiohook module to load).
  const accessibilityGranted = () =>
    process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false);
  const hooksAvailable = async () => {
    if (!accessibilityGranted()) return false;
    try {
      await import('uiohook-napi');
      return true;
    } catch {
      return false;
    }
  };
  ipcMain.handle('permissions:status', async () => {
    const screen = systemPreferences.getMediaAccessStatus('screen'); // 'granted' | 'denied' | 'not-determined' | 'restricted'
    return { screen, hooks: await hooksAvailable() };
  });

  // Shows macOS's Accessibility prompt (once; after that it only reports).
  ipcMain.handle('permissions:requestAccessibility', () =>
    process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(true),
  );

  // Asks from the app itself so the prompt names OpenScreen. Camera labels
  // stay empty in the renderer until this is granted.
  ipcMain.handle('permissions:requestCamera', async () =>
    process.platform !== 'darwin' || systemPreferences.askForMediaAccess('camera'),
  );

  // macOS only applies a new Screen Recording grant after a relaunch.
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.quit();
  });

  ipcMain.on('app:busy', (_e, reason: string | null) => {
    rendererBusy = reason || null;
  });

  // Keep OpenScreen's own window (countdown, recording card) out of the
  // capture: macOS then omits it from screen and window recordings.
  ipcMain.on('app:captureShield', (_e, on: boolean) => {
    win?.setContentProtection(!!on);
  });

  ipcMain.handle('permissions:openScreenSettings', async () => {
    const { shell } = await import('electron');
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
    return true;
  });

  ipcMain.handle('sources:list', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 640, height: 400 },
      fetchWindowIcons: true,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      displayId: s.display_id || undefined,
      thumbnailDataUrl: s.thumbnail.toDataURL(),
    }));
  });

  // Starts cursor/click tracking for a take. The renderer starts its
  // recorders after this resolves and reports the video's start time on
  // stop, so the samples can be shifted onto the video's clock.
  // Whether a capture source still exists. macOS keeps a closed window's
  // capture track "live" (it just stops sending frames), so the renderer
  // polls this during a take to notice a window or display going away.
  ipcMain.handle('sources:alive', async (_e, sourceId: string) => {
    const types: ('screen' | 'window')[] = [sourceId.startsWith('screen:') ? 'screen' : 'window'];
    try {
      const sources = await desktopCapturer.getSources({ types, thumbnailSize: { width: 0, height: 0 } });
      return sources.some((s) => s.id === sourceId);
    } catch {
      return true; // can't tell; don't end a take on a failed query
    }
  });

  ipcMain.handle('recording:start', async (_e, args: { sourceId: string; displayId?: string }) => {
    stopTracker();
    tracker = createCursorTracker({
      hz: 120,
      mode: cursorModeFor(args.sourceId),
      displayId: args.displayId,
      hooksAllowed: await hooksAvailable(),
    });
    const started = await tracker.start();
    trackerStartedAtMs = started.startedAtMs;
    return started;
  });

  ipcMain.handle('recording:stop', async (_e, args?: { videoStartedAtMs?: number }) => {
    const out = tracker?.stop() ?? { samples: [], keys: [] };
    tracker = null;
    if (!args?.videoStartedAtMs || !trackerStartedAtMs) return out;
    const offset = (args.videoStartedAtMs - trackerStartedAtMs) / 1000;
    return { samples: alignToVideoStart(out.samples, offset), keys: alignToVideoStart(out.keys, offset) };
  });

  // Save a finished recording: webm blob + cursor track + project.json.
  // The duration in project.json comes from the file itself, not a timer.
  ipcMain.handle(
    'bundle:save',
    async (_e, args: { videoBytes: ArrayBuffer; camBytes?: ArrayBuffer; cursor: CursorSample[]; keys?: KeystrokeSample[]; project: Project }) => {
      const dir = newBundleDir();
      mkdirSync(dir, { recursive: true });
      const video = join(dir, 'screen.webm');
      writeFileSync(video, Buffer.from(args.videoBytes));
      const project = withProbedDuration(args.project, await finalizeWebm(video));
      writeBundleSidecars(dir, { ...args, project });
      const cam = join(dir, 'cam.webm');
      if (existsSync(cam)) await finalizeWebm(cam);
      return { dir, project, videoUrl: fileUrl(video), camUrl: existsSync(cam) ? fileUrl(cam) : undefined };
    },
  );

  // Save a recording whose screen video is already in its bundle (the
  // iPhone helper writes screen.mov straight to disk).
  ipcMain.handle(
    'bundle:saveWithVideoFile',
    async (_e, args: { dir: string; camBytes?: ArrayBuffer; cursor: CursorSample[]; keys?: KeystrokeSample[]; project: Project }) => {
      if (!isInRecordingsRoot(args.dir)) throw new Error('bundle is outside the recordings folder');
      const video = join(args.dir, args.project.recording.screenVideoFile);
      if (!existsSync(video)) throw new Error(`recording is missing ${args.project.recording.screenVideoFile}`);
      args = { ...args, project: withProbedDuration(args.project, await probeDuration(video)) };
      writeBundleSidecars(args.dir, args);
      const cam = join(args.dir, 'cam.webm');
      if (existsSync(cam)) await finalizeWebm(cam);
      return {
        dir: args.dir,
        project: args.project,
        videoUrl: fileUrl(video),
        camUrl: existsSync(cam) ? fileUrl(cam) : undefined,
      };
    },
  );

  // Wired iPhone/iPad screens, via the native ios-capture helper.
  ipcMain.handle('ios:list', () => listIosDevices());

  ipcMain.handle('ios:start', async (_e, deviceId: string) => {
    // Ask from the app itself so the Camera prompt names OpenScreen; the
    // helper inherits the grant as our child process.
    const { systemPreferences } = await import('electron');
    if (!(await systemPreferences.askForMediaAccess('camera'))) {
      throw new Error('Camera permission is needed to record an iPhone. Allow OpenScreen in System Settings > Privacy & Security > Camera.');
    }
    const dir = newBundleDir();
    mkdirSync(dir, { recursive: true });
    try {
      const size = await startIosRecording(deviceId, join(dir, 'screen.mov'));
      iosBundleDir = dir;
      return { bundleDir: dir, ...size };
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  });

  // A take that failed keeps its screen.mov if the file plays (it has a
  // duration); otherwise the bundle is removed so no orphan is left.
  ipcMain.handle('ios:stop', async () => {
    const dir = iosBundleDir;
    iosBundleDir = null;
    try {
      return await stopIosRecording();
    } catch (e) {
      const mov = dir ? join(dir, 'screen.mov') : null;
      if (mov && existsSync(mov)) {
        const banner = await probe(mov);
        const duration = parseFfmpegDuration(banner);
        if (duration !== null) {
          const size = parseFfmpegVideoSize(banner);
          return { path: mov, duration, ...(size ?? {}), partial: true };
        }
      }
      if (dir) rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  });

  // Push an early end (cable pulled, helper died) so the renderer stops now.
  onIosEnded((ended) => {
    win?.webContents.send('ios:ended', 'err' in ended ? { message: ended.err } : { message: null });
  });

  // Remove a take's bundle that could not be saved.
  ipcMain.handle('bundle:discard', (_e, dir: string) => {
    if (isInRecordingsRoot(dir) && !existsSync(join(dir, 'project.json'))) rmSync(dir, { recursive: true, force: true });
    return true;
  });

  // Persist editor changes back into an existing bundle.
  ipcMain.handle('bundle:saveProject', async (_e, args: { dir: string; project: Project }) => {
    writeFileSync(join(args.dir, 'project.json'), JSON.stringify(args.project, null, 2));
    return true;
  });

  ipcMain.handle('file:writeText', async (_e, args: { path: string; text: string }) => {
    writeFileSync(args.path, args.text);
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
    if (!existsSync(join(dir, 'project.json'))) {
      throw new Error('That folder is not an OpenScreen recording. Pick a folder ending in .openscreen.');
    }
    let project: Project;
    try {
      project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    } catch {
      throw new Error('This recording\'s project.json is damaged and cannot be opened.');
    }
    project = normalizeProject(project);
    let cursor: unknown[] = [];
    try {
      cursor = JSON.parse(readFileSync(join(dir, 'cursor.json'), 'utf8')).samples ?? [];
    } catch {}
    let keys: unknown[] = [];
    try {
      keys = JSON.parse(readFileSync(join(dir, 'keystrokes.json'), 'utf8')).keys ?? [];
    } catch {}
    const videoPath = join(dir, project.recording?.screenVideoFile ?? 'screen.webm');
    if (!existsSync(videoPath)) throw new Error('This recording is missing its video file.');
    // Older takes stored a wall-clock duration. Correct it from the file and
    // write it back here, before the editor loads it, so the fix isn't an
    // unsaved change.
    if (project.recording) {
      const corrected = correctDuration(project, await probeDuration(videoPath));
      if (corrected !== project) {
        project = corrected;
        try {
          writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2));
        } catch (e) {
          console.error('could not write corrected duration:', e);
        }
      }
    }
    const camPath = project.recording?.cameraVideoFile
      ? join(dir, project.recording.cameraVideoFile)
      : undefined;
    return {
      bundleDir: dir,
      project,
      cursor,
      keys,
      videoPath,
      camPath,
      videoUrl: fileUrl(videoPath),
      camUrl: camPath ? fileUrl(camPath) : undefined,
    };
  });

  // Pick an image file for the background.
  ipcMain.handle('background:pick', async () => {
    const picked = await dialog.showOpenDialog(win!, {
      title: 'Background image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif'] }],
    });
    return picked.canceled ? null : picked.filePaths[0];
  });

  // Where converted backgrounds live: a JPEG per source file, keyed by path +
  // mtime so an edited file converts again.
  const backgroundCachePath = async (source: string) => {
    const { statSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const dir = join(app.getPath('userData'), 'backgrounds');
    mkdirSync(dir, { recursive: true });
    const key = createHash('sha1').update(`${source}:${statSync(source).mtimeMs}`).digest('hex');
    return join(dir, `${key}.jpg`);
  };

  // An image file for the current macOS wallpaper, or null when there isn't
  // one to use. NSWorkspace needs no Automation permission (Finder does).
  // Aerials and videos become a still frame; HEIC is converted when drawn.
  ipcMain.handle('background:wallpaper', async () => {
    if (process.platform !== 'darwin') return null;
    const { execFile } = await import('node:child_process');
    const { statSync } = await import('node:fs');
    const found = await new Promise<{ path: string; video: string } | null>((resolve) =>
      execFile('osascript', ['-l', 'JavaScript', '-e', WALLPAPER_JXA], (err, stdout) => {
        try {
          resolve(err ? null : JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      }),
    );
    if (!found) return null;
    const isDirectory = !!found.path && existsSync(found.path) && statSync(found.path).isDirectory();
    const plan = planWallpaper({ ...found, isDirectory });
    if (plan.kind === 'image') return existsSync(plan.path) ? plan.path : null;
    if (plan.kind === 'none' || !existsSync(plan.video)) return null;
    const out = await backgroundCachePath(plan.video);
    if (existsSync(out)) return out;
    const bin = await ffmpegPath();
    // A few seconds in: Aerials can open on a fade.
    const grab = (at: string) =>
      new Promise<boolean>((resolve) =>
        execFile(bin, ['-y', '-ss', at, '-i', plan.video, '-frames:v', '1', '-q:v', '2', out], (err) =>
          resolve(!err && existsSync(out)),
        ),
      );
    return (await grab('3')) || (await grab('0')) ? out : null;
  });

  // Chromium can't decode HEIC (the usual macOS wallpaper format): hand the
  // renderer a JPEG copy made with sips.
  ipcMain.handle('background:prepare', async (_e, path: string) => {
    if (!/\.hei[cf]$/i.test(path)) return path;
    const { execFile } = await import('node:child_process');
    const out = await backgroundCachePath(path);
    if (existsSync(out)) return out;
    return new Promise<string | null>((done) => {
      execFile('sips', ['-s', 'format', 'jpeg', path, '--out', out], (err) =>
        done(err || !existsSync(out) ? null : out),
      );
    });
  });

  // Transcribe a bundle's audio via whisper-cli → caption cues (source time).
  // The ggml model auto-downloads on first use (~148MB, into ~/models).
  ipcMain.handle('captions:transcribe', async (_e, args: { dir: string; videoFile: string }) => {
    const { execFile } = await import('node:child_process');
    const run = (cmd: string, argv: string[]) =>
      new Promise<void>((resolve, reject) =>
        execFile(cmd, argv, (e) => (e ? reject(e) : resolve())),
      );

    // Check for whisper-cli first, so nothing is downloaded for a tool that
    // isn't installed. A Finder-launched app's PATH misses Homebrew.
    const cli = findWhisperCli(existsSync, (process.env.PATH ?? '').split(delimiter));
    if (!cli) throw new Error('Transcription needs whisper-cpp. Install it with: brew install whisper-cpp');

    // Download to .part and rename, so an interrupted download is retried
    // instead of being mistaken for a model.
    const modelDir = join(app.getPath('home'), 'models');
    const model = process.env.OPENSCREEN_WHISPER_MODEL ?? join(modelDir, 'ggml-base.en.bin');
    if (!existsSync(model)) {
      mkdirSync(modelDir, { recursive: true });
      const part = partialPath(model);
      try {
        await run('curl', [
          '-fL', '--silent', '--show-error',
          'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
          '-o', part,
        ]);
        renameSync(part, model);
      } catch {
        rmSync(part, { force: true });
        throw new Error('Could not download the speech model (148 MB). Check your connection and try again.');
      }
    }

    const wav = await extractWav(args.dir, args.videoFile).catch(() => {
      throw new Error('Could not read the audio from this recording.');
    });
    const jsonOut = join(args.dir, 'transcript.json');
    // -ojf adds per-token offsets (ms) so the editor gets word-level timing.
    try {
      await run(cli, [
        '-m', model, '-f', wav, '--output-json-full', '--output-file', jsonOut.replace(/\.json$/, ''),
        '-t', '4',
      ]);
    } catch {
      throw new Error('whisper-cli failed to transcribe this recording.');
    }
    if (!existsSync(jsonOut)) throw new Error('whisper-cli produced no transcript.');
    const parsed = JSON.parse(readFileSync(jsonOut, 'utf8'));
    // whisper-cli --output-json-full emits { transcription: [{ offsets: {from,to}, text, tokens }] }
    const segs = parsed.transcription ?? parsed.result ?? [];
    return segs
      .map((s: { offsets?: { from: number; to: number }; timestamps?: { from: string; to: string }; text: string; tokens?: WhisperToken[] }) => {
        const from = s.offsets?.from ?? 0;
        const to = s.offsets?.to ?? 0;
        const words = s.tokens ? tokensToWords(s.tokens) : [];
        return { start: from / 1000, end: to / 1000, text: (s.text ?? '').trim(), words };
      })
      .filter((c: { start: number; end: number; text: string }) => c.end > c.start && c.text);
  });

  // Waveform peaks for the timeline: decode audio.wav → normalized
  // peak per bucket in source-time order.
  ipcMain.handle('audio:peaks', async (_e, args: { dir: string; videoFile: string; buckets?: number }) => {
    const wav = await extractWav(args.dir, args.videoFile);
    const buf = readFileSync(wav);
    let off = 12;
    let dataOff = -1;
    let dataLen = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const len = buf.readUInt32LE(off + 4);
      if (id === 'data') {
        dataOff = off + 8;
        dataLen = len;
        break;
      }
      off += 8 + len + (len % 2);
    }
    if (dataOff < 0) return [];
    const n = Math.min(Math.floor(dataLen / 2), Math.floor((buf.length - dataOff) / 2));
    const buckets = Math.max(64, Math.min(4096, args.buckets ?? 800));
    const per = Math.max(1, Math.floor(n / buckets));
    const peaks: number[] = [];
    for (let b = 0; b < buckets; b++) {
      let max = 0;
      const start = dataOff + b * per * 2;
      const end = Math.min(start + per * 2, dataOff + n * 2);
      for (let i = start; i + 1 < end; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > max) max = v;
      }
      peaks.push(max / 32768);
    }
    return peaks;
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
  ipcMain.handle('export:begin', async (_e, args: { outPath: string; w: number; h: number; fps: number; audioIn?: string; audioClips?: { start: number; end: number; speed: number }[]; clicks?: number[]; voiceCleanup?: boolean; duration: number }) => {
    await exportJob?.abort(); // a previous export that never ended
    exportJob = null;
    const ffmpegBin = await ffmpegPath();
    // Confirm the source actually has an audio stream before filtering
    // (filter_complex on a missing stream aborts the whole encode).
    let hasAudio = false;
    if (args.audioIn) {
      const { execFile } = await import('node:child_process');
      const probe = await new Promise<string>((resolve) =>
        execFile(ffmpegBin, ['-i', args.audioIn!], (_e, _so, se) => resolve(se ?? '')),
      );
      hasAudio = /Stream #\d+:\d+.*Audio:/.test(probe);
    }
    mkdirSync(dirname(args.outPath), { recursive: true });
    exportJob = await startFfmpegJob(ffmpegBin, buildExportArgs({ ...args, hasAudio }), args.outPath);
    return true;
  });

  // Where to save: a save dialog opened on ~/Movies/OpenScreen/<project>.<ext>.
  // Resolves null when the user cancels.
  ipcMain.handle('export:pickPath', async (_e, args: { bundleDir: string; kind: 'mp4' | 'gif' }) => {
    const name = basename(args.bundleDir).replace(/\.openscreen$/, '') || 'OpenScreen export';
    mkdirSync(recordingsRoot(), { recursive: true });
    const picked = await dialog.showSaveDialog(win!, {
      title: args.kind === 'gif' ? 'Export GIF' : 'Export MP4',
      defaultPath: join(recordingsRoot(), `${name}.${args.kind}`),
      filters: [args.kind === 'gif' ? { name: 'GIF', extensions: ['gif'] } : { name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (picked.canceled || !picked.filePath) return null;
    // ffmpeg picks the container from the extension, so make sure it has one.
    return extname(picked.filePath).toLowerCase() === `.${args.kind}` ? picked.filePath : `${picked.filePath}.${args.kind}`;
  });

  ipcMain.handle('export:reveal', (_e, path: string) => {
    shell.showItemInFolder(path);
    return true;
  });

  // Convert an exported mp4 into an optimized gif (two-pass palette). The
  // mp4 is an intermediate and is removed either way.
  ipcMain.handle('export:gif', async (_e, args: { inMp4: string; outGif: string }) => {
    const { execFile } = await import('node:child_process');
    const bin = await ffmpegPath();
    try {
      await new Promise<void>((resolve, reject) =>
        execFile(
          bin,
          [
            '-hide_banner', '-loglevel', 'error',
            '-y', '-i', args.inMp4,
            '-vf', 'fps=12,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer',
            '-loop', '0', args.outGif,
          ],
          (e, _so, se) => {
            if (!e) return resolve();
            const code = typeof e.code === 'number' ? e.code : null;
            const error = typeof e.code === 'string' ? e : undefined;
            reject(new Error(ffmpegFailure({ code, signal: e.signal ?? null, error }, se ?? '') ?? e.message));
          },
        ),
      );
    } catch (e) {
      rmSync(args.outGif, { force: true });
      throw e;
    } finally {
      rmSync(args.inMp4, { force: true });
    }
    return true;
  });

  ipcMain.handle('export:frame', async (_e, bytes: ArrayBuffer) => {
    if (!exportJob) throw new Error('export not started');
    await exportJob.write(new Uint8Array(bytes));
    return true;
  });

  // Finish the file. Throws with ffmpeg's reason when the encode failed.
  ipcMain.handle('export:end', async () => {
    const job = exportJob;
    exportJob = null;
    if (!job) throw new Error('export not started');
    await job.end();
    return true;
  });

  // Cancel or renderer-side failure: stop ffmpeg and delete the partial file.
  ipcMain.handle('export:abort', async () => {
    const job = exportJob;
    exportJob = null;
    await job?.abort();
    return true;
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

  // Auto-update from GitHub Releases (packaged builds only).
  if (app.isPackaged) {
    import('electron-updater')
      .then(({ autoUpdater }) => autoUpdater.checkForUpdatesAndNotify())
      .catch(() => {});
  }
});

// Ask before quitting over a recording or export. The window's own close
// guard is skipped once this has been answered.
app.on('before-quit', (e) => {
  if (quitConfirmed) return;
  if (!confirmDiscard('quit')) {
    e.preventDefault();
    return;
  }
  quitConfirmed = true;
  // Don't leave ffmpeg running or a half-written export behind.
  void exportJob?.abort();
});

app.on('will-quit', () => {
  stopTracker();
  disposeIosHelper();
});

// macOS keeps the app alive with no window; clicking the Dock icon brings one back.
app.on('activate', () => {
  if (!win && app.isReady()) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
