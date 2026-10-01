// An audio track on the timeline: one block per added sound (music, a
// voiceover) with its own waveform. Drag a block to move it, drag its edges to
// trim it, click to select it, right-click for Remove, Mute Track and Fit to
// Video. Fades show as the waveform tapering at either end.
import React, { useEffect, useRef } from 'react';
import { effectiveFades, itemExtent, itemSpan, laneRows, moveItem, segmentLength, trimItemEnd, trimItemStart } from '../../shared/audioTracks';
import type { AudioItem, AudioTrack } from '../../shared/types';
import { cssToken } from './ui';

type DragMode = 'move' | 'start' | 'end';

export function AudioTrackLane({
  track,
  outDur,
  peaks,
  selectedId,
  redraw,
  onSelect,
  onChange,
  onMenu,
}: {
  track: AudioTrack | undefined;
  outDur: number;
  /** Waveform peaks per file (whole file), when loaded. */
  peaks: Record<string, number[]>;
  selectedId: string | null;
  /** Anything that changes the lane's pixel size (zoom, height, width, appearance). */
  redraw: unknown;
  onSelect: (id: string) => void;
  /** Live while dragging: the item as it now is. */
  onChange: (item: AudioItem) => void;
  /** Two-finger click on a block (its id) or on the empty lane (null). */
  onMenu: (id: string | null, e: React.MouseEvent) => void;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: DragMode; pointer: number; x: number; item: AudioItem; moved: boolean } | null>(null);
  const pct = (t: number) => `${(t / outDur) * 100}%`;

  const onDown = (e: React.PointerEvent, item: AudioItem, mode: DragMode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // not an active pointer (synthetic events): moves over the block still drag it
    }
    drag.current = { mode, pointer: e.pointerId, x: e.clientX, item, moved: false };
  };
  const onMovePointer = (e: React.PointerEvent) => {
    const d = drag.current;
    const lane = laneRef.current;
    if (!d || d.pointer !== e.pointerId || !lane) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const dt = (dx / (lane.getBoundingClientRect().width || 1)) * outDur;
    const it = d.item;
    if (d.mode === 'move') onChange(moveItem(it, it.start + dt));
    else if (d.mode === 'start') onChange(trimItemStart(it, it.start + dt));
    else onChange(trimItemEnd(it, it.start + segmentLength(it) + dt));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) onSelect(d.item.id);
  };

  const items = track?.items ?? [];
  const rows = laneRows(items, outDur);
  return (
    <div
      ref={laneRef}
      className={`lane lane-music${track?.muted ? ' is-muted' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(null, e);
      }}
    >
      {items.map((item) => {
        const ext = itemExtent(item, outDur);
        return (
          <div
            key={item.id}
            className={`musicblock${item.id === selectedId ? ' selected' : ''}${rows.count > 1 ? ' stacked' : ''}`}
            title={`${item.name}. Drag to move, drag an edge to trim, right-click for options.`}
            style={{
              left: pct(ext.start),
              width: pct(Math.max(0, ext.end - ext.start)),
              top: `${(rows.row[item.id] / rows.count) * 100}%`,
              height: `${100 / rows.count}%`,
            }}
            onPointerDown={(e) => onDown(e, item, 'move')}
            onPointerMove={onMovePointer}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onMenu(item.id, e);
            }}
          >
            <ItemWave item={item} outDur={outDur} peaks={peaks[item.file]} redraw={redraw} />
            <span className="music-label tnum">
              {item.name}
              <span>
                {Math.max(0, itemSpan(item, outDur).end - item.start).toFixed(1)}s
                {item.loop ? ' · loops' : ''}
              </span>
            </span>
            <span className="trim-handle start" onPointerDown={(e) => onDown(e, item, 'start')} />
            {!item.loop && <span className="trim-handle end" onPointerDown={(e) => onDown(e, item, 'end')} />}
          </div>
        );
      })}
      {items.length === 0 && <span className="lane-note">Right-click to add music or a voiceover</span>}
    </div>
  );
}

/** The item's waveform: the file's peaks for the part that plays (repeated when
 *  looping), shaped by its fades; past the video's end it is drawn faint. */
function ItemWave({ item, outDur, peaks, redraw }: { item: AudioItem; outDur: number; peaks?: number[]; redraw: unknown }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const draw = () => {
      // Capped: zoomed in, a long block can be wider than a canvas may be.
      const W = (cv.width = Math.max(1, Math.min(16384, Math.round(cv.clientWidth * 2))));
      const H = (cv.height = Math.max(1, Math.round(cv.clientHeight * 2)));
      const g = cv.getContext('2d');
      if (!g) return;
      g.clearRect(0, 0, W, H);
      const ext = itemExtent(item, outDur);
      const len = segmentLength(item);
      if (!peaks?.length || len <= 0 || item.fileDuration <= 0) return;
      const playing = itemSpan(item, outDur);
      const { fadeIn, fadeOut } = effectiveFades(item, outDur);
      // Scaled to the file's own loudest moment, so a quiet file still reads.
      const top = Math.max(1e-4, ...peaks);
      const ink = cssToken('--wave', 'rgba(128,128,128,0.4)');
      const faint = cssToken('--label-4', 'rgba(128,128,128,0.2)');
      for (let x = 0; x < W; x++) {
        const t = ext.start + (x / W) * (ext.end - ext.start);
        const into = t - item.start;
        const ft = item.sourceIn + (item.loop ? into % len : Math.min(into, len));
        const p = peaks[Math.min(peaks.length - 1, Math.floor((ft / item.fileDuration) * peaks.length))] ?? 0;
        let env = 1;
        if (t < playing.end) {
          if (fadeIn > 0 && t < playing.start + fadeIn) env = Math.min(env, (t - playing.start) / fadeIn);
          if (fadeOut > 0 && t > playing.end - fadeOut) env = Math.min(env, (playing.end - t) / fadeOut);
        }
        const h = Math.max(1.5, (p / top) * env * H * 0.7);
        g.fillStyle = t >= playing.end ? faint : ink;
        g.fillRect(x, (H - h) / 2, 1, h);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [item, outDur, peaks, redraw]);
  return <canvas ref={ref} className="music-wave" aria-hidden />;
}
