import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SourceInfo } from './api';
import type { CursorSample, KeystrokeSample, Project } from '../../shared/types';
import { defaultProject } from '../../shared/types';
import { Editor } from './Editor';
import { Button, EmptyState, Segmented } from './ui';

type PickerTab = 'displays' | 'windows' | 'devices';

type Phase =
  | { name: 'picker' }
  | { name: 'recording'; startedAt: number }
  | { name: 'editor'; bundleDir: string; videoUrl: string; camUrl?: string; project: Project; cursor: CursorSample[]; keys: KeystrokeSample[] };

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

/** Capture a device camera (wired iPhone/iPad appear as continuity video
 *  devices on macOS) at up to 1080p60. */
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

export function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'picker' });
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selected, setSelected] = useState<SourceInfo | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<MediaDeviceInfo | null>(null);
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

  useEffect(() => {
    api.listSources().then(setSources).catch((e) => setStatus(`sources: ${e}`));
    api.permissionsStatus().then(setPerms).catch(() => {});
    navigator.mediaDevices.enumerateDevices().then((all) => {
      setDevices(all.filter((d) => d.kind === 'videoinput' && d.label));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (phase.name !== 'recording') return;
    const t = setInterval(() => setElapsed((performance.now() - phase.startedAt) / 1000), 250);
    return () => clearInterval(t);
  }, [phase]);

  const start = useCallback(() => {
    if (!selected && !selectedDevice) return;
    setCountdown(3);
  }, [selected, selectedDevice]);

  const reallyStart = useCallback(async () => {
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
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.start(250);
      recorderRef.current = rec;
      if (camOn && devices.length > 0) {
        try {
          const camStream = await captureDevice(devices[0].deviceId);
          camStreamRef.current = camStream;
          camChunksRef.current = [];
          const camRec = new MediaRecorder(camStream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
          camRec.ondataavailable = (e) => e.data.size && camChunksRef.current.push(e.data);
          camRec.start(250);
          camRecRef.current = camRec;
        } catch {
          setStatus('camera unavailable — recording screen only');
        }
      }
      await api.startRecording(selectedDevice?.deviceId ?? selected!.id);
      setPhase({ name: 'recording', startedAt: performance.now() });
    } catch (e) {
      setStatus(`record: ${e}`);
    }
  }, [selected, selectedDevice, micOn, camOn, devices]);

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

  const stop = useCallback(async () => {
    const rec = recorderRef.current;
    const stream = streamRef.current;
    if (!rec || !stream) return;
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.stop();
    stream.getTracks().forEach((t) => t.stop());
    await done;
    const { samples: cursor, keys } = await api.stopRecording();
    // Stop the camera recorder too, if it ran.
    let camBlob: Blob | undefined;
    if (camRecRef.current) {
      const camRec = camRecRef.current;
      const camDone = new Promise<void>((r) => (camRec.onstop = () => r()));
      camRec.stop();
      camStreamRef.current?.getTracks().forEach((t) => t.stop());
      await camDone;
      camRecRef.current = null;
      camStreamRef.current = null;
      camBlob = new Blob(camChunksRef.current, { type: camRec.mimeType });
    }
    const blob = new Blob(chunksRef.current, { type: rec.mimeType });
    const videoBytes = await blob.arrayBuffer();
    const camBytes = camBlob ? await camBlob.arrayBuffer() : undefined;
    const track = stream.getVideoTracks()[0]?.getSettings();
    const project = defaultProject({
      screenVideoFile: 'screen.webm',
      cameraVideoFile: camBytes ? 'cam.webm' : undefined,
      sourceKind: selectedDevice ? 'iosDevice' : 'display',
      sourceSize: { width: track?.width ?? 1920, height: track?.height ?? 1080 },
      duration: elapsed,
    });
    if (camBytes) project.cameraOverlay.enabled = true;
    const bundleDir = await api.saveBundle(videoBytes, cursor, project, camBytes, keys);
    const videoUrl = URL.createObjectURL(blob);
    const camUrl = camBlob ? URL.createObjectURL(camBlob) : undefined;
    setPhase({ name: 'editor', bundleDir, videoUrl, camUrl, project, cursor, keys });
  }, [elapsed]);

  const openProject = async () => {
    const b = await api.openBundle();
    if (!b) return;
    setPhase({
      name: 'editor',
      bundleDir: b.bundleDir,
      videoUrl: `file://${b.videoPath}`,
      camUrl: b.camPath ? `file://${b.camPath}` : undefined,
      project: b.project,
      cursor: b.cursor,
      keys: b.keys,
    });
  };

  if (phase.name === 'picker') {
    const displays = sources.filter((s) => s.id.startsWith('screen:'));
    const windows = sources.filter((s) => s.id.startsWith('window:'));
    const tab: PickerTab = pickerTab ?? (devices.length ? 'devices' : 'displays');
    const tabOptions = [
      { value: 'displays' as const, label: <>Displays<span className="count">{displays.length}</span></> },
      { value: 'windows' as const, label: <>Windows<span className="count">{windows.length}</span></> },
      { value: 'devices' as const, label: <>iPhone &amp; iPad<span className="count">{devices.length}</span></> },
    ];
    // The iPhone/iPad path is the headline feature: lead with it when one is plugged in.
    if (devices.length) tabOptions.unshift(tabOptions.pop()!);
    const shown = tab === 'displays' ? displays : tab === 'windows' ? windows : [];
    const selectedName = selectedDevice?.label ?? selected?.name;

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
            devices.length ? (
              <div className="cards">
                {devices.map((d) => (
                  <button
                    key={d.deviceId}
                    type="button"
                    className={`card${selectedDevice?.deviceId === d.deviceId ? ' selected' : ''}`}
                    onClick={() => {
                      setSelectedDevice(d);
                      setSelected(null);
                    }}
                  >
                    <div className="card-thumb device-thumb">
                      <div
                        className={`device-outline${
                          /ipad/i.test(d.label) ? ' tablet' : /iphone/i.test(d.label) ? '' : ' camera'
                        }`}
                      />
                    </div>
                    <div className="card-name">{d.label}</div>
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState
                art={<div className="device-outline large" />}
                title="No iPhone or iPad connected"
              >
                Connect it with a USB cable, unlock it, and tap Trust if asked. Then
                reopen OpenScreen to refresh this list.
              </EmptyState>
            )
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
          <label className="inline-switch">
            <input type="checkbox" role="switch" className="switch" checked={micOn} onChange={(e) => setMicOn(e.target.checked)} />
            Microphone
          </label>
          <label className="inline-switch">
            <input type="checkbox" role="switch" className="switch" checked={camOn} onChange={(e) => setCamOn(e.target.checked)} />
            Camera
          </label>
          <div className="spacer" />
          <span className="status" title={status}>
            {status || (selectedName ? selectedName : 'Nothing selected')}
          </span>
          <Button variant="primary" size="lg" disabled={!selected && !selectedDevice} onClick={start}>
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
            <span className="rec-source">{selectedDevice?.label ?? selected?.name ?? 'Recording'}</span>
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
      videoUrl={phase.videoUrl}
      camUrl={phase.camUrl}
      project={phase.project}
      cursor={phase.cursor}
      keys={phase.keys}
      bundleDir={phase.bundleDir}
    />
  );
}
