import { api } from './api';
import {
  MONITOR_PAD,
  monitorLayout,
  nextMonitor,
  type MonitorLayout,
  type MonitorPlacement,
  type MonitorPrefs,
  type MonitorState,
} from '../../shared/recordingMonitor';

// The recording monitor window (see shared/recordingMonitor.ts). It is a
// window.open child of this renderer, so it plays the streams already being
// recorded: the face tile shows a clone of the recorded camera track and the
// screen tile a clone of the capture track, both capped at 30 fps and a
// small size. Clones share their source, so nothing is captured twice; they
// are stopped on close, so the camera light goes off with the take. An
// iPhone tile draws the helper's live preview frames (about 12 a second).

/** Must match MONITOR_FRAME in main, which only allows this window. */
const FRAME_NAME = 'openscreen-recording-monitor';

/** At most 30 fps, and no more pixels than a tile can show. */
const TILE_CONSTRAINTS: MediaTrackConstraints = { frameRate: { max: 30 }, width: { max: 640 }, height: { max: 640 } };

/** What the source tile shows: the captured Mac screen, or an iPhone's preview frames. */
export type MonitorSource =
  | { kind: 'stream'; stream: MediaStream; aspect: number }
  | { kind: 'frames'; aspect: number; subscribe: (draw: (jpeg: Uint8Array) => void) => () => void };

export interface RecordingMonitor {
  /** Close it as the take ends; resolves where it was left (also after a
   *  hide) with the face's last size, shape and layout. */
  close(): Promise<{ placement: MonitorPlacement | null; layout: MonitorLayout; prefs: MonitorPrefs }>;
}

const CSS = `
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
  font: 600 11px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; user-select: none; -webkit-user-select: none; }
.monitor { position: absolute; inset: 0; cursor: grab; }
.monitor.dragging { cursor: grabbing; }
.tile { position: absolute; overflow: hidden; background: #1c1c1e; border-radius: 12px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.32), 0 1px 3px rgba(0, 0, 0, 0.25); }
.tile video, .tile canvas { width: 100%; height: 100%; display: block; pointer-events: none; }
.source { background: #000; }
.source video, .source canvas { object-fit: cover; }
.face video { object-fit: cover; transform: scaleX(-1); /* mirrored, like a selfie */ }
.round .face { border-radius: 50%; }
.square .face { border-radius: 22%; }
.controls, .hide { opacity: 0; transition: opacity 160ms ease; }
.monitor:hover .controls, .monitor:hover .hide, .monitor.show-controls .controls, .monitor.show-controls .hide { opacity: 1; }
.controls { position: absolute; display: flex; align-items: center; gap: 1px; padding: 2px; transform: translateX(-50%);
  border-radius: 999px; background: rgba(255, 255, 255, 0.88); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); white-space: nowrap; }
.controls button { all: unset; min-width: 18px; height: 18px; padding: 0 2px; box-sizing: border-box; border-radius: 999px;
  text-align: center; line-height: 18px; color: rgba(0, 0, 0, 0.72); cursor: default; }
.controls button:hover { background: rgba(0, 0, 0, 0.08); }
.controls button[aria-pressed='true'] { background: #1d1d1f; color: #fff; }
.controls .sep { width: 1px; height: 12px; margin: 0 2px; background: rgba(0, 0, 0, 0.15); }
.shape-dot { display: inline-block; width: 8px; height: 8px; vertical-align: -0.5px; background: currentColor; }
.shape-dot.r { border-radius: 50%; }
.shape-dot.s { border-radius: 2px; }
.tile-glyph { display: inline-block; box-sizing: border-box; border: 1.5px solid currentColor; vertical-align: -1px; }
.tile-glyph.screen { width: 12px; height: 8px; border-radius: 2px; }
.tile-glyph.phone { width: 7px; height: 11px; border-radius: 2px; vertical-align: -2px; }
.hide { all: unset; position: absolute; top: ${MONITOR_PAD - 9}px; right: ${MONITOR_PAD - 9}px; width: 20px; height: 20px; border-radius: 50%;
  text-align: center; line-height: 20px; font-size: 12px; background: rgba(255, 255, 255, 0.94); color: rgba(0, 0, 0, 0.75);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); cursor: default; }
.hide:hover { background: #fff; color: #000; }
@media (prefers-color-scheme: dark) {
  .controls { background: rgba(40, 40, 42, 0.88); }
  .controls button { color: rgba(255, 255, 255, 0.8); }
  .controls button:hover { background: rgba(255, 255, 255, 0.12); }
  .controls button[aria-pressed='true'] { background: #f5f5f7; color: #1d1d1f; }
  .controls .sep { background: rgba(255, 255, 255, 0.2); }
  .hide { background: rgba(44, 44, 46, 0.94); color: rgba(255, 255, 255, 0.85); }
  .hide:hover { background: #3a3a3c; color: #fff; }
}
`;

/** A track for a tile: a clone of `track`, held to 30 fps and tile size. */
async function tileTrack(track: MediaStreamTrack): Promise<MediaStreamTrack> {
  const clone = track.clone();
  await clone.applyConstraints(TILE_CONSTRAINTS).catch(() => {});
  return clone;
}

/**
 * Open the monitor for a take. `displayId` is the recorded display (a window
 * or iPhone take passes none and gets the display OpenScreen is on).
 * `onPrefs` gets every change the person makes, to remember it.
 * `onCameraLost` runs when the camera goes away mid-take: the monitor closes
 * and the take goes on. Null when the window could not be opened.
 */
export function openRecordingMonitor(opts: {
  camera: MediaStream;
  source: MonitorSource | null;
  displayId?: string;
  prefs: MonitorPrefs;
  onPrefs: (prefs: MonitorPrefs) => void;
  onCameraLost: (notice: string) => void;
}): RecordingMonitor | null {
  const cameraTrack = opts.camera.getVideoTracks()[0];
  if (!cameraTrack) return null;
  const child = window.open('about:blank', FRAME_NAME);
  if (!child) return null;
  let state: MonitorState = { status: 'open' };
  // Names this monitor to main, so a late close from it never closes another.
  const token = crypto.randomUUID();
  let prefs = { ...opts.prefs };
  let placement: MonitorPlacement | null = null;
  const clones: MediaStreamTrack[] = [];
  const cleanups: (() => void)[] = [];
  // Settles once the window is closed (hidden, camera lost or take over).
  let closing: Promise<void> | null = null;
  const shut = () =>
    (closing ??= (async () => {
      for (const c of cleanups.splice(0)) c();
      for (const t of clones.splice(0)) t.stop();
      placement = (await api.monitorClose(token).catch(() => null)) ?? placement;
      if (!child.closed) child.close();
    })());

  const doc = child.document;
  doc.title = 'Camera';
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.append(style);
  const root = doc.createElement('div');
  root.className = 'monitor';

  const face = doc.createElement('div');
  face.className = 'tile face';
  const faceVideo = doc.createElement('video');
  faceVideo.muted = true;
  faceVideo.playsInline = true;
  face.append(faceVideo);
  void tileTrack(cameraTrack).then((t) => {
    if (closing) return t.stop();
    clones.push(t);
    faceVideo.srcObject = new MediaStream([t]);
    void faceVideo.play().catch(() => {});
  });

  // The source tile: the screen as a throttled clone, or iPhone frames on a canvas.
  const sourceTile = doc.createElement('div');
  sourceTile.className = 'tile source';
  const src = opts.source;
  if (src?.kind === 'stream') {
    const v = doc.createElement('video');
    v.muted = true;
    v.playsInline = true;
    sourceTile.append(v);
    const track = src.stream.getVideoTracks()[0];
    if (track) {
      void tileTrack(track).then((t) => {
        if (closing) return t.stop();
        clones.push(t);
        v.srcObject = new MediaStream([t]);
        void v.play().catch(() => {});
      });
    }
  } else if (src?.kind === 'frames') {
    const canvas = doc.createElement('canvas');
    sourceTile.append(canvas);
    const g = canvas.getContext('2d');
    let busy = false;
    cleanups.push(
      src.subscribe((jpeg) => {
        // Drop a frame rather than queue them if decoding falls behind.
        if (busy || !g || !prefs.sourceTile) return;
        busy = true;
        createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }))
          .then((bmp) => {
            if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
              canvas.width = bmp.width;
              canvas.height = bmp.height;
            }
            g.drawImage(bmp, 0, 0);
            bmp.close();
          })
          .catch(() => {})
          .finally(() => (busy = false));
      }),
    );
  }

  // The hover controls: size, shape, swap sides, and the source tile.
  const controls = doc.createElement('div');
  controls.className = 'controls';
  const button = (label: string | Node, title: string, onClick: () => void) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.append(label);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  };
  const dot = (kind: 'r' | 's') => {
    const d = doc.createElement('span');
    d.className = `shape-dot ${kind}`;
    return d;
  };
  const sep = () => {
    const d = doc.createElement('span');
    d.className = 'sep';
    return d;
  };
  const set = (patch: Partial<MonitorPrefs>) => {
    if (state.status !== 'open') return;
    prefs = { ...prefs, ...patch };
    opts.onPrefs(prefs);
    render(true);
  };
  const small = button('S', 'Small', () => set({ size: 'small' }));
  const large = button('L', 'Large', () => set({ size: 'large' }));
  const round = button(dot('r'), 'Round', () => set({ shape: 'round' }));
  const square = button(dot('s'), 'Square', () => set({ shape: 'square' }));
  const swap = button('⇄', 'Swap sides', () => set({ faceSide: prefs.faceSide === 'left' ? 'right' : 'left' }));
  const glyph = doc.createElement('span');
  glyph.className = `tile-glyph ${src?.kind === 'frames' ? 'phone' : 'screen'}`;
  const screenToggle = button(glyph, src?.kind === 'frames' ? 'Show the iPhone beside you' : 'Show the screen beside you', () =>
    set({ sourceTile: !prefs.sourceTile }),
  );
  controls.append(small, large, sep(), round, square);
  if (src) controls.append(sep(), swap, screenToggle);

  const hide = doc.createElement('button');
  hide.type = 'button';
  hide.className = 'hide';
  hide.textContent = '×';
  hide.title = 'Hide. The camera keeps recording.';
  hide.setAttribute('aria-label', 'Hide your camera view');
  hide.addEventListener('click', () => {
    state = nextMonitor(state, { type: 'hide' }).state;
    void shut();
  });

  root.append(sourceTile, face, controls, hide);
  doc.body.append(root);

  let layout: MonitorLayout = monitorLayout({ size: prefs.size, faceSide: prefs.faceSide, sourceAspect: null });
  const place = (el: HTMLElement, r: { x: number; y: number; width: number; height: number }) =>
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
  /** Lay the tiles out for the current choices; `resize` tells main the new window size. */
  const render = (resize: boolean) => {
    const showSource = !!src && prefs.sourceTile;
    layout = monitorLayout({ size: prefs.size, faceSide: prefs.faceSide, sourceAspect: showSource ? src!.aspect : null });
    root.className = `monitor ${prefs.shape}`;
    place(face, layout.face);
    sourceTile.style.display = layout.source ? '' : 'none';
    if (layout.source) place(sourceTile, layout.source);
    // The controls sit on the bottom of the face tile.
    Object.assign(controls.style, { left: `${layout.face.x + layout.face.width / 2}px`, top: `${layout.face.y + layout.face.height - 34}px` });
    small.setAttribute('aria-pressed', String(prefs.size === 'small'));
    large.setAttribute('aria-pressed', String(prefs.size === 'large'));
    round.setAttribute('aria-pressed', String(prefs.shape === 'round'));
    square.setAttribute('aria-pressed', String(prefs.shape === 'square'));
    screenToggle.setAttribute('aria-pressed', String(prefs.sourceTile));
    if (resize) void api.monitorResize({ width: layout.width, height: layout.height }).catch(() => {});
  };
  render(false);

  // Drag anywhere but the buttons. macOS keeps sending moves to the window
  // the press began in, even when the pointer outruns it.
  let grab: { dx: number; dy: number } | null = null;
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    grab = { dx: e.screenX - child.screenX, dy: e.screenY - child.screenY };
    root.setPointerCapture(e.pointerId);
    root.classList.add('dragging');
  });
  root.addEventListener('pointermove', (e) => {
    if (grab) api.monitorMove(e.screenX - grab.dx, e.screenY - grab.dy);
  });
  const drop = () => {
    grab = null;
    root.classList.remove('dragging');
  };
  root.addEventListener('pointerup', drop);
  root.addEventListener('pointercancel', drop);

  // The camera unplugged (or taken by the system) mid-take: close with a
  // notice; the recording goes on.
  const onEnded = () => {
    const next = nextMonitor(state, { type: 'cameraLost' });
    state = next.state;
    void shut();
    if (next.notice) opts.onCameraLost(next.notice);
  };
  cameraTrack.addEventListener('ended', onEnded);
  cleanups.push(() => cameraTrack.removeEventListener('ended', onEnded));
  if (cameraTrack.readyState === 'ended') onEnded();
  else void api.monitorShow(token, opts.displayId, { width: layout.width, height: layout.height }, prefs.spot).catch(() => void shut());

  return {
    async close() {
      state = nextMonitor(state, { type: 'stop' }).state;
      await shut();
      return { placement, layout, prefs };
    },
  };
}
