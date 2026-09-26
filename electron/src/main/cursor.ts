// Cursor + click tracking during recording.
//
// Position: polls Electron's screen.getCursorScreenPoint() — no permission
// needed, works globally (outside our window) because it's an OS query.
// Rate ~120Hz so the smoothed path has dense data.
//
// Positions are normalized to the RECORDED display's bounds, not whichever
// display the pointer is on; samples off that display are dropped. Window
// and camera takes track no position at all (mode 'none'): without the
// window's bounds a cursor would be drawn in the wrong place.
//
// Clicks and keys come from uiohook-napi, which only works with the
// Accessibility grant. The hook is started only when the grant is there,
// and its listeners are removed on stop so they don't pile up per take.

import { screen } from 'electron';
import type { CursorSample, KeystrokeSample } from '../shared/types';
import { normalizeToDisplay, pickDisplay } from '../shared/recording';

export interface CursorTracker {
  /** Resolves once tracking runs. `startedAtMs` is the epoch time of t=0. */
  start(): Promise<{ startedAtMs: number; hooks: boolean }>;
  stop(): { samples: CursorSample[]; keys: KeystrokeSample[] };
}

export interface TrackerOptions {
  hz?: number;
  mode: 'display' | 'none';
  /** desktopCapturer display_id of the recorded screen. */
  displayId?: string;
  /** Accessibility granted, so the global input hook can run. */
  hooksAllowed: boolean;
}

export function createCursorTracker({ hz = 120, mode, displayId, hooksAllowed }: TrackerOptions): CursorTracker {
  const samples: CursorSample[] = [];
  const keys: KeystrokeSample[] = [];
  let startT = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let dragging = false;
  let stopHook: (() => void) | null = null;
  let bounds = screen.getPrimaryDisplay().bounds;

  const now = () => performance.now() / 1000 - startT;
  const pointOnDisplay = () => normalizeToDisplay(screen.getCursorScreenPoint(), bounds);

  const pushClick = (kind: 'clickDown' | 'clickUp') => {
    dragging = kind === 'clickDown';
    if (mode === 'none') return;
    const p = pointOnDisplay();
    if (p) samples.push({ time: now(), x: p.x, y: p.y, kind });
  };

  return {
    async start() {
      const startedAtMs = Date.now();
      startT = performance.now() / 1000;
      if (mode === 'display') {
        const nearest = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        bounds = pickDisplay(screen.getAllDisplays(), displayId, nearest).bounds;
        timer = setInterval(() => {
          const p = pointOnDisplay();
          if (p) samples.push({ time: now(), x: p.x, y: p.y, kind: dragging ? 'dragMove' : 'move' });
        }, 1000 / hz);
      }

      let hooks = false;
      if (hooksAllowed) {
        try {
          const { uIOhook, UiohookKey } = await import('uiohook-napi');
          const keyNames = new Map<number, string>(
            Object.entries(UiohookKey).map(([name, code]) => [code as number, name]),
          );
          uIOhook.removeAllListeners();
          uIOhook.on('mousedown', () => pushClick('clickDown'));
          uIOhook.on('mouseup', () => pushClick('clickUp'));
          uIOhook.on('keydown', (e) => {
            keys.push({ time: now(), key: keyNames.get(e.keycode) ?? String(e.keycode) });
          });
          uIOhook.start();
          stopHook = () => {
            uIOhook.removeAllListeners();
            uIOhook.stop();
          };
          hooks = true;
        } catch (e) {
          console.error('input hook failed to start:', e);
        }
      }
      return { startedAtMs, hooks };
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      try {
        stopHook?.();
      } catch (e) {
        console.error('input hook failed to stop:', e);
      }
      stopHook = null;
      return { samples, keys };
    },
  };
}
