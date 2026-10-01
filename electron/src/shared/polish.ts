// `agent polish` and the editor's Auto-edit button: good-looking defaults as
// a fixed list of edit ops, so the result is deterministic and every change
// is visible in the summary. Both run runPolish, so they make the same edit.

import { applyOps, type ApplyContext, type EditOp } from './agentOps';
import { formatClock } from './exportProgress';
import { Timeline } from './timeline';
import type { Project } from './types';

export type PolishStyle = 'clean' | 'bold';

export interface PolishOptions {
  style: PolishStyle;
  /** A fresh tap analysis is available in the apply context. */
  analyzed: boolean;
  /** A transcript is available in the apply context. */
  transcript: boolean;
  title?: string;
  subtitle?: string;
}

const LOOKS = {
  clean: {
    swatch: 'ocean',
    style: { paddingFraction: 0.08, cornerRadius: 24, shadowRadius: 60, shadowOpacity: 0.35 },
    tapStyle: { show: true, style: 'ripple', color: 'white', sizePt: 52 },
    depth: { phone: 1.6, desktop: 1.8 },
    waitSpeed: 3,
  },
  bold: {
    swatch: 'sunset',
    style: { paddingFraction: 0.1, cornerRadius: 32, shadowRadius: 90, shadowOpacity: 0.5 },
    tapStyle: { show: true, style: 'pulse', color: 'accent', sizePt: 60 },
    depth: { phone: 1.9, desktop: 2.2 },
    waitSpeed: 4,
  },
} as const;

export function planPolish(p: Project, o: PolishOptions): EditOp[] {
  const look = LOOKS[o.style];
  const phone = p.recording.sourceKind === 'iosDevice';
  const ops: EditOp[] = [];
  if (phone) {
    if (o.analyzed) ops.push({ op: 'analyzeTaps' });
    // A floating framed phone on the vertical canvas unless a canvas was already picked.
    const presetId = p.layout.presetId && p.layout.presetId !== 'none' ? p.layout.presetId : 'social-9x16';
    ops.push({ op: 'layout', presetId });
    ops.push({ op: 'device', frame: true });
    ops.push({ op: 'background', swatch: look.swatch });
    ops.push({ op: 'style', ...look.style });
    ops.push({ op: 'tapStyle', ...look.tapStyle });
    ops.push({ op: 'zoomSettings', fromTaps: true, autofocus: true, depth: look.depth.phone });
    // Dead air at the very start/end goes; stills in the middle play fast.
    ops.push({ op: 'cutWaits', which: 'edge', maxFraction: 0.5 });
    ops.push({ op: 'speedUpWaits', which: 'interior', speed: look.waitSpeed, maxFraction: 0.5 });
  } else {
    ops.push({ op: 'background', swatch: look.swatch });
    ops.push({ op: 'style', ...look.style });
    ops.push({ op: 'zoomSettings', autofocus: true, dwell: true, depth: look.depth.desktop });
    ops.push({ op: 'cursor', size: o.style === 'bold' ? 0.016 : 0.012 });
  }
  if (o.transcript && p.captions.length === 0) ops.push({ op: 'captionsFromTranscript' });
  if (o.title) ops.push({ op: 'titleCard', title: o.title, subtitle: o.subtitle ?? '' });
  return ops;
}

export interface PolishResult {
  project: Project;
  ops: EditOp[];
  notes: string[];
  /** Output length in seconds, before and after. */
  before: number;
  after: number;
}

/**
 * Plans and applies the polish recipe in one go. Pure: `ctx` carries the tap
 * analysis / transcript the caller already gathered; with no tap analysis
 * the project's existing taps and waits are used. Throws OpError like
 * applyOps, in which case nothing has changed.
 */
export function runPolish(p: Project, ctx: ApplyContext, o: Pick<PolishOptions, 'style' | 'title' | 'subtitle'>): PolishResult {
  const ops = planPolish(p, { ...o, analyzed: !!ctx.tapAnalysis, transcript: !!ctx.transcript });
  const { project, notes } = applyOps(p, ops, ctx);
  const length = (q: Project) => new Timeline(q.recording.duration, q.clips).outputDuration;
  return { project, ops, notes, before: length(p), after: length(project) };
}

/** The editor's one-line result: "Auto-edit: 1:12 → 0:48 · ⌘Z to undo". */
export function autoEditSummary(r: Pick<PolishResult, 'before' | 'after'>): string {
  // Within half a second reads as unchanged (a look-only Mac take).
  const length = Math.abs(r.before - r.after) >= 0.5 ? `${formatClock(r.before * 1000)} → ${formatClock(r.after * 1000)}` : 'look applied';
  return `Auto-edit: ${length} · ⌘Z to undo`;
}
