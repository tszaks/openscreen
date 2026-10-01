// The phone layer of a Mac + iPhone take, kept pure so it is tested: when
// the phone layer is drawn, which phone frame plays at an output time, where
// the Mac screen and the phone sit on the canvas, and what to keep and say
// when one side of a dual take fails.
//
// Time: the phone video runs on its own clock. Phone time = the Mac
// recording's source time - recording.phoneOffset, so it follows every cut
// and speed change the Mac footage gets, the way the camera overlay does.

import type { PhoneOverlay, Project, RecordingRef, Size } from './types';
import type { Timeline } from './timeline';
import { detectDevice, genericDevice, getDevice, type DeviceModel, type Orientation } from './devices';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The phone layer is drawn: a Mac take with a phone video, switched on. */
export const phoneLayerOn = (p: Pick<Project, 'recording' | 'phoneOverlay'>) =>
  !!p.recording.phoneVideoFile && p.recording.sourceKind !== 'iosDevice' && !!p.phoneOverlay?.enabled;

// ---------------------------------------------------------------------------
// Time

/** Phone seconds for a Mac source time, held on the first/last frame outside the phone take. */
export function phoneTimeForSource(srcT: number, offset: number, phoneDuration?: number): number {
  const t = srcT - (Number.isFinite(offset) ? offset : 0);
  const end = phoneDuration && phoneDuration > 0 ? phoneDuration : Infinity;
  return Math.min(Math.max(0, t), end);
}

/** Phone seconds that play at output time `outT`; null past the end of the timeline. */
export function phoneTimeAt(outT: number, tl: Timeline, recording: Pick<RecordingRef, 'phoneOffset' | 'phoneDuration'>): number | null {
  const src = tl.sourceTime(outT);
  return src === null ? null : phoneTimeForSource(src, recording.phoneOffset ?? 0, recording.phoneDuration);
}

/** Seconds the phone started after the Mac video (negative: it started first). */
export function phoneOffsetSeconds(macStartMs: number, phoneStartMs: number): number {
  if (!(macStartMs > 0) || !(phoneStartMs > 0)) return 0;
  return Math.round(phoneStartMs - macStartMs) / 1000;
}

// ---------------------------------------------------------------------------
// Device

export interface PhoneDevice {
  device: DeviceModel;
  orientation: Orientation;
}

/** The model the phone is framed as: the chosen one, else detected from its video size. */
export function phoneDevice(size: Size, overlay: Pick<PhoneOverlay, 'modelId'>): PhoneDevice {
  const match = detectDevice(size.width, size.height);
  const detected = match.confidence >= 0.3 ? match.device : genericDevice(size.width, size.height);
  const chosen = overlay.modelId ? getDevice(overlay.modelId) : undefined;
  return { device: chosen ?? detected, orientation: match.orientation };
}

/** Width / height of what is placed: the hardware body when framed, else the video. */
export function phoneAspect(size: Size, overlay: Pick<PhoneOverlay, 'frame' | 'modelId'>): number {
  if (!overlay.frame) return size.width / Math.max(1, size.height);
  const { device, orientation } = phoneDevice(size, overlay);
  const { width, height } = device.bodyMm;
  return orientation === 'landscape' ? height / width : width / height;
}

// ---------------------------------------------------------------------------
// Layout

export interface PhoneLayerRects {
  /** Where the Mac screen goes (already fitted to its aspect). */
  mac: Rect;
  /** The box the phone is drawn in, at `phoneAspect`: its frame body, or its screen when unframed. */
  phone: Rect;
  /** How side-by-side was arranged on this canvas. */
  arrangement: 'row' | 'column' | 'corner';
}

/** Largest rect of `aspect` (w/h) centred in `into`. */
export function fitAspect(into: Rect, aspect: number): Rect {
  if (into.w / into.h > aspect) {
    const w = into.h * aspect;
    return { x: into.x + (into.w - w) / 2, y: into.y, w, h: into.h };
  }
  const h = into.w / aspect;
  return { x: into.x, y: into.y + (into.h - h) / 2, w: into.w, h };
}

/** Largest a corner phone gets, as a fraction of the Mac screen's height. */
export const CORNER_MAX = 0.6;

/**
 * Where the Mac screen and the phone go inside `content` (the canvas minus
 * its padding).
 *
 * Side by side on a landscape or square canvas is a row: the phone is as
 * tall as `size` allows, the Mac screen fills what is left beside it, and the
 * pair is centred. On a portrait canvas the row would leave the Mac screen a
 * sliver, so it becomes a column: the Mac screen across the top (phone on the
 * right) or bottom (phone on the left), the phone in the rest.
 *
 * Corner keeps the Mac screen where it always is and puts the phone over the
 * chosen corner of it, inset like the camera overlay.
 */
export function phoneLayerRects(content: Rect, macAspect: number, phoneAspectRatio: number, overlay: Pick<PhoneOverlay, 'layout' | 'corner' | 'size'>): PhoneLayerRects {
  const size = Math.min(1, Math.max(0.3, overlay.size));
  const gap = Math.min(content.w, content.h) * 0.04;
  if (overlay.layout === 'corner') {
    const mac = fitAspect(content, macAspect);
    const margin = Math.min(mac.w, mac.h) * 0.04;
    let h = mac.h * CORNER_MAX * size;
    let w = h * phoneAspectRatio;
    // A landscape phone: keep it to half the Mac screen's width.
    if (w > mac.w * 0.5) {
      w = mac.w * 0.5;
      h = w / phoneAspectRatio;
    }
    const right = /Right/.test(overlay.corner);
    const bottom = /bottom/.test(overlay.corner);
    const phone = {
      x: right ? mac.x + mac.w - w - margin : mac.x + margin,
      y: bottom ? mac.y + mac.h - h - margin : mac.y + margin,
      w,
      h,
    };
    return { mac, phone, arrangement: 'corner' };
  }
  const phoneFirst = overlay.layout === 'side-by-side-left';
  const portrait = content.h > content.w * 1.2;
  if (!portrait) {
    let ph = content.h * size;
    let pw = ph * phoneAspectRatio;
    // Never more than half the row.
    if (pw > (content.w - gap) * 0.5) {
      pw = (content.w - gap) * 0.5;
      ph = pw / phoneAspectRatio;
    }
    const macBox = { x: 0, y: content.y, w: content.w - pw - gap, h: content.h };
    const macFit = fitAspect(macBox, macAspect);
    const total = macFit.w + gap + pw;
    const left = content.x + (content.w - total) / 2;
    const mac = { x: phoneFirst ? left + pw + gap : left, y: macFit.y, w: macFit.w, h: macFit.h };
    const phone = { x: phoneFirst ? left : left + macFit.w + gap, y: content.y + (content.h - ph) / 2, w: pw, h: ph };
    return { mac, phone, arrangement: 'row' };
  }
  // Column: the Mac screen spans the width; the phone takes what is left.
  let macH = content.w / macAspect;
  const minPhone = content.h * 0.35;
  if (content.h - macH - gap < minPhone) macH = Math.max(content.h * 0.3, content.h - gap - minPhone);
  const macFit = fitAspect({ x: content.x, y: 0, w: content.w, h: macH }, macAspect);
  const room = content.h - macFit.h - gap;
  let ph = room * size;
  let pw = ph * phoneAspectRatio;
  if (pw > content.w) {
    pw = content.w;
    ph = pw / phoneAspectRatio;
  }
  const total = macFit.h + gap + ph;
  const top = content.y + (content.h - total) / 2;
  const mac = { x: macFit.x, y: phoneFirst ? top + ph + gap : top, w: macFit.w, h: macFit.h };
  const phone = { x: content.x + (content.w - pw) / 2, y: phoneFirst ? top : top + macFit.h + gap, w: pw, h: ph };
  return { mac, phone, arrangement: 'column' };
}

// ---------------------------------------------------------------------------
// Dual takes: one side failing never costs the other

/** How the phone side of a dual take went. */
export type PhoneSide =
  | { state: 'off' }
  /** The helper never started: the Mac recorded alone. */
  | { state: 'startFailed'; error: string }
  /** Stopped with a playable file. `endedEarly`: it stopped sending before Stop. */
  | { state: 'ok'; duration: number; width: number; height: number; endedEarly?: boolean; partial?: boolean }
  /** Nothing playable came back. */
  | { state: 'failed'; error: string };

/** How the Mac side went: saved into its bundle, or not. */
export type MacSide = { state: 'saved' } | { state: 'failed'; error: string };

export interface DualOutcome {
  /** Which bundle opens in the editor. */
  open: 'mac' | 'phone' | 'none';
  /** The Mac bundle carries the phone video. */
  phoneInMac: boolean;
  /** One plain sentence about what went wrong, or null when nothing did. */
  notice: string | null;
}

const clean = (s: string) => s.replace(/\s+$/, '').replace(/[.]$/, '');

/** The RecordingRef fields a dual take's phone side adds to the Mac project. */
export function phoneRecordingFields(phone: PhoneSide, offset: number): Partial<RecordingRef> {
  if (phone.state !== 'ok') return {};
  return {
    phoneVideoFile: 'phone.mov',
    phoneOffset: offset,
    phoneSize: { width: phone.width, height: phone.height },
    phoneDuration: phone.duration,
  };
}

/** A phone side worth keeping: a file that plays and has a picture size. */
export const phoneUsable = (phone: PhoneSide): phone is Extract<PhoneSide, { state: 'ok' }> =>
  phone.state === 'ok' && phone.duration > 0 && phone.width > 0 && phone.height > 0;

/** What to open and what to tell the user once both sides have stopped. */
export function dualOutcome(mac: MacSide, phone: PhoneSide): DualOutcome {
  const usable = phoneUsable(phone);
  if (mac.state === 'failed') {
    if (usable) {
      return {
        open: 'phone',
        phoneInMac: false,
        notice: `The screen recording couldn't be saved (${clean(mac.error)}). The iPhone recording was kept and is open.`,
      };
    }
    return { open: 'none', phoneInMac: false, notice: `Couldn't save the recording: ${clean(mac.error)}.` };
  }
  switch (phone.state) {
    case 'off':
      return { open: 'mac', phoneInMac: false, notice: null };
    case 'startFailed':
      return { open: 'mac', phoneInMac: false, notice: `The iPhone didn't start recording (${clean(phone.error)}), so only the screen was recorded.` };
    case 'failed':
      return { open: 'mac', phoneInMac: false, notice: `The iPhone recording failed (${clean(phone.error)}). The screen recording was saved.` };
    case 'ok':
      if (!usable) return { open: 'mac', phoneInMac: false, notice: 'The iPhone recording came back empty. The screen recording was saved.' };
      if (phone.endedEarly || phone.partial) {
        return { open: 'mac', phoneInMac: true, notice: 'The iPhone stopped sending video before the end, so its picture holds on the last frame. Both recordings were saved.' };
      }
      return { open: 'mac', phoneInMac: true, notice: null };
  }
}
