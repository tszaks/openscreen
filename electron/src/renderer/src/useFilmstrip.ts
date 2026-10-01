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
    const seek = (t: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          video.removeEventListener('seeked', done);
          clearTimeout(timer);
          resolve();
        };
        // A stalled seek skips this frame rather than hanging the strip.
        const timer = setTimeout(done, 1500);
        video.addEventListener('seeked', done);
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
        await seek(times[i]);
        if (!alive) return;
        g.drawImage(video, 0, 0, w, height);
        out[i] = canvas.toDataURL('image/jpeg', 0.72);
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
