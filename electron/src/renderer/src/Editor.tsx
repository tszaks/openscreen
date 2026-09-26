import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { normalizeProject, type AudioSettings, type Clip, type CursorSample, type KeystrokeSample, type Project, type ZoomSettings } from '../../shared/types';
import { AutofocusPlanner, cameraAt, defaultAutofocus, dwellFocusEvents, type FocusSegment } from '../../shared/autofocus';
import { CursorSmoother } from '../../shared/cursor';
import { clickEvents, ripplesAt } from '../../shared/ripples';
import { Timeline, toOutputTime } from '../../shared/timeline';
import { locate, mediaDuration, playbackTick, type PlaybackTick } from '../../shared/playback';
import { remapProject, remapTime } from '../../shared/remap';
import { History } from '../../shared/history';
import { CanvasCompositor, backgroundReady } from './compositor';
import { parseCaptions, toSrt } from '../../shared/captions';
import { keysAt } from '../../shared/keystrokes';
import {
  planSmartCuts,
  removedRanges,
  firstKeptAtOrAfter,
  lastKeptAtOrBefore,
  type CutProposal,
} from '../../shared/editcuts';
import { suggestChapters, toChapterList } from '../../shared/chapters';
import type { TranscriptWord } from '../../shared/types';
import type { TapSuggestion } from '../../shared/taps';
import { SaveTracker, isTextEntry } from '../../shared/editorSession';
import { ipcErrorMessage } from '../../shared/exportArgs';
import { Button, EmptyState, Icon, IconButton, Kbd, Section, Segmented, Switch, Tabs } from './ui';
import { ScrubField } from './components/ScrubField';
import { planTapZoom } from '../../shared/autozoomTaps';
import {
  isPhoneProject,
  layoutPreset,
  pendingWaits,
  presetAllowsZoom,
  projectCanvasSize,
  rangesToOutput,
  resolveDevice,
  speedUpRanges,
  tapSourceTime,
  tapsToOutput,
  waitCore,
} from '../../shared/mobileProject';
import { TapsLane } from './mobile/TapsLane';
import { DevicePanel } from './mobile/DevicePanel';
import { LayoutSection } from './mobile/LayoutSection';

type InspectorTab = 'background' | 'device' | 'zoom' | 'cursor' | 'camera' | 'audio' | 'text';

const SWATCHES = [
  { name: 'Aurora', bg: { kind: 'gradient' as const, startHex: '#3a1c71', endHex: '#d76d77', angle: 120 } },
  { name: 'Ocean', bg: { kind: 'gradient' as const, startHex: '#0f2027', endHex: '#2c5364', angle: 135 } },
  { name: 'Sunset', bg: { kind: 'gradient' as const, startHex: '#ff7e5f', endHex: '#feb47b', angle: 160 } },
  { name: 'Mono', bg: { kind: 'solid' as const, hex: '#17171c' } },
];

export function Editor({
  videoUrl,
  camUrl,
  project,
  cursor,
  keys,
  bundleDir,
  onNewRecording,
  onOpenProject,
}: {
  videoUrl: string;
  camUrl?: string;
  project: Project;
  cursor: CursorSample[];
  keys: KeystrokeSample[];
  bundleDir: string;
  /** Leave for the source picker. Called only once changes are dealt with. */
  onNewRecording: () => void;
  /** Pick and open another project in place of this one. */
  onOpenProject: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const camRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [proj, setProj] = useState(() => normalizeProject(project));
  // Undo/redo: one step per burst of edits (a slider drag is one step, not
  // one per tick). Mount and no-op updates record nothing.
  const historyRef = useRef(new History<Project>());
  const projRef = useRef(proj);
  const applyingHistory = useRef(false);
  useEffect(() => {
    if (proj === projRef.current) return;
    if (applyingHistory.current) {
      applyingHistory.current = false;
    } else {
      historyRef.current.record(projRef.current, performance.now());
    }
    projRef.current = proj;
  }, [proj]);
  // Each pointer gesture (a click, a drag) is its own undo step.
  useEffect(() => {
    const seal = () => historyRef.current.seal();
    window.addEventListener('pointerdown', seal, true);
    window.addEventListener('pointerup', seal, true);
    return () => {
      window.removeEventListener('pointerdown', seal, true);
      window.removeEventListener('pointerup', seal, true);
    };
  }, []);
  // Output time, always. The video element only knows source time.
  const [playhead, setPlayhead] = useState(0);
  const playheadRef = useRef(0);
  // Index of the clip being played (a source moment can sit in two clips).
  const playIndex = useRef(0);
  const movePlayhead = (t: number) => {
    playheadRef.current = t;
    setPlayhead(t);
  };
  const [duration, setDuration] = useState(project.recording.duration || 0);
  const [status, setStatus] = useState('');
  // Zoom and audio settings live in the project, so they save and undo.
  const { autofocus: autofocusOn, dwell: dwellOn, depth: zoomDepth, motionEvents: motionEv } = proj.zoom;
  const { clickSounds: clickSfx, voiceCleanup } = proj.audio;
  const manualSegments = proj.manualZooms;
  const setZoom = (patch: Partial<ZoomSettings>) =>
    setProj((p) => ({ ...p, zoom: { ...p.zoom, ...patch } }));
  const setAudio = (patch: Partial<AudioSettings>) =>
    setProj((p) => ({ ...p, audio: { ...p.audio, ...patch } }));
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [cropMode, setCropMode] = useState(false);
  const cropDrag = useRef<{ x: number; y: number } | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const waveRef = useRef<HTMLCanvasElement>(null);
  // Smart cut preview: proposed ranges sit here until applied/dismissed.
  const [smartCuts, setSmartCuts] = useState<(CutProposal & { on: boolean })[] | null>(null);
  // Transcript edit mode: click/shift-click selects word ranges to cut.
  const [editTranscript, setEditTranscript] = useState(false);
  const [wordSel, setWordSel] = useState<{ cueId: string; anchor: number; end: number } | null>(null);
  // UI only: inspector tab, export menu, and a mirror of the video's play state.
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('background');
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  // What's on disk, so leaving can warn about edits the autosave hasn't
  // written yet (or couldn't write).
  const saveTracker = useRef(new SaveTracker(proj));
  // Where to go once the unsaved-changes confirm is answered.
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const disposed = useRef(false);
  // Phone recordings: the tap selected on the taps lane (clicking the preview
  // places it), a tap analysis in flight, and whether the title field has
  // focus (the preview shows safe-zone guides meanwhile).
  const isPhone = isPhoneProject(proj);
  const [selectedTap, setSelectedTap] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [titleFocus, setTitleFocus] = useState(false);

  /** Write a snapshot into the bundle and record it as saved. */
  const persist = async (snapshot: Project) => {
    await api.saveProject(bundleDir, snapshot);
    saveTracker.current.markSaved(snapshot);
  };

  // Leaving stops playback and lets go of the decoders; App releases any
  // blob URLs behind them.
  useEffect(() => {
    const media = [videoRef.current, camRef.current];
    disposed.current = false;
    return () => {
      disposed.current = true;
      for (const v of media) {
        if (!v) continue;
        v.pause();
        v.removeAttribute('src');
        v.load();
      }
    };
  }, []);

  useEffect(() => {
    let dead = false;
    api.audioPeaks(bundleDir, proj.recording.screenVideoFile, 1200).then((p) => {
      if (!dead) setPeaks(p);
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleDir]);

  const timeline = useMemo(
    () => new Timeline(proj.recording.duration, proj.clips),
    [proj.recording.duration, proj.clips],
  );
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

  // Autosave edits into the bundle (debounced; undo/redo snapshots included).
  useEffect(() => {
    const t = setTimeout(() => {
      void persist(proj).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proj, bundleDir]);

  const cancelExport = useRef(false);

  const smoothed = useMemo(() => new CursorSmoother().smoothedPath(cursor), [cursor]);
  const clickEv = useMemo(() => clickEvents(cursor, timeline), [cursor, timeline]);

  const preset = useMemo(() => layoutPreset(proj), [proj.layout, proj.recording, proj.device]);
  const resolvedDevice = useMemo(() => resolveDevice(proj), [proj.recording, proj.device]);
  // Taps are source time; the lane, the zoom and the preview play in output time.
  const outTaps = useMemo(() => tapsToOutput(proj.taps, timeline), [proj.taps, timeline]);
  const fromTaps = isPhone && proj.zoom.fromTaps;

  const segments = useMemo<FocusSegment[]>(() => {
    // App Store previews stay on the native UI.
    if (!presetAllowsZoom(preset)) return [];
    const taps = fromTaps ? planTapZoom(outTaps, timeline.outputDuration || duration, { scale: zoomDepth }) : [];
    const auto = autofocusOn
      ? new AutofocusPlanner({ ...defaultAutofocus, maxScale: zoomDepth }).planSegments(
          // Clicks, dwells and touches are source time; zooms play in output time.
          toOutputTime(
            [
              ...cursor.filter((s) => s.kind === 'clickDown'),
              ...(dwellOn ? dwellFocusEvents(cursor) : []),
              ...motionEv,
            ],
            timeline,
          ),
          timeline.outputDuration || duration,
        )
      : [];
    return [...auto, ...taps, ...manualSegments].sort((a, b) => a.inStart - b.inStart);
  }, [cursor, timeline, autofocusOn, dwellOn, duration, manualSegments, zoomDepth, motionEv, preset, fromTaps, outTaps]);

  const canvasSize = useMemo(() => projectCanvasSize(proj), [proj]);

  const compositor = useMemo(
    () => new CanvasCompositor(proj, canvasSize, segments),
    [proj, canvasSize, segments],
  );

  /** Map a point on the preview canvas to normalized full-source coords
   *  (valid in crop mode, where the source is drawn unzoomed). */
  const canvasToSource = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * canvasSize.width;
    const py = ((clientY - r.top) / r.height) * canvasSize.height;
    // Raw source is aspect-fit centered — recover its rect.
    const src = proj.recording.sourceSize;
    const pad = Math.min(canvasSize.width, canvasSize.height) * proj.style.paddingFraction;
    const cw = canvasSize.width - pad * 2;
    const ch = canvasSize.height - pad * 2;
    const ar = src.width / src.height;
    let rw = cw;
    let rh = ch;
    let rx = pad;
    let ry = pad;
    if (cw / ch > ar) {
      rw = ch * ar;
      rx = pad + (cw - rw) / 2;
    } else {
      rh = cw / ar;
      ry = pad + (ch - rh) / 2;
    }
    return { x: (px - rx) / rw, y: (py - ry) / rh };
  };

  /** Canvas client coords → canvas pixels. */
  const canvasPoint = (clientX: number, clientY: number) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return null;
    return { x: ((clientX - r.left) / r.width) * canvasSize.width, y: ((clientY - r.top) / r.height) * canvasSize.height };
  };

  const onCanvasDown = (e: React.MouseEvent) => {
    if (!cropMode && selectedTap) {
      // Place the selected tap where the preview was clicked (zoom included).
      const px = canvasPoint(e.clientX, e.clientY);
      const at = px && compositor.canvasToSource(px.x, px.y);
      if (!at) return;
      const x = Math.min(1, Math.max(0, at.x));
      const y = Math.min(1, Math.max(0, at.y));
      setProj((p) => ({
        ...p,
        taps: p.taps.map((t) => {
          if (t.id !== selectedTap) return t;
          // A swipe moves as a whole, keeping its direction.
          const moved = { ...t, x, y };
          if (t.endX !== undefined) moved.endX = Math.min(1, Math.max(0, t.endX + x - t.x));
          if (t.endY !== undefined) moved.endY = Math.min(1, Math.max(0, t.endY + y - t.y));
          return moved;
        }),
      }));
      return;
    }
    if (!cropMode) return;
    const p = canvasToSource(e.clientX, e.clientY);
    if (p) cropDrag.current = p;
  };

  const onCanvasMove = (e: React.MouseEvent) => {
    if (!cropMode || !cropDrag.current) return;
    const p = canvasToSource(e.clientX, e.clientY);
    if (!p) return;
    const s = cropDrag.current;
    const x = Math.min(s.x, p.x);
    const y = Math.min(s.y, p.y);
    const w = Math.abs(p.x - s.x);
    const h = Math.abs(p.y - s.y);
    if (w > 0.01 && h > 0.01) {
      setProj((pr) => ({
        ...pr,
        style: {
          ...pr.style,
          cropRect: {
            x: Math.max(0, x),
            y: Math.max(0, y),
            w: Math.min(1, x + w) - Math.max(0, x),
            h: Math.min(1, y + h) - Math.max(0, y),
          },
        },
      }));
    }
  };

  const onCanvasUp = () => {
    cropDrag.current = null;
    setCropMode(false);
  };

  // Leaving the canvas only ends crop mode mid-drag, not on the way in.
  const onCanvasLeave = () => {
    if (cropDrag.current) onCanvasUp();
  };

  // Draw the composited frame at output time `outT` onto the preview canvas.
  // The video is already on the matching source frame; cursor and keys are
  // recorded in source time, so they follow the video.
  const renderAt = useCallback(
    (outT: number) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      canvas.width = canvasSize.width;
      canvas.height = canvasSize.height;
      const srcT = video.currentTime;
      const cursorPos = cursorAt(smoothed, srcT);
      const keyCaps = keysAt(srcT, keys);
      const cam = camRef.current;
      compositor.render(outT, {
        frame: video,
        cursor: cursorPos,
        cursorTrail: proj.style.cursorTrail ? trailAt(smoothed, srcT) : undefined,
        keystrokes: keyCaps,
        ripples: ripplesAt(outT, clickEv),
        cameraFrame: cam && cam.readyState >= 2 ? cam : undefined,
      });
      ctx.drawImage(compositor.canvas, 0, 0);
      drawEditorGuides(ctx);
      // In crop mode, dim outside the current crop rect (in source space).
      if (cropMode) {
        const src = proj.recording.sourceSize;
        const pad = Math.min(canvasSize.width, canvasSize.height) * proj.style.paddingFraction;
        const cw = canvasSize.width - pad * 2;
        const ch = canvasSize.height - pad * 2;
        const ar = src.width / src.height;
        let rw = cw, rh = ch, rx = pad, ry = pad;
        if (cw / ch > ar) { rw = ch * ar; rx = pad + (cw - rw) / 2; }
        else { rh = cw / ar; ry = pad + (ch - rh) / 2; }
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);
        const c = proj.style.cropRect;
        // The whole uncropped frame, dimmed, so there's something to drag over.
        ctx.drawImage(video, 0, 0, src.width, src.height, rx, ry, rw, rh);
        ctx.fillRect(rx, ry, rw, rh);
        if (c) {
          const cx0 = rx + c.x * rw;
          const cy0 = ry + c.y * rh;
          const cx1 = rx + (c.x + c.w) * rw;
          const cy1 = ry + (c.y + c.h) * rh;
          // redraw the selection undimmed
          ctx.drawImage(
            video,
            (c.x * src.width), (c.y * src.height), (c.w * src.width), (c.h * src.height),
            cx0, cy0, cx1 - cx0, cy1 - cy0,
          );
          ctx.strokeStyle = '#fdcb6e';
          ctx.lineWidth = 3;
          ctx.strokeRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compositor, canvasSize, smoothed, keys, clickEv, cropMode, proj, selectedTap, titleFocus],
  );

  /** Preview-only marks, never exported: the selected tap and, while the
   *  title is being edited, the platform safe zone and title box. */
  const drawEditorGuides = (ctx: CanvasRenderingContext2D) => {
    const unit = Math.max(canvasSize.width, canvasSize.height) / 900;
    const tap = selectedTap ? proj.taps.find((t) => t.id === selectedTap) : undefined;
    const at = tap && compositor.sourceToCanvas(tap);
    if (at) {
      ctx.save();
      ctx.strokeStyle = '#FF8A3D';
      ctx.lineWidth = 2.5 * unit;
      ctx.setLineDash([6 * unit, 5 * unit]);
      ctx.beginPath();
      ctx.arc(at.x, at.y, 22 * unit, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#FF8A3D';
      ctx.beginPath();
      ctx.arc(at.x, at.y, 3 * unit, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    const layout = compositor.phoneLayout;
    if (titleFocus && layout) {
      ctx.save();
      ctx.lineWidth = 1.5 * unit;
      ctx.setLineDash([8 * unit, 6 * unit]);
      const s = layout.safe;
      if (s.w < canvasSize.width || s.h < canvasSize.height) {
        // Dim what platform UI covers, outline what stays clear.
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.beginPath();
        ctx.rect(0, 0, canvasSize.width, canvasSize.height);
        ctx.rect(s.x, s.y + s.h, s.w, -s.h);
        ctx.fill('evenodd');
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.strokeRect(s.x, s.y, s.w, s.h);
      }
      if (layout.title) {
        const t = layout.title;
        ctx.strokeStyle = '#FF8A3D';
        ctx.strokeRect(t.x, t.y, t.w, t.h);
      }
      ctx.restore();
    }
  };

  /** Move the playhead to output time `outT` and put the video (and camera)
   *  on the source frame that plays there, at that clip's speed. */
  const seekOutput = (outT: number) => {
    const tl = timelineRef.current;
    const t = Math.min(Math.max(0, outT), tl.outputDuration);
    const at = locate(tl, t);
    playIndex.current = at.index;
    for (const v of [videoRef.current, camRef.current]) {
      if (!v) continue;
      if (Math.abs(v.currentTime - at.srcT) > 1e-3) v.currentTime = at.srcT;
      v.playbackRate = tl.clips[at.index].speed;
    }
    movePlayhead(t);
    if (videoRef.current?.paused) renderAt(t);
  };

  // Playback follows the timeline: each frame maps the video's source time to
  // output time, hops over removed footage to the next clip, plays each clip
  // at its speed, and stops at the end.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    const apply = (tick: PlaybackTick) => {
      const cam = camRef.current;
      if (tick.kind === 'jump') {
        playIndex.current = tick.index;
        video.currentTime = tick.seekTo;
        if (cam) cam.currentTime = tick.seekTo;
      }
      if (tick.kind !== 'end' && video.playbackRate !== tick.rate) {
        video.playbackRate = tick.rate;
        if (cam) cam.playbackRate = tick.rate;
      }
      movePlayhead(tick.outT);
      renderAt(tick.outT);
    };
    const loop = () => {
      const tick = playbackTick(timelineRef.current, playIndex.current, video.currentTime);
      apply(tick);
      if (tick.kind === 'end') video.pause();
      else raf = requestAnimationFrame(loop);
    };
    const onSeeked = () => renderAt(playheadRef.current);
    const onPlay = () => {
      // Play from the playhead; from the end, start over.
      const atEnd = playheadRef.current >= timelineRef.current.outputDuration - 0.02;
      seekOutput(atEnd ? 0 : playheadRef.current);
      camRef.current?.play();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    };
    const onPause = () => {
      camRef.current?.pause();
      cancelAnimationFrame(raf);
      const tick = playbackTick(timelineRef.current, playIndex.current, video.currentTime);
      if (tick.kind !== 'jump') movePlayhead(tick.outT);
      else if (video.ended) {
        // The file ended between frames, but a later clip still has to play.
        apply(tick);
        void video.play();
      }
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    if (!video.paused) raf = requestAnimationFrame(loop);
    // Paused edits (style, crop, undo…) redraw right away.
    else renderAt(playheadRef.current);
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderAt]);

  // A clip edit or undo moves footage under the playhead: keep the playhead
  // on the timeline and show the frame that now plays there.
  useEffect(() => {
    seekOutput(Math.min(playheadRef.current, timeline.outputDuration));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline]);

  // Redraw once a background image finishes loading.
  const bgPath = proj.style.background.kind === 'imageFile' ? proj.style.background.path : null;
  useEffect(() => {
    if (!bgPath) return;
    let live = true;
    void backgroundReady(bgPath).then(() => {
      if (live && videoRef.current?.paused) renderAt(playheadRef.current);
    });
    return () => {
      live = false;
    };
  }, [bgPath, renderAt]);

  const seekTimeline = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * (timeline.outputDuration || duration);
    if (e.altKey) {
      // Alt+click: add a manual zoom centered on the cursor at that time.
      const c = cursorAt(smoothed, locate(timeline, t).srcT) ?? { x: 0.5, y: 0.5 };
      const seg: FocusSegment = {
        inStart: t,
        holdStart: t + 0.5,
        holdEnd: t + 1.4,
        outEnd: t + 2.1,
        center: { x: c.x, y: c.y },
        scale: 2,
      };
      setProj((p) => ({ ...p, manualZooms: [...p.manualZooms, seg] }));
      return;
    }
    seekOutput(t);
  };

  const exportVideo = async (wantGif = false) => {
    const video = videoRef.current;
    if (!video || exporting) return;
    const outPath = await api.exportPickPath(bundleDir, wantGif ? 'gif' : 'mp4');
    if (!outPath) return;
    // A GIF is converted from an intermediate mp4 in the bundle.
    const mp4Path = wantGif ? `${bundleDir}/export-${Date.now()}.mp4` : outPath;
    const fps = proj.outputFPS;
    const total = Math.floor((timeline.outputDuration || duration) * fps);
    const { width: W, height: H } = canvasSize;
    const audioIn = `${bundleDir}/${proj.recording.screenVideoFile}`;
    // Cut timelines get filtered audio (atrim+atempo+concat); identity uses
    // the track as is. Main probes for a real audio stream either way.
    const audioClips = timeline.isIdentity
      ? undefined
      : proj.clips.map((c) => ({ start: c.sourceStart, end: c.sourceEnd, speed: c.speed }));
    setExporting(true);
    setStatus('exporting…');
    cancelExport.current = false;
    let encoding = false; // ffmpeg is running and owns a partial file
    try {
      await api.exportBegin(
        mp4Path,
        W,
        H,
        fps,
        audioIn,
        audioClips,
        clickSfx ? clickEv.map((e) => e.time) : undefined,
        voiceCleanup,
        total / fps,
      );
      encoding = true;
      video.pause();
      for (let i = 0; i < total; i++) {
        if (cancelExport.current) break;
        const outT = i / fps;
        const srcT = timeline.sourceTime(outT);
        if (srcT === null) continue;
        await seekVideo(video, srcT);
        const cam = camRef.current;
        if (cam) await seekVideo(cam, srcT);
        compositor.render(outT, {
          cursorTrail: proj.style.cursorTrail ? trailAt(smoothed, srcT) : undefined,
          frame: video,
          cursor: cursorAt(smoothed, srcT),
          keystrokes: keysAt(srcT, keys),
          ripples: ripplesAt(outT, clickEv),
          cameraFrame: cam && cam.readyState >= 2 ? cam : undefined,
        });
        const ctx = compositor.canvas.getContext('2d')!;
        const rgba = ctx.getImageData(0, 0, W, H);
        await api.exportFrame(rgba.data.buffer); // rejects once ffmpeg has stopped
        if (i % 10 === 0) {
          setStatus(`exporting ${i}/${total}`);
          await new Promise((r) => setTimeout(r, 0)); // let UI paint
        }
      }
      if (cancelExport.current) {
        encoding = false;
        await api.exportAbort();
        setStatus('export cancelled');
        return;
      }
      encoding = false; // end() cleans up after itself on failure
      await api.exportEnd();
      if (proj.captions.length) {
        await api.writeText(outPath.replace(/\.[^./]*$/, '.srt'), toSrt(proj.captions));
      }
      if (proj.chapters.length) {
        await api.writeText(outPath.replace(/\.[^./]*$/, '.chapters.txt'), toChapterList(proj.chapters) + '\n');
      }
      if (wantGif) {
        setStatus('converting gif…');
        await api.exportGif(mp4Path, outPath);
      }
      setStatus(`exported ${outPath.split('/').pop()}`);
      void api.exportReveal(outPath);
    } catch (e) {
      if (encoding) await api.exportAbort().catch(() => {});
      setStatus(`export failed: ${ipcErrorMessage(e)}`);
    } finally {
      setExporting(false);
    }
  };

  /** Output-time range of each clip for the timeline strip. */
  const clipBlocks = useMemo(() => {
    let cursor = 0;
    return timeline.clips.map((c) => {
      const start = cursor;
      const dur = (c.sourceEnd - c.sourceStart) / Math.max(c.speed, 1e-9);
      cursor += dur;
      return { id: c.id, start, end: cursor };
    });
  }, [timeline]);

  /** Replace the clip list. Captions, text overlays, chapters, manual zooms
   *  and the playhead move with their footage. */
  const editClips = (clips: Clip[]) => {
    const oldTl = timeline;
    const newTl = new Timeline(proj.recording.duration, clips);
    setProj((p) => remapProject(p, oldTl, newTl));
    movePlayhead(
      remapTime(playheadRef.current, oldTl, newTl) ?? Math.min(playheadRef.current, newTl.outputDuration),
    );
  };

  const splitAtPlayhead = () => {
    const tl = new Timeline(proj.recording.duration, proj.clips.map((c) => ({ ...c })));
    if (!tl.split(playhead)) {
      setStatus('cannot split here');
      return;
    }
    editClips(tl.clips);
  };

  const deleteSelectedClip = () => {
    if (!selectedClip || proj.clips.length <= 1) return;
    editClips(proj.clips.filter((c) => c.id !== selectedClip));
    setSelectedClip(null);
  };

  const trimClip = (edge: 'start' | 'end') => {
    if (!selectedClip) return;
    const src = timeline.sourceTime(playhead);
    if (src === null) {
      setStatus('playhead is outside a kept clip');
      return;
    }
    editClips(
      proj.clips.map((c) => {
        if (c.id !== selectedClip) return c;
        if (edge === 'start' && src > c.sourceStart && src < c.sourceEnd) {
          return { ...c, sourceStart: src };
        }
        if (edge === 'end' && src < c.sourceEnd && src > c.sourceStart) {
          return { ...c, sourceEnd: src };
        }
        return c;
      }),
    );
  };

  const setClipSpeed = (speed: number) => {
    if (!selectedClip) return;
    editClips(proj.clips.map((c) => (c.id === selectedClip ? { ...c, speed } : c)));
  };

  const dragFrom = useRef<number | null>(null);

  /** Remove source-time ranges from the timeline; returns seconds removed.
   *  Captions, words and the rest follow the cut via `editClips`. */
  const cutSourceRanges = (ranges: { start: number; end: number }[]) => {
    const tl = new Timeline(proj.recording.duration, proj.clips.map((c) => ({ ...c })));
    const removed = tl.cutRanges(ranges);
    if (removed > 0) {
      editClips(tl.clips);
      setWordSel(null);
    }
    return removed;
  };

  /** Detect silences + filler words and stage them as previewable cut proposals. */
  const smartCut = async () => {
    setStatus('analyzing audio…');
    try {
      const sils = await api.detectSilences(bundleDir, proj.recording.screenVideoFile);
      // Words are stored in output time — map back to source for cutting.
      const srcWords: TranscriptWord[] = [];
      for (const c of proj.captions) {
        for (const w of c.words ?? []) {
          const s = timeline.sourceTime(w.start);
          const e = timeline.sourceTime(w.end);
          if (s !== null && e !== null && e > s) srcWords.push({ start: s, end: e, text: w.text });
        }
      }
      // Fallback for transcripts without word timing (e.g. imported SRT):
      // cut whole cues that are nothing but a filler word.
      const fillerCues = srcWords.length
        ? []
        : proj.captions
            .filter((c) => FILLER.test(c.text))
            .map((c) => {
              const s = timeline.sourceTime(c.start);
              const e = timeline.sourceTime(c.end);
              return s !== null && e !== null && e > s ? { start: s, end: e } : null;
            })
            .filter((r): r is { start: number; end: number } => r !== null);
      const proposals = planSmartCuts({
        silences: sils,
        words: srcWords,
        fillerCues,
        sourceDuration: proj.recording.duration,
      });
      if (!proposals.length) {
        setStatus(
          proj.captions.length ? 'nothing to cut' : 'no silence found — transcribe to also cut fillers',
        );
        return;
      }
      setSmartCuts(proposals.map((p) => ({ ...p, on: true })));
      const saved = proposals.reduce((s, p) => s + p.end - p.start, 0);
      setStatus(`${proposals.length} cuts proposed, ${saved.toFixed(1)}s — review & apply`);
    } catch (e) {
      setStatus(`smart cut failed: ${e}`);
    }
  };

  const applySmartCuts = () => {
    const sel = (smartCuts ?? []).filter((p) => p.on);
    setSmartCuts(null);
    if (!sel.length) return;
    const removed = cutSourceRanges(sel);
    setStatus(`cut ${sel.length} span(s), ${removed.toFixed(1)}s removed — ⌘Z to undo`);
  };

  /** Proposals live in source time; display them in output-time coords. */
  const proposalOutRange = (p: { start: number; end: number }) => {
    const gone = removedRanges(timeline);
    const s = timeline.outputTime(firstKeptAtOrAfter(p.start, gone, proj.recording.duration));
    const e = timeline.outputTime(lastKeptAtOrBefore(p.end, gone));
    return s !== null && e !== null && e > s ? { start: s, end: e } : null;
  };

  /** Cut the selected word range (edit-by-transcript). */
  const cutSelectedWords = () => {
    if (!wordSel) return;
    const cue = proj.captions.find((c) => c.id === wordSel.cueId);
    if (!cue?.words?.length) return;
    const lo = Math.min(wordSel.anchor, wordSel.end);
    const hi = Math.max(wordSel.anchor, wordSel.end);
    const sel = cue.words.slice(lo, hi + 1);
    if (!sel.length) return;
    const s = timeline.sourceTime(sel[0].start);
    const e = timeline.sourceTime(sel[sel.length - 1].end);
    if (s === null || e === null || !(e > s)) {
      setStatus('selection already cut');
      return;
    }
    const removed = cutSourceRanges([{ start: s, end: e }]);
    setStatus(removed ? `cut “${sel.map((w) => w.text).join(' ')}” (${removed.toFixed(1)}s)` : 'nothing cut');
  };

  const cutCue = (cue: { start: number; end: number }) => {
    const s = timeline.sourceTime(cue.start);
    const e = timeline.sourceTime(cue.end);
    if (s === null || e === null) {
      setStatus('cue already cut');
      return;
    }
    const removed = cutSourceRanges([{ start: s, end: e }]);
    setStatus(removed ? `cut ${removed.toFixed(1)}s` : 'nothing cut');
  };

  const undo = () => {
    const prev = historyRef.current.undo(projRef.current);
    if (prev) {
      applyingHistory.current = true;
      setProj(prev);
    }
  };

  const redo = () => {
    const next = historyRef.current.redo(projRef.current);
    if (next) {
      applyingHistory.current = true;
      setProj(next);
    }
  };

  // Keyboard shortcuts: space = play/pause, S = split, ⌘Z = undo, ⌘⇧Z = redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (pendingLeave) {
        if (e.key === 'Escape') void answerLeave('cancel');
        return;
      }
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if ((e.target as HTMLElement)?.getAttribute?.('role') === 'spinbutton') return;
      // ⌘Z / ⇧⌘Z come from the app menu (Edit > Undo/Redo) so one press is one undo.
      // ⌘S, ⌘⌫ and friends belong to the menu, not to split and delete.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'Escape' && selectedTap) {
        setSelectedTap(null);
      } else if (e.key === 's' || e.key === 'S') {
        splitAtPlayhead();
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (editTranscript && wordSel) {
          e.preventDefault();
          cutSelectedWords();
        } else if (selectedTap) {
          e.preventDefault();
          removeTap(selectedTap);
        } else {
          deleteSelectedClip();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // App-menu commands arrive as `openscreen:menu` events.
  useEffect(() => {
    const onMenu = (e: Event) => {
      if (pendingLeave) return;
      switch ((e as CustomEvent<string>).detail) {
        case 'newRecording':
          return leave(onNewRecording);
        case 'openProject':
          return leave(onOpenProject);
        case 'save':
          return void saveProject();
        case 'exportMp4':
          if (!exporting) void exportVideo();
          return;
        case 'exportGif':
          if (!exporting) void exportVideo(true);
          return;
        case 'undo':
        case 'redo':
          return menuHistory((e as CustomEvent<string>).detail as 'undo' | 'redo');
        case 'playPause':
          if (!exporting) togglePlay();
          return;
        case 'split':
          if (!exporting) splitAtPlayhead();
          return;
      }
    };
    window.addEventListener('openscreen:menu', onMenu);
    return () => window.removeEventListener('openscreen:menu', onMenu);
  });

  /**
   * Phone recordings have no cursor track: read taps, swipes and still
   * stretches from the video itself (main runs ffmpeg + taps.ts). They land
   * on the taps track as editable suggestions, in source time. `auto` is the
   * first-open run, which isn't an undo step of its own.
   */
  const analyzeTaps = async (auto = false) => {
    if (analyzing) return;
    setAnalyzing(true);
    setStatus('Finding taps…');
    try {
      const found = await api.analyzeTaps(bundleDir, proj.recording.screenVideoFile);
      if (disposed.current) return;
      if (auto) applyingHistory.current = true;
      setProj((p) => ({ ...p, taps: found.taps, waits: found.deadTime, tapsAnalyzed: true }));
      setSelectedTap(null);
      const n = found.taps.length;
      setStatus(n ? `${n} tap${n === 1 ? '' : 's'} found` : 'No taps found. Option-click the taps lane to add one');
    } catch (e) {
      if (!disposed.current) setStatus(`Couldn't find taps: ${ipcErrorMessage(e)}`);
    } finally {
      if (!disposed.current) setAnalyzing(false);
    }
  };

  // The first time a phone recording opens, find its taps.
  useEffect(() => {
    if (isPhone && !proj.tapsAnalyzed && proj.taps.length === 0) void analyzeTaps(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateTap = (id: string, patch: Partial<TapSuggestion>) =>
    setProj((p) => ({ ...p, taps: p.taps.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));

  const removeTap = (id: string) => {
    setProj((p) => ({ ...p, taps: p.taps.filter((t) => t.id !== id) }));
    if (selectedTap === id) setSelectedTap(null);
  };

  /** Option-click on the taps lane: a tap at the playhead, mid-screen until placed. */
  const addTapAtPlayhead = () => {
    const tap: TapSuggestion = {
      id: crypto.randomUUID(),
      t: tapSourceTime(playheadRef.current, timeline),
      x: 0.5,
      y: 0.5,
      kind: 'tap',
      confidence: 1,
    };
    setProj((p) => ({ ...p, taps: [...p.taps, tap].sort((a, b) => a.t - b.t) }));
    setSelectedTap(tap.id);
    setStatus('Tap added. Click the preview to place it');
  };

  const selectTap = (id: string) => {
    setSelectedTap(id);
    const t = outTaps.find((x) => x.id === id);
    // Just after touch-down, where the indicator is fully pressed.
    if (t) seekOutput(Math.min(timeline.outputDuration, t.t + 0.1));
  };

  const waitsLeft = useMemo(() => pendingWaits(proj.waits, timeline), [proj.waits, timeline]);
  const waitCores = waitsLeft.map((w) => waitCore(w)).filter((r): r is { start: number; end: number } => r !== null);

  /** Play every still stretch at 3x (clip speed + split), or cut them. */
  const handleWaits = (how: 'speed' | 'cut') => {
    if (!waitCores.length) return;
    const secs = waitCores.reduce((n, r) => n + r.end - r.start, 0);
    if (how === 'speed') {
      editClips(speedUpRanges(proj.clips, waitCores, 3));
      setStatus(`${waitCores.length} wait${waitCores.length === 1 ? '' : 's'} sped up 3×, ${(secs * (2 / 3)).toFixed(1)}s saved`);
    } else {
      const removed = cutSourceRanges(waitCores);
      setStatus(`${waitCores.length} wait${waitCores.length === 1 ? '' : 's'} cut, ${removed.toFixed(1)}s removed`);
    }
  };

  const transcribe = async () => {
    setStatus('transcribing…');
    try {
      const segs = await api.transcribe(bundleDir, proj.recording.screenVideoFile);
      // whisper times are source-time — remap through the timeline.
      const cues = segs
        .map((s) => {
          const start = timeline.outputTime(s.start);
          const end = timeline.outputTime(s.end);
          if (start === null || end === null) return null;
          const words = (s.words ?? [])
            .map((w) => {
              const ws = timeline.outputTime(w.start);
              const we = timeline.outputTime(w.end);
              return ws !== null && we !== null && we > ws
                ? { start: ws, end: we, text: w.text }
                : null;
            })
            .filter((w): w is NonNullable<typeof w> => w !== null);
          // Cue text is rebuilt from surviving words so words already cut
          // from the timeline don't linger in the transcript.
          const text = words.length ? words.map((w) => w.text).join(' ') : s.text;
          if (!text) return null;
          return { id: crypto.randomUUID(), start, end, text, ...(words.length ? { words } : {}) };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);
      if (!cues.length) {
        setStatus('no speech detected (recording has no audio?)');
        return;
      }
      setProj((p) => ({ ...p, captions: cues }));
      setWordSel(null);
      const nWords = cues.reduce((n, c) => n + (c.words?.length ?? 0), 0);
      setStatus(`${cues.length} captions transcribed${nWords ? ` (${nWords} words)` : ''}`);
    } catch (e) {
      setStatus(`transcribe failed: ${e}`);
    }
  };

  const importCaptions = async (file: File) => {
    const cues = parseCaptions(await file.text());
    if (!cues.length) {
      setStatus('no cues found in file');
      return;
    }
    setProj((p) => ({ ...p, captions: cues }));
    setStatus(`${cues.length} captions imported`);
  };

  const saveProject = async () => {
    try {
      await persist(proj);
      setStatus('project saved');
    } catch (e) {
      setStatus(`save failed: ${e}`);
    }
  };

  /** Run `go` (which unmounts this editor), first asking about unsaved
   *  changes. An export in flight has to finish or be cancelled first. */
  const leave = (go: () => void) => {
    if (exporting) {
      setStatus('cancel the export before leaving');
      return;
    }
    if (saveTracker.current.isDirty(projRef.current)) setPendingLeave(() => go);
    else go();
  };

  const answerLeave = async (choice: 'save' | 'discard' | 'cancel') => {
    const go = pendingLeave;
    setPendingLeave(null);
    if (!go || choice === 'cancel') return;
    if (choice === 'save') {
      try {
        await persist(projRef.current);
      } catch (e) {
        setStatus(`save failed: ${e}`);
        return;
      }
    }
    go();
  };

  /** Undo/redo from the menu: a focused text field gets the native edit,
   *  anything else (sliders, switches, the canvas) the project history. */
  const menuHistory = (dir: 'undo' | 'redo') => {
    if (isTextEntry(document.activeElement as HTMLInputElement | null)) {
      document.execCommand(dir);
    } else if (dir === 'undo') undo();
    else redo();
  };

  // Repaint the waveform whenever peaks or the cut layout changes.
  useEffect(() => {
    const cv = waveRef.current;
    if (!cv || !peaks.length) return;
    const W = (cv.width = cv.clientWidth * 2);
    const H = (cv.height = cv.clientHeight * 2);
    const g = cv.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,0.28)';
    const outDur = timeline.outputDuration || duration || 1;
    const srcDur = proj.recording.duration || 1;
    for (let x = 0; x < W; x++) {
      const outT = (x / W) * outDur;
      const srcT = timeline.sourceTime(outT);
      if (srcT == null) continue;
      const p = peaks[Math.min(peaks.length - 1, Math.floor((srcT / srcDur) * peaks.length))];
      const h = Math.max(2, p * H * 0.9);
      g.fillRect(x, (H - h) / 2, 1, h);
    }
  }, [peaks, timeline, duration, proj.recording.duration]);

  // Smart cut proposals are reviewed in the Text tab, so bring it forward.
  useEffect(() => {
    if (smartCuts) setInspectorTab('text');
  }, [smartCuts]);

  // Close the export menu on any click outside it.
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!exportMenuRef.current?.contains(e.target as Node)) setExportMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [exportMenuOpen]);

  const zoomMarks = segments;

  // ── presentation only below: derived display values and UI-only state ──
  const outDur = timeline.outputDuration || duration || 1;
  const bundleName = (bundleDir.split('/').filter(Boolean).pop() ?? 'Untitled').replace(/\.openscreen$/, '');
  const exportProgress = /exporting (\d+)\/(\d+)/.exec(status);
  const selectedSpeed = proj.clips.find((c) => c.id === selectedClip)?.speed ?? 1;
  const togglePlay = () =>
    videoRef.current?.paused ? videoRef.current?.play() : videoRef.current?.pause();

  // Phone recordings have no cursor; they get the Device tab instead.
  const inspectorTabs = [
    { value: 'background' as const, label: 'Background' },
    ...(isPhone ? [{ value: 'device' as const, label: 'Device' }] : []),
    { value: 'zoom' as const, label: 'Zoom' },
    ...(isPhone ? [] : [{ value: 'cursor' as const, label: 'Cursor' }]),
    ...(camUrl ? [{ value: 'camera' as const, label: 'Camera' }] : []),
    { value: 'audio' as const, label: 'Audio' },
    { value: 'text' as const, label: 'Text' },
  ];
  const activeTab: InspectorTab = inspectorTabs.some((t) => t.value === inspectorTab) ? inspectorTab : 'background';
  /** Ends the undo step a scrub gesture made. */
  const sealHistory = () => historyRef.current.seal();
  const blurredBg = isPhone && proj.layout.background === 'blurred';

  const importCaptionsButton = (variant: 'secondary' | 'ghost', size: 'sm' | 'md') => (
    <label className={`btn btn-${variant} btn-${size}`}>
      Import captions…
      <input
        type="file"
        accept=".srt,.vtt"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && importCaptions(e.target.files[0])}
      />
    </label>
  );

  const backgroundPanel = (
    <>
      {isPhone && <LayoutSection proj={proj} setProj={setProj} onTitleFocus={setTitleFocus} />}
      <Section title="Backdrop">
        <div className="tiles">
          {isPhone && (
            <button
              type="button"
              title="A soft blur of the recording itself"
              className={`tile${blurredBg ? ' selected' : ''}`}
              onClick={() => setProj((p) => ({ ...p, layout: { ...p.layout, background: 'blurred' } }))}
            >
              <span className="tile-swatch blurred" />
              <span className="tile-label">Blurred</span>
            </button>
          )}
          {SWATCHES.map((s) => (
            <button
              key={s.name}
              type="button"
              title={s.name}
              className={`tile${!blurredBg && sameBackground(s.bg, proj.style.background) ? ' selected' : ''}`}
              onClick={() =>
                setProj((p) => ({ ...p, style: { ...p.style, background: s.bg }, layout: { ...p.layout, background: 'style' } }))
              }
            >
              <span
                className="tile-swatch"
                style={
                  s.bg.kind === 'gradient'
                    ? { background: `linear-gradient(${s.bg.angle}deg, ${s.bg.startHex}, ${s.bg.endHex})` }
                    : { background: s.bg.hex }
                }
              />
              <span className="tile-label">{s.name}</span>
            </button>
          ))}
          <button
            type="button"
            title="Custom background image"
            className="tile"
            onClick={async () => {
              const path = await api.pickBackground();
              if (path) {
                setProj((p) => ({
                  ...p,
                  style: { ...p.style, background: { kind: 'imageFile', path } },
                  layout: { ...p.layout, background: 'style' },
                }));
              }
            }}
          >
            <span className="tile-swatch tile-text">Image…</span>
            <span className="tile-label">Choose</span>
          </button>
          <button
            type="button"
            title="Use desktop wallpaper"
            className="tile"
            onClick={async () => {
              const noWallpaper = "Couldn't read your wallpaper, choose an image instead";
              const path = await api.wallpaperPath().catch(() => null);
              if (!path || !(await backgroundReady(path))) {
                setStatus(noWallpaper);
                return;
              }
              setProj((p) => ({
                ...p,
                style: { ...p.style, background: { kind: 'imageFile', path } },
                layout: { ...p.layout, background: 'style' },
              }));
            }}
          >
            <span className="tile-swatch tile-text">Desktop</span>
            <span className="tile-label">Wallpaper</span>
          </button>
        </div>
        {proj.style.background.kind === 'imageFile' && !blurredBg && (
          <ScrubField
            label="Image blur"
            min={0}
            max={60}
            step={1}
            unit="px"
            value={proj.style.background.blur ?? 0}
            onCommit={sealHistory}
            onChange={(v) =>
              setProj((p) => ({
                ...p,
                style: {
                  ...p.style,
                  background: { kind: 'imageFile', path: p.style.background.kind === 'imageFile' ? p.style.background.path : '', blur: v },
                },
              }))
            }
          />
        )}
      </Section>
      {!preset && (
        <Section title="Frame">
          {(
            [
              ['Padding', 'paddingFraction', 0, 0.4, 0.01, '%', 100],
              ['Corner radius', 'cornerRadius', 0, 120, 1, 'px', 1],
              ['Shadow', 'shadowRadius', 0, 200, 1, 'px', 1],
              ['Shadow opacity', 'shadowOpacity', 0, 1, 0.01, '%', 100],
            ] as const
          ).map(([label, key, min, max, step, unit, mul]) => (
            <ScrubField
              key={key}
              label={label}
              // Percentages scrub and type as whole numbers.
              min={min * mul}
              max={max * mul}
              step={step * mul}
              unit={unit}
              value={Math.round(proj.style[key] * mul * 100) / 100}
              onCommit={sealHistory}
              onChange={(v) => setProj((p) => ({ ...p, style: { ...p.style, [key]: v / mul } }))}
            />
          ))}
        </Section>
      )}
    </>
  );

  const zoomPanel = (
    <>
      {!presetAllowsZoom(preset) && (
        <Section title="Automatic">
          <p className="hint">
            App Store previews don't zoom: Apple recommends showing the app's native UI. Pick another
            canvas to zoom.
          </p>
        </Section>
      )}
      {presetAllowsZoom(preset) && (
        <Section title="Automatic">
          {isPhone ? (
            <Switch
              label="Zoom to taps"
              hint="Glide in on each tap, pan between quick ones, pull out for swipes"
              checked={proj.zoom.fromTaps}
              onChange={(v) => setZoom({ fromTaps: v })}
            />
          ) : (
            <>
              <Switch
                label="Auto-focus"
                hint="Zoom toward each click"
                checked={autofocusOn}
                onChange={(v) => setZoom({ autofocus: v })}
              />
              {autofocusOn && (
                <Switch
                  label="Dwell zoom"
                  hint="Also zoom where the cursor lingers"
                  title="Also zoom where the cursor lingers, not just clicks"
                  checked={dwellOn}
                  onChange={(v) => setZoom({ dwell: v })}
                />
              )}
            </>
          )}
          {(isPhone ? proj.zoom.fromTaps : autofocusOn) && (
            <ScrubField
              label="Zoom depth"
              min={1.2}
              max={4}
              step={0.1}
              unit="×"
              value={zoomDepth}
              format={(v) => v.toFixed(1)}
              onCommit={sealHistory}
              onChange={(v) => setZoom({ depth: v })}
            />
          )}
        </Section>
      )}
      <Section title="Manual zooms">
        <p className="hint">
          <Kbd>⌥</Kbd> Option-click the timeline to add a zoom at that moment. Right-click a
          manual zoom on the Zoom lane to remove it.
        </p>
        <p className="hint tnum">
          {manualSegments.length
            ? `${manualSegments.length} manual zoom${manualSegments.length === 1 ? '' : 's'}`
            : 'No manual zooms yet'}
        </p>
      </Section>
    </>
  );

  const cursorPanel = (
    <Section title="Cursor">
      <ScrubField
        label="Size"
        min={5}
        max={30}
        step={1}
        value={Math.round(proj.style.cursorSize * 1000)}
        onCommit={sealHistory}
        onChange={(v) => setProj((p) => ({ ...p, style: { ...p.style, cursorSize: v / 1000 } }))}
      />
      <Switch
        label="Trail"
        hint="Smear the cursor along its recent path"
        checked={proj.style.cursorTrail}
        onChange={(v) => setProj((p) => ({ ...p, style: { ...p.style, cursorTrail: v } }))}
      />
      <label className="row" title="Cursor color">
        <span className="row-label">Color</span>
        <span className="color-field">
          <span className="tnum">{proj.style.cursorHex.toUpperCase()}</span>
          <input
            type="color"
            value={proj.style.cursorHex}
            onChange={(e) =>
              setProj((p) => ({ ...p, style: { ...p.style, cursorHex: e.target.value } }))
            }
          />
        </span>
      </label>
    </Section>
  );

  const cameraPanel = camUrl && (
    <Section title="Camera">
      <Switch
        label="Show camera"
        checked={proj.cameraOverlay.enabled}
        onChange={(v) =>
          setProj((p) => ({
            ...p,
            cameraOverlay: { ...p.cameraOverlay, enabled: v },
          }))
        }
      />
      <div className="field-block">
        <span className="row-label">Corner</span>
        <Segmented
          label="Camera corner"
          columns={2}
          value={proj.cameraOverlay.corner}
          options={[
            { value: 'topLeft', label: 'Top left' },
            { value: 'topRight', label: 'Top right' },
            { value: 'bottomLeft', label: 'Bottom left' },
            { value: 'bottomRight', label: 'Bottom right' },
          ]}
          onChange={(corner) =>
            setProj((p) => ({
              ...p,
              cameraOverlay: { ...p.cameraOverlay, corner },
            }))
          }
        />
      </div>
      <Switch
        label="Circle"
        hint="Crop the camera to a circle"
        checked={proj.cameraOverlay.circular}
        onChange={(v) =>
          setProj((p) => ({
            ...p,
            cameraOverlay: { ...p.cameraOverlay, circular: v },
          }))
        }
      />
    </Section>
  );

  const audioPanel = (
    <Section title="Audio">
      <Switch
        label="Click sounds"
        hint="Mix a click sound at each click"
        title="Mix a click sound at each click"
        checked={clickSfx}
        onChange={(v) => setAudio({ clickSounds: v })}
      />
      <Switch
        label="Voice cleanup"
        hint="Denoise and level the voice on export, locally with ffmpeg"
        title="Denoise + level the voice track on export (highpass, afftdn, compressor, limiter — all local ffmpeg)"
        checked={voiceCleanup}
        onChange={(v) => setAudio({ voiceCleanup: v })}
      />
    </Section>
  );

  const smartCutPanel = smartCuts && (
    <section className="section smartcuts">
      <header className="section-head">
        <h3>Smart cut</h3>
        <span className="section-meta tnum">
          {smartCuts.filter((p) => p.on).length} of {smartCuts.length} selected
        </span>
      </header>
      <div className="list">
        {smartCuts.map((p, i) => {
          const r = proposalOutRange(p);
          return (
            <div
              className="cue"
              key={i}
              onClick={() => {
                if (r) seekOutput(r.start);
              }}
            >
              <input
                type="checkbox"
                className="check"
                checked={p.on}
                onClick={(e) => e.stopPropagation()}
                onChange={() =>
                  setSmartCuts((s) =>
                    s ? s.map((x, xi) => (xi === i ? { ...x, on: !x.on } : x)) : s,
                  )
                }
              />
              <span className="t">{r ? fmtTime(r.start) : '—'}</span>
              <span className="cue-text">
                <span className={`tag ${p.kind}`}>{p.kind === 'silence' ? 'Silence' : 'Filler'}</span>
                {p.label}
              </span>
            </div>
          );
        })}
      </div>
      <div className="sticky-actions">
        <Button variant="primary" onClick={applySmartCuts}>
          Apply cuts
        </Button>
        <Button variant="ghost" onClick={() => setSmartCuts(null)}>
          Dismiss
        </Button>
      </div>
    </section>
  );

  const textPanel = (
    <>
      {smartCutPanel}
      <Section
        title="Text overlays"
        actions={
          <Button size="sm" title="Add a text overlay at the playhead" onClick={() =>
            setProj((p) => ({
              ...p,
              annotations: [
                ...p.annotations,
                {
                  id: crypto.randomUUID(),
                  start: playhead,
                  end: Math.min(timeline.outputDuration, playhead + 3),
                  text: 'Text',
                  band: 1,
                  hex: '#ffffff',
                },
              ],
            }))
          }>
            Add text
          </Button>
        }
      >
        {proj.annotations.length === 0 ? (
          <p className="hint">Adds a three second overlay at the playhead.</p>
        ) : (
          <div className="list">
            {proj.annotations.map((a) => (
              <div className="annot" key={a.id}>
                <input
                  className="field"
                  value={a.text}
                  onChange={(e) =>
                    setProj((p) => ({
                      ...p,
                      annotations: p.annotations.map((x) =>
                        x.id === a.id ? { ...x, text: e.target.value } : x,
                      ),
                    }))
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="band-btn"
                  title="Position: top / middle / bottom"
                  onClick={() =>
                    setProj((p) => ({
                      ...p,
                      annotations: p.annotations.map((x) =>
                        x.id === a.id ? { ...x, band: ((x.band + 1) % 3) as 0 | 1 | 2 } : x,
                      ),
                    }))
                  }
                >
                  {a.band === 0 ? 'Top' : a.band === 1 ? 'Middle' : 'Bottom'}
                </Button>
                <IconButton
                  label="Delete"
                  className="sm"
                  onClick={() =>
                    setProj((p) => ({
                      ...p,
                      annotations: p.annotations.filter((x) => x.id !== a.id),
                    }))
                  }
                >
                  {Icon.close(12)}
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Transcript"
        actions={
          proj.captions.length > 0 && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className={editTranscript ? 'is-on' : ''}
                aria-pressed={editTranscript}
                title="Edit mode: click a word, shift-click to extend, then delete to cut that span"
                onClick={() => {
                  setEditTranscript((v) => !v);
                  setWordSel(null);
                }}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="Suggest chapters + a title from the transcript"
                onClick={() => {
                  const ch = suggestChapters(proj.captions, timeline.outputDuration || duration);
                  if (!ch.length) {
                    setStatus('not enough transcript for chapters');
                    return;
                  }
                  setProj((p) => ({ ...p, chapters: ch }));
                  setStatus(`${ch.length} chapters suggested`);
                }}
              >
                Chapters
              </Button>
            </>
          )
        }
      >
        {proj.captions.length === 0 ? (
          <EmptyState
            title="No transcript yet"
            actions={
              <>
                <Button variant="primary" onClick={transcribe} title="Auto-transcribe via whisper">
                  Transcribe
                </Button>
                {importCaptionsButton('secondary', 'md')}
              </>
            }
          >
            Transcribe the recording to get captions you can edit word by word and turn
            into chapters. You can also import an SRT or VTT file.
          </EmptyState>
        ) : (
          <>
            <div className="toolbar">
              <Button size="sm" onClick={transcribe} title="Auto-transcribe via whisper">
                Transcribe again
              </Button>
              {importCaptionsButton('ghost', 'sm')}
            </div>
            {editTranscript && (
              <div className="edit-hint">
                {wordSel ? (
                  <Button size="sm" variant="danger" onClick={cutSelectedWords} title="Cut the selected words' span from the video">
                    Cut selected words
                  </Button>
                ) : (
                  <span>
                    Click a word, <Kbd>⇧</Kbd> Shift-click to extend, then <Kbd>⌫</Kbd> to cut.
                  </span>
                )}
              </div>
            )}
            <div className="list">
              {proj.captions.map((c) => (
                <div className="cue" key={c.id} onClick={() => !editTranscript && seekOutput(c.start)}>
                  <span className="t">{fmtTime(c.start)}</span>
                  {editTranscript && c.words?.length ? (
                    <span className="cue-text words">
                      {c.words.map((w, wi) => {
                        const sel =
                          wordSel?.cueId === c.id &&
                          wi >= Math.min(wordSel.anchor, wordSel.end) &&
                          wi <= Math.max(wordSel.anchor, wordSel.end);
                        return (
                          <span
                            key={wi}
                            className={`tw${sel ? ' sel' : ''}`}
                            title={fmtTime(w.start)}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (e.shiftKey && wordSel?.cueId === c.id) {
                                setWordSel({ cueId: c.id, anchor: wordSel.anchor, end: wi });
                              } else {
                                setWordSel({ cueId: c.id, anchor: wi, end: wi });
                              }
                            }}
                          >
                            {w.text}{' '}
                          </span>
                        );
                      })}
                    </span>
                  ) : (
                    <span className="cue-text">{c.text}</span>
                  )}
                  <IconButton
                    label="Cut this cue from the video"
                    className="sm cue-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      cutCue(c);
                    }}
                  >
                    {Icon.scissors(12)}
                  </IconButton>
                </div>
              ))}
            </div>
          </>
        )}
      </Section>

      {proj.chapters.length > 0 && (
        <Section
          title="Chapters"
          actions={
            <>
              <Button
                size="sm"
                variant="ghost"
                title="Copy as YouTube chapter list"
                onClick={() => {
                  void navigator.clipboard.writeText(toChapterList(proj.chapters));
                  setStatus('chapters copied');
                }}
              >
                Copy
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="Clear chapters"
                onClick={() => setProj((p) => ({ ...p, chapters: [] }))}
              >
                Clear
              </Button>
            </>
          }
        >
          <div className="list">
            {proj.chapters.map((ch) => (
              <div className="cue" key={ch.id} onClick={() => seekOutput(ch.start)}>
                <span className="t">{fmtTime(ch.start)}</span>
                <input
                  className="field chtitle"
                  value={ch.title}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    setProj((p) => ({
                      ...p,
                      chapters: p.chapters.map((x) =>
                        x.id === ch.id ? { ...x, title: e.target.value } : x,
                      ),
                    }))
                  }
                />
                <IconButton
                  label="Remove chapter"
                  className="sm cue-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    setProj((p) => ({ ...p, chapters: p.chapters.filter((x) => x.id !== ch.id) }));
                  }}
                >
                  {Icon.close(12)}
                </IconButton>
              </div>
            ))}
          </div>
        </Section>
      )}

      {!smartCuts && (
        <Section title="Smart cut">
          <div className="row">
            <span className="row-hint">
              Find silences{proj.captions.length ? ' and filler words' : ''}, then review each cut
              before applying.
            </span>
            <Button
              size="sm"
              onClick={smartCut}
              title="Detect silences + filler words and preview the cuts before applying"
            >
              Smart cut
            </Button>
          </div>
        </Section>
      )}
    </>
  );

  return (
    <div className="editor">
      <video
        ref={videoRef}
        src={videoUrl}
        className="hidden"
        preload="auto"
        muted={exporting}
        onLoadedMetadata={(e) => setDuration(mediaDuration(e.currentTarget.duration, proj.recording.duration))}
        onDurationChange={(e) => setDuration(mediaDuration(e.currentTarget.duration, proj.recording.duration))}
        onLoadedData={() => renderAt(playheadRef.current)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      {camUrl && <video ref={camRef} src={camUrl} className="hidden" preload="auto" muted />}

      <header className="topbar ed-top">
        <Button
          size="sm"
          variant="ghost"
          className="back-btn"
          title="Back to the source picker (⌘N)"
          disabled={exporting}
          onClick={() => leave(onNewRecording)}
        >
          {Icon.chevronLeft(12)}
          New recording
        </Button>
        <span className="doc-title" title={bundleDir}>{bundleName}</span>
        <div className="history no-drag">
          <IconButton label="Undo (⌘Z)" onClick={undo}>{Icon.undo(15)}</IconButton>
          <IconButton label="Redo (⌘⇧Z)" onClick={redo}>{Icon.redo(15)}</IconButton>
        </div>
        <div className="spacer" />
        {(status || exporting) && (
          <div className={`status-pill no-drag${exporting ? ' busy' : ''}`} title={status}>
            {exportProgress && (
              <span className="progress">
                <span style={{ width: `${(+exportProgress[1] / Math.max(1, +exportProgress[2])) * 100}%` }} />
              </span>
            )}
            <span className="status-text tnum">
              {exportProgress
                ? `Exporting ${Math.round((+exportProgress[1] / Math.max(1, +exportProgress[2])) * 100)}%`
                : status}
            </span>
            {exporting && (
              <button type="button" className="pill-cancel" onClick={() => { cancelExport.current = true; }}>
                Cancel
              </button>
            )}
          </div>
        )}
        <div className="spacer" />
        <Button variant="ghost" onClick={saveProject}>Save</Button>
        <div className="split-btn no-drag" ref={exportMenuRef}>
          <Button variant="primary" className="split-main" disabled={exporting} onClick={() => exportVideo()}>
            Export MP4
          </Button>
          <Button
            variant="primary"
            className="split-toggle"
            aria-label="Export options"
            aria-expanded={exportMenuOpen}
            onClick={() => setExportMenuOpen((o) => !o)}
          >
            {Icon.chevronDown(12)}
          </Button>
          {exportMenuOpen && (
            <div className="menu" role="dialog" aria-label="Export options">
              <div className="field-block">
                <span className="row-label">Resolution</span>
                <Segmented
                  label="Resolution"
                  value={proj.exportPreset}
                  options={[
                    { value: 'original', label: 'Original' },
                    { value: 'p1080', label: '1080p' },
                    { value: 'uhd4k', label: '4K' },
                  ]}
                  onChange={(v) => setProj((p) => ({ ...p, exportPreset: v }))}
                />
              </div>
              <div className="field-block">
                <span className="row-label">Frame rate</span>
                <Segmented
                  label="Frame rate"
                  value={proj.outputFPS}
                  options={[24, 30, 60].map((f) => ({ value: f, label: `${f} fps` }))}
                  onChange={(v) => setProj((p) => ({ ...p, outputFPS: v }))}
                />
              </div>
              <div className="menu-sep" />
              <Button
                disabled={exporting}
                onClick={() => {
                  setExportMenuOpen(false);
                  void exportVideo(true);
                }}
              >
                Export GIF
              </Button>
              <p className="hint">The GIF is made from the MP4, which is kept alongside it.</p>
            </div>
          )}
        </div>
      </header>

      <main className="ed-stage">
        <div className="stage-canvas">
          <div className="stage-inner">
            <canvas
              ref={canvasRef}
              className={`preview${cropMode ? ' cropping' : ''}`}
              style={{ cursor: cropMode || selectedTap ? 'crosshair' : undefined }}
              title={selectedTap ? 'Click to place the selected tap' : undefined}
              onMouseDown={onCanvasDown}
              onMouseMove={onCanvasMove}
              onMouseUp={onCanvasUp}
              onMouseLeave={onCanvasLeave}
            />
          </div>
        </div>
        <div className="transport">
          <div className="transport-group">
            <button
              type="button"
              className="play-btn"
              aria-label={playing ? 'Pause' : 'Play'}
              title={playing ? 'Pause (Space)' : 'Play (Space)'}
              onClick={togglePlay}
            >
              {playing ? Icon.pause(14) : Icon.play(14)}
            </button>
            <span className="timecode tnum">
              {fmtPrecise(playhead)}
              <span> / {fmtPrecise(timeline.outputDuration || duration)}</span>
            </span>
          </div>
          <div className="transport-group">
            <Button size="sm" variant="ghost" onClick={splitAtPlayhead} title="Split at playhead (S)">
              Split
            </Button>
            <Button size="sm" variant="ghost" disabled={!selectedClip} onClick={() => trimClip('start')} title="Trim clip start to playhead">
              Trim start
            </Button>
            <Button size="sm" variant="ghost" disabled={!selectedClip} onClick={() => trimClip('end')} title="Trim clip end to playhead">
              Trim end
            </Button>
            <Button size="sm" variant="ghost" onClick={deleteSelectedClip} disabled={!selectedClip || proj.clips.length <= 1} title="Delete clip (⌫)">
              Delete clip
            </Button>
            {selectedClip && (
              <Segmented
                size="sm"
                label="Clip speed"
                value={selectedSpeed}
                options={[0.5, 0.75, 1, 1.5, 2, 4].map((v) => ({ value: v, label: `${v}×` }))}
                onChange={setClipSpeed}
              />
            )}
          </div>
          {!preset && (
            <div className="transport-group">
              <Button
                size="sm"
                variant="ghost"
                className={cropMode ? 'is-on' : ''}
                onClick={() => setCropMode((c) => !c)}
              >
                {cropMode ? 'Drag on preview…' : 'Crop'}
              </Button>
              {proj.style.cropRect && !cropMode && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setProj((p) => ({ ...p, style: { ...p.style, cropRect: null } }))}
                >
                  Reset crop
                </Button>
              )}
            </div>
          )}
        </div>
      </main>

      <aside className="inspector">
        <Tabs value={activeTab} tabs={inspectorTabs} onChange={setInspectorTab} />
        <div className="inspector-body" key={activeTab}>
          {activeTab === 'background' && backgroundPanel}
          {activeTab === 'device' && (
            <DevicePanel
              proj={proj}
              setProj={setProj}
              onCommit={sealHistory}
              resolved={resolvedDevice}
              analyzing={analyzing}
              onRedetect={() => void analyzeTaps()}
              pendingWaits={{ count: waitCores.length, seconds: waitCores.reduce((n, r) => n + r.end - r.start, 0) }}
              onSpeedUpWaits={() => handleWaits('speed')}
              onCutWaits={() => handleWaits('cut')}
            />
          )}
          {activeTab === 'zoom' && zoomPanel}
          {activeTab === 'cursor' && cursorPanel}
          {activeTab === 'camera' && cameraPanel}
          {activeTab === 'audio' && audioPanel}
          {activeTab === 'text' && textPanel}
        </div>
      </aside>

      <footer className={`ed-timeline${isPhone ? ' has-taps' : ''}`}>
        <div className="tl-labels" aria-hidden="true">
          <span />
          <span>Clips</span>
          <span>Zoom</span>
          {isPhone && <span>Taps</span>}
          <span>Audio</span>
        </div>
        {/* The seek target spans exactly the lanes, so click % = time %. */}
        <div className="tl-lanes" onClick={seekTimeline}>
          <div className="tl-ruler">
            {rulerTicks(outDur).map((t) => (
              <span key={t} className="tick tnum" style={{ left: `${(t / outDur) * 100}%` }}>
                {fmtTime(t)}
              </span>
            ))}
          </div>
          <div className="lane lane-clips">
            {clipBlocks.map((b, i) => {
              const speed = timeline.clips[i]?.speed ?? 1;
              return (
                <div
                  key={b.id}
                  className={`clipblock${selectedClip === b.id ? ' selected' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    dragFrom.current = timeline.clips.findIndex((c) => c.id === b.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const from = dragFrom.current;
                    const to = timeline.clips.findIndex((c) => c.id === b.id);
                    dragFrom.current = null;
                    if (from === null || to < 0 || from === to) return;
                    const tl = new Timeline(proj.recording.duration, proj.clips.map((c) => ({ ...c })));
                    tl.reorder(from, to);
                    editClips(tl.clips);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedClip(b.id);
                    setSelectedTap(null);
                  }}
                  style={{
                    left: `${(b.start / (timeline.outputDuration || duration || 1)) * 100}%`,
                    width: `${((b.end - b.start) / (timeline.outputDuration || duration || 1)) * 100}%`,
                  }}
                >
                  <span className="clip-label tnum">
                    Clip {i + 1}
                    <span>
                      {(b.end - b.start).toFixed(1)}s{speed !== 1 ? ` · ${speed}×` : ''}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          <div className="lane lane-zoom">
            {zoomMarks.map((s, i) => {
              const manual = manualSegments.includes(s);
              return (
                <div
                  key={i}
                  className={`zoommark${manual ? ' manual' : ''}`}
                  title={manual ? 'Manual zoom (right-click to remove)' : 'Auto zoom'}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setProj((p) => ({ ...p, manualZooms: p.manualZooms.filter((x) => x !== s) }));
                  }}
                  style={{
                    left: `${(s.inStart / (timeline.outputDuration || duration || 1)) * 100}%`,
                    width: `${(Math.max(0, s.outEnd - s.inStart) / (timeline.outputDuration || duration || 1)) * 100}%`,
                  }}
                >
                  <span className="tnum">{s.scale.toFixed(1)}×</span>
                </div>
              );
            })}
          </div>
          {isPhone && (
            <TapsLane
              taps={outTaps}
              waits={rangesToOutput(proj.waits, timeline).map((r) => ({
                ...r,
                pending: r.speed < 1.5,
              }))}
              outDur={outDur}
              selectedId={selectedTap}
              onSelect={(id) => {
                setSelectedClip(null);
                selectTap(id);
              }}
              onMove={(id, outT) => updateTap(id, { t: tapSourceTime(outT, timeline) })}
              onRemove={removeTap}
              onAdd={addTapAtPlayhead}
            />
          )}
          <div className="lane lane-audio">
            <canvas ref={waveRef} className="wave" />
            {peaks.length > 0 && Math.max(...peaks) < 0.03 && (
              <span className="lane-note">Silent recording</span>
            )}
          </div>
          {(smartCuts ?? []).map((p, i) => {
            const r = proposalOutRange(p);
            if (!r) return null;
            const outDur = timeline.outputDuration || duration || 1;
            return (
              <div
                key={`cut-${i}`}
                className={`cutmark${p.on ? '' : ' off'}`}
                title={`${p.kind === 'silence' ? 'Silence' : 'Filler'} ${p.label}`}
                style={{
                  left: `${(r.start / outDur) * 100}%`,
                  width: `${((r.end - r.start) / outDur) * 100}%`,
                }}
              />
            );
          })}
          {(proj.chapters ?? []).map((ch) => (
            <div
              key={ch.id}
              className="chaptermark"
              title={`Chapter: ${ch.title}`}
              style={{ left: `${(ch.start / (timeline.outputDuration || duration || 1)) * 100}%` }}
            />
          ))}
          <div
            className="playhead"
            style={{ left: `${(playhead / (timeline.outputDuration || duration || 1)) * 100}%` }}
          />
        </div>
      </footer>

      {pendingLeave && (
        <div className="modal-scrim" onMouseDown={() => void answerLeave('cancel')}>
          <div
            className="modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="leave-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 id="leave-title">Save changes to {bundleName}?</h2>
            <p>Your latest edits aren't saved yet. If you don't save, they're lost.</p>
            <div className="modal-actions">
              <Button variant="ghost" onClick={() => void answerLeave('discard')}>
                Don't save
              </Button>
              <div className="spacer" />
              <Button onClick={() => void answerLeave('cancel')}>Cancel</Button>
              <Button variant="primary" autoFocus onClick={() => void answerLeave('save')}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const FILLER = /^[\s.,!?]*(?:um+|uh+|er+|eh+|ah+|hmm+|mm+|mhm)[\s.,!?]*$/i;

/** Field-wise background equality (saved projects may order keys differently). */
function sameBackground(a: Project['style']['background'], b: Project['style']['background']) {
  if (a.kind === 'gradient' && b.kind === 'gradient') {
    return (
      a.startHex.toLowerCase() === b.startHex.toLowerCase() &&
      a.endHex.toLowerCase() === b.endHex.toLowerCase() &&
      a.angle === b.angle
    );
  }
  if (a.kind === 'solid' && b.kind === 'solid') return a.hex.toLowerCase() === b.hex.toLowerCase();
  return false;
}

/** Evenly spaced ruler labels: the smallest round step giving at most ~10. */
function rulerTicks(total: number) {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  const step = steps.find((s) => total / s <= 10) ?? 3600;
  const out: number[] = [];
  for (let t = 0; t < total - step * 0.3; t += step) out.push(t);
  return out;
}

/** m:ss.t for the transport readout. */
function fmtPrecise(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function fmtTime(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Recent cursor positions (oldest→newest) over the last ~0.28s — the trail. */
function trailAt(smoothed: CursorSample[], time: number) {
  const s = new CursorSmoother();
  const moves = smoothed.filter((m) => m.kind === 'move');
  const out: { x: number; y: number }[] = [];
  const span = 0.28;
  const steps = 8;
  for (let i = steps; i >= 1; i--) {
    const p = s.positionAt(time - (span * i) / steps, moves);
    if (p) out.push(p);
  }
  return out;
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
