import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { normalizeProject, type AudioSettings, type Clip, type CursorSample, type KeystrokeSample, type Project, type Size, type ZoomSettings } from '../../shared/types';
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
import { SaveTracker, isTextEntry } from '../../shared/editorSession';
import { exportCanvasSize, ipcErrorMessage } from '../../shared/exportArgs';
import { getPreset, type ExportPreset, type PresetId } from '../../shared/exportPresets';
import {
  ENCODE_WEIGHT,
  batchUnits,
  croppedSource,
  layoutPresetOf,
  outputBase,
  outputFiles,
  planRenders,
  presetChoices,
  presetUsesZoom,
  presetWarnings,
  projectForPreset,
  shortName,
} from '../../shared/exportJobs';
import { ExportProgress, type ExportProgressState } from './components/ExportProgress';
import { ExportPanel, ExportTasks, type TaskRowState } from './components/ExportPanel';
import { Button, EmptyState, Icon, IconButton, Kbd, Section, Segmented, Slider, Switch, Tabs } from './ui';

type InspectorTab = 'background' | 'zoom' | 'cursor' | 'camera' | 'audio' | 'text';

/** The export shown in the progress overlay: one file, or a batch of formats. */
interface ExportRun {
  kind: 'single' | 'batch';
  state: ExportProgressState;
  startedAt: number;
  /** Progress units: frames, plus weighted encode work for preset transcodes. */
  done: number;
  total: number;
  detail?: string;
  message?: string;
  /** Single: the file Show in Finder reveals. */
  reveal?: string;
  retry: () => void;
  /** Batch only. */
  rows?: TaskRowState[];
  folder?: string;
}

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
  // The export overlay, and whoever is listening for transcode progress.
  const [xp, setXp] = useState<ExportRun | null>(null);
  const transcodeProgress = useRef<((e: { presetId: PresetId; fraction: number }) => void) | null>(null);
  useEffect(() => api.onTranscodeProgress((e) => transcodeProgress.current?.(e)), []);
  // Formats ticked in the Export menu (null until the user changes the default).
  const [formatPick, setFormatPick] = useState<PresetId[] | null>(null);
  const [recordingHasAudio, setRecordingHasAudio] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let dead = false;
    api.exportHasAudio(`${bundleDir}/${proj.recording.screenVideoFile}`).then(
      (has) => !dead && setRecordingHasAudio(has),
      () => {},
    );
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleDir]);

  const smoothed = useMemo(() => new CursorSmoother().smoothedPath(cursor), [cursor]);
  const clickEv = useMemo(() => clickEvents(cursor, timeline), [cursor, timeline]);

  const segments = useMemo<FocusSegment[]>(() => {
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
    return [...auto, ...manualSegments].sort((a, b) => a.inStart - b.inStart);
  }, [cursor, timeline, autofocusOn, dwellOn, duration, manualSegments, zoomDepth, motionEv]);

  const canvasSize = useMemo(
    () => exportCanvasSize(proj.recording.sourceSize, proj.exportPreset),
    [proj],
  );

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

  const onCanvasDown = (e: React.MouseEvent) => {
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
    [compositor, canvasSize, smoothed, keys, clickEv, cropMode, proj],
  );

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

  /** Render every output frame through `comp` and pipe it into ffmpeg at
   *  `outPath` (a finished mp4, or a master .mov for preset transcodes).
   *  Resolves false when cancelled; throws with ffmpeg's reason on failure. */
  const renderFrames = async (
    comp: CanvasCompositor,
    outPath: string,
    fps: number,
    master: boolean,
    onFrame: (i: number, total: number) => void,
  ): Promise<boolean> => {
    const video = videoRef.current;
    if (!video) throw new Error('the recording is not loaded');
    const total = Math.floor((timeline.outputDuration || duration) * fps);
    const { width: W, height: H } = comp.canvasSize;
    const audioIn = `${bundleDir}/${proj.recording.screenVideoFile}`;
    // Cut timelines get filtered audio (atrim+atempo+concat); identity uses
    // the track as is. Main probes for a real audio stream either way.
    const audioClips = timeline.isIdentity
      ? undefined
      : proj.clips.map((c) => ({ start: c.sourceStart, end: c.sourceEnd, speed: c.speed }));
    let encoding = false; // ffmpeg is running and owns a partial file
    try {
      await api.exportBegin(
        outPath,
        W,
        H,
        fps,
        audioIn,
        audioClips,
        clickSfx ? clickEv.map((e) => e.time) : undefined,
        voiceCleanup,
        total / fps,
        master,
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
        comp.render(outT, {
          cursorTrail: proj.style.cursorTrail ? trailAt(smoothed, srcT) : undefined,
          frame: video,
          cursor: cursorAt(smoothed, srcT),
          keystrokes: keysAt(srcT, keys),
          ripples: ripplesAt(outT, clickEv),
          cameraFrame: cam && cam.readyState >= 2 ? cam : undefined,
        });
        const ctx = comp.canvas.getContext('2d')!;
        const rgba = ctx.getImageData(0, 0, W, H);
        await api.exportFrame(rgba.data.buffer); // rejects once ffmpeg has stopped
        if (i % 10 === 0) {
          onFrame(i, total);
          await new Promise((r) => setTimeout(r, 0)); // let UI paint
        }
      }
      if (cancelExport.current) {
        encoding = false;
        await api.exportAbort();
        return false;
      }
      encoding = false; // end() cleans up after itself on failure
      await api.exportEnd();
      onFrame(total, total);
      return true;
    } catch (e) {
      if (encoding) await api.exportAbort().catch(() => {});
      throw e;
    }
  };

  /** A multi-format pass's compositor: the pass's own canvas (several presets
   *  can't share the editor's single canvas), the preset's layout, and the
   *  editor's zooms only where the preset keeps them. */
  const presetCompositor = (preset: ExportPreset, size: Size = preset) =>
    new CanvasCompositor(
      projectForPreset(proj, preset),
      { width: size.width, height: size.height },
      presetUsesZoom(preset) ? segments : [],
    );

  const writeSidecars = async (basePath: string) => {
    if (proj.captions.length) await api.writeText(`${basePath}.srt`, toSrt(proj.captions));
    if (proj.chapters.length) await api.writeText(`${basePath}.chapters.txt`, toChapterList(proj.chapters) + '\n');
  };

  /** This project's export: MP4 or GIF, drawn with the project's layout preset
   *  when one is set (and then encoded to that preset's spec), otherwise at
   *  the Resolution and Frame rate picked in the Export menu. */
  const exportVideo = async (wantGif = false) => {
    const video = videoRef.current;
    if (!video || exporting) return;
    setExportMenuOpen(false);
    const outPath = await api.exportPickPath(bundleDir, wantGif ? 'gif' : 'mp4');
    if (!outPath) return;
    const preset = layoutPresetOf(proj);
    // A GIF is converted from an intermediate mp4 in the bundle.
    const mp4Path = wantGif ? `${bundleDir}/export-${Date.now()}.mp4` : outPath;
    const fps = preset ? preset.fps : proj.outputFPS;
    // The editor's compositor is already sized and laid out for the project's
    // preset (projectCanvasSize), so this export draws exactly the preview.
    const comp = compositor;
    // A preset MP4 renders a master, then encodes it with the preset's settings.
    const transcode = preset !== null && !wantGif;
    const frames = Math.floor((timeline.outputDuration || duration) * fps);
    const total = frames + (transcode ? frames * ENCODE_WEIGHT : 0);
    const basePath = outPath.replace(/\.[^./]*$/, '');
    const count = new Intl.NumberFormat('en-US');
    const rendering = (i: number) => (transcode ? `Rendering ${count.format(i)} of ${count.format(frames)} frames` : undefined);
    const startedAt = Date.now();
    let phase = 'rendering';
    setXp({ kind: 'single', state: 'running', startedAt, done: 0, total, detail: rendering(0), retry: () => void exportVideo(wantGif) });
    setExporting(true);
    setStatus('');
    cancelExport.current = false;
    let master: string | null = null;
    try {
      if (transcode) master = await api.exportMasterPath(preset.id);
      const ok = await renderFrames(comp, master ?? mp4Path, fps, transcode, (i) =>
        setXp((x) => x && { ...x, done: i, detail: rendering(i) }),
      );
      if (!ok) {
        setXp(null);
        setStatus('export cancelled');
        return;
      }
      let reveal = outPath;
      if (transcode && master) {
        phase = 'encoding';
        setXp((x) => x && { ...x, done: frames, detail: `Encoding for ${preset.label}` });
        transcodeProgress.current = ({ fraction }) =>
          setXp((x) => x && { ...x, done: frames + fraction * frames * ENCODE_WEIGHT });
        const files = await api.exportTranscode(preset.id, master, basePath, frames / fps);
        reveal = files[0] ?? outPath;
      }
      await writeSidecars(basePath);
      if (wantGif) {
        phase = 'converting to GIF';
        setXp((x) => x && { ...x, detail: 'Converting to GIF' });
        await api.exportGif(mp4Path, outPath);
      }
      setXp((x) => x && { ...x, state: 'done', done: total, message: reveal.split('/').pop(), reveal });
    } catch (e) {
      if (cancelExport.current) {
        setXp(null);
        setStatus('export cancelled');
      } else {
        const message = ipcErrorMessage(e);
        setXp((x) => x && { ...x, state: 'failed', message, detail: transcode || wantGif ? `Stopped while ${phase}` : undefined });
      }
    } finally {
      transcodeProgress.current = null;
      if (master) void api.exportDiscardMaster(master);
      setExporting(false);
    }
  };

  /**
   * Export several presets into one folder. Presets that draw the same
   * picture share one rendered master (planRenders); each preset is then
   * encoded from it with its own settings, one at a time. Cancel stops the
   * running step and skips the rest; finished files are kept.
   */
  const exportFormats = async (ids: PresetId[], folderIn?: string, prevRows?: TaskRowState[]) => {
    if (!videoRef.current || exporting || ids.length === 0) return;
    setExportMenuOpen(false);
    const folder = folderIn ?? (await api.exportPickFolder(bundleDir));
    if (!folder) return;
    const presets = ids.map(getPreset);
    const passes = planRenders(presets);
    const dur = timeline.outputDuration || duration;
    const total = batchUnits(passes, dur);
    const name = bundleName;
    const fresh = (p: ExportPreset): TaskRowState => ({
      preset: p,
      status: 'queued',
      progress: 0,
      files: outputFiles(outputBase(folder, name, p), p),
    });
    let rows = prevRows ? prevRows.map((r) => (ids.includes(r.preset.id) ? fresh(r.preset) : r)) : presets.map(fresh);
    const setRow = (id: PresetId, patch: Partial<TaskRowState>) => {
      rows = rows.map((r) => (r.preset.id === id ? { ...r, ...patch } : r));
    };
    const startedAt = Date.now();
    let done = 0;
    let detail = '';
    const publish = (state: ExportProgressState = 'running', message?: string) =>
      setXp({ kind: 'batch', state, startedAt, done, total, detail, message, rows, folder, retry: () => {} });
    // Render and encode split each row's ring in proportion to their cost.
    const renderShare = 1 / (1 + ENCODE_WEIGHT);

    setExporting(true);
    setStatus('');
    cancelExport.current = false;
    publish();
    try {
      for (const pass of passes) {
        if (cancelExport.current) break;
        const frames = Math.floor(dur * pass.fps);
        const passStart = done;
        const comp = presetCompositor(getPreset(pass.layoutPreset), pass);
        for (const id of pass.presetIds) setRow(id, { status: 'rendering', progress: 0 });
        detail = `Rendering ${pass.presetIds.map(shortName).join(' and ')}`;
        publish();
        let master: string | null = null;
        try {
          master = await api.exportMasterPath(pass.key);
          const ok = await renderFrames(comp, master, pass.fps, true, (i) => {
            done = passStart + i;
            for (const id of pass.presetIds) setRow(id, { progress: (i / Math.max(1, frames)) * renderShare });
            publish();
          });
          if (!ok) break;
          for (const id of pass.presetIds) {
            if (cancelExport.current) break;
            const encStart = done;
            setRow(id, { status: 'encoding', progress: renderShare });
            detail = `Encoding ${shortName(id)}`;
            publish();
            transcodeProgress.current = (e) => {
              if (e.presetId !== id) return;
              done = encStart + e.fraction * frames * ENCODE_WEIGHT;
              setRow(id, { progress: renderShare + (1 - renderShare) * e.fraction });
              publish();
            };
            try {
              const files = await api.exportTranscode(id, master, outputBase(folder, name, getPreset(id)), frames / pass.fps);
              setRow(id, { status: 'done', progress: 1, files });
            } catch (e) {
              if (cancelExport.current) break;
              setRow(id, { status: 'failed', error: ipcErrorMessage(e) });
            }
            done = encStart + frames * ENCODE_WEIGHT;
            publish();
          }
        } catch (e) {
          if (cancelExport.current) break;
          for (const id of pass.presetIds) setRow(id, { status: 'failed', error: ipcErrorMessage(e) });
          done = passStart + frames * (1 + ENCODE_WEIGHT * pass.presetIds.length);
          publish();
        } finally {
          transcodeProgress.current = null;
          if (master) void api.exportDiscardMaster(master);
        }
      }
      const mine = () => rows.filter((r) => ids.includes(r.preset.id));
      const saved = mine().filter((r) => r.status === 'done').length;
      if (saved > 0) await writeSidecars(`${folder}/${name}`).catch(() => {});
      if (cancelExport.current) {
        for (const r of mine()) {
          if (r.status === 'rendering' || r.status === 'encoding') setRow(r.preset.id, { status: 'cancelled' });
          else if (r.status === 'queued') setRow(r.preset.id, { status: 'skipped' });
        }
        detail = `${saved} of ${ids.length} formats finished`;
        publish('failed', 'Export cancelled. Finished formats were kept.');
      } else if (saved < ids.length) {
        const failed = ids.length - saved;
        detail = `${saved} of ${ids.length} formats saved`;
        publish('failed', `${failed} format${failed === 1 ? '' : 's'} failed. Retry runs just ${failed === 1 ? 'that one' : 'those'}.`);
      } else {
        detail = '';
        publish('done', `${ids.length} format${ids.length === 1 ? '' : 's'} saved to ${folder.split('/').pop()}`);
      }
    } finally {
      transcodeProgress.current = null;
      setExporting(false);
    }
  };

  const cancelRunningExport = () => {
    cancelExport.current = true;
    void api.exportAbort(); // stops an encode right away; the frame loop checks the flag
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
      // ⌘Z / ⇧⌘Z come from the app menu (Edit > Undo/Redo) so one press is one undo.
      // ⌘S, ⌘⌫ and friends belong to the menu, not to split and delete.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 's' || e.key === 'S') {
        splitAtPlayhead();
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (editTranscript && wordSel) {
          e.preventDefault();
          cutSelectedWords();
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
   * Frame-diff the recording for sustained local motion (taps/swipes on an
   * iPhone/iPad capture, where no cursor events exist). Sustained-motion
   * centroids become autofocus events through the same dwell pipeline.
   */
  const detectMotion = async () => {
    const video = videoRef.current;
    // WebM from MediaRecorder can report an Infinity duration; never loop on it.
    const total = mediaDuration(duration, proj.recording.duration);
    if (!video || !total) return;
    const origT = video.currentTime;
    video.pause();
    setStatus('detecting motion…');
    try {
      const src = proj.recording.sourceSize;
      const W2 = 192;
      const H2 = Math.max(8, Math.round((W2 * src.height) / src.width));
      const det = document.createElement('canvas');
      det.width = W2;
      det.height = H2;
      const dctx = det.getContext('2d', { willReadFrequently: true })!;
      const samples: CursorSample[] = [];
      let prev: ImageData | null = null;
      const step = 0.4;
      const area = W2 * H2;
      for (let t = step; t < total; t += step) {
        if (disposed.current) return;
        await seekVideo(video, t);
        dctx.drawImage(video, 0, 0, W2, H2);
        const img = dctx.getImageData(0, 0, W2, H2);
        if (prev) {
          const d = img.data;
          const p = prev.data;
          let sx = 0;
          let sy = 0;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) {
            const diff =
              Math.abs(d[i] - p[i]) + Math.abs(d[i + 1] - p[i + 1]) + Math.abs(d[i + 2] - p[i + 2]);
            if (diff > 90) {
              sx += i / 4 % W2;
              sy += Math.floor(i / 4 / W2);
              n++;
            }
          }
          // Sustained local motion only — ignore noise and whole-frame changes
          // (scrolls, transitions) which would yank the zoom around.
          if (n > area * 0.003 && n < area * 0.35) {
            samples.push({ time: t - step / 2, x: sx / n / W2, y: sy / n / H2, kind: 'move' });
          }
        }
        prev = img;
        setStatus(`detecting motion ${Math.round((t / total) * 100)}%`);
      }
      const ev = dwellFocusEvents(samples, { radius: 0.06, minDur: 0.6, debounce: 2 });
      setZoom({ motionEvents: ev });
      setStatus(ev.length ? `${ev.length} motion focus region(s)` : 'no sustained motion detected');
    } finally {
      if (!disposed.current) await seekVideo(video, origT);
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
  const formatChoices = presetChoices(proj.recording.sourceSize);
  const selectedFormats =
    formatPick ?? [formatChoices[0].id, 'social-9x16' as const].filter((id) => formatChoices.some((p) => p.id === id));
  const layoutPreset = layoutPresetOf(proj);
  const audibleExport = recordingHasAudio === undefined ? undefined : recordingHasAudio || (clickSfx && clickEv.length > 0);
  const formatWarnings = Object.fromEntries(
    [...formatChoices, ...(layoutPreset ? [layoutPreset] : [])].map((p) => [
      p.id,
      presetWarnings(p, { duration: outDur, source: croppedSource(proj), hasAudio: audibleExport }),
    ]),
  );
  const selectedSpeed = proj.clips.find((c) => c.id === selectedClip)?.speed ?? 1;
  const togglePlay = () =>
    videoRef.current?.paused ? videoRef.current?.play() : videoRef.current?.pause();

  const inspectorTabs = [
    { value: 'background' as const, label: 'Background' },
    { value: 'zoom' as const, label: 'Zoom' },
    { value: 'cursor' as const, label: 'Cursor' },
    ...(camUrl ? [{ value: 'camera' as const, label: 'Camera' }] : []),
    { value: 'audio' as const, label: 'Audio' },
    { value: 'text' as const, label: 'Text' },
  ];
  const activeTab: InspectorTab = !camUrl && inspectorTab === 'camera' ? 'background' : inspectorTab;

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
      <Section title="Backdrop">
        <div className="tiles">
          {SWATCHES.map((s) => (
            <button
              key={s.name}
              type="button"
              title={s.name}
              className={`tile${sameBackground(s.bg, proj.style.background) ? ' selected' : ''}`}
              onClick={() =>
                setProj((p) => ({ ...p, style: { ...p.style, background: s.bg } }))
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
              }));
            }}
          >
            <span className="tile-swatch tile-text">Desktop</span>
            <span className="tile-label">Wallpaper</span>
          </button>
        </div>
        {proj.style.background.kind === 'imageFile' && (
          <Slider
            label="Image blur"
            min={0}
            max={60}
            step={1}
            value={proj.style.background.blur ?? 0}
            format={(v) => `${v}px`}
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
      <Section title="Frame">
        {(
          [
            ['Padding', 'paddingFraction', 0, 0.4, 0.01, (v: number) => `${Math.round(v * 100)}%`],
            ['Corner radius', 'cornerRadius', 0, 120, 1, (v: number) => `${v}px`],
            ['Shadow', 'shadowRadius', 0, 200, 1, (v: number) => `${v}px`],
            ['Shadow opacity', 'shadowOpacity', 0, 1, 0.01, (v: number) => `${Math.round(v * 100)}%`],
          ] as const
        ).map(([label, key, min, max, step, format]) => (
          <Slider
            key={key}
            label={label}
            title={key}
            min={min}
            max={max}
            step={step}
            value={proj.style[key]}
            format={format}
            onChange={(v) => setProj((p) => ({ ...p, style: { ...p.style, [key]: v } }))}
          />
        ))}
        {proj.recording.sourceKind === 'iosDevice' && (
          <Switch
            label="Phone frame"
            hint="Wrap the frame in iPhone hardware"
            title="Wrap the frame in iPhone hardware chrome"
            checked={proj.style.deviceFrame === 'phone'}
            onChange={(v) =>
              setProj((p) => ({
                ...p,
                style: { ...p.style, deviceFrame: v ? 'phone' : 'none' },
              }))
            }
          />
        )}
      </Section>
    </>
  );

  const zoomPanel = (
    <>
      <Section title="Automatic">
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
        {autofocusOn && (
          <Slider
            label="Zoom depth"
            title="Max zoom on click"
            min={1.2}
            max={4}
            step={0.1}
            value={zoomDepth}
            format={(v) => `${v.toFixed(1)}×`}
            onChange={(v) => setZoom({ depth: v })}
          />
        )}
        {autofocusOn && (
          <div className="row">
            <span className="row-text">
              <span className="row-label">Touches</span>
              <span className="row-hint">iPhone and iPad captures have no cursor track</span>
            </span>
            <Button
              size="sm"
              onClick={detectMotion}
              title="Frame-diff the video for taps/swipes (iPhone/iPad captures have no cursor track)"
            >
              Detect touches
            </Button>
          </div>
        )}
      </Section>
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
      <Slider
        label="Size"
        title="Software cursor size (fraction of frame height)"
        min={0.005}
        max={0.03}
        step={0.001}
        value={proj.style.cursorSize}
        format={(v) => (v * 1000).toFixed(0)}
        onChange={(v) => setProj((p) => ({ ...p, style: { ...p.style, cursorSize: v } }))}
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
        {status && !xp && (
          <div className="status-pill no-drag" title={status}>
            <span className="status-text tnum">{status}</span>
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
            <ExportPanel
              layoutPreset={layoutPreset}
              singleSettings={
                <>
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
                </>
              }
              choices={formatChoices}
              selected={selectedFormats}
              warnings={formatWarnings}
              disabled={exporting}
              onToggle={(id, on) =>
                setFormatPick(
                  formatChoices
                    .map((p) => p.id)
                    .filter((x) => (x === id ? on : selectedFormats.includes(x))),
                )
              }
              onExportSingle={(gif) => void exportVideo(gif)}
              onExportFormats={() => void exportFormats(selectedFormats)}
            />
          )}
        </div>
      </header>

      <main className="ed-stage">
        <div className="stage-canvas">
          <div className="stage-inner">
            <canvas
              ref={canvasRef}
              className={`preview${cropMode ? ' cropping' : ''}`}
              style={{ cursor: cropMode ? 'crosshair' : undefined }}
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
        </div>
      </main>

      <aside className="inspector">
        <Tabs value={activeTab} tabs={inspectorTabs} onChange={setInspectorTab} />
        <div className="inspector-body" key={activeTab}>
          {activeTab === 'background' && backgroundPanel}
          {activeTab === 'zoom' && zoomPanel}
          {activeTab === 'cursor' && cursorPanel}
          {activeTab === 'camera' && cameraPanel}
          {activeTab === 'audio' && audioPanel}
          {activeTab === 'text' && textPanel}
        </div>
      </aside>

      <footer className="ed-timeline">
        <div className="tl-labels" aria-hidden="true">
          <span />
          <span>Clips</span>
          <span>Zoom</span>
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

      {xp && (
        <div className="xp-overlay no-drag">
          {xp.kind === 'batch' && xp.rows ? (
            <ExportTasks
              rows={xp.rows}
              progress={{
                state: xp.state,
                done: xp.done,
                total: xp.total,
                startedAt: xp.startedAt,
                message: xp.message,
                detail: xp.detail,
                onCancel: cancelRunningExport,
                onClose: () => setXp(null),
              }}
              onReveal={(path) => void api.exportReveal(path)}
              onRetry={(ids) => void exportFormats(ids, xp.folder, xp.rows)}
            />
          ) : (
            <ExportProgress
              state={xp.state}
              done={xp.done}
              total={xp.total}
              startedAt={xp.startedAt}
              message={xp.message}
              detail={xp.detail}
              onCancel={cancelRunningExport}
              onReveal={() => xp.reveal && void api.exportReveal(xp.reveal)}
              onRetry={xp.retry}
              onClose={() => setXp(null)}
            />
          )}
        </div>
      )}

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
