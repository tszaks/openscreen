import React, { useEffect, useRef } from 'react';
import { Button } from '../ui';
import { formatElapsed } from './iosSetup';
import './recording-ux.css';

// The recording screen's card: a live preview of what is being recorded
// under a title bar with a pulsing REC badge, the timer, the source name
// and Stop. The look (framed screen card, red-tint REC pill with a pulsing
// dot) is borrowed from "Agent Screen" in Beautiful UI - Code Examples
// (21-agent-screen.tsx, MIT), rebuilt in plain CSS.

export function RecordingCard({
  sourceName,
  elapsed,
  saving,
  onStop,
  stream,
  device,
  warning,
}: {
  sourceName: string;
  elapsed: number;
  saving: boolean;
  onStop: () => void;
  /** The capture stream already being recorded, shown muted. Never a second capture. */
  stream?: MediaStream | null;
  /** An iPhone/iPad take: the helper writes straight to disk, so there are no
   *  live pixels here, only the device outline. */
  device?: { name: string; tablet: boolean } | null;
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
            <div className={`device-outline rec-device${device.tablet ? ' tablet' : ''}${warning ? ' is-stalled' : ''}`} />
            <p className="rec-card-device-note">
              Recording straight from {device.name}. Watch the phone itself; there's no live preview here.
            </p>
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
    </section>
  );
}
