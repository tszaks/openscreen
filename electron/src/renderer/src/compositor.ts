// Canvas compositor — port of the RenderKit compositor. Draw order:
// background → screen frame (zoomed via camera, rounded corners, shadow)
// → software cursor → click ripples → caption pill.
//
// Phone recordings add: a blurred-recording backdrop, the video clipped to
// the real screen shape, touch indicators inside the zoom camera (so they
// zoom with the content), the procedural device frame and a title card.
// With a layout preset the canvas and phone placement come from
// computePhoneLayout; without one the phone sits in the classic padded frame.
//
// A Mac + iPhone take adds the phone layer (shared/phoneLayer): the phone's
// own video in its device frame, beside the Mac screen (which shrinks to make
// room) or over a corner of it, drawn after the camera overlay.
import type { Annotation, CaptionCue, Point, Project, Size } from '../../shared/types';
import { cameraAt, type AutofocusOptions, type FocusSegment } from '../../shared/autofocus';
import type { DeviceModel, Orientation } from '../../shared/devices';
import type { ExportPreset } from '../../shared/exportPresets';
import type { TapSuggestion } from '../../shared/taps';
import { Timeline } from '../../shared/timeline';
import { isPhoneProject, layoutPreset, presetAllowsZoom, resolveDevice, tapsToOutput } from '../../shared/mobileProject';
import {
  clipToScreen,
  continuousRectPath,
  drawDeviceFrame,
  pointScaleFor,
  screenRectFor,
  type Rect,
} from './mobile/deviceFrame';
import { ACCENT_TOUCH_COLOR, drawTouchIndicators } from './mobile/tapIndicator';
import { computePhoneLayout, drawBlurredBackground, drawTitleCard, type PhoneLayout } from './mobile/layout';
import type { Ripple } from '../../shared/ripples';
import { fileUrl } from '../../shared/fileUrl';
import { isColourBackground, paintBackdrop } from './backdrop';
import { phoneAspect, phoneDevice, phoneLayerOn, phoneLayerRects, type PhoneDevice } from '../../shared/phoneLayer';
import { api } from './api';
import { macContentRect, overlayRect } from '../../shared/cameraOverlay';

// Background images by raw path, shared by every compositor: the editor
// builds a new compositor on each edit, and reloading the image each time
// would flash the fallback.
const bgImages = new Map<string, { img: HTMLImageElement; ready: Promise<boolean> }>();

function backgroundImage(path: string) {
  let entry = bgImages.get(path);
  if (!entry) {
    const img = new Image();
    const ready = new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      // HEIC goes through main for a JPEG copy; null means it can't be shown.
      api.prepareBackground(path).then(
        (usable) => {
          if (usable) img.src = fileUrl(usable);
          else resolve(false);
        },
        () => resolve(false),
      );
    });
    entry = { img, ready };
    bgImages.set(path, entry);
  }
  return entry;
}

/** Resolves once the background image at `path` has loaded (true) or
 *  couldn't be (false). */
export function backgroundReady(path: string): Promise<boolean> {
  return backgroundImage(path).ready;
}

export interface FrameInputs {
  frame: CanvasImageSource; // source frame at this output time
  cursor: Point | null; // normalized position, or null to hide
  cursorTrail?: Point[]; // recent positions, oldest→newest (motion smear)
  ripples: Ripple[];
  cameraFrame?: CanvasImageSource;
  /** The phone layer's frame at this output time (Mac + iPhone takes). */
  phoneFrame?: CanvasImageSource;
  keystrokes?: string[]; // recently pressed key names, oldest→newest
}

/** Phone setup for a project, resolved once per compositor. */
interface PhoneSetup {
  device: DeviceModel;
  orientation: Orientation;
  preset: ExportPreset | null;
  /** Set when a layout preset places the phone. */
  layout: PhoneLayout | null;
  /** Draw the hardware frame. */
  frame: boolean;
  /** Taps on the output timeline. */
  taps: TapSuggestion[];
}

/** Where the full source frame lands on the canvas at the last render (zoom
 *  included), and the visible screen rect: lets the editor map clicks back. */
export interface ScreenMap {
  /** The whole source frame, zoomed; may extend past the screen. */
  source: Rect;
  /** The visible screen / content rect. */
  screen: Rect;
}

export class CanvasCompositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private phone: PhoneSetup | null;
  private zoomOn: boolean;
  /** The phone layer of a Mac + iPhone take: its model and the aspect it is placed at. */
  private phoneLayer: (PhoneDevice & { aspect: number }) | null;
  /** Where the phone layer was drawn at the last render (its body, or its screen when unframed). */
  phoneRect: Rect | null = null;
  /** Where the camera bubble goes on this canvas, as of the last render
   *  (set even before the camera has a frame, so the editor can hit-test it). */
  cameraRect: Rect | null = null;
  /** Filled by render(); see ScreenMap. */
  screenMap: ScreenMap | null = null;

  constructor(
    private project: Project,
    public canvasSize: Size,
    private focusSegments: FocusSegment[] = [],
    private autofocusOpts?: AutofocusOptions,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = canvasSize.width;
    this.canvas.height = canvasSize.height;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    this.ctx = ctx;
    this.phone = phoneSetup(project);
    this.zoomOn = presetAllowsZoom(this.phone?.preset ?? null);
    const size = project.recording.phoneSize;
    this.phoneLayer =
      phoneLayerOn(project) && size ? { ...phoneDevice(size, project.phoneOverlay), aspect: phoneAspect(size, project.phoneOverlay) } : null;
  }

  /** The phone layout on this canvas (safe zone, title rect), when a preset places it. */
  get phoneLayout(): PhoneLayout | null {
    return this.phone?.layout ?? null;
  }

  /** Canvas px → normalized full-source coords, using the last render. Null
   *  outside the visible screen. */
  canvasToSource(px: number, py: number): Point | null {
    const m = this.screenMap;
    if (!m) return null;
    const { screen: s, source: v } = m;
    if (px < s.x || py < s.y || px > s.x + s.w || py > s.y + s.h) return null;
    return { x: (px - v.x) / v.w, y: (py - v.y) / v.h };
  }

  /** Normalized full-source coords → canvas px, using the last render. */
  sourceToCanvas(p: Point): Point | null {
    const m = this.screenMap;
    return m ? { x: m.source.x + p.x * m.source.w, y: m.source.y + p.y * m.source.h } : null;
  }

  /** Draw the frame at output time `time`. Zoom, captions and annotations
   *  are keyed to output time; the source-time overlays (cursor, keys) come
   *  in already resolved through `input`. */
  render(time: number, input: FrameInputs): void {
    const { ctx, canvas, phone } = this;
    const { width: W, height: H } = canvas;
    const style = this.project.style;
    const fullW = this.project.recording.sourceSize.width;
    const fullH = this.project.recording.sourceSize.height;
    const layout = phone?.layout ?? null;

    // 1. Background.
    if (phone && this.project.layout.background === 'blurred') {
      drawBlurredBackground(ctx, input.frame, { width: fullW, height: fullH }, { width: W, height: H });
    } else {
      this.drawBackground(W, H);
    }

    // 2. Where the screen goes, and how to clip to it.
    let rect: Rect;
    let clip: () => void;
    let frameBody: Rect | null = null;
    if (layout && phone) {
      rect = layout.screen;
      if (layout.mode === 'full-bleed') {
        clip = () => {
          ctx.beginPath();
          ctx.rect(0, 0, W, H);
          ctx.clip();
        };
      } else if (phone.frame && layout.device) {
        frameBody = layout.device;
        const body = frameBody;
        clip = () => clipToScreen(ctx, body, phone.device, { orientation: phone.orientation });
      } else {
        // No hardware: a floating screen with the device's real corners.
        const r = layout.screenRadius;
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.38)';
        ctx.shadowBlur = Math.max(rect.w, rect.h) * 0.06;
        ctx.shadowOffsetY = Math.max(rect.w, rect.h) * 0.025;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        continuousRectPath(ctx, rect.x, rect.y, rect.w, rect.h, r);
        ctx.fill();
        ctx.restore();
        clip = () => {
          ctx.beginPath();
          continuousRectPath(ctx, rect.x, rect.y, rect.w, rect.h, r);
          ctx.clip();
        };
      }
    } else {
      const pad = Math.min(W, H) * style.paddingFraction;
      const contentRect = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 };
      if (phone?.frame) {
        // Phone in the classic padded frame: the body fills the content rect.
        const opts = { orientation: phone.orientation };
        frameBody = contentRect;
        rect = screenRectFor(contentRect, phone.device, opts);
        clip = () => clipToScreen(ctx, contentRect, phone.device, opts);
      } else {
        const macAspect = style.cropRect ? (style.cropRect.w * fullW) / (style.cropRect.h * fullH) : fullW / fullH;
        // A phone layer beside the screen takes its share of the content rect first.
        const placed = this.phoneLayer ? phoneLayerRects(contentRect, macAspect, this.phoneLayer.aspect, this.project.phoneOverlay) : null;
        this.phoneRect = placed?.phone ?? null;
        // The same rect the editor's snap guides and the bubble placement use.
        rect = macContentRect(this.project, { width: W, height: H });
        const r = style.cornerRadius;
        clip = () => {
          ctx.shadowColor = `rgba(0,0,0,${style.shadowOpacity})`;
          ctx.shadowBlur = style.shadowRadius;
          roundedPath(ctx, rect.x, rect.y, rect.w, rect.h, r);
          ctx.clip();
        };
      }
    }

    // Effective source rect = user crop (normalized → px) or full source.
    const crop = style.cropRect;
    const srcRect = crop
      ? { x: crop.x * fullW, y: crop.y * fullH, w: crop.w * fullW, h: crop.h * fullH }
      : { x: 0, y: 0, w: fullW, h: fullH };

    const cam = this.zoomOn
      ? cameraAt(time, this.focusSegments, this.autofocusOpts)
      : { center: { x: 0.5, y: 0.5 }, scale: 1 };

    // Camera crop: camera center is normalized over the FULL source —
    // remap into effective-source space, then apply zoom scale.
    const cropW = srcRect.w / cam.scale;
    const cropH = srcRect.h / cam.scale;
    const cx = cam.center.x * fullW - srcRect.x;
    const cy = cam.center.y * fullH - srcRect.y;
    const sx = srcRect.x + Math.max(0, Math.min(srcRect.w - cropW, cx - cropW / 2));
    const sy = srcRect.y + Math.max(0, Math.min(srcRect.h - cropH, cy - cropH / 2));

    // The whole source frame as the camera places it (for taps and clicks).
    const kx = rect.w / cropW;
    const ky = rect.h / cropH;
    const source = { x: rect.x - sx * kx, y: rect.y - sy * ky, w: fullW * kx, h: fullH * ky };
    this.screenMap = { source, screen: intersect(rect, { x: 0, y: 0, w: W, h: H }) };

    ctx.save();
    clip();
    ctx.drawImage(input.frame, sx, sy, cropW, cropH, rect.x, rect.y, rect.w, rect.h);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    // Touch indicators ride the camera: same clip, same zoom as the video.
    if (phone && this.project.tapStyle.show && phone.taps.length) {
      const ts = this.project.tapStyle;
      drawTouchIndicators(ctx, phone.taps, time, source, pointScaleFor(rect, phone.device) * cam.scale, {
        style: ts.style,
        color: ts.color === 'accent' ? ACCENT_TOUCH_COLOR : '#FFFFFF',
        sizePt: ts.sizePt,
      });
    }
    ctx.restore();

    // Overlays sit on the part of the screen that is on the canvas.
    const visible = this.screenMap.screen;

    // 3. Cursor (full-source normalized → crop-relative → rect pixels).
    const dot = (px: number, py: number, d: number, fill: string) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.ellipse(px, py, d / 2, d / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    };
    const toPx = (p: Point) => ({
      x: rect.x + ((p.x * fullW - sx) / cropW) * rect.w,
      y: rect.y + ((p.y * fullH - sy) / cropH) * rect.h,
    });
    const d = H * style.cursorSize;
    const showCursor = style.cursorShow !== false;
    const op = Math.min(1, Math.max(0, style.cursorOpacity ?? 0.85));
    const alphaHex = (a: number) => Math.round(255 * a).toString(16).padStart(2, '0');
    if (showCursor && input.cursorTrail?.length) {
      const n = input.cursorTrail.length;
      for (let i = 0; i < n; i++) {
        const t = (i + 1) / n; // fade oldest→newest
        const { x, y } = toPx(input.cursorTrail[i]);
        dot(x, y, d * (0.4 + 0.6 * t), `${style.cursorHex}${alphaHex(Math.min(1, 0.4 * t * (op / 0.85)))}`);
      }
    }
    if (showCursor && input.cursor) {
      const { x, y } = toPx(input.cursor);
      dot(x, y, d, `${style.cursorHex}${alphaHex(op)}`);
    }

    // 4. Click ripples — same full-source→crop-relative mapping.
    for (const r of input.ripples) {
      const rx = rect.x + ((r.position.x * fullW - sx) / cropW) * rect.w;
      const ry = rect.y + ((r.position.y * fullH - sy) / cropH) * rect.h;
      const maxR = H * 0.055;
      const rad = maxR * (0.25 + 0.75 * r.progress);
      const alpha = Math.max(0, 0.75 * (1 - r.progress));
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = Math.max(1.5, H * 0.002);
      ctx.beginPath();
      ctx.ellipse(rx, ry, rad, rad, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${alpha * 0.35})`;
      ctx.beginPath();
      ctx.ellipse(rx, ry, rad * 0.45, rad * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 5. The camera bubble, wherever it was placed (shared/cameraOverlay).
    const overlay = this.project.cameraOverlay;
    this.cameraRect = overlay.enabled ? overlayRect(overlay, visible, { width: W, height: H }) : null;
    if (this.cameraRect && input.cameraFrame) {
      const { x: ox, y: oy, w: d } = this.cameraRect;
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${style.shadowOpacity})`;
      ctx.shadowBlur = style.shadowRadius * 0.4;
      ctx.beginPath();
      if (overlay.circular) {
        ctx.ellipse(ox + d / 2, oy + d / 2, d / 2, d / 2, 0, 0, Math.PI * 2);
      } else {
        roundedPath(ctx, ox, oy, d, d, d * 0.18);
      }
      ctx.clip();
      // Cover-crop the camera frame to square.
      const cf = input.cameraFrame as CanvasImageSource;
      const fw = (cf as HTMLVideoElement).videoWidth || (cf as HTMLCanvasElement).width || 1;
      const fh = (cf as HTMLVideoElement).videoHeight || (cf as HTMLCanvasElement).height || 1;
      const side = Math.min(fw, fh);
      ctx.drawImage(cf, (fw - side) / 2, (fh - side) / 2, side, side, ox, oy, d, d);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = Math.max(1.5, d * 0.02);
      ctx.beginPath();
      if (overlay.circular) {
        ctx.ellipse(ox + d / 2, oy + d / 2, d / 2, d / 2, 0, 0, Math.PI * 2);
      } else {
        roundedPath(ctx, ox, oy, d, d, d * 0.18);
      }
      ctx.stroke();
    }

    // 6. The phone layer, beside the screen or over its corner.
    if (this.phoneLayer && this.phoneRect) this.drawPhoneLayer(this.phoneRect, input.phoneFrame);

    // 7. Keystroke keycaps, bottom-left inside the content frame.
    if (input.keystrokes?.length) this.drawKeystrokes(input.keystrokes, visible, H);

    // 8. Device frame — hardware drawn over the screen's edge.
    if (phone && frameBody) {
      drawDeviceFrame(ctx, frameBody, phone.device, this.project.device.finishId, { orientation: phone.orientation });
    }

    // 9. Text overlays and the caption pill, above the hardware so the
    // frame never cuts through them.
    for (const a of this.project.annotations ?? []) {
      if (time >= a.start && time <= a.end) this.drawAnnotation(a, visible, H);
    }
    const cue = this.project.captions.find((c) => c.start <= time && time <= c.end);
    if (cue && cue.text) this.drawCaption(cue, visible, W, H);

    // 10. Title card beside the phone.
    const title = this.project.layout.titleCard;
    if (layout?.title && title?.title.trim()) {
      drawTitleCard(
        ctx,
        layout.title,
        { title: title.title, subtitle: title.subtitle },
        { align: layout.titleTextAlign, valign: layout.titleAlign },
      );
    }
  }

  /** The phone's video in `box`: inside its hardware frame, or as a floating
   *  screen with the device's own corners. Black until its first frame loads. */
  private drawPhoneLayer(box: Rect, frame?: CanvasImageSource) {
    const { ctx } = this;
    const layer = this.phoneLayer!;
    const o = this.project.phoneOverlay;
    const opts = { orientation: layer.orientation };
    let screen: Rect;
    let clip: () => void;
    if (o.frame) {
      screen = screenRectFor(box, layer.device, opts);
      clip = () => clipToScreen(ctx, box, layer.device, opts);
    } else {
      screen = box;
      const r = screenCornerRadiusFor(box, layer.device);
      if (o.shadow) {
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.38)';
        ctx.shadowBlur = Math.max(box.w, box.h) * 0.06;
        ctx.shadowOffsetY = Math.max(box.w, box.h) * 0.025;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        continuousRectPath(ctx, box.x, box.y, box.w, box.h, r);
        ctx.fill();
        ctx.restore();
      }
      clip = () => {
        ctx.beginPath();
        continuousRectPath(ctx, box.x, box.y, box.w, box.h, r);
        ctx.clip();
      };
    }
    ctx.save();
    clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(screen.x, screen.y, screen.w, screen.h);
    if (frame) ctx.drawImage(frame, screen.x, screen.y, screen.w, screen.h);
    ctx.restore();
    if (o.frame) drawDeviceFrame(ctx, box, layer.device, o.finishId, { ...opts, shadow: o.shadow });
  }

  private drawBackground(W: number, H: number) {
    const { ctx } = this;
    const bg = this.project.style.background;
    if (isColourBackground(bg)) {
      paintBackdrop(ctx, bg, W, H);
    } else if (bg.kind === 'imageFile') {
      const img = backgroundImage(bg.path).img;
      if (img.complete && img.naturalWidth > 0) {
        const ar = W / H;
        const ir = img.naturalWidth / img.naturalHeight;
        let sw = img.naturalWidth;
        let sh = img.naturalHeight;
        if (ar > ir) sh = sw / ar;
        else sw = sh * ar;
        const blur = bg.blur ?? 0;
        if (blur > 0) {
          ctx.save();
          ctx.filter = `blur(${blur}px)`;
          // slight overscan hides the softened edges
          const m = blur;
          ctx.drawImage(
            img,
            (img.naturalWidth - sw) / 2,
            (img.naturalHeight - sh) / 2,
            sw, sh, -m, -m, W + m * 2, H + m * 2,
          );
          ctx.restore();
        } else {
          ctx.drawImage(
            img,
            (img.naturalWidth - sw) / 2,
            (img.naturalHeight - sh) / 2,
            sw, sh, 0, 0, W, H,
          );
        }
      } else {
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, W, H);
      }
    } else {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, W, H);
    }
  }

  private drawAnnotation(a: Annotation, rect: { x: number; y: number; w: number; h: number }, H: number) {
    const { ctx } = this;
    const fontSize = Math.max(20, H * 0.055);
    ctx.font = `800 ${fontSize}px -apple-system, sans-serif`;
    const tw = ctx.measureText(a.text).width;
    const x = rect.x + rect.w / 2 - tw / 2;
    const y = rect.y + (a.band === 0 ? rect.h * 0.12 : a.band === 1 ? rect.h * 0.47 : rect.h * 0.82);
    ctx.textBaseline = 'middle';
    ctx.lineWidth = fontSize * 0.12;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeText(a.text, x, y);
    ctx.fillStyle = a.hex;
    ctx.fillText(a.text, x, y);
  }

  private drawCaption(cue: CaptionCue, rect: { x: number; y: number; w: number; h: number }, W: number, H: number) {
    const { ctx } = this;
    // Sized to the screen it sits on, and wrapped so it never runs off it.
    const fontSize = Math.max(16, Math.min(H * 0.032, rect.w * 0.06));
    ctx.font = `600 ${fontSize}px -apple-system, sans-serif`;
    const maxW = Math.max(fontSize * 4, Math.min(rect.w * 0.9, W * 0.94));
    const lines = wrapText(ctx, cue.text, maxW).slice(0, 3);
    const padX = fontSize * 0.5;
    const padY = fontSize * 0.28;
    const lineH = fontSize * 1.3;
    const pw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
    const ph = lineH * lines.length + padY * 2;
    const px = rect.x + rect.w / 2 - pw / 2;
    const py = rect.y + rect.h - ph - Math.min(H * 0.03, rect.h * 0.06);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    roundedPath(ctx, px, py, pw, ph, Math.min(ph, lineH + padY * 2) / 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    lines.forEach((l, i) => ctx.fillText(l, px + pw / 2, py + padY + lineH * (i + 0.5)));
    ctx.textAlign = 'start';
  }

  private drawKeystrokes(keys: string[], rect: { x: number; y: number; w: number; h: number }, H: number) {
    const { ctx } = this;
    const fontSize = Math.max(14, H * 0.028);
    ctx.font = `600 ${fontSize}px -apple-system, sans-serif`;
    ctx.textBaseline = 'middle';
    const capH = fontSize * 1.8;
    const padX = fontSize * 0.45;
    const gap = fontSize * 0.3;
    const y = rect.y + rect.h - capH - H * 0.03;
    let x = rect.x + H * 0.03;
    for (const key of keys) {
      const label = keyLabel(key);
      const cw = Math.max(ctx.measureText(label).width + padX * 2, capH);
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      roundedPath(ctx, x, y, cw, capH, capH / 4);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + (cw - ctx.measureText(label).width) / 2, y + capH / 2);
      x += cw + gap;
    }
  }
}

/** Display label for a uiohook key name. */
function keyLabel(key: string): string {
  const map: Record<string, string> = {
    Space: 'Space',
    Enter: '↵',
    Return: '↵',
    Escape: 'esc',
    Backspace: '⌫',
    Delete: '⌦',
    Tab: '⇥',
    Shift: '⇧',
    ShiftRight: '⇧',
    Ctrl: '⌃',
    CtrlRight: '⌃',
    Alt: '⌥',
    AltRight: '⌥',
    Meta: '⌘',
    MetaRight: '⌘',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    CapsLock: '⇪',
  };
  if (map[key]) return map[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

/** Phone recordings: device, placement and taps for this project. */
function phoneSetup(project: Project): PhoneSetup | null {
  if (!isPhoneProject(project)) return null;
  const { device, orientation } = resolveDevice(project);
  const preset = layoutPreset(project);
  const tl = new Timeline(project.recording.duration, project.clips);
  const framedPreset = preset?.layout === 'framed';
  const layout = preset
    ? computePhoneLayout(preset, device, {
        // Frameless phones keep the floating placement; only App Store is full-bleed.
        deviceFrame: framedPreset,
        titleCard: preset.titleCard && !!project.layout.titleCard,
        orientation,
      })
    : null;
  return {
    device,
    orientation,
    preset,
    layout,
    frame: project.device.frame && (!preset || framedPreset),
    taps: tapsToOutput(project.taps, tl),
  };
}

/** A frameless phone screen's corner radius in canvas px: the device's own, scaled to `screen`. */
function screenCornerRadiusFor(screen: Rect, device: DeviceModel): number {
  return device.cornerRadiusPt * pointScaleFor(screen, device);
}

/** Largest rect of `aspect` centred in `into`. */
function fitAspect(into: Rect, aspect: number): Rect {
  const r = { ...into };
  if (into.w / into.h > aspect) {
    r.w = into.h * aspect;
    r.x = into.x + (into.w - r.w) / 2;
  } else {
    r.h = into.w / aspect;
    r.y = into.y + (into.h - r.h) / 2;
  }
  return r;
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

function roundedPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Greedy word wrap to `maxW` pixels in the context's current font. */
export function wrapText(ctx: { measureText(t: string): { width: number } }, text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(next).width > maxW) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}
