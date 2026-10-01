import React, { useEffect, useState } from 'react';
import { RecordingCard } from './components/RecordingCard';
import { ExportProgress } from './components/ExportProgress';
import { ExportTasks, type TaskRowState } from './components/ExportPanel';
import { IosSetupCard } from './components/IosSetupCard';
import { getPreset } from '../../shared/exportPresets';
import { openCameraBubble, type CameraBubble } from './cameraBubble';

/**
 * Development only: `index.html?gallery=<state>` renders one screen that is
 * hard to reach on demand (a take in progress, an export at a given moment,
 * the setup sheet) with made-up content, so it can be looked at and
 * screenshotted without recording anything real.
 */

/** A drawn stand-in for a captured window, streamed like a real capture. */
function useFakeCapture(): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null);
  useEffect(() => {
    const c = document.createElement('canvas');
    c.width = 1600;
    c.height = 1000;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 1600, 1000);
    grad.addColorStop(0, '#7aa7d9');
    grad.addColorStop(0.55, '#c99ad6');
    grad.addColorStop(1, '#f2b38a');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1600, 1000);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.roundRect(120, 90, 1360, 820, 18);
    g.fill();
    g.fillStyle = '#f0eef2';
    g.fillRect(120, 90, 220, 820);
    g.fillStyle = '#1d1d1f';
    g.font = '600 26px system-ui';
    g.fillText('Spring launch', 380, 150);
    for (let col = 0; col < 4; col++) {
      g.fillStyle = '#f5f5f7';
      g.beginPath();
      g.roundRect(380 + col * 265, 190, 245, 520, 14);
      g.fill();
      for (let i = 0; i < 3 - (col % 2); i++) {
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.roundRect(392 + col * 265, 230 + i * 92, 221, 78, 10);
        g.fill();
        g.fillStyle = '#d8d8dc';
        g.fillRect(408 + col * 265, 250 + i * 92, 140, 12);
        g.fillRect(408 + col * 265, 274 + i * 92, 80, 10);
      }
    }
    const s = c.captureStream(10);
    setStream(s);
    return () => s.getTracks().forEach((t) => t.stop());
  }, []);
  return stream;
}

const preset = (id: Parameters<typeof getPreset>[0]) => getPreset(id);

/**
 * The camera bubble as a take opens it, on the display OpenScreen is on.
 * Run with --use-fake-device-for-media-stream so the camera is Chromium's
 * test pattern, not a real one. `window.cameraBubble.close()` closes it and
 * resolves where it was left, as Stop does.
 */
function BubbleDemo({ circular }: { circular: boolean }) {
  const [state, setState] = useState('Opening the camera…');
  useEffect(() => {
    let live = true;
    let stream: MediaStream | null = null;
    let bubble: CameraBubble | null = null;
    void navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then((s) => {
        stream = s;
        if (!live) return s.getTracks().forEach((t) => t.stop());
        bubble = openCameraBubble({ stream: s, circular, onCameraLost: setState });
        (window as unknown as { cameraBubble: CameraBubble | null }).cameraBubble = bubble;
        setState(bubble ? 'The camera bubble is open.' : 'The bubble window could not open.');
      })
      .catch((e) => setState(`No camera: ${String(e)}`));
    return () => {
      live = false;
      void bubble?.close();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [circular]);
  return <p style={{ padding: 40 }}>{state}</p>;
}

export function Gallery({ view }: { view: string }) {
  const stream = useFakeCapture();
  const startedAt = Date.now() - 41_000;
  const noop = () => {};

  if (view === 'rec' || view === 'rec-ios' || view === 'rec-warning' || view === 'saving') {
    const ios = view !== 'rec' && view !== 'saving';
    return (
      <div className="shell">
        <header className="topbar" />
        <main className="rec-screen">
          <RecordingCard
            sourceName={ios ? 'iPhone 16 Pro' : 'Roadmap'}
            elapsed={83}
            saving={view === 'saving'}
            onStop={noop}
            stream={ios ? null : stream}
            device={ios ? { id: 'demo', name: 'iPhone 16 Pro', tablet: false, preview: null } : null}
            warning={view === 'rec-warning' ? 'No new picture for a few seconds. The iPhone may be locked.' : null}
          />
          <p className="rec-hint">{view === 'saving' ? 'Saving the recording…' : 'Recording. Stop to open the editor.'}</p>
        </main>
      </div>
    );
  }

  const overlay = (child: React.ReactNode) => (
    <div className="editor gallery-editor">
      <header className="topbar ed-top" />
      <div className="xp-overlay no-drag">{child}</div>
    </div>
  );

  if (view.startsWith('export-')) {
    const state = view === 'export-done' ? 'done' : view === 'export-failed' ? 'failed' : 'running';
    if (view === 'export-batch') {
      const rows: TaskRowState[] = [
        { preset: preset('social-9x16'), status: 'done', progress: 1, files: ['/demo/Trips demo 9x16.mp4'] },
        { preset: preset('feed-4x5'), status: 'encoding', progress: 0.72, files: [] },
        { preset: preset('square'), status: 'queued', progress: 0, files: [] },
        { preset: preset('landscape-16x9'), status: 'failed', progress: 0.4, files: [], error: 'ffmpeg stopped: the disk is full.' },
      ];
      return overlay(
        <ExportTasks
          rows={rows}
          progress={{ state: 'running', done: 620, total: 1000, startedAt, detail: 'Encoding Feed 4:5', onCancel: noop, onClose: noop }}
          onReveal={noop}
          onRetry={noop}
        />,
      );
    }
    return overlay(
      <ExportProgress
        state={state}
        done={state === 'running' ? 412 : state === 'failed' ? 300 : 1080}
        total={1080}
        startedAt={startedAt}
        message={state === 'done' ? 'Trips demo.mp4' : state === 'failed' ? 'ffmpeg stopped: the disk is full.' : undefined}
        onCancel={noop}
        onReveal={noop}
        onRetry={noop}
        onClose={noop}
      />,
    );
  }

  if (view === 'setup' || view === 'setup-error') {
    return (
      <div className="shell">
        <header className="topbar" />
        <main className="picker" />
        <IosSetupCard
          dialog
          initialStep={view === 'setup-error' ? 1 : 0}
          message={view === 'setup-error' ? 'The iPhone sent no picture. Unlock it and try again.' : null}
          onClose={noop}
          onHide={noop}
        />
      </div>
    );
  }

  if (view === 'camera-bubble' || view === 'camera-bubble-square') return <BubbleDemo circular={view === 'camera-bubble'} />;

  return <p style={{ padding: 40 }}>Unknown gallery view: {view}</p>;
}
