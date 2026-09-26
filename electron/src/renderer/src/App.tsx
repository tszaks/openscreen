import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, type IosDevice, type SourceInfo } from './api';
import type { CursorSample, KeystrokeSample, Project } from '../../shared/types';
import { defaultProject } from '../../shared/types';
import {
  cameraLabel,
  captureErrorMessage,
  createStopLatch,
  endNotice,
  sourceKindFor,
  type EndReason,
} from '../../shared/recording';
import { decodeIosError } from '../../shared/iosErrors';
import { Editor } from './Editor';
import { Button, EmptyState, Segmented } from './ui';
import { IosSetupCard } from './components/IosSetupCard';
import { RecordingCard } from './components/RecordingCard';
import { checklistFor, readSetupPrefs, recordingWarning, writeSetupPref, type SetupPrefs, type SetupTrigger } from './components/iosSetup';

type PickerTab = 'displays' | 'windows' | 'devices';

type Phase =
  | { name: 'picker' }
  | { name: 'recording'; startedAt: number }
  // `session` is new on every entry, so reopening remounts a fresh editor.
  | { name: 'editor'; session: number; bundleDir: string; videoUrl: string; camUrl?: string; project: Project; cursor: CursorSample[]; keys: KeystrokeSample[] };

type EditorPhase = Extract<Phase, { name: 'editor' }>;

/** Capture one source (screen or window) at 60fps via getDisplayMedia. */
async function captureStream(sourceId: string): Promise<MediaStream> {
  // Electron: chromium constraints for desktopCapturer sources.
  const stream = await (navigator.mediaDevices as any).getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        minFrameRate: 30,
        maxFrameRate: 60,
      },
    },
  });
  return stream as MediaStream;
}

/** Capture a camera (webcam, or an iPhone's camera via Continuity Camera)
 *  at up to 1080p60. iPhone/iPad SCREENS go through the ios-capture helper. */
async function captureDevice(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: { exact: deviceId },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60 },
    },
  });
}

/** IPC errors arrive wrapped ("Error invoking remote method 'x': Error: ..."). */
const ipcMessage = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const recorderMime = () =>
  MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';

const stopTracks = (s: MediaStream | null | undefined) => s?.getTracks().forEach((t) => t.stop());
const stopRecorder = (r: MediaRecorder | null | undefined) => {
  if (r && r.state !== 'inactive') r.stop();
};

export function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'picker' });
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selected, setSelected] = useState<SourceInfo | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<MediaDeviceInfo | null>(null);
  // Wired iPhone/iPad screens from the native helper (not MediaDevices).
  const [ios, setIos] = useState<{ devices: IosDevice[]; ready: boolean; error: string | null }>({
    devices: [],
    ready: false,
    error: null,
  });
  const [selectedIos, setSelectedIos] = useState<IosDevice | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  // Camera for the overlay (null = the first one).
  const [camId, setCamId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Stop was pressed (or the source went away) and the take is being written.
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  // Shown over any screen, e.g. "the window closed, so recording stopped".
  const [notice, setNotice] = useState<string | null>(null);
  const [perms, setPerms] = useState<{ screen: string; hooks: boolean } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  // UI only: which source tab the picker shows (null = pick a sensible default).
  const [pickerTab, setPickerTab] = useState<PickerTab | null>(null);
  // The iPhone setup checklist: persisted choices, the dialog (first pick or
  // a failed start; `key` remounts it at its step), and the copy shown in
  // place of the empty iPhone tab.
  const [setupPrefs, setSetupPrefs] = useState<SetupPrefs>(() => readSetupPrefs(localStorage));
  const [setupDialog, setSetupDialog] = useState<{ step: number; message: string | null; key: number } | null>(null);
  const [inlineSetup, setInlineSetup] = useState(() => !readSetupPrefs(localStorage).hidden);
  // Mid-take iPhone warning ("may be locked"), read from the helper while recording.
  const [iosWarning, setIosWarning] = useState<string | null>(null);
  // The stream being recorded, shown muted on the recording card.
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const latchRef = useRef<ReturnType<typeof createStopLatch> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const camRecRef = useRef<MediaRecorder | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const camChunksRef = useRef<Blob[]>([]);
  // Epoch ms each recorder actually started, and when cursor tracking did.
  const startsRef = useRef({ video: 0, cam: 0, tracker: 0 });
  // Size read from the live track at start, in case it has ended by Stop.
  const sourceSizeRef = useRef<{ width: number; height: number } | null>(null);
  const stoppingRef = useRef(false);
  // The in-flight iPhone take: its bundle and the size from the first frame.
  const iosTakeRef = useRef<{ bundleDir: string; width: number; height: number; startedAtMs: number } | null>(null);
  const sessionRef = useRef(0);
  const openEditor = useCallback(
    (p: Omit<EditorPhase, 'name' | 'session'>) =>
      setPhase({ name: 'editor', session: ++sessionRef.current, ...p }),
    [],
  );

  const openSetup = useCallback(
    (trigger: SetupTrigger) => {
      const open = checklistFor(trigger, setupPrefs);
      if (!open) return;
      setSetupDialog({ ...open, key: Date.now() });
      if (trigger.kind === 'firstUse') {
        writeSetupPref(localStorage, 'seen');
        setSetupPrefs((p) => ({ ...p, seen: true }));
      }
    },
    [setupPrefs],
  );
  const hideSetup = useCallback(() => {
    writeSetupPref(localStorage, 'hidden');
    setSetupPrefs((p) => ({ ...p, hidden: true }));
    setSetupDialog(null);
    setInlineSetup(false);
  }, []);
  const closeSetupDialog = useCallback(() => setSetupDialog(null), []);

  // Cameras stay listed before permission gives them labels.
  const refreshCameras = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'videoinput' && d.deviceId));
    } catch {}
  }, []);

  // Sources and permissions change while the app is open (a new window, a
  // grant in System Settings), so the picker re-reads them on entry, on
  // focus, and from its Refresh button.
  const refresh = useCallback(async () => {
    api.permissionsStatus().then(setPerms).catch(() => {});
    void refreshCameras();
    try {
      setSources(await api.listSources());
    } catch (e) {
      setStatus(`Couldn't list screens and windows: ${ipcMessage(e)}`);
    }
  }, [refreshCameras]);

  useEffect(() => {
    if (phase.name !== 'picker') return;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [phase.name, refresh]);

  // Drop a selected window or display that no longer exists.
  useEffect(() => {
    if (selected && sources.length && !sources.some((s) => s.id === selected.id)) setSelected(null);
  }, [sources, selected]);

  // Poll the helper's device list while the picker is open, so a phone
  // plugged in (or trusted) shows up without reopening the app.
  useEffect(() => {
    if (phase.name !== 'picker') return;
    let live = true;
    const poll = () =>
      api.iosList().then((r) => live && setIos(r)).catch((e) => {
        if (live) setIos((prev) => ({ ...prev, error: ipcMessage(e) }));
      });
    void poll();
    const t = setInterval(poll, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [phase.name]);

  // Drop a selected iPhone that was unplugged.
  useEffect(() => {
    if (selectedIos && ios.ready && !ios.devices.some((d) => d.id === selectedIos.id)) setSelectedIos(null);
  }, [ios, selectedIos]);

  useEffect(() => {
    if (phase.name !== 'recording' || saving) return;
    const t = setInterval(() => setElapsed((performance.now() - phase.startedAt) / 1000), 250);
    return () => clearInterval(t);
  }, [phase, saving]);

  // A closed window's track doesn't end on macOS; it just freezes. Watch
  // the recorded window or display and finish the take when it's gone.
  const recordingSourceId = phase.name === 'recording' && !selectedIos && !selectedDevice ? selected?.id : undefined;
  useEffect(() => {
    if (!recordingSourceId) return;
    let live = true;
    const t = setInterval(async () => {
      const alive = await api.sourceAlive(recordingSourceId).catch(() => true);
      if (live && !alive) void stopRef.current('sourceEnded');
    }, 1500);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [recordingSourceId]);

  // While an iPhone take runs, read the helper's warning so a locked phone
  // (a frozen picture) is called out, and cleared once frames resume.
  const iosRecording = phase.name === 'recording' && !!selectedIos && !saving;
  useEffect(() => {
    if (!iosRecording) {
      setIosWarning(null);
      return;
    }
    let live = true;
    const poll = () =>
      api.iosList().then((r) => live && setIosWarning(recordingWarning(r.warning))).catch(() => {});
    void poll();
    const t = setInterval(poll, 1500);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [iosRecording]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  const start = useCallback(() => {
    if (!selected && !selectedDevice && !selectedIos) return;
    setCountdown(3);
  }, [selected, selectedDevice, selectedIos]);

  // Turning the camera on asks macOS for access first: until it's granted
  // there is no camera to open and no prompt would ever appear.
  const toggleCamera = useCallback(
    async (on: boolean) => {
      setCamOn(on);
      if (!on) return;
      let ok = false;
      try {
        ok = await api.requestCamera();
      } catch {}
      if (!ok) {
        setCamOn(false);
        setStatus('Camera access is off. Allow OpenScreen in System Settings > Privacy & Security > Camera.');
        return;
      }
      setStatus('');
      await refreshCameras();
    },
    [refreshCameras],
  );

  const overlayCamera = devices.find((d) => d.deviceId === camId) ?? devices[0];

  // Open the overlay camera before any recorder starts: it takes up to a
  // second or two, and a late camera would be out of step with the video.
  const openCamera = useCallback(async (): Promise<MediaStream | null> => {
    if (!camOn) return null;
    if (!overlayCamera) {
      setStatus('No camera found. Recording without the camera.');
      return null;
    }
    try {
      return await captureDevice(overlayCamera.deviceId);
    } catch {
      setStatus('Camera unavailable. Recording without the camera.');
      return null;
    }
  }, [camOn, overlayCamera]);

  const startCamRecorder = (camStream: MediaStream | null) => {
    if (!camStream) return null;
    camStreamRef.current = camStream;
    camChunksRef.current = [];
    const camRec = new MediaRecorder(camStream, { mimeType: recorderMime(), videoBitsPerSecond: 6_000_000 });
    camRec.ondataavailable = (e) => e.data.size && camChunksRef.current.push(e.data);
    camRec.onstart = () => (startsRef.current.cam = Date.now());
    camRecRef.current = camRec;
    return camRec;
  };

  const stopCamOverlay = useCallback(async (): Promise<Blob | undefined> => {
    const camRec = camRecRef.current;
    const camStream = camStreamRef.current;
    camRecRef.current = null;
    camStreamRef.current = null;
    if (!camRec) {
      stopTracks(camStream);
      return undefined;
    }
    await createStopLatch(camRec).stop();
    stopTracks(camStream);
    return new Blob(camChunksRef.current, { type: camRec.mimeType });
  }, []);

  // The latest stop(), for handlers attached when a take starts.
  const stopRef = useRef<(reason?: EndReason, detail?: string | null) => Promise<void>>(async () => {});

  const beginRecordingPhase = () => {
    setElapsed(0);
    setSaving(false);
    stoppingRef.current = false;
    api.setBusy('recording');
    setPhase({ name: 'recording', startedAt: performance.now() });
  };

  const reallyStart = useCallback(async () => {
    setStatus('');
    if (selectedIos) {
      // iPhone/iPad screen: the helper records straight to disk. Audio comes
      // from the device, so the mic switch doesn't apply.
      const camStream = await openCamera();
      try {
        setStatus(`Starting ${selectedIos.name}…`);
        const take = await api.iosStart(selectedIos.id);
        const camRec = startCamRecorder(camStream);
        camRec?.start(250);
        iosTakeRef.current = { ...take, startedAtMs: Date.now() };
        setStatus('');
        beginRecordingPhase();
      } catch (e) {
        iosTakeRef.current = null;
        stopRecorder(camRecRef.current);
        camRecRef.current = null;
        camStreamRef.current = null;
        stopTracks(camStream);
        // "no-frames" (and a start that timed out) opens the checklist at
        // the step that fixes it, with the helper's own words on top.
        const { code, message } = decodeIosError(ipcMessage(e));
        setStatus(message);
        openSetup({ kind: 'startError', code, message });
      }
      return;
    }

    let stream: MediaStream | null = null;
    let camStream: MediaStream | null = null;
    let rec: MediaRecorder | null = null;
    let tracking = false;
    try {
      camStream = await openCamera();
      stream = selectedDevice
        ? await captureDevice(selectedDevice.deviceId)
        : await captureStream(selected!.id);
      if (micOn) {
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
          mic.getAudioTracks().forEach((t) => stream!.addTrack(t));
        } catch {
          setStatus('Microphone access is off. Recording without sound.');
        }
      }
      const videoTrack = stream.getVideoTracks()[0];
      const settings = videoTrack?.getSettings();
      sourceSizeRef.current = settings?.width && settings?.height ? { width: settings.width, height: settings.height } : null;

      // Tracker first, then both recorders in the same tick, so cursor,
      // camera and video share a start. Each start time is recorded.
      const tracker = await api.startRecording(selectedDevice?.deviceId ?? selected!.id, selected?.displayId);
      tracking = true;
      chunksRef.current = [];
      rec = new MediaRecorder(stream, { mimeType: recorderMime(), videoBitsPerSecond: 12_000_000 });
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      startsRef.current = { video: Date.now(), cam: 0, tracker: tracker.startedAtMs };
      rec.onstart = () => (startsRef.current.video = Date.now());
      // A recorder whose only track ended (window closed, display gone)
      // stops by itself; with the mic on it would carry on audio-only.
      // Either way, finish the take and say why.
      latchRef.current = createStopLatch(rec, () => void stopRef.current('sourceEnded'));
      if (videoTrack) videoTrack.onended = () => void stopRef.current('sourceEnded');
      const camRec = startCamRecorder(camStream);
      rec.start(250);
      camRec?.start(250);
      recorderRef.current = rec;
      streamRef.current = stream;
      setLiveStream(stream);
      beginRecordingPhase();
    } catch (e) {
      // Nothing may keep running after a failed start: no recorder, no
      // capture indicator, no camera light, no cursor tracker.
      stopRecorder(rec);
      stopRecorder(camRecRef.current);
      stopTracks(stream);
      stopTracks(camStream);
      camRecRef.current = null;
      camStreamRef.current = null;
      recorderRef.current = null;
      streamRef.current = null;
      latchRef.current = null;
      if (tracking) await api.stopRecording().catch(() => {});
      setStatus(captureErrorMessage(e, selectedDevice ? cameraLabel(selectedDevice, 0) : selected?.name));
    }
  }, [selected, selectedDevice, selectedIos, micOn, openCamera, openSetup]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      setCountdown(null);
      void reallyStart();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 900);
    return () => clearTimeout(t);
  }, [countdown, reallyStart]);

  const stopIos = useCallback(
    async (reason?: EndReason, detail?: string | null) => {
      const take = iosTakeRef.current;
      if (!take) return;
      iosTakeRef.current = null;
      let done;
      try {
        done = await api.iosStop();
      } catch (e) {
        await stopCamOverlay();
        setStatus(`The iPhone recording failed and nothing playable was saved: ${ipcMessage(e)}`);
        setPhase({ name: 'picker' });
        return;
      }
      const camBlob = await stopCamOverlay();
      const camBytes = camBlob?.size ? await camBlob.arrayBuffer() : undefined;
      const project = defaultProject({
        screenVideoFile: 'screen.mov',
        cameraVideoFile: camBytes ? 'cam.webm' : undefined,
        sourceKind: 'iosDevice',
        // The finished file's size wins: the phone may have rotated mid-take.
        sourceSize: { width: done.width ?? take.width, height: done.height ?? take.height },
        duration: done.duration ?? (Date.now() - take.startedAtMs) / 1000,
      });
      if (camBytes) project.cameraOverlay.enabled = true;
      try {
        const saved = await api.saveBundleWithVideoFile(take.bundleDir, [], project, camBytes, []);
        openEditor({ bundleDir: saved.dir, videoUrl: saved.videoUrl, camUrl: saved.camUrl, project: saved.project, cursor: [], keys: [] });
        if (reason || done.partial) setNotice(endNotice('deviceEnded', detail ?? undefined));
      } catch (e) {
        setStatus(`Couldn't save the iPhone recording (its video is in ${take.bundleDir}): ${ipcMessage(e)}`);
        setPhase({ name: 'picker' });
      }
    },
    [stopCamOverlay, openEditor],
  );

  const stopScreen = useCallback(
    async (reason?: EndReason) => {
      const rec = recorderRef.current;
      const stream = streamRef.current;
      const latch = latchRef.current;
      if (!rec || !stream || !latch) return;
      // Read the size before the tracks stop (an ended track reports none).
      const live = stream.getVideoTracks()[0]?.getSettings();
      const stoppedAtMs = Date.now();
      try {
        await latch.stop();
        stopTracks(stream);
        const starts = startsRef.current;
        const { samples: cursor, keys } = await api.stopRecording(starts.video);
        const camBlob = await stopCamOverlay();
        const blob = new Blob(chunksRef.current, { type: rec.mimeType });
        const videoBytes = await blob.arrayBuffer();
        const camBytes = camBlob?.size ? await camBlob.arrayBuffer() : undefined;
        const size =
          live?.width && live?.height ? { width: live.width, height: live.height } : sourceSizeRef.current ?? { width: 1920, height: 1080 };
        const project = defaultProject({
          screenVideoFile: 'screen.webm',
          cameraVideoFile: camBytes ? 'cam.webm' : undefined,
          sourceKind: sourceKindFor(selected?.id ?? ''),
          sourceSize: size,
          // A stand-in: main replaces it with the saved file's real duration.
          duration: Math.max(0.1, (stoppedAtMs - starts.video) / 1000),
          cursorOffset: starts.tracker ? (starts.video - starts.tracker) / 1000 : undefined,
          cameraOffset: camBytes && starts.cam ? (starts.cam - starts.video) / 1000 : undefined,
        });
        if (camBytes) project.cameraOverlay.enabled = true;
        const saved = await api.saveBundle(videoBytes, cursor, project, camBytes, keys);
        chunksRef.current = [];
        camChunksRef.current = [];
        openEditor({ bundleDir: saved.dir, videoUrl: saved.videoUrl, camUrl: saved.camUrl, project: saved.project, cursor, keys });
        if (reason) setNotice(endNotice(reason));
      } catch (e) {
        setStatus(`Couldn't save the recording: ${ipcMessage(e)}`);
        setPhase({ name: 'picker' });
      } finally {
        recorderRef.current = null;
        streamRef.current = null;
        latchRef.current = null;
        setLiveStream(null);
      }
    },
    [selected, stopCamOverlay, openEditor],
  );

  // One stop for every path: the Stop button, a source that went away, or
  // an iPhone that stopped sending. Runs once per take.
  const stop = useCallback(
    async (reason?: EndReason, detail?: string | null) => {
      if (stoppingRef.current) return;
      stoppingRef.current = true;
      setSaving(true);
      api.setBusy('saving');
      try {
        if (iosTakeRef.current) await stopIos(reason ?? undefined, detail);
        else await stopScreen(reason);
      } finally {
        setSaving(false);
        api.setBusy(null);
      }
    },
    [stopIos, stopScreen],
  );
  stopRef.current = stop;

  // The helper reports a take that ended on its own; finish it right away.
  useEffect(
    () =>
      api.onIosEnded((e) => {
        if (iosTakeRef.current) void stopRef.current('deviceEnded', e.message);
      }),
    [],
  );

  // Replaces whatever is open. The editor asks about unsaved changes first.
  const openProject = useCallback(async () => {
    try {
      const b = await api.openBundle();
      if (!b) return;
      openEditor({
        bundleDir: b.bundleDir,
        videoUrl: b.videoUrl,
        camUrl: b.camUrl,
        project: b.project,
        cursor: b.cursor,
        keys: b.keys,
      });
    } catch (e) {
      setNotice(`Couldn't open that project. ${ipcMessage(e)}`);
    }
  }, [openEditor]);

  const backToPicker = useCallback(() => setPhase({ name: 'picker' }), []);

  // Native menu clicks arrive over IPC; re-broadcast them in this world as
  // `openscreen:menu` events for the picker and editor to handle.
  useEffect(() => api.onMenu((a) => window.dispatchEvent(new CustomEvent('openscreen:menu', { detail: a }))), []);

  // Keep the menu's enabled items in step with what's on screen.
  const menuBundle = phase.name === 'editor' ? phase.bundleDir : undefined;
  useEffect(() => api.setMenuPhase(phase.name, menuBundle), [phase.name, menuBundle]);

  // The app menu dispatches `openscreen:menu` events. The editor handles
  // its own; the picker only opens projects.
  useEffect(() => {
    if (phase.name !== 'picker') return;
    const onMenu = (e: Event) => {
      if ((e as CustomEvent<string>).detail === 'openProject') void openProject();
    };
    window.addEventListener('openscreen:menu', onMenu);
    return () => window.removeEventListener('openscreen:menu', onMenu);
  }, [phase.name, openProject]);

  // Release any blob URLs an editor was opened with when it goes. (Saved
  // takes now open from their files, so this is only a safety net.)
  const editorVideoUrl = phase.name === 'editor' ? phase.videoUrl : undefined;
  const editorCamUrl = phase.name === 'editor' ? phase.camUrl : undefined;
  useEffect(
    () => () => {
      for (const url of [editorVideoUrl, editorCamUrl]) {
        if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
      }
    },
    [editorVideoUrl, editorCamUrl],
  );

  const noticeToast = notice && (
    <div className="notice" role="status">
      <span className="banner-dot" />
      <p>{notice}</p>
      <button type="button" className="notice-close" aria-label="Dismiss" onClick={() => setNotice(null)}>
        Dismiss
      </button>
    </div>
  );


  if (phase.name === 'picker') {
    const displays = sources.filter((s) => s.id.startsWith('screen:'));
    const windows = sources.filter((s) => s.id.startsWith('window:'));
    // iPhone/iPad screens come from the helper. Every MediaDevices camera,
    // Continuity Camera included, is a camera, not a screen.
    const iosDevices = ios.devices;
    const otherCameras = devices;
    const tab: PickerTab = pickerTab ?? (iosDevices.length ? 'devices' : 'displays');
    const tabOptions = [
      { value: 'displays' as const, label: <>Displays<span className="count">{displays.length}</span></> },
      { value: 'windows' as const, label: <>Windows<span className="count">{windows.length}</span></> },
      { value: 'devices' as const, label: <>iPhone &amp; iPad<span className="count">{iosDevices.length}</span></> },
    ];
    // The iPhone/iPad path is the headline feature: lead with it when one is plugged in.
    if (iosDevices.length) tabOptions.unshift(tabOptions.pop()!);
    const shown = tab === 'displays' ? displays : tab === 'windows' ? windows : [];
    const selectedName = selectedIos?.name ?? (selectedDevice ? cameraLabel(selectedDevice, 0) : selected?.name);
    const cameraCard = (d: MediaDeviceInfo, i: number) => (
      <button
        key={d.deviceId}
        type="button"
        className={`card${selectedDevice?.deviceId === d.deviceId ? ' selected' : ''}`}
        onClick={() => {
          setSelectedDevice(d);
          setSelected(null);
          setSelectedIos(null);
        }}
      >
        <div className="card-thumb device-thumb">
          <div className="webcam" />
        </div>
        <div className="card-name">{cameraLabel(d, i)}</div>
      </button>
    );
    const iosCard = (d: IosDevice) => (
      <button
        key={d.id}
        type="button"
        className={`card${selectedIos?.id === d.id ? ' selected' : ''}`}
        onClick={() => {
          setSelectedIos(d);
          setSelected(null);
          setSelectedDevice(null);
          openSetup({ kind: 'firstUse' });
        }}
      >
        <div className="card-thumb device-thumb">
          <div className={`device-outline${/ipad/i.test(d.name) ? ' tablet' : ''}`} />
        </div>
        <div className="card-name">{d.name}</div>
      </button>
    );

    return (
      <div className="shell">
        <header className="topbar">
          <span className="wordmark">OpenScreen</span>
          <div className="spacer" />
          <Button variant="ghost" onClick={openProject}>
            Open project…
          </Button>
        </header>

        <main className="picker">
          {perms && perms.screen !== 'granted' && (
            <div className="banner">
              <span className="banner-dot" />
              <p>
                OpenScreen doesn't have Screen Recording access, so recordings will come
                out black. After you allow it in System Settings, macOS needs OpenScreen
                to quit and reopen.
              </p>
              <Button size="sm" onClick={() => api.openScreenSettings()}>
                Open System Settings
              </Button>
              <Button size="sm" onClick={() => void api.relaunch()}>
                Quit &amp; Reopen
              </Button>
            </div>
          )}
          {perms && !perms.hooks && (
            <div className="banner">
              <span className="banner-dot" />
              <p>
                Clicks and keystrokes won't be tracked until OpenScreen has Accessibility
                access. Without it there are no click effects or click-based auto-zoom.
              </p>
              <Button
                size="sm"
                onClick={async () => {
                  const granted = await api.requestAccessibility().catch(() => false);
                  if (granted) void refresh();
                }}
              >
                Grant Access
              </Button>
            </div>
          )}

          <div className="picker-head">
            <div>
              <h1>New recording</h1>
              <p>Choose a display, a window, or a connected iPhone or iPad.</p>
            </div>
            <div className="picker-tools">
              <Button variant="ghost" size="sm" onClick={() => void refresh()} title="Look for new windows and displays">
                Refresh
              </Button>
              <Segmented value={tab} options={tabOptions} onChange={setPickerTab} label="Source type" />
            </div>
          </div>
          {tab === 'windows' && shown.length > 0 && (
            <p className="hint">
              Window recordings don't include the cursor, click effects or auto-zoom. Record the
              display for those.
            </p>
          )}

          {tab === 'devices' ? (
            <>
              {iosDevices.length ? (
                <div className="cards">{iosDevices.map(iosCard)}</div>
              ) : ios.error ? (
                <EmptyState art={<div className="device-outline large" />} title="iPhone capture is unavailable">
                  {ios.error}
                </EmptyState>
              ) : ios.ready && inlineSetup ? (
                <div className="setup-empty">
                  <p className="empty-title">No iPhone or iPad connected</p>
                  <p className="empty-body">Follow these steps. It shows up here within a few seconds.</p>
                  <IosSetupCard onClose={() => setInlineSetup(false)} onHide={hideSetup} />
                </div>
              ) : (
                <EmptyState
                  art={<div className="device-outline large" />}
                  title={ios.ready ? 'No iPhone or iPad connected' : 'Looking for iPhone and iPad…'}
                  actions={
                    ios.ready && (
                      <Button size="sm" onClick={() => setInlineSetup(true)}>
                        Show setup steps
                      </Button>
                    )
                  }
                >
                  Connect it with a USB cable, unlock it, and tap Trust on the device if
                  asked. It shows up here within a few seconds.
                </EmptyState>
              )}
              {otherCameras.length > 0 && (
                <>
                  <h2 className="subhead">Other cameras</h2>
                  <p className="hint">
                    These record a camera, not a screen. Continuity Camera is your iPhone's camera.
                  </p>
                  <div className="cards">{otherCameras.map(cameraCard)}</div>
                </>
              )}
            </>
          ) : shown.length ? (
            <div className="cards">
              {shown.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`card${selected?.id === s.id ? ' selected' : ''}`}
                  onClick={() => {
                    setSelected(s);
                    setSelectedDevice(null);
                    setSelectedIos(null);
                  }}
                >
                  <div className="card-thumb">
                    {s.thumbnailDataUrl && s.thumbnailDataUrl.length > 32 ? (
                      <img
                        src={s.thumbnailDataUrl}
                        alt=""
                        onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
                      />
                    ) : (
                      <span className="thumb-empty">{s.name.slice(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="card-name">{s.name}</div>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState title={tab === 'displays' ? 'No displays found' : 'No windows found'}>
              {tab === 'windows'
                ? 'Open the app you want to record, then press Refresh.'
                : 'OpenScreen could not list any displays. Check the Screen Recording permission.'}
            </EmptyState>
          )}
        </main>

        <footer className="picker-foot">
          <label
            className={`inline-switch${selectedIos ? ' disabled' : ''}`}
            title={selectedIos ? 'iPhone and iPad recordings use the device audio' : undefined}
          >
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={micOn && !selectedIos}
              disabled={!!selectedIos}
              onChange={(e) => setMicOn(e.target.checked)}
            />
            Microphone
            {selectedIos && <span className="hint">Uses device audio</span>}
          </label>
          <label className="inline-switch">
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={camOn}
              onChange={(e) => void toggleCamera(e.target.checked)}
            />
            Camera
          </label>
          {camOn &&
            (devices.length > 1 ? (
              <select
                className="cam-select"
                aria-label="Camera"
                value={overlayCamera?.deviceId ?? ''}
                onChange={(e) => setCamId(e.target.value)}
              >
                {devices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {cameraLabel(d, i)}
                  </option>
                ))}
              </select>
            ) : devices.length === 0 ? (
              <span className="hint">No camera found</span>
            ) : null)}
          <div className="spacer" />
          <span className="status" title={status}>
            {status || (selectedName ? selectedName : 'Nothing selected')}
          </span>
          <Button variant="primary" size="lg" disabled={!selected && !selectedDevice && !selectedIos} onClick={start}>
            Start recording
          </Button>
        </footer>

        {noticeToast}
        {setupDialog && (
          <IosSetupCard
            key={setupDialog.key}
            dialog
            initialStep={setupDialog.step}
            message={setupDialog.message}
            onClose={closeSetupDialog}
            onHide={hideSetup}
          />
        )}
        {countdown !== null && countdown > 0 && (
          <div className="countdown">
            <div className="countdown-ring">
              <svg viewBox="0 0 120 120" aria-hidden="true">
                <circle className="track" cx="60" cy="60" r="54" />
                <circle key={countdown} className="sweep" cx="60" cy="60" r="54" />
              </svg>
              <span key={countdown} className="countdown-num">{countdown}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (phase.name === 'recording') {
    const sourceName = selectedIos?.name ?? (selectedDevice ? cameraLabel(selectedDevice, 0) : selected?.name) ?? 'Recording';
    return (
      <div className="shell">
        <header className="topbar" />
        <main className="rec-screen">
          <RecordingCard
            sourceName={sourceName}
            elapsed={elapsed}
            saving={saving}
            onStop={() => void stop()}
            stream={selectedIos ? null : liveStream}
            device={selectedIos ? { name: selectedIos.name, tablet: /ipad/i.test(selectedIos.name) } : null}
            warning={selectedIos ? iosWarning : null}
          />
          <p className="rec-hint">{saving ? 'Saving the recording…' : 'Recording. Stop to open the editor.'}</p>
        </main>
        {noticeToast}
      </div>
    );
  }

  return (
    <>
      <Editor
        key={phase.session}
        videoUrl={phase.videoUrl}
        camUrl={phase.camUrl}
        project={phase.project}
        cursor={phase.cursor}
        keys={phase.keys}
        bundleDir={phase.bundleDir}
        onNewRecording={backToPicker}
        onOpenProject={openProject}
      />
      {noticeToast}
    </>
  );
}
