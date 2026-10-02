// `agent polish`: good-looking defaults as a fixed list of edit ops, so the
// result is deterministic and every change is visible in the summary.

import type { EditOp } from './agentOps';
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
  } else if (p.recording.sourceKind === 'camera') {
    // "Just me": a face video has no clicks to zoom to and no cursor.
    ops.push({ op: 'background', swatch: look.swatch });
    ops.push({ op: 'style', ...look.style });
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
