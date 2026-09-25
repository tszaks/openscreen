// Cursor + click tracking during recording.
//
// Position: polls Electron's screen.getCursorScreenPoint() — no permission
// needed, works globally (outside our window) because it's an OS query.
// Rate ~120Hz so the smoothed path has dense data.
//
// Clicks: macOS gives us no global click events without Accessibility
// permission. If uiohook-napi is installed we use it; otherwise we degrade
// to polling the NSEvent pressedMouseButtons equivalent — which Electron
// doesn't expose — so without the native hook clicks are detected only via
// the optional helper. The model layer doesn't care where events come from.

import { screen } from 'electron';
import type { CursorSample, KeystrokeSample } from '../shared/types';

export interface CursorTracker {
  start(): Promise<void>;
  stop(): { samples: CursorSample[]; keys: KeystrokeSample[] };
}

/** Polls cursor position at `hz`, normalized to the display bounds the
 *  point is on. Drag detection: if a click hook reports button state we
 *  mark dragMove; else moves stay 'move'. */
export function createCursorTracker(hz = 120): CursorTracker {
  const samples: CursorSample[] = [];
  const keys: KeystrokeSample[] = [];
  const t0 = () => performance.now() / 1000;
  let startT = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let dragging = false;
  let clickHook: { stop(): void } | null = null;

  const pushClick = async (kind: 'clickDown' | 'clickUp') => {
    const t = performance.now() / 1000 - startT;
    const p = screen.getCursorScreenPoint();
    const disp = screen.getDisplayNearestPoint(p);
    const x = (p.x - disp.bounds.x) / disp.bounds.width;
    const y = (p.y - disp.bounds.y) / disp.bounds.height;
    samples.push({ time: t, x, y, kind });
    dragging = kind === 'clickDown';
  };

  return {
    async start() {
      startT = t0();
      timer = setInterval(() => {
        const t = performance.now() / 1000 - startT;
        const p = screen.getCursorScreenPoint();
        const disp = screen.getDisplayNearestPoint(p);
        samples.push({
          time: t,
          x: (p.x - disp.bounds.x) / disp.bounds.width,
          y: (p.y - disp.bounds.y) / disp.bounds.height,
          kind: dragging ? 'dragMove' : 'move',
        });
      }, 1000 / hz);

      // Optional global click hook — absent without Accessibility permission.
      try {
        const { uIOhook, UiohookKey } = await import('uiohook-napi');
        const keyNames = new Map<number, string>(
          Object.entries(UiohookKey).map(([name, code]) => [code as number, name]),
        );
        uIOhook.on('mousedown', () => void pushClick('clickDown'));
        uIOhook.on('mouseup', () => void pushClick('clickUp'));
        uIOhook.on('keydown', (e) => {
          const t = performance.now() / 1000 - startT;
          keys.push({ time: t, key: keyNames.get(e.keycode) ?? String(e.keycode) });
        });
        uIOhook.start();
        clickHook = { stop: () => uIOhook.stop() };
      } catch {
        clickHook = null; // degrade: moves only, no click/key events
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      clickHook?.stop();
      clickHook = null;
      return { samples, keys };
    },
  };
}
