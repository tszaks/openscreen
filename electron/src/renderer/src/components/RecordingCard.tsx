import React, { useEffect, useRef } from 'react';
import { Button } from '../ui';
import { formatElapsed } from './iosSetup';
import { IosLivePreview } from './IosLivePreview';
import type { IosPreview } from '../api';
import './recording-ux.css';

// The recording screen's card: a live preview of what is being recorded
// under a title bar with a pulsing REC badge, the timer, the source name
// and Stop. An iPhone take shows the phone's own frames from the helper. The look (framed screen card, red-tint REC pill with a pulsing
// dot) is borrowed from "Agent Screen" in Beautiful UI - Code Examples
// (21-agent-screen.tsx, MIT), rebuilt in plain CSS.

export function RecordingCard({
  sourceName,
  elapsed,
  saving,
  onStop,
  stream,
  device,
  phone,
  warning,
}: {
  sourceName: string;
  elapsed: number;
  saving: boolean;
  onStop: () => void;
  /** The capture stream already being recorded, shown muted. Never a second capture. */
  stream?: MediaStream | null;
  /** An iPhone/iPad take: its live frames come from the helper's preview,
   *  shown in the device outline. */
  device?: { id: string; name: string; tablet: boolean; preview: IosPreview | null } | null;
  /** The phone of a Mac + iPhone take, shown live beside the screen. */
  phone?: { id: string; name: string; tablet: boolean; preview: IosPreview | null } | null;
  /** A calm mid-take warning, e.g. the phone may be locked. */
  warning?: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream ?? null;
    if (stream) void v.play().catch(() => {});
    return () => {
      v.srcObject = null;
    };
  }, [stream]);

  return (
    <section className={`rec-card${warning ? ' has-warning' : ''}`} aria-label="Recording">
      <header className="rec-card-bar">
        <div className="rec-card-title">
          {saving ? (
            <span className="rec-badge is-saving">Saving</span>
          ) : (
            <span className="rec-badge" aria-label={`Recording, ${formatElapsed(elapsed)}`}>
              <span className="rec-badge-dot" />
              REC
              <span className="rec-badge-time">{formatElapsed(elapsed)}</span>
            </span>
          )}
          <span className="rec-card-name" title={sourceName}>
            {sourceName}
          </span>
        </div>
        <Button variant="record" size="sm" onClick={onStop} disabled={saving}>
          <span className="stop-glyph" />
          {saving ? 'Saving…' : 'Stop'}
        </Button>
      </header>

      <div className="rec-card-stage">
        {device ? (
          <div className="rec-card-device">
            <IosLivePreview
              deviceId={device.id}
              deviceName={device.name}
              tablet={device.tablet}
              preview={device.preview}
              size="stage"
              dimmed={!!warning}
            />
          </div>
        ) : stream && phone ? (
          <div className="rec-card-dual">
            <video ref={videoRef} className="rec-card-video" muted playsInline autoPlay />
            <div className="rec-card-dual-phone">
              <IosLivePreview deviceId={phone.id} deviceName={phone.name} tablet={phone.tablet} preview={phone.preview} size="card" />
            </div>
          </div>
        ) : stream ? (
          <video ref={videoRef} className="rec-card-video" muted playsInline autoPlay />
        ) : (
          <span className="rec-card-empty">No preview</span>
        )}
        {warning && (
          <div className="rec-card-warning" role="status">
            <span className="rec-card-warning-dot" />
            <p>{warning}</p>
          </div>
        )}
      </div>
      <p className="rec-card-hint">
        OpenScreen is hidden from screen captures while recording so it stays out of your video.
      </p>
    </section>
  );
}
