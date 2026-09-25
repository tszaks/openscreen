import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { CursorSample, Project } from '../../shared/types';
import { AutofocusPlanner, cameraAt, type FocusSegment } from '../../shared/autofocus';
import { CursorSmoother } from '../../shared/cursor';
import { clickEvents, ripplesAt } from '../../shared/ripples';
import { Timeline } from '../../shared/timeline';
import { CanvasCompositor } from './compositor';

const SWATCHES = [
  { name: 'Aurora', bg: { kind: 'gradient' as const, startHex: '#3a1c71', endHex: '#d76d77', angle: 120 } },
  { name: 'Ocean', bg: { kind: 'gradient' as const, startHex: '#0f2027', endHex: '#2c5364', angle: 135 } },
  { name: 'Sunset', bg: { kind: 'gradient' as const, startHex: '#ff7e5f', endHex: '#feb47b', angle: 160 } },
  { name: 'Mono', bg: { kind: 'solid' as const, hex: '#17171c' } },
];

export function Editor({
  videoUrl,
  project,
  cursor,
  bundleDir,
}: {
  videoUrl: string;
  project: Project;
  cursor: CursorSample[];
  bundleDir: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [proj, setProj] = useState(project);
  const [playhead, setPlayhead] = useState(0);
  const [duration, setDuration] = useState(project.recording.duration || 0);
  const [status, setStatus] = useState('');
  const [autofocusOn, setAutofocusOn] = useState(true);

  const timeline = useMemo(() => new Timeline(proj.recording.duration, proj.clips), [proj]);

  const smoothed = useMemo(() => new CursorSmoother().smoothedPath(cursor), [cursor]);
  const clickEv = useMemo(() => clickEvents(cursor, timeline), [cursor, timeline]);

  const segments = useMemo<FocusSegment[]>(() => {
    if (!autofocusOn) return [];
    return new AutofocusPlanner().planSegments(
      cursor.filter((s) => s.kind === 'clickDown'),
      timeline.outputDuration || duration,
    );
  }, [cursor, timeline, autofocusOn, duration]);

  const canvasSize = useMemo(() => {
    const src = proj.recording.sourceSize;
    const h = proj.exportPreset === 'uhd4k' ? 2160 : 1080;
    return { width: Math.round((h * src.width) / src.height), height: h };
  }, [proj]);

  const compositor = useMemo(
    () => new CanvasCompositor(proj, canvasSize, segments),
    [proj, canvasSize, segments],
  );

  // Draw the composited frame for `time` onto the preview canvas.
  const renderAt = useCallback(
    (time: number) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      canvas.width = canvasSize.width;
      canvas.height = canvasSize.height;
      const cursorPos = cursorAt(smoothed, time);
      compositor.render(time, {
        frame: video,
        cursor: cursorPos,
        ripples: ripplesAt(time, clickEv),
      });
      ctx.drawImage(compositor.canvas, 0, 0);
    },
    [compositor, canvasSize, smoothed, clickEv],
  );

  // Keep preview in sync while video plays or after seeks.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    const loop = () => {
      renderAt(video.currentTime);
      setPlayhead(video.currentTime);
      raf = requestAnimationFrame(loop);
    };
    const onSeeked = () => renderAt(video.currentTime);
    video.addEventListener('seeked', onSeeked);
    if (!video.paused) raf = requestAnimationFrame(loop);
    const onPlay = () => { raf = requestAnimationFrame(loop); };
    const onPause = () => cancelAnimationFrame(raf);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, [renderAt]);

  const seekTimeline = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * (timeline.outputDuration || duration);
    const srcT = timeline.sourceTime(t) ?? t;
    if (videoRef.current) videoRef.current.currentTime = srcT;
    setPlayhead(t);
  };

  const exportVideo = async () => {
    const video = videoRef.current;
    if (!video) return;
    setStatus('exporting…');
    const fps = proj.outputFPS;
    const total = Math.floor((timeline.outputDuration || duration) * fps);
    const { width: W, height: H } = canvasSize;
    const outPath = `${bundleDir}/export-${Date.now()}.mp4`;
    await api.exportBegin(outPath, W, H, fps);
    video.pause();

    for (let i = 0; i < total; i++) {
      const outT = i / fps;
      const srcT = timeline.sourceTime(outT);
      if (srcT === null) continue;
      await seekVideo(video, srcT);
      compositor.render(outT, {
        frame: video,
        cursor: cursorAt(smoothed, outT),
        ripples: ripplesAt(outT, clickEv),
      });
      const ctx = compositor.canvas.getContext('2d')!;
      const rgba = ctx.getImageData(0, 0, W, H);
      await api.exportFrame(rgba.data.buffer);
      if (i % 10 === 0) {
        setStatus(`exporting ${i}/${total}`);
        await new Promise((r) => setTimeout(r, 0)); // let UI paint
      }
    }
    await api.exportEnd();
    setStatus(`exported → ${outPath}`);
  };

  const zoomMarks = segments.map((s) => s.inStart);

  return (
    <div className="editor">
      <video
        ref={videoRef}
        src={videoUrl}
        className="hidden"
        preload="auto"
        muted
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />
      <div className="preview-wrap">
        <canvas ref={canvasRef} className="preview" />
      </div>
      <div className="timeline" onClick={seekTimeline}>
        <div
          className="playhead"
          style={{ left: `${(playhead / (timeline.outputDuration || duration || 1)) * 100}%` }}
        />
        {zoomMarks.map((t, i) => (
          <div
            key={i}
            className="zoommark"
            style={{ left: `${(t / (timeline.outputDuration || duration || 1)) * 100}%` }}
          />
        ))}
      </div>
      <div className="panel">
        <label>
          <input
            type="checkbox"
            checked={autofocusOn}
            onChange={(e) => setAutofocusOn(e.target.checked)}
          />
          Auto-focus
        </label>
        <div className="swatches">
          {SWATCHES.map((s) => (
            <button
              key={s.name}
              title={s.name}
              className="swatch"
              style={
                s.bg.kind === 'gradient'
                  ? { background: `linear-gradient(${s.bg.angle}deg, ${s.bg.startHex}, ${s.bg.endHex})` }
                  : { background: s.bg.hex }
              }
              onClick={() =>
                setProj((p) => ({ ...p, style: { ...p.style, background: s.bg } }))
              }
            />
          ))}
        </div>
        <button onClick={() => videoRef.current?.paused ? videoRef.current?.play() : videoRef.current?.pause()}>
          Play/Pause
        </button>
        <button className="primary" onClick={exportVideo}>Export MP4</button>
        <span className="status">{status}</span>
      </div>
    </div>
  );
}

/** Cursor position at output time from the smoothed move samples. */
function cursorAt(smoothed: CursorSample[], time: number) {
  const moves = smoothed.filter((s) => s.kind === 'move');
  if (moves.length === 0) return null;
  const s = new CursorSmoother();
  return s.positionAt(time, moves);
}

function seekVideo(video: HTMLVideoElement, t: number): Promise<void> {
  if (Math.abs(video.currentTime - t) < 0.001 && video.readyState >= 2) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    // 'seeked' can fail to fire on stalls — don't hang the export loop.
    setTimeout(done, 2000);
    video.currentTime = t;
  });
}
