// Phone-demo pieces of the project model, kept pure so they are tested:
// which device and canvas a project renders on, the taps track moved
// between source and output time, and the "speed up waits" clip math.
//
// Time domains: taps and waits are stored in SOURCE time (like cursor
// samples), so cutting, speeding up or reordering clips never has to rewrite
// them. They are mapped onto the output timeline for drawing, for the
// timeline lane and for tap-driven zoom.
import type { Clip, Project, Size, WaitRange } from './types';
import type { TapSuggestion } from './taps';
import { Timeline } from './timeline';
import { clipSpans } from './playback';
import { detectDevice, genericDevice, getDevice, type DeviceModel, type Orientation } from './devices';
import { appStorePresetFor, getPreset, PRESETS, type ExportPreset, type PresetId } from './exportPresets';
import { exportCanvasSize } from './exportArgs';

export const isPhoneProject = (p: Pick<Project, 'recording'>) => p.recording.sourceKind === 'iosDevice';

// ---------------------------------------------------------------------------
// Device

/** Below this, a size match is a guess; a generic frame is more honest. */
const MIN_DETECT_CONFIDENCE = 0.3;

export interface ResolvedDevice {
  device: DeviceModel;
  /** The model the recording's size points to (first in the picker). */
  detected: DeviceModel;
  /** Every model sharing the detected panel. */
  candidates: DeviceModel[];
  orientation: Orientation;
}

/** The device a project is framed with: the chosen model, else the detected one. */
export function resolveDevice(p: Pick<Project, 'recording' | 'device'>): ResolvedDevice {
  const { width, height } = p.recording.sourceSize;
  const match = detectDevice(width, height);
  const detected = match.confidence >= MIN_DETECT_CONFIDENCE ? match.device : genericDevice(width, height);
  const candidates = match.confidence >= MIN_DETECT_CONFIDENCE ? match.candidates : [detected];
  const chosen = p.device.modelId ? getDevice(p.device.modelId) : undefined;
  return { device: chosen ?? detected, detected, candidates, orientation: match.orientation };
}

// ---------------------------------------------------------------------------
// Layout

export interface LayoutChoice {
  /** Stored in project.layout.presetId ('appstore' resolves per device). */
  id: string;
  label: string;
  /** Short aspect label for the picker tile. */
  ratio: string;
}

/** The canvas picker, in display order. */
export const LAYOUT_CHOICES: LayoutChoice[] = [
  { id: 'social-9x16', label: 'Vertical', ratio: '9:16' },
  { id: 'feed-4x5', label: 'Feed', ratio: '4:5' },
  { id: 'square', label: 'Square', ratio: '1:1' },
  { id: 'landscape-16x9', label: 'Wide', ratio: '16:9' },
  { id: 'appstore', label: 'App Store', ratio: 'Preview' },
  { id: 'landing-loop', label: 'Landing', ratio: 'Loop' },
  { id: 'none', label: 'Classic', ratio: 'Padded' },
];

/**
 * The export preset a project renders on, or null for the classic padded
 * frame. 'appstore' picks the App Store size for the device family and the
 * recording's orientation.
 */
export function layoutPreset(p: Pick<Project, 'recording' | 'layout' | 'device'>): ExportPreset | null {
  const id = p.layout.presetId;
  if (!id || id === 'none') return null;
  if (id === 'appstore' || id.startsWith('appstore-')) {
    const { device, orientation } = resolveDevice(p);
    return appStorePresetFor(device.family, orientation === 'landscape');
  }
  return PRESETS.some((x) => x.id === id) ? getPreset(id as PresetId) : null;
}

/** Output canvas size: the preset's exact pixels, else the classic export size. */
export function projectCanvasSize(p: Project): Size {
  const preset = layoutPreset(p);
  return preset ? { width: preset.width, height: preset.height } : exportCanvasSize(p.recording.sourceSize, p.exportPreset);
}

/** App Store previews stay on the native UI: no frame, no zoom, no title. */
export const presetAllowsZoom = (preset: ExportPreset | null) => !preset || preset.defaults.autoZoom;

// ---------------------------------------------------------------------------
// Taps across time domains

/**
 * Taps moved onto the output timeline, sorted. A tap in removed footage is
 * dropped; a sped-up tap keeps its on-screen feel, so its hold and settle
 * scale with the clip speed.
 */
export function tapsToOutput(taps: TapSuggestion[], tl: Timeline): TapSuggestion[] {
  const out: TapSuggestion[] = [];
  for (const s of taps) {
    const t = tl.outputTime(s.t);
    if (t === null) continue;
    const speed = clipAt(tl, s.t)?.speed ?? 1;
    const mapped: TapSuggestion = { ...s, t };
    if (s.duration !== undefined) mapped.duration = s.duration / speed;
    if (s.settleT !== undefined) mapped.settleT = tl.outputTime(s.settleT) ?? t + (s.settleT - s.t) / speed;
    out.push(mapped);
  }
  return out.sort((a, b) => a.t - b.t);
}

function clipAt(tl: Timeline, src: number): Clip | undefined {
  return tl.clips.find((c) => src >= c.sourceStart && src <= c.sourceEnd);
}

/** Source time for a tap dragged to output time `outT` (clamped to the timeline). */
export function tapSourceTime(outT: number, tl: Timeline): number {
  const t = Math.min(Math.max(0, outT), Math.max(0, tl.outputDuration - 1e-6));
  return tl.sourceTime(t) ?? tl.clips[tl.clips.length - 1].sourceEnd;
}

// ---------------------------------------------------------------------------
// Waits

/** Output-time pieces of source ranges, one per clip that shows them. */
export function rangesToOutput(ranges: { start: number; end: number }[], tl: Timeline): { start: number; end: number; speed: number }[] {
  const out: { start: number; end: number; speed: number }[] = [];
  for (const r of ranges) {
    for (const span of clipSpans(tl)) {
      const a = Math.max(r.start, span.clip.sourceStart);
      const b = Math.min(r.end, span.clip.sourceEnd);
      if (b - a <= 1e-6) continue;
      const speed = Math.max(span.clip.speed, 1e-9);
      out.push({
        start: span.outStart + (a - span.clip.sourceStart) / speed,
        end: span.outStart + (b - span.clip.sourceStart) / speed,
        speed: span.clip.speed,
      });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

/** Seconds of 1x footage kept either side of a wait so the UI settles on screen. */
export const WAIT_MARGIN = 0.25;

/** The part of each wait worth speeding up: trimmed by the margin, still long enough. */
export function waitCore(w: WaitRange, minLen = 0.5): { start: number; end: number } | null {
  const start = w.edge === 'start' ? w.start : w.start + WAIT_MARGIN;
  const end = w.edge === 'end' ? w.end : w.end - WAIT_MARGIN;
  return end - start >= minLen ? { start, end } : null;
}

/** Waits that still play at normal speed somewhere on the timeline. */
export function pendingWaits(waits: WaitRange[], tl: Timeline): WaitRange[] {
  return waits.filter((w) => {
    const core = waitCore(w);
    return !!core && rangesToOutput([core], tl).some((r) => r.speed < 1.5 && r.end - r.start >= 0.3);
  });
}

/**
 * Clips with the source ranges played at `speed` (never slower than they
 * already are). Clips are split at the range edges, so everything outside the
 * ranges keeps its timing and order.
 */
export function speedUpRanges(clips: Clip[], ranges: { start: number; end: number }[], speed: number): Clip[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: Clip[] = [];
  for (const clip of clips) {
    const cuts = new Set<number>([clip.sourceStart, clip.sourceEnd]);
    for (const r of sorted) {
      if (r.start > clip.sourceStart && r.start < clip.sourceEnd) cuts.add(r.start);
      if (r.end > clip.sourceStart && r.end < clip.sourceEnd) cuts.add(r.end);
    }
    const edges = [...cuts].sort((a, b) => a - b);
    if (edges.length === 2) {
      const inside = sorted.some((r) => r.start <= clip.sourceStart && r.end >= clip.sourceEnd);
      out.push(inside && clip.speed < speed ? { ...clip, speed } : clip);
      continue;
    }
    for (let i = 0; i + 1 < edges.length; i++) {
      const a = edges[i];
      const b = edges[i + 1];
      if (b - a <= 1e-6) continue;
      const mid = (a + b) / 2;
      const inside = sorted.some((r) => mid > r.start && mid < r.end);
      out.push({
        id: crypto.randomUUID(),
        sourceStart: a,
        sourceEnd: b,
        speed: inside ? Math.max(clip.speed, speed) : clip.speed,
      });
    }
  }
  return out;
}
