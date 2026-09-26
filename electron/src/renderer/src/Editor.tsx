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
import type { TranscriptWord } from '../../shared/types';

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
    );
    video.pause();

    cancelExport.current = false;
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
    await api.exportEnd();
    setExporting(false);
    if (cancelExport.current) {
      setStatus('export cancelled');
      return;
    }
    if (proj.captions.length) {
      const srtPath = outPath.replace(/\.mp4$/, '.srt');
      await api.writeText(srtPath, toSrt(proj.captions));
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

  // Keyboard shortcuts: space = play/pause, S = split, ⌘Z = undo, ⌘⇧Z = redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const h = historyRef.current;
        if (e.shiftKey) {
          const next = h.redo.pop();
          if (next) {
            h.undo.push(projRef.current);
            applyingHistory.current = true;
            setProj(next);
          }
        } else {
          const prev = h.undo.pop();
          if (prev) {
            h.redo.push(projRef.current);
            applyingHistory.current = true;
            setProj(prev);
          }
        }
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

  const zoomMarks = segments;

  return (
    <div className="editor">
      <div className="ed-main">
      <video
        ref={videoRef}
        src={videoUrl}
        className="hidden"
        preload="auto"
        muted={exporting}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />
      {camUrl && <video ref={camRef} src={camUrl} className="hidden" preload="auto" muted />}
      <div className="preview-wrap">
        <canvas
          ref={canvasRef}
          className="preview"
          style={{ cursor: cropMode ? 'crosshair' : undefined }}
          onMouseDown={onCanvasDown}
          onMouseMove={onCanvasMove}
          onMouseUp={onCanvasUp}
          onMouseLeave={onCanvasUp}
        />
      </div>
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
      <div className="panel">
        <label>
          <input
            type="checkbox"
            checked={autofocusOn}
            onChange={(e) => setAutofocusOn(e.target.checked)}
          />
          Auto-focus
        </label>
        {autofocusOn && (
          <label title="Also zoom where the cursor lingers, not just clicks">
            <input
              type="checkbox"
              checked={dwellOn}
              onChange={(e) => setDwellOn(e.target.checked)}
            />
            Dwell zoom
          </label>
        )}
        <label title="Mix a click sound at each click">
          <input
            type="checkbox"
            checked={clickSfx}
            onChange={(e) => setClickSfx(e.target.checked)}
          />
          Click sfx
        </label>
        {autofocusOn && (
          <button onClick={detectMotion} title="Frame-diff the video for taps/swipes (iPhone/iPad captures have no cursor track)">
            Detect touches
          </button>
        )}
        {autofocusOn && (
          <label title="Max zoom on click">
            Zoom {zoomDepth.toFixed(1)}×
            <input
              type="range"
              min={1.2}
              max={4}
              step={0.1}
              value={zoomDepth}
              onChange={(e) => setZoomDepth(+e.target.value)}
            />
          </label>
        )}
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
          <button
            title="Custom background image"
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
            Img…
          </button>
          <button
            title="Use desktop wallpaper"
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
            Wall
          </button>
        </div>
        {proj.style.background.kind === 'imageFile' && (
          <label>
            Blur {proj.style.background.blur ?? 0}px
            <input
              type="range"
              min={0}
              max={60}
              step={1}
              value={proj.style.background.blur ?? 0}
              onChange={(e) =>
                setProj((p) => ({
                  ...p,
                  style: {
                    ...p.style,
                    background: { kind: 'imageFile', path: p.style.background.kind === 'imageFile' ? p.style.background.path : '', blur: +e.target.value },
                  },
                }))
              }
            />
          </label>
        )}
        {proj.recording.sourceKind === 'iosDevice' && (
          <label title="Wrap the frame in iPhone hardware chrome">
            Phone frame
            <input
              type="checkbox"
              checked={proj.style.deviceFrame === 'phone'}
              onChange={(e) =>
                setProj((p) => ({
                  ...p,
                  style: { ...p.style, deviceFrame: e.target.checked ? 'phone' : 'none' },
                }))
              }
            />
          </label>
        )}
        <label title="Add a text overlay at the playhead">
          <button
            onClick={() =>
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
            }
          >
            + Text
          </button>
        </label>
        {camUrl && (
          <div className="sliders">
            <label>
              Camera
              <input
                type="checkbox"
                checked={proj.cameraOverlay.enabled}
                onChange={(e) =>
                  setProj((p) => ({
                    ...p,
                    cameraOverlay: { ...p.cameraOverlay, enabled: e.target.checked },
                  }))
                }
              />
            </label>
            <label>
              Corner
              <select
                value={proj.cameraOverlay.corner}
                onChange={(e) =>
                  setProj((p) => ({
                    ...p,
                    cameraOverlay: {
                      ...p.cameraOverlay,
                      corner: e.target.value as typeof p.cameraOverlay.corner,
                    },
                  }))
                }
              >
                {(['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Circle
              <input
                type="checkbox"
                checked={proj.cameraOverlay.circular}
                onChange={(e) =>
                  setProj((p) => ({
                    ...p,
                    cameraOverlay: { ...p.cameraOverlay, circular: e.target.checked },
                  }))
                }
              />
            </label>
          </div>
        )}
        <div className="sliders">
          {(
            [
              ['Padding', 'paddingFraction', 0, 0.4, 0.01],
              ['Corner', 'cornerRadius', 0, 120, 1],
              ['Shadow', 'shadowRadius', 0, 200, 1],
              ['Shadow α', 'shadowOpacity', 0, 1, 0.01],
            ] as const
          ).map(([label, key, min, max, step]) => (
            <label key={key} title={key}>
              {label}
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={proj.style[key]}
                onChange={(e) =>
                  setProj((p) => ({ ...p, style: { ...p.style, [key]: +e.target.value } }))
                }
              />
            </label>
          ))}
        </div>
        <div className="sliders">
          <label title="Software cursor size (fraction of frame height)">
            Cursor {(proj.style.cursorSize * 1000).toFixed(0)}
            <input
              type="range"
              min={0.005}
              max={0.03}
              step={0.001}
              value={proj.style.cursorSize}
              onChange={(e) =>
                setProj((p) => ({ ...p, style: { ...p.style, cursorSize: +e.target.value } }))
              }
            />
          </label>
          <label title="Smear the cursor along its recent path">
            <input
              type="checkbox"
              checked={proj.style.cursorTrail}
              onChange={(e) =>
                setProj((p) => ({ ...p, style: { ...p.style, cursorTrail: e.target.checked } }))
              }
            />
            Trail
          </label>
          <label title="Cursor color">
            <input
              type="color"
              value={proj.style.cursorHex}
              onChange={(e) =>
                setProj((p) => ({ ...p, style: { ...p.style, cursorHex: e.target.value } }))
              }
            />
          </label>
        </div>
        <button onClick={() => videoRef.current?.paused ? videoRef.current?.play() : videoRef.current?.pause()}>
          Play/Pause
        </button>
        <button
          onClick={() => {
            setCropMode((c) => !c);
            if (!cropMode) renderAt(videoRef.current?.currentTime ?? 0);
          }}
        >
          {cropMode ? 'Dragging…' : 'Crop'}
        </button>
        {proj.style.cropRect && !cropMode && (
          <button
            onClick={() => setProj((p) => ({ ...p, style: { ...p.style, cropRect: null } }))}
          >
            Reset crop
          </button>
        )}
        <button onClick={splitAtPlayhead}>Split</button>
        <button onClick={deleteSelectedClip} disabled={!selectedClip || proj.clips.length <= 1}>
          Delete clip
        </button>
        {selectedClip && (
          <>
            <button onClick={() => trimClip('start')} title="Trim clip start to playhead">
              ⟦Trim
            </button>
            <button onClick={() => trimClip('end')} title="Trim clip end to playhead">
              Trim⟧
            </button>
          </>
        )}
        {selectedClip && (
          <label>
            Speed
            <select
              value={proj.clips.find((c) => c.id === selectedClip)?.speed ?? 1}
              onChange={(e) => setClipSpeed(+e.target.value)}
            >
              {[0.5, 0.75, 1, 1.5, 2, 4].map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
          </label>
        )}
        <button onClick={transcribe} title="Auto-transcribe via whisper">
          Transcribe
        </button>
        <button
          onClick={smartCut}
          title="Detect silences + filler words and preview the cuts before applying"
        >
          Smart cut
        </button>
        <label style={{ cursor: 'pointer' }}>
          Captions…
          <input
            type="file"
            accept=".srt,.vtt"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && importCaptions(e.target.files[0])}
          />
        </label>
        <button onClick={saveProject}>Save project</button>
        <label>
          Res
          <select
            value={proj.exportPreset}
            onChange={(e) =>
              setProj((p) => ({ ...p, exportPreset: e.target.value as typeof p.exportPreset }))
            }
          >
            <option value="original">Original</option>
            <option value="p1080">1080p</option>
            <option value="uhd4k">4K</option>
          </select>
        </label>
        <label>
          FPS
          <select
            value={proj.outputFPS}
            onChange={(e) => setProj((p) => ({ ...p, outputFPS: +e.target.value }))}
          >
            {[24, 30, 60].map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" onClick={() => exportVideo()}>Export MP4</button>
        <button onClick={() => exportVideo(true)}>Export GIF</button>
        {exporting && <button onClick={() => { cancelExport.current = true; }}>Cancel</button>}
        <span className="status">{status}</span>
      </div>
      </div>
      {smartCuts && (
        <div className="transcript smartcuts">
          <h3>
            Smart cut — {smartCuts.filter((p) => p.on).length}/{smartCuts.length} selected
          </h3>
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
                  checked={p.on}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() =>
                    setSmartCuts((s) =>
                      s ? s.map((x, xi) => (xi === i ? { ...x, on: !x.on } : x)) : s,
                    )
                  }
                />
                <span className="t">{r ? fmtTime(r.start) : '—'}</span>
                <span className={p.kind}>
                  {p.kind === 'silence' ? 'silence' : 'filler'} {p.label}
                </span>
              </div>
            );
          })}
          <div className="sc-actions">
            <button className="primary" onClick={applySmartCuts}>
              Apply cuts
            </button>
            <button onClick={() => setSmartCuts(null)}>Dismiss</button>
          </div>
        </div>
      )}
      {(proj.captions.length > 0 || proj.annotations.length > 0) && (
        <div className="transcript">
          {proj.annotations.length > 0 && (
            <>
              <h3>Text</h3>
              {proj.annotations.map((a) => (
                <div className="cue" key={a.id}>
                  <input
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
                  <span
                    className="x"
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
                    {a.band === 0 ? '⤒' : a.band === 1 ? '↕' : '⤓'}
                  </span>
                  <span
                    className="x"
                    title="Delete"
                    onClick={() =>
                      setProj((p) => ({
                        ...p,
                        annotations: p.annotations.filter((x) => x.id !== a.id),
                      }))
                    }
                  >
                    ✕
                  </span>
                </div>
              ))}
            </>
          )}
          {proj.captions.length > 0 && (
            <>
              <h3>
                Transcript
                <button
                  className={`mini${editTranscript ? ' on' : ''}`}
                  title="Edit mode: click a word, shift-click to extend, then delete to cut that span"
                  onClick={() => {
                    setEditTranscript((v) => !v);
                    setWordSel(null);
                  }}
                >
                  Edit
                </button>
              </h3>
          {editTranscript && wordSel && (
            <button className="cutall" onClick={cutSelectedWords} title="Cut the selected words' span from the video">
              Cut selected words
            </button>
          )}
          {proj.captions.map((c) => (
            <div className="cue" key={c.id} onClick={() => !editTranscript && seekOutput(c.start)}>
              <span className="t">{fmtTime(c.start)}</span>
              {editTranscript && c.words?.length ? (
                <span className="words">
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
                <span>{c.text}</span>
              )}
              <span
                className="x"
                title="Cut this cue from the video"
                onClick={(e) => {
                  e.stopPropagation();
                  cutCue(c);
                }}
              >
                ✂
              </span>
            </div>
          ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const FILLER = /^[\s.,!?]*(?:um+|uh+|er+|eh+|ah+|hmm+|mm+|mhm)[\s.,!?]*$/i;

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
