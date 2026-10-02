import React, { useEffect, useState } from 'react';
import { RecordingCard } from './components/RecordingCard';
import { ExportProgress } from './components/ExportProgress';
import { ExportTasks, type TaskRowState } from './components/ExportPanel';
import { IosSetupCard } from './components/IosSetupCard';
import { getPreset } from '../../shared/exportPresets';
import { openRecordingMonitor, type RecordingMonitor } from './recordingMonitor';
import { readMonitorPrefs, writeMonitorPrefs } from '../../shared/recordingMonitor';

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

/** A stand-in for an iPhone's live preview: JPEG frames of a drawn home
 *  screen, about 12 a second, the way the helper sends them. */
function fakePhoneFrames(): (draw: (jpeg: Uint8Array) => void) => () => void {
  return (draw) => {
    const c = document.createElement('canvas');
    c.width = 360;
    c.height = 780;
    const g = c.getContext('2d')!;
    let n = 0;
    const t = setInterval(() => {
      const grad = g.createLinearGradient(0, 0, 0, 780);
      grad.addColorStop(0, '#5b7cfa');
      grad.addColorStop(1, '#c86dd7');
      g.fillStyle = grad;
      g.fillRect(0, 0, 360, 780);
      for (let i = 0; i < 20; i++) {
        g.fillStyle = `hsl(${(i * 37 + n * 3) % 360} 70% 60%)`;
        g.beginPath();
        g.roundRect(28 + (i % 4) * 80, 90 + Math.floor(i / 4) * 96, 60, 60, 14);
        g.fill();
      }
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.font = '600 22px system-ui';
      g.fillText(`9:41`, 30, 44);
      n++;
      c.toBlob((b) => b && void b.arrayBuffer().then((buf) => draw(new Uint8Array(buf))), 'image/jpeg', 0.8);
    }, 83);
    return () => clearInterval(t);
  };
}

/** A Retina-sized moving stand-in for a 60 fps screen capture. */
function animatedScreen(): { stream: MediaStream; stop: () => void } {
  const c = document.createElement('canvas');
  c.width = 2880;
  c.height = 1800;
  const g = c.getContext('2d')!;
  let raf = 0;
  const tick = (t: number) => {
    g.fillStyle = '#eef0f4';
    g.fillRect(0, 0, 2880, 1800);
    g.fillStyle = '#ffffff';
    g.fillRect(240, 180, 2400, 1440);
    g.fillStyle = '#5b7cfa';
    g.fillRect(240 + ((t / 4) % 2200), 700, 200, 200);
    g.fillStyle = '#1d1d1f';
    g.font = '600 64px system-ui';
    g.fillText('Spring launch', 320, 300);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const stream = c.captureStream(60);
  return { stream, stop: () => (cancelAnimationFrame(raf), stream.getTracks().forEach((t) => t.stop())) };
}

/**
 * The recording monitor as a take opens it, on the display OpenScreen is
 * on: `monitor` beside a drawn stand-in screen, `monitor-phone` beside a
 * stand-in iPhone preview, `monitor-face` with the face alone. Run with
 * --use-fake-device-for-media-stream so the camera is Chromium's test
 * pattern, not a real one. `window.recordingMonitor.close()` closes it as
 * Stop does and resolves where it was left.
 */
function MonitorDemo({ view }: { view: string }) {
  const [state, setState] = useState('Opening the camera…');
  useEffect(() => {
    // monitor-off: the same streams with no monitor, to measure what it costs.
    const fake = view === 'monitor' || view === 'monitor-off' ? animatedScreen() : null;
    const screen = fake?.stream ?? null;
    let live = true;
    let stream: MediaStream | null = null;
    let monitor: RecordingMonitor | null = null;
    void navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then((s) => {
        stream = s;
        if (!live) return s.getTracks().forEach((t) => t.stop());
        if (view === 'monitor-off') return setState('Streams running, no monitor.');
        const prefs = { ...readMonitorPrefs(localStorage), sourceTile: view !== 'monitor-face' };
        monitor = openRecordingMonitor({
          camera: s,
          source:
            view === 'monitor-phone'
              ? { kind: 'frames', aspect: 360 / 780, subscribe: fakePhoneFrames() }
              : screen
                ? { kind: 'stream', stream: screen, aspect: 2880 / 1800 }
                : null,
          prefs,
          onPrefs: (p) => writeMonitorPrefs(localStorage, p),
          onCameraLost: setState,
        });
        Object.assign(window, { recordingMonitor: monitor, monitorCamera: s });
        setState(monitor ? 'The recording monitor is open.' : 'The monitor window could not open.');
      })
      .catch((e) => setState(`No camera: ${String(e)}`));
    return () => {
      live = false;
      void monitor?.close();
      stream?.getTracks().forEach((t) => t.stop());
      fake?.stop();
    };
  }, [view]);
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

  if (view.startsWith('monitor')) return <MonitorDemo view={view} />;

  return <p style={{ padding: 40 }}>Unknown gallery view: {view}</p>;
}
