import React, { useEffect, useRef, useState } from 'react';
import { api, type IosPreview } from '../api';
import './live-preview.css';

// A wired iPhone's screen, live, inside the drawn phone outline: the
// picker's selected card and the recording card both use it. Frames are
// small JPEGs from the helper (~360 px, up to ~12 a second). Each is
// decoded with createImageBitmap and drawn to a canvas; one that arrives
// while the previous is still decoding replaces any waiting frame instead
// of queueing, so the picture never falls behind.

const DEFAULT_ASPECT = { phone: 9 / 19.5, tablet: 3 / 4 };

/** What to say over the phone before its first frame. */
export function previewStatus(preview: IosPreview | null, deviceName: string): string {
  if (preview?.state === 'error') {
    return preview.code === 'no-frames' ? `No picture from ${deviceName}` : preview.message || 'Preview unavailable';
  }
  if (preview?.state === 'stopped') return 'Preview stopped';
  return `Connecting to ${deviceName}…`;
}

export function IosLivePreview({
  deviceId,
  deviceName,
  tablet,
  preview,
  size,
  dimmed,
}: {
  deviceId: string;
  deviceName: string;
  tablet: boolean;
  /** The helper's preview state for this device, if any. */
  preview: IosPreview | null;
  size: 'card' | 'stage';
  /** Fade the picture (the take may be stalled). */
  dimmed?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [aspect, setAspect] = useState(tablet ? DEFAULT_ASPECT.tablet : DEFAULT_ASPECT.phone);
  const [hasFrame, setHasFrame] = useState(false);

  useEffect(() => {
    setHasFrame(false);
    let alive = true;
    let decoding = false;
    let waiting: Uint8Array | null = null;
    const draw = async (jpeg: Uint8Array) => {
      decoding = true;
      try {
        const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }));
        const canvas = canvasRef.current;
        if (alive && canvas) {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
          // The phone may rotate: follow the frame's shape.
          const next = bitmap.width / bitmap.height;
          setAspect((prev) => (Math.abs(prev - next) > 0.005 ? next : prev));
          setHasFrame(true);
        }
        bitmap.close();
      } catch {
        // A frame that doesn't decode is skipped; the next one replaces it.
      } finally {
        decoding = false;
        const next = waiting;
        waiting = null;
        if (next && alive) void draw(next);
      }
    };
    const off = api.onIosPreviewFrame((f) => {
      if (f.id !== deviceId) return;
      if (decoding) waiting = f.jpeg;
      else void draw(f.jpeg);
    });
    return () => {
      alive = false;
      off();
    };
  }, [deviceId]);

  const status = hasFrame ? null : previewStatus(preview, deviceName);
  return (
    <div className={`live-fit size-${size}`}>
      <div
        className={`live-phone size-${size}${tablet ? ' tablet' : ''}${hasFrame ? ' has-frame' : ''}${dimmed ? ' is-dimmed' : ''}`}
        style={{ '--ar': aspect } as React.CSSProperties}
      >
        <canvas ref={canvasRef} className="live-screen" aria-label={`Live view of ${deviceName}`} />
        {status && (
          <span className={`live-status${preview?.state === 'error' ? ' is-error' : ''}`} role="status">
            {status}
          </span>
        )}
      </div>
    </div>
  );
}
