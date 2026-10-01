import { api } from './api';
import {
  BUBBLE_PAD,
  BUBBLE_SIZES,
  DEFAULT_BUBBLE_SIZE,
  nextBubble,
  type BubblePlacement,
  type BubbleSize,
  type BubbleState,
} from '../../shared/cameraBubble';

// The floating camera bubble shown during a display or window take. It is a
// window.open child of this renderer (main makes it frameless, transparent,
// always on top, unfocusable and hidden from screen capture), so it plays
// the very stream being recorded: no second camera capture, and when the
// take stops that stream's tracks, the camera light goes off with it.

/** Must match BUBBLE_FRAME in main, which only allows this window. */
const FRAME_NAME = 'openscreen-camera-bubble';

const SIZE_LABEL: Record<BubbleSize, string> = { s: 'S', m: 'M', l: 'L' };

const CSS = `
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
  font: 600 11px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; user-select: none; -webkit-user-select: none; }
.bubble { position: absolute; inset: ${BUBBLE_PAD}px; cursor: grab; }
.bubble.dragging { cursor: grabbing; }
.face { position: absolute; inset: 0; overflow: hidden; background: #1c1c1e;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.32), 0 1px 3px rgba(0, 0, 0, 0.25); }
.face::after { content: ''; position: absolute; inset: 0; border-radius: inherit;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22); pointer-events: none; }
.circle .face { border-radius: 50%; }
.rounded .face { border-radius: 22%; }
/* Mirrored, like a selfie camera: moving left moves left. */
video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); display: block; pointer-events: none; }
.sizes, .hide { opacity: 0; transition: opacity 160ms ease; }
.bubble:hover .sizes, .bubble:hover .hide, .bubble.show-controls .sizes, .bubble.show-controls .hide { opacity: 1; }
.sizes { position: absolute; left: 50%; bottom: 9%; transform: translateX(-50%); display: flex; gap: 2px; padding: 2px;
  border-radius: 999px; background: rgba(255, 255, 255, 0.86); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
.sizes button { all: unset; width: 22px; height: 18px; border-radius: 999px; text-align: center; line-height: 18px;
  color: rgba(0, 0, 0, 0.7); cursor: default; }
.sizes button:hover { background: rgba(0, 0, 0, 0.08); }
.sizes button[aria-pressed='true'] { background: #1d1d1f; color: #fff; }
.hide { all: unset; position: absolute; width: 22px; height: 22px; border-radius: 50%; text-align: center; line-height: 22px;
  font-size: 13px; background: rgba(255, 255, 255, 0.92); color: rgba(0, 0, 0, 0.75); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); cursor: default; }
/* On the circle's edge at the top right; on the square's corner. */
.circle .hide { left: calc(85.36% - 11px); top: calc(14.64% - 11px); }
.rounded .hide { right: -7px; top: -7px; }
.hide:hover { background: #fff; color: #000; }
@media (prefers-color-scheme: dark) {
  .sizes { background: rgba(40, 40, 42, 0.86); }
  .sizes button { color: rgba(255, 255, 255, 0.78); }
  .sizes button:hover { background: rgba(255, 255, 255, 0.12); }
  .sizes button[aria-pressed='true'] { background: #f5f5f7; color: #1d1d1f; }
  .hide { background: rgba(44, 44, 46, 0.94); color: rgba(255, 255, 255, 0.85); }
  .hide:hover { background: #3a3a3c; color: #fff; }
}
`;

export interface CameraBubble {
  /** Close it as the take ends; resolves where it was left (also after a
   *  hide), or null when it never showed. */
  close(): Promise<BubblePlacement | null>;
}

/**
 * Open the bubble on the recorded display (`displayId`; a window take
 * passes none and gets the display OpenScreen is on). `onCameraLost` runs
 * when the camera goes away mid-take: the bubble closes and the take goes on.
 * Null when the window could not be opened.
 */
export function openCameraBubble(opts: {
  stream: MediaStream;
  displayId?: string;
  circular: boolean;
  onCameraLost: (notice: string) => void;
}): CameraBubble | null {
  const child = window.open('about:blank', FRAME_NAME);
  if (!child) return null;
  let state: BubbleState = { status: 'open', size: DEFAULT_BUBBLE_SIZE };
  let placement: BubblePlacement | null = null;
  // Settles once the bubble is closed (hidden, camera lost or take over).
  let closing: Promise<void> | null = null;
  const shut = () =>
    (closing ??= api
      .bubbleClose()
      .then((p) => void (placement = p ?? placement))
      .catch(() => {}));

  const doc = child.document;
  doc.title = 'Camera';
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.append(style);

  const bubble = doc.createElement('div');
  bubble.className = `bubble ${opts.circular ? 'circle' : 'rounded'}`;
  const face = doc.createElement('div');
  face.className = 'face';
  const video = doc.createElement('video');
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = opts.stream;
  face.append(video);

  const sizes = doc.createElement('div');
  sizes.className = 'sizes';
  sizes.setAttribute('role', 'group');
  sizes.setAttribute('aria-label', 'Bubble size');
  const sizeButtons = BUBBLE_SIZES.map((size) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = SIZE_LABEL[size];
    b.title = { s: 'Small', m: 'Medium', l: 'Large' }[size];
    b.setAttribute('aria-pressed', String(size === DEFAULT_BUBBLE_SIZE));
    b.addEventListener('click', () => {
      state = nextBubble(state, { type: 'resize', size }).state;
      if (state.status !== 'open') return;
      sizeButtons.forEach((x, i) => x.setAttribute('aria-pressed', String(BUBBLE_SIZES[i] === size)));
      void api.bubbleResize(size).catch(() => {});
    });
    return b;
  });
  sizes.append(...sizeButtons);

  const hide = doc.createElement('button');
  hide.type = 'button';
  hide.className = 'hide';
  hide.textContent = '×';
  hide.title = 'Hide the bubble. The camera keeps recording.';
  hide.setAttribute('aria-label', 'Hide camera bubble');
  hide.addEventListener('click', () => {
    state = nextBubble(state, { type: 'hide' }).state;
    void shut();
  });

  bubble.append(face, sizes, hide);
  doc.body.append(bubble);
  void video.play().catch(() => {});

  // Drag anywhere on the bubble but its buttons. macOS keeps sending moves
  // to the window the press began in, even when the pointer outruns it.
  let grab: { dx: number; dy: number } | null = null;
  bubble.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    grab = { dx: e.screenX - child.screenX, dy: e.screenY - child.screenY };
    bubble.setPointerCapture(e.pointerId);
    bubble.classList.add('dragging');
  });
  bubble.addEventListener('pointermove', (e) => {
    if (grab) api.bubbleMove(e.screenX - grab.dx, e.screenY - grab.dy);
  });
  const drop = () => {
    grab = null;
    bubble.classList.remove('dragging');
  };
  bubble.addEventListener('pointerup', drop);
  bubble.addEventListener('pointercancel', drop);

  // The camera unplugged (or taken by the system) mid-take: close with a
  // notice; the screen keeps recording.
  const track = opts.stream.getVideoTracks()[0];
  const onEnded = () => {
    const next = nextBubble(state, { type: 'cameraLost' });
    state = next.state;
    void shut();
    if (next.notice) opts.onCameraLost(next.notice);
  };
  track?.addEventListener('ended', onEnded);
  if (track && track.readyState === 'ended') onEnded();
  else void api.bubbleShow(opts.displayId, DEFAULT_BUBBLE_SIZE).catch(() => void shut());

  return {
    async close() {
      track?.removeEventListener('ended', onEnded);
      state = nextBubble(state, { type: 'stop' }).state;
      video.srcObject = null;
      await shut();
      if (!child.closed) child.close();
      return placement;
    },
  };
}
