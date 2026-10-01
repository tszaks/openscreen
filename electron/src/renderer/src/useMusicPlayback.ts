// Preview playback of the audio tracks: one <audio> element per item, driven
// from the editor's playback loop in output time. Each tick puts every item
// that should be sounding on the right moment of its file at the right volume
// (fades, track volume, mute) and pauses the rest; the recording's own sound
// is lowered while music that ducks plays. Items always play at normal speed,
// whatever the clip under them does.
import { useEffect, useRef } from 'react';
import { fileTimeAt, itemGainAt, recordingGainAt } from '../../shared/audioTracks';
import type { Track } from '../../shared/types';

/** Further than this from where it should be (seconds), an element is re-seeked. */
const DRIFT = 0.15;

/** file:// URL for a path, each segment escaped (names can hold # or ?). */
export const fileUrlOf = (path: string) => `file://${path.split('/').map(encodeURIComponent).join('/')}`;

export function useMusicPlayback(bundleDir: string, tracks: Track[]) {
  const elements = useRef(new Map<string, { file: string; el: HTMLAudioElement }>());
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  // One element per item, made when an item appears and let go when it leaves.
  useEffect(() => {
    const want = new Map(tracks.flatMap((t) => t.items.map((i) => [i.id, i.file] as const)));
    for (const [id, entry] of elements.current) {
      if (want.get(id) === entry.file) continue;
      entry.el.pause();
      entry.el.removeAttribute('src');
      entry.el.load();
      elements.current.delete(id);
    }
    for (const [id, file] of want) {
      if (elements.current.has(id)) continue;
      const el = new Audio(fileUrlOf(`${bundleDir.replace(/\/+$/, '')}/${file}`));
      el.preload = 'auto';
      elements.current.set(id, { file, el });
    }
  }, [tracks, bundleDir]);

  useEffect(
    () => () => {
      for (const { el } of elements.current.values()) {
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
      elements.current.clear();
    },
    [],
  );

  /** Bring every item in line with output time `t`; `playing` false pauses them all. */
  const sync = (t: number, outDur: number, playing: boolean, recording?: HTMLMediaElement | null) => {
    const list = tracksRef.current;
    if (recording) recording.volume = playing ? recordingGainAt(list, t, outDur) : 1;
    for (const track of list) {
      for (const item of track.items) {
        const el = elements.current.get(item.id)?.el;
        if (!el) continue;
        const at = playing ? fileTimeAt(item, t, outDur) : null;
        const gain = itemGainAt(item, track, t, outDur);
        if (at === null || gain <= 0) {
          if (!el.paused) el.pause();
          continue;
        }
        el.volume = Math.min(1, gain);
        if (el.paused) {
          el.currentTime = at;
          void el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - at) > DRIFT) {
          el.currentTime = at;
        }
      }
    }
  };

  return { sync, stop: (recording?: HTMLMediaElement | null) => sync(0, 0, false, recording) };
}
