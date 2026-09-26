import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, type IosDevice, type SourceInfo } from './api';
import type { CursorSample, KeystrokeSample, Project } from '../../shared/types';
import { defaultProject } from '../../shared/types';
import { Editor } from './Editor';
import { Button, EmptyState, Segmented } from './ui';

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
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState('');
  const [perms, setPerms] = useState<{ screen: string; hooks: boolean } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  // UI only: which source tab the picker shows (null = pick a sensible default).
  const [pickerTab, setPickerTab] = useState<PickerTab | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const camRecRef = useRef<MediaRecorder | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const camChunksRef = useRef<Blob[]>([]);
  // The in-flight iPhone take: its bundle and the size from the first frame.
  const iosTakeRef = useRef<{ bundleDir: string; width: number; height: number } | null>(null);
  const sessionRef = useRef(0);
  const openEditor = useCallback(
    (p: Omit<EditorPhase, 'name' | 'session'>) =>
      setPhase({ name: 'editor', session: ++sessionRef.current, ...p }),
    [],
  );

  useEffect(() => {
    api.listSources().then(setSources).catch((e) => setStatus(`sources: ${e}`));
    api.permissionsStatus().then(setPerms).catch(() => {});
    navigator.mediaDevices.enumerateDevices().then((all) => {
      setDevices(all.filter((d) => d.kind === 'videoinput' && d.label));
    }).catch(() => {});
  }, []);

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
    if (phase.name !== 'recording') return;
    const t = setInterval(() => setElapsed((performance.now() - phase.startedAt) / 1000), 250);
    return () => clearInterval(t);
  }, [phase]);

  const start = useCallback(() => {
    if (!selected && !selectedDevice && !selectedIos) return;
    setCountdown(3);
  }, [selected, selectedDevice, selectedIos]);

  // Optional camera overlay, recorded alongside whichever source runs.
  const startCamOverlay = useCallback(async () => {
    if (!camOn || devices.length === 0) return;
    try {
      const camStream = await captureDevice(devices[0].deviceId);
      camStreamRef.current = camStream;
      camChunksRef.current = [];
      const camRec = new MediaRecorder(camStream, { mimeType: recorderMime(), videoBitsPerSecond: 6_000_000 });
      camRec.ondataavailable = (e) => e.data.size && camChunksRef.current.push(e.data);
      camRec.start(250);
      camRecRef.current = camRec;
    } catch {
      setStatus('camera unavailable — recording screen only');
    }
  }, [camOn, devices]);

  const stopCamOverlay = useCallback(async (): Promise<Blob | undefined> => {
    const camRec = camRecRef.current;
    if (!camRec) return undefined;
    const camDone = new Promise<void>((r) => (camRec.onstop = () => r()));
    camRec.stop();
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
    await camDone;
    camRecRef.current = null;
    camStreamRef.current = null;
    return new Blob(camChunksRef.current, { type: camRec.mimeType });
  }, []);

  const reallyStart = useCallback(async () => {
    if (selectedIos) {
      // iPhone/iPad screen: the helper records straight to disk. Audio comes
      // from the device, so the mic switch doesn't apply.
      try {
        setStatus(`Starting ${selectedIos.name}…`);
        iosTakeRef.current = await api.iosStart(selectedIos.id);
        setStatus('');
        await startCamOverlay();
        setPhase({ name: 'recording', startedAt: performance.now() });
      } catch (e) {
        iosTakeRef.current = null;
        setStatus(ipcMessage(e));
      }
      return;
    }
    try {
      const stream = selectedDevice
        ? await captureDevice(selectedDevice.deviceId)
        : await captureStream(selected!.id);
      if (micOn) {
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
          mic.getAudioTracks().forEach((t) => stream.addTrack(t));
        } catch {
          setStatus('mic denied — recording silent');
        }
      }
      streamRef.current = stream;
      chunksRef.current = [];
      const rec = new MediaRecorder(stream, { mimeType: recorderMime(), videoBitsPerSecond: 12_000_000 });
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.start(250);
      recorderRef.current = rec;
      await startCamOverlay();
      await api.startRecording(selectedDevice?.deviceId ?? selected!.id);
      setPhase({ name: 'recording', startedAt: performance.now() });
    } catch (e) {
      setStatus(`record: ${e}`);
    }
  }, [selected, selectedDevice, selectedIos, micOn, startCamOverlay]);

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

  const stopIos = useCallback(async () => {
    const take = iosTakeRef.current;
    if (!take) return;
    iosTakeRef.current = null;
    let done;
    try {
      done = await api.iosStop();
    } catch (e) {
      await stopCamOverlay();
      setStatus(`recording failed: ${ipcMessage(e)}`);
      setPhase({ name: 'picker' });
      return;
    }
    const camBlob = await stopCamOverlay();
    const camBytes = camBlob ? await camBlob.arrayBuffer() : undefined;
    const project = defaultProject({
      screenVideoFile: 'screen.mov',
      cameraVideoFile: camBytes ? 'cam.webm' : undefined,
      sourceKind: 'iosDevice',
      // The finished file's size wins: the phone may have rotated mid-take.
      sourceSize: { width: done.width ?? take.width, height: done.height ?? take.height },
      duration: done.duration ?? elapsed,
    });
    if (camBytes) project.cameraOverlay.enabled = true;
    const bundleDir = await api.saveBundleWithVideoFile(take.bundleDir, [], project, camBytes, []);
    openEditor({
      bundleDir,
      videoUrl: `file://${bundleDir}/screen.mov`,
      camUrl: camBlob ? URL.createObjectURL(camBlob) : undefined,
      project,
      cursor: [],
      keys: [],
    });
  }, [elapsed, stopCamOverlay, openEditor]);

  const stop = useCallback(async () => {
    if (iosTakeRef.current) return stopIos();
    const rec = recorderRef.current;
    const stream = streamRef.current;
    if (!rec || !stream) return;
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.stop();
    stream.getTracks().forEach((t) => t.stop());
    await done;
    const { samples: cursor, keys } = await api.stopRecording();
    // Stop the camera recorder too, if it ran.
    const camBlob = await stopCamOverlay();
    const blob = new Blob(chunksRef.current, { type: rec.mimeType });
    const videoBytes = await blob.arrayBuffer();
    const camBytes = camBlob ? await camBlob.arrayBuffer() : undefined;
    const track = stream.getVideoTracks()[0]?.getSettings();
    const project = defaultProject({
      screenVideoFile: 'screen.webm',
      cameraVideoFile: camBytes ? 'cam.webm' : undefined,
      sourceKind: 'display',
      sourceSize: { width: track?.width ?? 1920, height: track?.height ?? 1080 },
      duration: elapsed,
    });
    if (camBytes) project.cameraOverlay.enabled = true;
    const bundleDir = await api.saveBundle(videoBytes, cursor, project, camBytes, keys);
    const videoUrl = URL.createObjectURL(blob);
    const camUrl = camBlob ? URL.createObjectURL(camBlob) : undefined;
    openEditor({ bundleDir, videoUrl, camUrl, project, cursor, keys });
  }, [elapsed, stopIos, stopCamOverlay, openEditor]);

  // Replaces whatever is open. The editor asks about unsaved changes first.
  const openProject = useCallback(async () => {
    const b = await api.openBundle();
    if (!b) return;
    openEditor({
      bundleDir: b.bundleDir,
      videoUrl: `file://${b.videoPath}`,
      camUrl: b.camPath ? `file://${b.camPath}` : undefined,
      project: b.project,
      cursor: b.cursor,
      keys: b.keys,
    });
  }, [openEditor]);

  const backToPicker = useCallback(() => setPhase({ name: 'picker' }), []);

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

  // A fresh recording plays from blob URLs; release them when its editor goes.
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
    const selectedName = selectedIos?.name ?? selectedDevice?.label ?? selected?.name;
    const cameraCard = (d: MediaDeviceInfo) => (
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
        <div className="card-name">{d.label}</div>
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
                Screen Recording permission is {perms.screen} — captures will come
                out black until granted.
              </p>
              <Button size="sm" onClick={() => api.openScreenSettings()}>
                Open System Settings
              </Button>
            </div>
          )}
          {perms && !perms.hooks && (
            <div className="banner">
              <span className="banner-dot" />
              <p>
                Input hooks unavailable — clicks and keystrokes won't be tracked
                (grant Accessibility + restart the app).
              </p>
            </div>
          )}

          <div className="picker-head">
            <div>
              <h1>New recording</h1>
              <p>Choose a display, a window, or a connected iPhone or iPad.</p>
            </div>
            <Segmented value={tab} options={tabOptions} onChange={setPickerTab} label="Source type" />
          </div>

          {tab === 'devices' ? (
            <>
              {iosDevices.length ? (
                <div className="cards">{iosDevices.map(iosCard)}</div>
              ) : ios.error ? (
                <EmptyState art={<div className="device-outline large" />} title="iPhone capture is unavailable">
                  {ios.error}
                </EmptyState>
              ) : (
                <EmptyState
                  art={<div className="device-outline large" />}
                  title={ios.ready ? 'No iPhone or iPad connected' : 'Looking for iPhone and iPad…'}
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
                ? 'Open the app you want to record, then reopen OpenScreen to refresh this list.'
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
            <input type="checkbox" role="switch" className="switch" checked={camOn} onChange={(e) => setCamOn(e.target.checked)} />
            Camera
          </label>
          <div className="spacer" />
          <span className="status" title={status}>
            {status || (selectedName ? selectedName : 'Nothing selected')}
          </span>
          <Button variant="primary" size="lg" disabled={!selected && !selectedDevice && !selectedIos} onClick={start}>
            Start recording
          </Button>
        </footer>

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
    const mm = Math.floor(elapsed / 60);
    const ss = Math.floor(elapsed % 60);
    return (
      <div className="shell">
        <header className="topbar" />
        <main className="rec-screen">
          <div className="rec-pill">
            <span className="rec-dot" />
            <span className="rec-time">
              {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
            </span>
            <span className="rec-source">{selectedIos?.name ?? selectedDevice?.label ?? selected?.name ?? 'Recording'}</span>
            <Button variant="record" onClick={stop}>
              <span className="stop-glyph" />
              Stop
            </Button>
          </div>
          <p className="rec-hint">Recording. Stop to open the editor.</p>
        </main>
      </div>
    );
  }

  return (
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
  );
}
