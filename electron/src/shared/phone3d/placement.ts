// Where the 3D phone lives and whether it is on. Pure, shared by the
// compositor, the editor, the warnings and the CLI.
//
// phoneHome copies the compositor's two framed-iPhone placement cases
// (compositor.ts render() step 2 and phoneSetup) exactly, so turning 3D on
// never moves the recording: test/placement3d.test.ts renders the real
// compositor and checks contentRect equals phoneHome().body.
//
// phone3dActive lives here, not in model.ts: it needs the project modules,
// and types.ts imports model.ts, so model.ts must stay free of them.

import { mapRect, placeContent } from '../contentTransform';
import { deviceBodyRect, screenRectFor, type Rect } from '../deviceGeometry';
import type { DeviceModel, Orientation } from '../devices';
import type { ExportPreset } from '../exportPresets';
import { isPhoneProject, layoutPreset, resolveDevice } from '../mobileProject';
import { phoneLayerOn } from '../phoneLayer';
import { computePhoneLayout } from '../phoneLayout';
import type { Project, Size } from '../types';

export interface PhoneHome {
  /** The placed body (the compositor's contentRect): where the flat frame is drawn. */
  body: Rect;
  /** The same body where the layout fits it, before the hand move (contentBase). */
  base: Rect;
  /** The flat screen rect inside `body`. */
  screen: Rect;
  device: DeviceModel;
  orientation: Orientation;
  /** The canvas preset the phone sits on (null: the classic padded frame). */
  preset: ExportPreset | null;
}

/**
 * The flat phone's place on a `canvas`-sized frame, or null when the project
 * has no framed iPhone/iPad (not a phone take, frame off, or an App Store /
 * frameless preset). Mirrors the compositor:
 * - framed preset: computePhoneLayout(...).device, then placeContent
 * - no preset: deviceBodyRect(padded content rect, device, {orientation}), then placeContent
 */
export function phoneHome(p: Project, canvas: Size): PhoneHome | null {
  if (!isPhoneProject(p) || !p.device?.frame) return null;
  const { device, orientation } = resolveDevice(p);
  const preset = layoutPreset(p);
  const t = p.style.contentTransform;
  if (preset) {
    if (preset.layout !== 'framed') return null;
    const layout = computePhoneLayout(preset, device, {
      deviceFrame: true,
      titleCard: preset.titleCard && !!p.layout.titleCard,
      orientation,
    });
    if (layout.mode !== 'framed' || !layout.device) return null;
    const base = layout.device;
    const body = placeContent(base, t, canvas);
    return { body, base, screen: mapRect(layout.screen, base, body), device, orientation, preset };
  }
  const W = canvas.width;
  const H = canvas.height;
  const pad = Math.min(W, H) * p.style.paddingFraction;
  const contentRect = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 };
  const opts = { orientation };
  const base = deviceBodyRect(contentRect, device, opts);
  const body = placeContent(base, t, canvas);
  return { body, base, screen: screenRectFor(body, device, opts), device, orientation, preset: null };
}

export type Phone3DInactiveReason = 'disabled' | 'not-iphone' | 'frame-off' | 'app-store' | 'mac-iphone' | 'frameless-layout';

/**
 * The one gate for "draw the phone in 3D" (compositor, 3D tab, warnings,
 * `info`). Active only when phone3d is enabled, the take is an iPhone/iPad
 * recording, the device frame is on, there is no Mac + iPhone phone layer,
 * and the canvas is the classic frame or a framed preset. App Store previews
 * (full-bleed) and any frameless layout stay flat by construction.
 */
export function phone3dActive(p: Pick<Project, 'phone3d' | 'recording' | 'device' | 'layout' | 'phoneOverlay'>): {
  active: boolean;
  reason?: Phone3DInactiveReason;
} {
  if (!p.phone3d?.enabled) return { active: false, reason: 'disabled' };
  if (phoneLayerOn(p)) return { active: false, reason: 'mac-iphone' };
  if (!isPhoneProject(p)) return { active: false, reason: 'not-iphone' };
  if (!p.device?.frame) return { active: false, reason: 'frame-off' };
  const preset = layoutPreset(p);
  if (preset && preset.layout !== 'framed') {
    return { active: false, reason: preset.group === 'App Store' ? 'app-store' : 'frameless-layout' };
  }
  return { active: true };
}
