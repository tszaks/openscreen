import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { CursorSample, KeystrokeSample, Project } from '../../shared/types';
import { AutofocusPlanner, cameraAt, defaultAutofocus, dwellFocusEvents, type FocusSegment } from '../../shared/autofocus';
import { CursorSmoother } from '../../shared/cursor';
import { clickEvents, ripplesAt } from '../../shared/ripples';
import { Timeline } from '../../shared/timeline';
import { CanvasCompositor } from './compositor';
import { parseCaptions, toSrt } from '../../shared/captions';
import { keysAt } from '../../shared/keystrokes';
import {
  planSmartCuts,
  remapCues,
  removedRanges,
  firstKeptAtOrAfter,
  lastKeptAtOrBefore,
  type CutProposal,
} from '../../shared/editcuts';
import { suggestChapters, toChapterList } from '../../shared/chapters';
import type { TranscriptWord } from '../../shared/types';
import { Button, EmptyState, Icon, IconButton, Kbd, Section, Segmented, Slider, Switch, Tabs } from './ui';

type InspectorTab = 'background' | 'zoom' | 'cursor' | 'camera' | 'audio' | 'text';

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
}: {
  videoUrl: string;
  camUrl?: string;
  project: Project;
  cursor: CursorSample[];
  keys: KeystrokeSample[];
  bundleDir: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const camRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [proj, setProj] = useState(project);
  // Undo/redo: snapshot the previous project on every change (cap 60).
  const historyRef = useRef<{ undo: Project[]; redo: Project[] }>({ undo: [], redo: [] });
  const projRef = useRef(proj);
  const applyingHistory = useRef(false);
  useEffect(() => {
    if (applyingHistory.current) {
      applyingHistory.current = false;
    } else {
      historyRef.current.undo.push(projRef.current);
      if (historyRef.current.undo.length > 60) historyRef.current.undo.shift();
      historyRef.current.redo = [];
    }
    projRef.current = proj;
  }, [proj]);
  const [playhead, setPlayhead] = useState(0);
  const [duration, setDuration] = useState(project.recording.duration || 0);
  const [status, setStatus] = useState('');
  const [autofocusOn, setAutofocusOn] = useState(true);
  const [dwellOn, setDwellOn] = useState(true);
  const [clickSfx, setClickSfx] = useState(true);
  const [zoomDepth, setZoomDepth] = useState(2);
  const [manualSegments, setManualSegments] = useState<FocusSegment[]>([]);
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  const [motionEv, setMotionEv] = useState<CursorSample[]>([]);
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
  const [voiceCleanup, setVoiceCleanup] = useState(false);
  // UI only: inspector tab, export menu, and a mirror of the video's play state.
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('background');
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

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

  const timeline = useMemo(() => new Timeline(proj.recording.duration, proj.clips), [proj]);

  // Autosave edits into the bundle (debounced; undo/redo snapshots included).
  useEffect(() => {
    const t = setTimeout(() => {
      void api.saveProject(bundleDir, proj).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proj, bundleDir]);

  const cancelExport = useRef(false);

  const smoothed = useMemo(() => new CursorSmoother().smoothedPath(cursor), [cursor]);
  const clickEv = useMemo(() => clickEvents(cursor, timeline), [cursor, timeline]);

  const segments = useMemo<FocusSegment[]>(() => {
    const auto = autofocusOn
      ? new AutofocusPlanner({ ...defaultAutofocus, maxScale: zoomDepth }).planSegments(
          [
            ...cursor.filter((s) => s.kind === 'clickDown'),
            ...(dwellOn ? dwellFocusEvents(cursor) : []),
            ...motionEv,
          ].sort((a, b) => a.time - b.time),
          timeline.outputDuration || duration,
        )
      : [];
    return [...auto, ...manualSegments].sort((a, b) => a.inStart - b.inStart);
  }, [cursor, timeline, autofocusOn, dwellOn, duration, manualSegments, zoomDepth, motionEv]);

  const canvasSize = useMemo(() => {
    const src = proj.recording.sourceSize;
    const h =
      proj.exportPreset === 'uhd4k'
        ? 2160
        : proj.exportPreset === 'original'
          ? src.height
          : 1080;
    return { width: Math.round((h * src.width) / src.height), height: h };
  }, [proj]);

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
      const keyCaps = keysAt(time, keys);
      const cam = camRef.current;
      compositor.render(time, {
        frame: video,
        cursor: cursorPos,
        cursorTrail: proj.style.cursorTrail ? trailAt(smoothed, time) : undefined,
        keystrokes: keyCaps,
        ripples: ripplesAt(time, clickEv),
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
        ctx.drawImage(video, 0, 0, src.width, src.height, rx, ry, rw, rh);
        if (c) {
          const cx0 = rx + c.x * rw;
          const cy0 = ry + c.y * rh;
          const cx1 = rx + (c.x + c.w) * rw;
          const cy1 = ry + (c.y + c.h) * rh;
          // cut the hole back out so the selection stays bright
          ctx.clearRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
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
    [compositor, canvasSize, smoothed, clickEv, cropMode, proj],
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
    const onSeeked = () => {
      if (camRef.current) camRef.current.currentTime = video.currentTime;
      renderAt(video.currentTime);
    };
    video.addEventListener('seeked', onSeeked);
    if (!video.paused) raf = requestAnimationFrame(loop);
    const onPlay = () => {
      camRef.current?.play();
      raf = requestAnimationFrame(loop);
    };
    const onPause = () => {
      camRef.current?.pause();
      cancelAnimationFrame(raf);
    };
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
    if (e.altKey) {
      // Alt+click: add a manual zoom centered on the cursor at that time.
      const c = cursorAt(smoothed, t) ?? { x: 0.5, y: 0.5 };
      const seg: FocusSegment = {
        inStart: t,
        holdStart: t + 0.5,
        holdEnd: t + 1.4,
        outEnd: t + 2.1,
        center: { x: c.x, y: c.y },
        scale: 2,
      };
      setManualSegments((m) => [...m, seg]);
      return;
    }
    const srcT = timeline.sourceTime(t) ?? t;
    if (videoRef.current) videoRef.current.currentTime = srcT;
    if (camRef.current) camRef.current.currentTime = srcT;
    setPlayhead(t);
  };

  const exportVideo = async (wantGif = false) => {
    const video = videoRef.current;
    if (!video) return;
    setStatus('exporting…');
    const fps = proj.outputFPS;
    const total = Math.floor((timeline.outputDuration || duration) * fps);
    const { width: W, height: H } = canvasSize;
    setExporting(true);
    const outPath = `${bundleDir}/export-${Date.now()}.mp4`;
    const audioIn = `${bundleDir}/${proj.recording.screenVideoFile}`;
    // Cut timelines get filtered audio (atrim+atempo+concat); identity gets
    // passthrough. Main probes for a real audio stream either way.
    const audioClips = timeline.isIdentity
      ? undefined
      : proj.clips.map((c) => ({ start: c.sourceStart, end: c.sourceEnd, speed: c.speed }));
    await api.exportBegin(
      outPath,
      W,
      H,
      fps,
      audioIn,
      audioClips,
      clickSfx ? clickEv.map((e) => e.time) : undefined,
      voiceCleanup,
    );
    video.pause();

    cancelExport.current = false;
    let failed: unknown = null;
    try {
      for (let i = 0; i < total; i++) {
        if (cancelExport.current) break;
        const outT = i / fps;
        const srcT = timeline.sourceTime(outT);
        if (srcT === null) continue;
        await seekVideo(video, srcT);
        const cam = camRef.current;
        if (cam) await seekVideo(cam, srcT);
        compositor.render(outT, {
          cursorTrail: proj.style.cursorTrail ? trailAt(smoothed, outT) : undefined,
          frame: video,
          cursor: cursorAt(smoothed, outT),
          keystrokes: keysAt(outT, keys),
          ripples: ripplesAt(outT, clickEv),
          cameraFrame: cam && cam.readyState >= 2 ? cam : undefined,
        });
        const ctx = compositor.canvas.getContext('2d')!;
        const rgba = ctx.getImageData(0, 0, W, H);
        await api.exportFrame(rgba.data.buffer);
        if (i % 10 === 0) {
          setStatus(`exporting ${i}/${total}`);
          await new Promise((r) => setTimeout(r, 0)); // let UI paint
        }
      }
    } catch (e) {
      failed = e;
    }
    try {
      await api.exportEnd(); // always ends the ffmpeg pipe, even on failure
    } catch {
      // ffmpeg already exited or never started — nothing to end
    }
    setExporting(false);
    if (failed !== null) {
      setStatus(`export failed: ${failed instanceof Error ? failed.message : String(failed)}`);
      return;
    }
    if (cancelExport.current) {
      setStatus('export cancelled');
      return;
    }
    if (proj.captions.length) {
      const srtPath = outPath.replace(/\.mp4$/, '.srt');
      await api.writeText(srtPath, toSrt(proj.captions));
    }
    if (proj.chapters.length) {
      const chPath = outPath.replace(/\.mp4$/, '.chapters.txt');
      await api.writeText(chPath, toChapterList(proj.chapters) + '\n');
    }
    if (wantGif) {
      const gifPath = outPath.replace(/\.mp4$/, '.gif');
      setStatus('converting gif…');
      await api.exportGif(outPath, gifPath);
      setStatus(`exported → ${outPath} + gif`);
    } else {
      setStatus(`exported → ${outPath}`);
    }
    setExporting(false);
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

  const splitAtPlayhead = () => {
    const tl = new Timeline(proj.recording.duration, proj.clips.map((c) => ({ ...c })));
    if (!tl.split(playhead)) {
      setStatus('cannot split here');
      return;
    }
    setProj((p) => ({ ...p, clips: tl.clips }));
  };

  const deleteSelectedClip = () => {
    if (!selectedClip || proj.clips.length <= 1) return;
    setProj((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== selectedClip) }));
    setSelectedClip(null);
  };

  const trimClip = (edge: 'start' | 'end') => {
    if (!selectedClip) return;
    const src = timeline.sourceTime(playhead);
    if (src === null) {
      setStatus('playhead is outside a kept clip');
      return;
    }
    setProj((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id !== selectedClip) return c;
        if (edge === 'start' && src > c.sourceStart && src < c.sourceEnd) {
          return { ...c, sourceStart: src };
        }
        if (edge === 'end' && src < c.sourceEnd && src > c.sourceStart) {
          return { ...c, sourceEnd: src };
        }
        return c;
      }),
    }));
  };

  const setClipSpeed = (speed: number) => {
    if (!selectedClip) return;
    setProj((p) => ({
      ...p,
      clips: p.clips.map((c) => (c.id === selectedClip ? { ...c, speed } : c)),
    }));
  };

  const dragFrom = useRef<number | null>(null);

  /** Remove source-time ranges from the timeline; returns seconds removed.
   *  Captions/words are remapped through the cut so the transcript stays
   *  aligned to the new output timeline. */
  const cutSourceRanges = (ranges: { start: number; end: number }[]) => {
    const oldTl = new Timeline(proj.recording.duration, proj.clips.map((c) => ({ ...c })));
    const tl = new Timeline(proj.recording.duration, proj.clips.map((c) => ({ ...c })));
    const removed = tl.cutRanges(ranges);
    if (removed > 0) {
      setProj((p) => ({ ...p, clips: tl.clips, captions: remapCues(p.captions, oldTl, tl, ranges) }));
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

  const seekOutput = (outT: number) => {
    const srcT = timeline.sourceTime(outT);
    if (srcT !== null) {
      if (videoRef.current) videoRef.current.currentTime = srcT;
      if (camRef.current) camRef.current.currentTime = srcT;
    }
    setPlayhead(outT);
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
    const h = historyRef.current;
    const prev = h.undo.pop();
    if (prev) {
      h.redo.push(projRef.current);
      applyingHistory.current = true;
      setProj(prev);
    }
  };

  const redo = () => {
    const h = historyRef.current;
    const next = h.redo.pop();
    if (next) {
      h.undo.push(projRef.current);
      applyingHistory.current = true;
      setProj(next);
    }
  };

  // Keyboard shortcuts: space = play/pause, S = split, ⌘Z = undo, ⌘⇧Z = redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        videoRef.current?.paused ? videoRef.current?.play() : videoRef.current?.pause();
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

  /**
   * Frame-diff the recording for sustained local motion (taps/swipes on an
   * iPhone/iPad capture, where no cursor events exist). Sustained-motion
   * centroids become autofocus events through the same dwell pipeline.
   */
  const detectMotion = async () => {
    const video = videoRef.current;
    if (!video || !duration) return;
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
      for (let t = step; t < duration; t += step) {
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
        setStatus(`detecting motion ${Math.round((t / duration) * 100)}%`);
      }
      const ev = dwellFocusEvents(samples, { radius: 0.06, minDur: 0.6, debounce: 2 });
      setMotionEv(ev);
      setStatus(ev.length ? `${ev.length} motion focus region(s)` : 'no sustained motion detected');
    } finally {
      await seekVideo(video, origT);
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
    await api.saveProject(bundleDir, proj);
    setStatus('project saved');
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
  const bgKey = JSON.stringify(proj.style.background);
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
              className={`tile${JSON.stringify(s.bg) === bgKey ? ' selected' : ''}`}
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
              const path = await api.wallpaperPath();
              if (path) {
                setProj((p) => ({
                  ...p,
                  style: { ...p.style, background: { kind: 'imageFile', path } },
                }));
              } else setStatus('wallpaper unavailable');
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
      <Section title="Auto-focus">
        <Switch
          label="Auto-focus"
          hint="Zoom toward each click"
          checked={autofocusOn}
          onChange={setAutofocusOn}
        />
        {autofocusOn && (
          <Switch
            label="Dwell zoom"
            hint="Also zoom where the cursor lingers"
            title="Also zoom where the cursor lingers, not just clicks"
            checked={dwellOn}
            onChange={setDwellOn}
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
            onChange={setZoomDepth}
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
        onChange={setClickSfx}
      />
      <Switch
        label="Voice cleanup"
        hint="Denoise and level the voice on export, locally with ffmpeg"
        title="Denoise + level the voice track on export (highpass, afftdn, compressor, limiter — all local ffmpeg)"
        checked={voiceCleanup}
        onChange={setVoiceCleanup}
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
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      {camUrl && <video ref={camRef} src={camUrl} className="hidden" preload="auto" muted />}

      <header className="topbar ed-top">
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
              style={{ cursor: cropMode ? 'crosshair' : undefined }}
              onMouseDown={onCanvasDown}
              onMouseMove={onCanvasMove}
              onMouseUp={onCanvasUp}
              onMouseLeave={onCanvasUp}
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
              onClick={() => {
                setCropMode((c) => !c);
                if (!cropMode) renderAt(videoRef.current?.currentTime ?? 0);
              }}
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
        <div className="timeline" onClick={seekTimeline}>
          <canvas ref={waveRef} className="wave" />
          <div
            className="playhead"
            style={{ left: `${(playhead / (timeline.outputDuration || duration || 1)) * 100}%` }}
          />
          {clipBlocks.map((b) => (
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
                setProj((p) => ({ ...p, clips: tl.clips }));
              }}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedClip(b.id);
              }}
              style={{
                left: `${(b.start / (timeline.outputDuration || duration || 1)) * 100}%`,
                width: `${((b.end - b.start) / (timeline.outputDuration || duration || 1)) * 100}%`,
              }}
            />
          ))}
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
          {zoomMarks.map((s, i) => (
            <div
              key={i}
              className="zoommark"
              title="Zoom (right-click to remove)"
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setManualSegments((m) => m.filter((x) => x !== s));
              }}
              style={{ left: `${(s.inStart / (timeline.outputDuration || duration || 1)) * 100}%` }}
            />
          ))}
        </div>
      </footer>
    </div>
  );
}

const FILLER = /^[\s.,!?]*(?:um+|uh+|er+|eh+|ah+|hmm+|mm+|mhm)[\s.,!?]*$/i;

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
