import type { CameraOverlay, SourceKind } from './types';

// The camera bubble: a small floating window that shows the camera live
// while a display or window take runs, so the person recording can see
// themselves. It is never in the screen recording (the camera is recorded
// on its own and composited in the editor), and where it was left becomes
// the camera overlay's corner and size in the new project.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BubbleSize = 's' | 'm' | 'l';

/** The bubble's diameter (points) for each size. */
export const BUBBLE_DIAMETER: Record<BubbleSize, number> = { s: 120, m: 180, l: 260 };
export const BUBBLE_SIZES: readonly BubbleSize[] = ['s', 'm', 'l'];
export const DEFAULT_BUBBLE_SIZE: BubbleSize = 'm';

/** Clear space around the bubble inside its window, for the shadow and the
 *  hide button. The window is the bubble plus this on every side. */
export const BUBBLE_PAD = 18;

/** Default distance from the display's bottom-right corner to the bubble. */
export const BUBBLE_INSET = 32;

/** The window frame around a bubble whose circle is at `bubble`. */
export const windowForBubble = (bubble: Rect): Rect => ({
  x: bubble.x - BUBBLE_PAD,
  y: bubble.y - BUBBLE_PAD,
  width: bubble.width + BUBBLE_PAD * 2,
  height: bubble.height + BUBBLE_PAD * 2,
});

/** The circle inside a bubble window frame. */
export const bubbleInWindow = (win: Rect): Rect => ({
  x: win.x + BUBBLE_PAD,
  y: win.y + BUBBLE_PAD,
  width: Math.max(0, win.width - BUBBLE_PAD * 2),
  height: Math.max(0, win.height - BUBBLE_PAD * 2),
});

/**
 * Where the bubble window opens: its circle at the bottom-right of the
 * display's work area (the part the Dock and menu bar don't cover), inset
 * BUBBLE_INSET.
 */
export function defaultBubbleWindow(workArea: Rect, size: BubbleSize = DEFAULT_BUBBLE_SIZE): Rect {
  const d = BUBBLE_DIAMETER[size];
  return windowForBubble({
    x: workArea.x + workArea.width - BUBBLE_INSET - d,
    y: workArea.y + workArea.height - BUBBLE_INSET - d,
    width: d,
    height: d,
  });
}

/**
 * The window frame after a size change: the circle keeps its centre, then
 * the whole circle is pulled back inside `area` if the new size pokes out.
 */
export function resizeBubbleWindow(win: Rect, size: BubbleSize, area: Rect): Rect {
  const old = bubbleInWindow(win);
  const d = BUBBLE_DIAMETER[size];
  const cx = old.x + old.width / 2;
  const cy = old.y + old.height / 2;
  const bubble = clampInto({ x: Math.round(cx - d / 2), y: Math.round(cy - d / 2), width: d, height: d }, area);
  return windowForBubble(bubble);
}

/** `r` moved (not resized) so it lies inside `area` where it fits. */
export function clampInto(r: Rect, area: Rect): Rect {
  const x = Math.min(Math.max(r.x, area.x), area.x + area.width - r.width);
  const y = Math.min(Math.max(r.y, area.y), area.y + area.height - r.height);
  return { ...r, x: Math.max(area.x, x), y: Math.max(area.y, y) };
}

/** The overlay corner nearest the bubble: the quadrant of the display its centre is in. */
export function cornerForBubble(bubble: Rect, display: Rect): CameraOverlay['corner'] {
  const cx = bubble.x + bubble.width / 2 - display.x;
  const cy = bubble.y + bubble.height / 2 - display.y;
  const top = cy < display.height / 2;
  const left = cx < display.width / 2;
  return top ? (left ? 'topLeft' : 'topRight') : left ? 'bottomLeft' : 'bottomRight';
}

/** The overlay sizes a bubble maps to: smaller stops reading as a face,
 *  larger covers too much of the recording. */
export const MIN_SIZE_FRACTION = 0.1;
export const MAX_SIZE_FRACTION = 0.4;

/**
 * The overlay size that matches the bubble: the compositor draws the camera
 * at sizeFraction × the shorter side of the recording, and a display take is
 * that display, so the same proportion of its shorter side looks the same.
 */
export function sizeFractionForBubble(bubble: Rect, display: Rect): number {
  const short = Math.min(display.width, display.height);
  if (!(short > 0) || !(bubble.width > 0)) return 0.22;
  const f = bubble.width / short;
  return Math.round(Math.min(MAX_SIZE_FRACTION, Math.max(MIN_SIZE_FRACTION, f)) * 1000) / 1000;
}

/** Where the bubble was when the take ended: its window frame and the recorded display. */
export interface BubblePlacement {
  window: Rect;
  display: Rect;
}

/**
 * The new project's camera overlay, carrying over where the bubble was left.
 * Only a display take maps: a window take's own bounds aren't known, so it
 * keeps the default corner and size. No placement (the bubble never opened)
 * keeps the default too.
 */
export function overlayFromBubble(
  overlay: CameraOverlay,
  placement: BubblePlacement | null,
  sourceKind: SourceKind,
): CameraOverlay {
  if (!placement || sourceKind !== 'display') return overlay;
  const bubble = bubbleInWindow(placement.window);
  return {
    ...overlay,
    corner: cornerForBubble(bubble, placement.display),
    sizeFraction: sizeFractionForBubble(bubble, placement.display),
  };
}

/** What a take records, for whether the bubble opens: a screen source,
 *  a camera as the source, or an iPhone on its own. */
export type TakeSource = SourceKind | 'camera' | 'iphone';

/**
 * The bubble opens for a display or window take (with or without an iPhone
 * alongside) whose camera actually opened, when "Show me while recording" is
 * on. An iPhone-only take or a camera-only take never gets one.
 */
export function bubbleOpensFor(take: { source: TakeSource; cameraOpen: boolean; showWhileRecording: boolean }): boolean {
  return take.showWhileRecording && take.cameraOpen && (take.source === 'display' || take.source === 'window');
}

/**
 * The bubble's lifecycle during one take. `open` until the take ends, the
 * hide button is pressed, or the camera goes away; every one of those
 * closes it for good (it never reopens mid-take). `notice` says why when the
 * person should be told.
 */
export type BubbleState = { status: 'closed' } | { status: 'open'; size: BubbleSize } | { status: 'hidden' } | { status: 'lost' };

export type BubbleEvent =
  | { type: 'start'; take: Parameters<typeof bubbleOpensFor>[0] }
  | { type: 'resize'; size: BubbleSize }
  | { type: 'hide' }
  | { type: 'cameraLost' }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'error' };

export const CAMERA_LOST_NOTICE = 'The camera was disconnected, so the camera bubble closed. The screen is still recording.';

export function nextBubble(state: BubbleState, event: BubbleEvent): { state: BubbleState; notice?: string } {
  switch (event.type) {
    case 'start':
      return { state: bubbleOpensFor(event.take) ? { status: 'open', size: DEFAULT_BUBBLE_SIZE } : { status: 'closed' } };
    case 'resize':
      return { state: state.status === 'open' ? { status: 'open', size: event.size } : state };
    case 'hide':
      return { state: state.status === 'open' ? { status: 'hidden' } : state };
    case 'cameraLost':
      return state.status === 'open' ? { state: { status: 'lost' }, notice: CAMERA_LOST_NOTICE } : { state };
    case 'stop':
    case 'cancel':
    case 'error':
      return { state: { status: 'closed' } };
  }
}

// "Show me while recording": on unless it was turned off.
const SHOW_KEY = 'openscreen.cameraBubble.show';

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

export function readShowBubble(store: KeyValue): boolean {
  try {
    return store.getItem(SHOW_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeShowBubble(store: KeyValue, on: boolean) {
  try {
    store.setItem(SHOW_KEY, on ? '1' : '0');
  } catch {}
}
