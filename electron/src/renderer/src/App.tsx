import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SourceInfo } from './api';
import type { CursorSample, Project } from '../../shared/types';
import { defaultProject } from '../../shared/types';
import { Editor } from './Editor';

type Phase =
  | { name: 'picker' }
  | { name: 'recording'; startedAt: number }
  | { name: 'editor'; bundleDir: string; videoUrl: string; project: Project; cursor: CursorSample[] };

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
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    api.listSources().then(setSources).catch((e) => setStatus(`sources: ${e}`));
    navigator.mediaDevices.enumerateDevices().then((all) => {
      setDevices(all.filter((d) => d.kind === 'videoinput' && d.label));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (phase.name !== 'recording') return;
    const t = setInterval(() => setElapsed((performance.now() - phase.startedAt) / 1000), 250);
    return () => clearInterval(t);
  }, [phase]);

  const start = useCallback(async () => {
    if (!selected && !selectedDevice) return;
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
      await api.startRecording(selectedDevice?.deviceId ?? selected!.id);
      setPhase({ name: 'recording', startedAt: performance.now() });
    } catch (e) {
      setStatus(`record: ${e}`);
    }
  }, [selected, selectedDevice, micOn]);

  const stop = useCallback(async () => {
    const rec = recorderRef.current;
    const stream = streamRef.current;
    if (!rec || !stream) return;
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.stop();
    stream.getTracks().forEach((t) => t.stop());
    await done;
    const cursor = await api.stopRecording();
    const blob = new Blob(chunksRef.current, { type: rec.mimeType });
    const videoBytes = await blob.arrayBuffer();
    const track = stream.getVideoTracks()[0]?.getSettings();
    const project = defaultProject({
      screenVideoFile: 'screen.webm',
      sourceKind: selectedDevice ? 'iosDevice' : 'display',
      sourceSize: { width: track?.width ?? 1920, height: track?.height ?? 1080 },
      duration: elapsed,
    });
    const bundleDir = await api.saveBundle(videoBytes, cursor, project);
    const videoUrl = URL.createObjectURL(blob);
    setPhase({ name: 'editor', bundleDir, videoUrl, project, cursor });
  }, [elapsed]);

  if (phase.name === 'picker') {
    return (
      <div className="app">
        <h2>OpenScreen</h2>
        <div className="sources">
          {sources.map((s) => (
            <button
              key={s.id}
              className={`source${selected?.id === s.id ? ' selected' : ''}`}
              onClick={() => {
                setSelected(s);
                setSelectedDevice(null);
              }}
            >
              <img src={s.thumbnailDataUrl} alt="" />
              <div className="name">{s.name}</div>
            </button>
          ))}
          {devices.map((d) => (
            <button
              key={d.deviceId}
              className={`source${selectedDevice?.deviceId === d.deviceId ? ' selected' : ''}`}
              onClick={() => {
                setSelectedDevice(d);
                setSelected(null);
              }}
            >
              <div className="name" style={{ padding: '24px 8px', textAlign: 'center' }}>
                {d.label}
              </div>
            </button>
          ))}
        </div>
        <div>
          <button className="primary" disabled={!selected && !selectedDevice} onClick={start}>
            Start Recording
          </button>{' '}
          <button
            onClick={async () => {
              const b = await api.openBundle();
              if (!b) return;
              setPhase({
                name: 'editor',
                bundleDir: b.bundleDir,
                videoUrl: `file://${b.videoPath}`,
                project: b.project,
                cursor: b.cursor,
              });
            }}
          >
            Open project…
          </button>{' '}
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked={micOn} onChange={(e) => setMicOn(e.target.checked)} /> Mic
          </label>{' '}
          <span className="status">{status}</span>
        </div>
      </div>
    );
  }

  if (phase.name === 'recording') {
    return (
      <div className="app">
        <div className="rec-hud">
          <div className="rec-dot" />
          <span>Recording — {elapsed.toFixed(1)}s</span>
        </div>
        <button className="primary" onClick={stop}>Stop</button>
      </div>
    );
  }

  return (
    <Editor
      videoUrl={phase.videoUrl}
      project={phase.project}
      cursor={phase.cursor}
      bundleDir={phase.bundleDir}
    />
  );
}
