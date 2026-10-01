import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, screen, shell, systemPreferences } from 'electron';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createCursorTracker, type CursorTracker } from './cursor';
import { startFfmpegJob, type FfmpegJob } from './ffmpegJob';
import { transcodePreset, type TranscodeRun } from './transcodeJob';
import {
  listIosDevices,
  onIosEnded,
  onIosPreview,
  shutdownIosHelper,
  startIosPreview,
  startIosRecording,
  stopIosPreview,
  stopIosRecording,
} from './ios';
import { interruptedBundles, recoveredProject, RECOVERABLE_VIDEO, type BundleListing } from '../shared/recovery';
import { buildAppMenu } from './menu';
import { applyAppearance, loadAppearance } from './appearance';
import type { Appearance } from '../shared/appearance';
import type { ContextMenuItem, MenuPhase } from '../shared/menu';
import { fileSafeName, normalizeProject, projectName, type CursorSample, type KeystrokeSample, type Project } from '../shared/types';
import { parseHeadlessArgs, type HeadlessJob, type HeadlessResult } from '../shared/headless';
import { analyzeTapsInFile, audioFilePeaks, detectSilences, extractWav as extractBundleWav, importAudioFile, transcribeBundle } from '../node/media';
import { AUDIO_EXTENSIONS, bundleRelative, type MusicInput } from '../shared/audioTracks';
import { buildExportArgs, ffmpegFailure } from '../shared/exportArgs';
import { getPreset, type PresetId } from '../shared/exportPresets';
import { WALLPAPER_JXA, planWallpaper } from '../shared/wallpaper';
import {
  alignToVideoStart,
  cursorModeFor,
  correctDuration,
  parseFfmpegDuration,
  parseFfmpegProgressTime,
  parseFfmpegVideoSize,
  withProbedDuration,
} from '../shared/recording';

// Dev runs take the name from package.json ("openscreen"); the menu wants the product name.
app.setName('OpenScreen');

// `OpenScreen --export <bundle> --out <file>`: render one export with no
// window shown and no dialogs, print JSON lines, exit 0/1. It runs beside a
// GUI instance without touching its state: its own userData, no updater,
// no menu, no quit confirmations.
const headlessParsed = parseHeadlessArgs(process.argv);
const headless: HeadlessJob | null = headlessParsed && !('error' in headlessParsed) ? headlessParsed : null;
const emitJson = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');
let headlessFinished = false;
const finishHeadless = (r: HeadlessResult) => {
  if (headlessFinished) return;
  headlessFinished = true;
  emitJson(r);
  // exit() skips before-quit/will-quit; nothing of the GUI's is running.
  void (exportJob?.abort() ?? Promise.resolve()).finally(() => app.exit(r.ok ? 0 : 1));
};
// `OpenScreen --open <bundle>`: open that project in the editor (an agent
// handing a project to a human). It is the one bundle outside the
// recordings folder the renderer may open.
const openArgIndex = process.argv.indexOf('--open');
const openOnLaunch = !headlessParsed && openArgIndex >= 0 && process.argv[openArgIndex + 1] ? resolve(process.argv[openArgIndex + 1]) : null;
if (headlessParsed && 'error' in headlessParsed) {
  emitJson({ ok: false, error: headlessParsed.error });
  app.exit(1);
}
// OPENSCREEN_USER_DATA gives a test instance its own profile.
if (process.env.OPENSCREEN_USER_DATA && !headlessParsed) app.setPath('userData', process.env.OPENSCREEN_USER_DATA);
if (headless) {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'openscreen-headless-')));
  app.dock?.hide();
  const t = setTimeout(() => finishHeadless({ ok: false, error: `timed out after ${headless.timeoutSec}s` }), headless.timeoutSec * 1000);
  t.unref();
}

let win: BrowserWindow | null = null;
let tracker: CursorTracker | null = null;
let exportJob: FfmpegJob | null = null;
// A preset transcode (multi-format export) in flight.
let transcodeRun: TranscodeRun | null = null;
let trackerStartedAtMs = 0;
// The in-flight iPhone take's bundle, so a failed take can be salvaged or removed.
let iosBundleDir: string | null = null;

// What the renderer is in the middle of ('recording', 'saving', …), so
// closing or quitting can ask before throwing it away.
let rendererBusy: string | null = null;
let quitConfirmed = false;
// export:begin sets exportJob; export:end/abort clear it. export:transcode
// holds transcodeRun while it runs.
const exportRunning = () => exportJob !== null || transcodeRun !== null;
const busyReason = () => rendererBusy ?? (exportRunning() ? 'exporting' : null);

/** True when nothing is running, or the user chose to throw it away. */
const confirmDiscard = (action: 'close' | 'quit') => {
  if (headless) return true;
  const reason = busyReason();
  if (!reason) return true;
  const what =
    reason === 'exporting'
      ? ['An export is still running.', 'it stops the export and leaves an unfinished file']
      : reason === 'saving'
        ? ['A recording is still being saved.', 'the recording may be lost']
        : iosBundleDir
          ? ['A recording is in progress.', 'OpenScreen stops it and keeps what was recorded so far']
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
let appearance: Appearance = 'system';
const setAppearance = (a: Appearance) => {
  appearance = a;
  applyAppearance(a, true);
  refreshMenu();
};
const refreshMenu = () =>
  Menu.setApplicationMenu(buildAppMenu(() => win, menuState, { current: appearance, set: setAppearance }));

// OPENSCREEN_RECORDINGS_DIR points a test run somewhere other than the
// real recordings, which recovery would otherwise scan and write into.
const recordingsRoot = () =>
  process.env.OPENSCREEN_RECORDINGS_DIR || join(app.getPath('videos'), 'OpenScreen');

const newBundleDir = () => join(recordingsRoot(), `rec-${Date.now()}.openscreen`);

// Bundle dirs coming back from the renderer must be ones we created.
const isInRecordingsRoot = (dir: string) => {
  const rel = relative(recordingsRoot(), resolve(dir));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

// Write everything but the screen video into a bundle (shared by both save paths).
// project.json contents we wrote, per bundle, so the live-reload watcher
// can tell our own saves from outside edits.
const lastWrittenProject = new Map<string, string>();
const projectWatchers = new Map<string, FSWatcher>();
const writeProjectFile = (dir: string, project: Project) => {
  const text = JSON.stringify(project, null, 2);
  lastWrittenProject.set(dir, text);
  writeFileSync(join(dir, 'project.json'), text);
};

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

/** Whether a media file has an audio stream. */
const probeHasAudio = async (bin: string, path: string) => {
  const { execFile } = await import('node:child_process');
  const probe = await new Promise<string>((resolve) => execFile(bin, ['-i', path], (_e, _so, se) => resolve(se ?? '')));
  return /Stream #\d+:\d+.*Audio:/.test(probe);
};

/** Is there any audible sound in the file's audio (peak above -70 dBFS)?
 *  Unknown counts as audible, so a failed probe never drops normalization. */
const probeAudible = async (bin: string, path: string) => {
  const { execFile } = await import('node:child_process');
  const out = await new Promise<string>((resolve) =>
    execFile(bin, ['-hide_banner', '-i', path, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024 }, (_e, _so, se) => resolve(String(se ?? ''))),
  );
  const m = /max_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(out);
  if (!m) return true;
  return m[1] !== '-inf' && parseFloat(m[1]) > -70;
};

// Extract 16kHz mono wav from a bundle video for analysis (shared by
// transcription and silence detection).
const extractWav = async (dir: string, videoFile: string) => extractBundleWav(dir, videoFile, await ffmpegPath());

/** Whether a movie plays: its length and size, or null. */
const probeMovie = async (file: string) => {
  const banner = await probe(file);
  const size = parseFfmpegVideoSize(banner);
  const duration = parseFfmpegDuration(banner) ?? (size ? await probeDuration(file) : null);
  return duration !== null && size ? { duration, size } : null;
};

/**
 * Save a recording whose screen video is already in its bundle (the iPhone
 * helper writes screen.mov straight to disk). The duration comes from the
 * file itself.
 */
const saveWithVideoFile = async (args: { dir: string; camBytes?: ArrayBuffer; cursor: CursorSample[]; keys?: KeystrokeSample[]; project: Project }) => {
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
};

/**
 * Give an interrupted take (screen.mov but no project.json) a project so
 * it opens in the editor. Resolves false when its movie doesn't play; the
 * bundle is then left as it is.
 */
const recoverBundle = async (dir: string) => {
  const movie = await probeMovie(join(dir, RECOVERABLE_VIDEO));
  const project = movie && recoveredProject(movie);
  if (!project) return false;
  await saveWithVideoFile({ dir, cursor: [], keys: [], project });
  return true;
};

const listBundle = (dir: string): BundleListing => {
  const files = readdirSync(dir);
  let videoMtimeMs: number | undefined;
  try {
    if (files.includes(RECOVERABLE_VIDEO)) videoMtimeMs = statSync(join(dir, RECOVERABLE_VIDEO)).mtimeMs;
  } catch {}
  return { dir, files, videoMtimeMs };
};

/** Recover every interrupted take in the recordings folder; returns those that play. */
const recoverInterrupted = async () => {
  const root = recordingsRoot();
  let listings: BundleListing[] = [];
  try {
    listings = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.endsWith('.openscreen'))
      .map((e) => listBundle(join(root, e.name)));
  } catch {
    return [];
  }
  const recovered: string[] = [];
  for (const dir of interruptedBundles(listings, iosBundleDir, Date.now())) {
    try {
      if (await recoverBundle(dir)) recovered.push(dir);
    } catch (e) {
      console.error('could not recover', dir, e);
    }
  }
  return recovered;
};

/** A take that can't be saved keeps its bundle if its movie plays (recovery picks it up); otherwise it goes. */
const keepOrDiscardIosBundle = async (dir: string) => {
  const mov = join(dir, RECOVERABLE_VIDEO);
  if (existsSync(mov) && (await probeMovie(mov))) return;
  rmSync(dir, { recursive: true, force: true });
};

function createWindow() {
  win = new BrowserWindow({
    // Headless exports never show a window; frames keep coming while hidden.
    show: !headless,
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    title: 'OpenScreen',
    // Hidden title bar: the renderer's toolbar is the drag region and leaves
    // room on the left for the traffic lights, centred in its 52px height.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 19 },
    // The window's material is the sidebar's vibrancy; the renderer paints
    // every opaque region itself and leaves the inspector translucent over
    // it. Reduce Transparency turns the material opaque system-wide.
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: !headless,
    },
  });
  win.loadFile(join(__dirname, '../renderer/index.html'), headless ? { query: { headless: '1' } } : undefined);
  win.on('close', (e) => {
    if (!quitConfirmed && !confirmDiscard('close')) e.preventDefault();
  });
  // The take lived in this renderer: stop tracking, the preview, and any
  // iPhone take. The take's movie is kept if it plays, for recovery.
  const abandonTake = () => {
    rendererBusy = null;
    stopTracker();
    stopIosPreview();
    if (iosBundleDir) {
      const dir = iosBundleDir;
      iosBundleDir = null;
      stopIosRecording()
        .catch(() => {})
        .finally(() => void keepOrDiscardIosBundle(dir));
    }
  };
  win.webContents.on('render-process-gone', (_e, d) => {
    abandonTake();
    if (headless) finishHeadless({ ok: false, error: `renderer crashed (${d.reason})` });
  });
  win.on('closed', () => {
    abandonTake();
    win = null;
    menuState = { phase: 'picker' };
    refreshMenu();
  });
}

app.whenReady().then(() => {
  if (!headless) {
    appearance = loadAppearance();
    applyAppearance(appearance);
    refreshMenu();
  }
  // Right-click (two-finger click) menus: the renderer describes the items,
  // main pops a native menu and resolves with the chosen id, or null.
  ipcMain.handle('contextMenu:show', (e, items: ContextMenuItem[]) =>
    new Promise<string | null>((resolve) => {
      // On macOS the close callback can fire before the item's click, so a
      // click resolves at once and the close only settles "nothing picked"
      // after a beat (a promise resolves once; the later call is a no-op).
      const menu = Menu.buildFromTemplate(
        items.map((it) =>
          it.type === 'separator'
            ? { type: 'separator' as const }
            : { label: it.label, enabled: it.enabled !== false, click: () => resolve(it.id) },
        ),
      );
      const w = BrowserWindow.fromWebContents(e.sender);
      if (!w || w.isDestroyed()) return resolve(null);
      menu.popup({ window: w, callback: () => setTimeout(() => resolve(null), 250) });
    }),
  );
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
    (_e, args: { dir: string; camBytes?: ArrayBuffer; cursor: CursorSample[]; keys?: KeystrokeSample[]; project: Project }) =>
      saveWithVideoFile(args),
  );

  // Takes cut off by a crash or a quit, now openable. The picker asks on entry.
  ipcMain.handle('recovery:scan', () => recoverInterrupted());

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
      if (dir) await keepOrDiscardIosBundle(dir);
      throw e;
    }
  });

  // Live preview of a phone. Camera access is asked for from the app itself,
  // as for a take, so the prompt names OpenScreen.
  ipcMain.handle('ios:preview', async (_e, deviceId: string) => {
    if (!(await systemPreferences.askForMediaAccess('camera'))) {
      throw new Error('Camera permission is needed to show your iPhone. Allow OpenScreen in System Settings > Privacy & Security > Camera.');
    }
    return startIosPreview(deviceId);
  });
  ipcMain.handle('ios:unpreview', () => {
    stopIosPreview();
    return true;
  });
  onIosPreview(
    (preview) => win?.webContents.send('ios:previewState', preview),
    (frame) => win?.webContents.send('ios:previewFrame', frame),
  );

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
    writeProjectFile(args.dir, args.project);
    return true;
  });

  // Live reload: watch the open bundle for project.json changes that did not
  // come from our own saves (the agent CLI, a text editor) and send them on.
  ipcMain.on('bundle:watch', (e, dir: string) => {
    if (typeof dir !== 'string' || !existsSync(dir)) return;
    projectWatchers.get(dir)?.close();
    let timer: NodeJS.Timeout | null = null;
    const sender = e.sender;
    const check = () => {
      timer = null;
      let text: string;
      try {
        text = readFileSync(join(dir, 'project.json'), 'utf8');
      } catch {
        return;
      }
      if (text === lastWrittenProject.get(dir)) return;
      lastWrittenProject.set(dir, text);
      if (!sender.isDestroyed()) sender.send('bundle:projectChanged', { dir, text });
    };
    try {
      // Watch the folder: writers that replace the file (rename) end a file watch.
      const w = watch(dir, (_ev, name) => {
        if (name && name !== 'project.json') return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(check, 300);
      });
      w.on('error', () => w.close());
      projectWatchers.set(dir, w);
      if (!lastWrittenProject.has(dir)) {
        try {
          lastWrittenProject.set(dir, readFileSync(join(dir, 'project.json'), 'utf8'));
        } catch {}
      }
    } catch (err) {
      console.error('could not watch', dir, err);
    }
  });
  ipcMain.on('bundle:unwatch', (_e, dir: string) => {
    projectWatchers.get(dir)?.close();
    projectWatchers.delete(dir);
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
    return loadBundle(picked.filePaths[0]);
  });

  // Open a bundle by path (e.g. one just recovered). Only our own bundles.
  ipcMain.handle('bundle:openDir', (_e, dir: string) => {
    if (!isInRecordingsRoot(dir) && resolve(dir) !== openOnLaunch) throw new Error('That recording is outside the recordings folder.');
    return loadBundle(dir);
  });

  const loadBundle = async (dir: string) => {
    if (!existsSync(join(dir, 'project.json'))) {
      // An interrupted iPhone take: give it a project if its movie plays.
      const interrupted = isInRecordingsRoot(dir) && interruptedBundles([listBundle(dir)], iosBundleDir, Date.now()).length > 0;
      if (!interrupted || !(await recoverBundle(dir).catch(() => false))) {
        throw new Error(
          existsSync(join(dir, RECOVERABLE_VIDEO))
            ? "This recording was interrupted and its video can't be played."
            : 'That folder is not an OpenScreen recording. Pick a folder ending in .openscreen.',
        );
      }
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
          // A headless export only reads the bundle; the fix applies in memory.
          if (!headless) writeProjectFile(dir, project);
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
  };

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
  ipcMain.handle('captions:transcribe', async (_e, args: { dir: string; videoFile: string }) =>
    transcribeBundle(args.dir, args.videoFile, await ffmpegPath()),
  );

  // Waveform peaks for the timeline: decode audio.wav → normalized
  // peak per bucket in source-time order.
  ipcMain.handle('audio:peaks', async (_e, args: { dir: string; videoFile: string; buckets?: number }) => {
    const wav = await extractWav(args.dir, args.videoFile);
    // No audio track: an empty waveform, not an error.
    if (!wav) return [];
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

  // Add Music or Voiceover: pick a sound file and copy it into the bundle's
  // audio/ folder. Resolves null when the user cancels.
  ipcMain.handle('audio:import', async (_e, dir: string) => {
    if (typeof dir !== 'string' || !existsSync(join(dir, 'project.json'))) throw new Error('No project is open.');
    const picked = await dialog.showOpenDialog(win!, {
      title: 'Add Music or Voiceover',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const id = randomUUID();
    return { id, ...(await importAudioFile(dir, picked.filePaths[0], id, await ffmpegPath())) };
  });

  // Waveform peaks for an added sound inside the bundle (whole file, in file time).
  ipcMain.handle('audio:filePeaks', async (_e, args: { dir: string; file: string; buckets?: number }) => {
    if (!bundleRelative(args.file)) return [];
    return audioFilePeaks(join(args.dir, args.file), args.buckets ?? 1000, await ffmpegPath());
  });

  // Silence detection: ffmpeg silencedetect on the bundle audio →
  // [{start,end}] silent ranges in source seconds.
  ipcMain.handle(
    'audio:detectSilences',
    async (_e, args: { dir: string; videoFile: string; thresholdDb?: number; minDur?: number }) =>
      detectSilences(args.dir, args.videoFile, { thresholdDb: args.thresholdDb, minDur: args.minDur }, await ffmpegPath()),
  );

  // Tap analysis for phone recordings: ffmpeg streams small grayscale
  // frames, taps.ts turns their differences into tap/swipe suggestions and
  // still stretches. Everything is in source seconds.
  ipcMain.handle('taps:analyze', async (_e, args: { dir: string; videoFile: string }) =>
    analyzeTapsInFile(join(args.dir, args.videoFile), await ffmpegPath()),
  );

  // ffmpeg re-encode: pipe rendered RGBA frames → h264 mp4. The renderer
  // sends raw frame buffers; main streams them into ffmpeg stdin.
  ipcMain.handle('export:begin', async (_e, args: { outPath: string; w: number; h: number; fps: number; audioIn?: string; audioClips?: { start: number; end: number; speed: number }[]; clicks?: number[]; voiceCleanup?: boolean; duration: number; master?: boolean; music?: MusicInput[]; duck?: { start: number; end: number }[] }) => {
    await exportJob?.abort(); // a previous export that never ended
    exportJob = null;
    // A missing music file would fail the whole encode with ffmpeg's own words.
    const missing = (args.music ?? []).find((m) => !existsSync(m.path));
    if (missing) throw new Error(`The sound file ${missing.path.split('/').pop()} is missing from this project's audio folder.`);
    const ffmpegBin = await ffmpegPath();
    // Confirm the source actually has an audio stream before filtering
    // (filter_complex on a missing stream aborts the whole encode).
    const hasAudio = args.audioIn ? await probeHasAudio(ffmpegBin, args.audioIn) : false;
    mkdirSync(dirname(args.outPath), { recursive: true });
    exportJob = await startFfmpegJob(ffmpegBin, buildExportArgs({ ...args, hasAudio }), args.outPath);
    return true;
  });

  // Where to save: a save dialog opened on ~/Movies/OpenScreen/<project>.<ext>.
  // Resolves null when the user cancels.
  ipcMain.handle('export:pickPath', async (_e, args: { bundleDir: string; kind: 'mp4' | 'gif'; name?: string }) => {
    const name = fileSafeName(projectName({ name: args.name }, args.bundleDir));
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

  // Multi-format export: one folder for every file, opened on
  // ~/Movies/OpenScreen/<project>/. Resolves null when the user cancels.
  ipcMain.handle('export:pickFolder', async (_e, args: { bundleDir: string; name?: string }) => {
    const name = fileSafeName(projectName({ name: args.name }, args.bundleDir));
    const defaultPath = join(recordingsRoot(), name);
    mkdirSync(defaultPath, { recursive: true });
    const picked = await dialog.showOpenDialog(win!, {
      title: 'Export formats to…',
      buttonLabel: 'Export Here',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    return picked.filePaths[0];
  });

  // Rendered masters live in a temp folder of their own, and only files in it
  // can be discarded through export:discardMaster.
  const mastersDir = () => join(tmpdir(), 'openscreen-export');
  ipcMain.handle('export:masterPath', (_e, key: string) => {
    mkdirSync(mastersDir(), { recursive: true });
    return join(mastersDir(), `master-${Date.now()}-${key.replace(/[^a-z0-9]+/gi, '_')}.mov`);
  });
  ipcMain.handle('export:discardMaster', (_e, path: string) => {
    if (dirname(resolve(path)) === mastersDir()) rmSync(path, { force: true });
    return true;
  });

  // Whether a file has an audio stream (for the Export panel's warnings).
  ipcMain.handle('export:hasAudio', async (_e, path: string) => probeHasAudio(await ffmpegPath(), path));

  // Transcode a rendered master into one preset's files. Progress arrives as
  // export:transcodeProgress; export:abort cancels it.
  ipcMain.handle('export:transcode', async (_e, args: { presetId: PresetId; input: string; outBase: string; duration: number }) => {
    await transcodeRun?.cancel();
    const bin = await ffmpegPath();
    const preset = getPreset(args.presetId);
    const hasAudio = await probeHasAudio(bin, args.input);
    mkdirSync(dirname(args.outBase), { recursive: true });
    const audible = hasAudio && preset.audio.mode === 'aac-stereo' && preset.audio.loudnessLufs !== undefined
      ? await probeAudible(bin, args.input)
      : true;
    const run = transcodePreset(bin, preset, args.input, args.outBase, hasAudio, args.duration, (fraction) =>
      win?.webContents.send('export:transcodeProgress', { presetId: args.presetId, fraction }),
      audible,
    );
    transcodeRun = run;
    try {
      return await run.done;
    } finally {
      if (transcodeRun === run) transcodeRun = null;
    }
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
    const run = transcodeRun;
    transcodeRun = null;
    await Promise.all([job?.abort(), run?.cancel()]);
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

  // Headless export plumbing: the job, its bundle, progress and the result.
  ipcMain.handle('headless:job', () => (headless ? { bundleDir: headless.bundleDir, out: headless.out, gif: headless.gif, presets: headless.presets } : null));
  ipcMain.handle('headless:open', () => {
    if (!headless) throw new Error('not a headless run');
    return loadBundle(resolve(headless.bundleDir));
  });
  let lastPct = -1;
  ipcMain.on('headless:progress', (_e, p: { done: number; total: number; detail: string }) => {
    if (!headless || !(p.total > 0)) return;
    const pct = Math.floor((p.done / p.total) * 100);
    if (pct === lastPct || pct % 5 !== 0) return;
    lastPct = pct;
    emitJson({ progress: pct / 100, done: Math.round(p.done), total: Math.round(p.total), ...(p.detail ? { detail: p.detail } : {}) });
  });
  ipcMain.on('headless:done', (_e, r: HeadlessResult) => {
    if (!headless) return;
    if (r.ok && r.out && !existsSync(r.out)) finishHeadless({ ok: false, error: `export reported success but ${r.out} is missing` });
    else finishHeadless(r);
  });

  if (headless) {
    if (!existsSync(join(resolve(headless.bundleDir), 'project.json'))) {
      finishHeadless({ ok: false, error: `${headless.bundleDir} is not an OpenScreen bundle (no project.json)` });
      return;
    }
    createWindow();
    return;
  }

  ipcMain.handle('app:openOnLaunch', () => openOnLaunch);

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
  if (quitConfirmed || headless) return;
  if (!confirmDiscard('quit')) {
    e.preventDefault();
    return;
  }
  quitConfirmed = true;
  // Don't leave ffmpeg running or a half-written export behind.
  void exportJob?.abort();
  void transcodeRun?.cancel();
});

// Quitting mid-take keeps the take: the helper is asked to finish the file
// (up to 3s) before it's let go. Recovery gives it a project next time.
let iosShutDown = false;
app.on('will-quit', (e) => {
  stopTracker();
  if (iosShutDown) return;
  e.preventDefault();
  iosShutDown = true;
  void shutdownIosHelper(3000).finally(() => app.quit());
});

// macOS keeps the app alive with no window; clicking the Dock icon brings one back.
app.on('activate', () => {
  if (!win && app.isReady() && !headless) createWindow();
});

app.on('window-all-closed', () => {
  if (headless) finishHeadless({ ok: false, error: 'the export window closed' });
  else if (process.platform !== 'darwin') app.quit();
});
