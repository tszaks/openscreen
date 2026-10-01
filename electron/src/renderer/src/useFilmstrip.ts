import { useEffect, useState } from 'react';
import { filmstripTimes } from '../../shared/filmstrip';

/**
 * Small stills of the recording for the timeline's clips, grabbed from a
 * second, muted video element so the preview's own player is never moved.
 * Frames arrive progressively; a slot is null until its frame is ready.
 */
export function useFilmstrip(url: string, duration: number, enabled: boolean, count = 40, height = 96) {
  const [frames, setFrames] = useState<(string | null)[]>([]);
  useEffect(() => {
    const times = filmstripTimes(duration, count);
    if (!enabled || !times.length) return;
    let alive = true;
    const out: (string | null)[] = times.map(() => null);
    setFrames([...out]);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    // Resolves true once the frame at `t` is decoded, false if the seek
    // stalls: a stalled slot stays empty rather than showing the last frame.
    const seek = (t: number) =>
      new Promise<boolean>((resolve) => {
        const finish = (ok: boolean) => {
          video.removeEventListener('seeked', onSeeked);
          clearTimeout(timer);
          resolve(ok);
        };
        const onSeeked = () => finish(true);
        const timer = setTimeout(() => finish(false), 1500);
        video.addEventListener('seeked', onSeeked);
        video.currentTime = t;
      });
    const run = async () => {
      await new Promise<void>((resolve, reject) => {
        if (video.readyState >= 2) return resolve();
        video.addEventListener('loadeddata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(new Error('no video')), { once: true });
      });
      const w = Math.max(1, Math.round((height * video.videoWidth) / Math.max(1, video.videoHeight)));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = height;
      const g = canvas.getContext('2d');
      if (!g) return;
      for (let i = 0; i < times.length && alive; i++) {
        const ok = await seek(times[i]);
        if (!alive) return;
        if (ok) {
          g.drawImage(video, 0, 0, w, height);
          out[i] = canvas.toDataURL('image/jpeg', 0.72);
        }
        // Publish in small batches: a re-render per frame would churn the timeline.
        if (i % 4 === 3 || i === times.length - 1) setFrames([...out]);
      }
    };
    run().catch(() => {});
    return () => {
      alive = false;
      video.removeAttribute('src');
      video.load();
    };
  }, [url, duration, enabled, count, height]);
  return frames;
}
