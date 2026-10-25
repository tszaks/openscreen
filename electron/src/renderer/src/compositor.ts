// Canvas compositor — port of the RenderKit compositor. It draws the
// background, then every canvas layer (shared/canvasLayers) in the project's
// order: the recording (zoomed via camera, rounded corners, shadow, with the
// software cursor and click ripples), the camera bubble, the phone layer,
// text overlays and the title card, with the caption pill docked on the
// recording. Each layer's box is reported in `layers` for the editor.
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
//
// A 3D phone (project.phone3d, when phone3dActive) is drawn by the WebGL
// engine (phone3d/, loaded lazily) at the content layer's slot: the screen
// content goes into the engine's screen texture through the same
// drawScreenContent, the engine renders the phone and its shadow over the
// ROI, and the result is copied 1:1. Placement, contentRect, the camera
// bubble, text, title and captions are exactly as flat; only the hardware
// frame is not drawn. Until the engine has loaded the preview draws flat.
import type { Annotation, CaptionCue, Point, Project, Size } from '../../shared/types';
import { cameraAt, type AutofocusOptions, type FocusSegment } from '../../shared/autofocus';
import { getFinish, type DeviceModel, type Orientation } from '../../shared/devices';
import type { ExportPreset } from '../../shared/exportPresets';
import type { TapSuggestion } from '../../shared/taps';
import { Timeline } from '../../shared/timeline';
import { isPhoneProject, layoutPreset, presetAllowsZoom, resolveDevice, tapsToOutput } from '../../shared/mobileProject';
import {
  clipToScreen,
  continuousRectPath,
  deviceBodyRect,
  drawCutouts,
  drawDeviceFrame,
  pointScaleFor,
  screenRectFor,
  type Rect,
} from './mobile/deviceFrame';
import { ACCENT_TOUCH_COLOR, drawTouchIndicators, PHONE3D_TOUCH, PHONE3D_TOUCH_SIZE } from './mobile/tapIndicator';
import { computePhoneLayout, drawBlurredBackground, drawTitleCard, type PhoneLayout } from './mobile/layout';
import type { Ripple } from '../../shared/ripples';
import { fileUrl } from '../../shared/fileUrl';
import { isColourBackground, paintBackdrop } from './backdrop';
import { phoneAspect, phoneDevice, phoneLayerOn, phoneLayerRects, type PhoneDevice } from '../../shared/phoneLayer';
import { api } from './api';
import { macContentRect, macFittedRect, overlayRect } from '../../shared/cameraOverlay';
import { mapRect, placeContent } from '../../shared/contentTransform';
import { layerOrder, textLayer, type LayerBox, type LayerId } from '../../shared/canvasLayers';
import type { TextBox } from '../../shared/textBoxes';
import { phone3dActive } from '../../shared/phone3d/placement';
import {
  bodyHull,
  canvasToScreenUV,
  MIN_HIT_FACING,
  scene3d,
  screenMap3d,
  screenUVToCanvas,
  zoomViewAt,
  type Scene3D,
  type ScreenMap3D,
  type View2D,
} from '../../shared/phone3d/projection';
import { engineSync, ensurePhone3d } from './phone3d/loader';
import { finish3dHex } from './phone3d/finishes3d';
import type { Render3DResult } from './phone3d/view';

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
  /**
   * How to render a 3D phone (export, frames and the paused preview). Absent:
   * the live preview (one sample, no motion blur, supersample 1).
   * `quality: 'full'` turns on the 8 jittered anti-aliasing samples and the
   * adaptive motion-blur count; 'draft' renders one sample. `strict` (export
   * and frames) never falls back to a flat phone: a missing engine or a lost
   * GPU sets `error3d` instead.
   */
  render3d?: Render3DSettings;
}

export interface Render3DSettings {
  ss: 1 | 2 | 3;
  quality: 'full' | 'draft';
  motionBlur: { samples: number; shutter: number } | null;
  fps: number;
  strict: boolean;
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
  /** A 3D phone's screen as drawn (quad, facing, homography), with the flat
   *  screen rect `source` was placed against; absent when flat. */
  phone3d?: { map: ScreenMap3D; flat: Rect };
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
  /** What the camera bubble's size is measured against at the last render:
   *  the visible screen where the layout fits it, before any hand move. */
  cameraBasis: Rect | null = null;
  /** Filled by render(); see ScreenMap. */
  screenMap: ScreenMap | null = null;
  /** The recording's box as placed at the last render (its frame body when
   *  framed), which the editor selects, moves and resizes; null when it
   *  can't be moved (App Store previews). */
  contentRect: Rect | null = null;
  /** The same box where the layout fits it, before the hand move (scale 1). */
  contentBase: Rect | null = null;
  /** The phone layer's box where its layout puts it, before its hand move. */
  phoneBase: Rect | null = null;
  /** Every layer drawn at the last render, bottom to top (shared/canvasLayers). */
  layers: LayerBox[] = [];
  /** Every text box drawn at the last render (captions, keycaps, text
   *  overlays, the title card), in drawing order, canvas px. Read-only
   *  reporting: filling it changes no drawing (shared/textBoxes). */
  textBoxes: TextBox[] = [];
  /** Set by a strict render (export, frames) that could not draw the 3D phone; the caller aborts. */
  error3d: string | null = null;
  /** The 3D phone's scene when phone3dActive (else null): placement, pose sampler, body data. */
  private scene3d: Scene3D | null;
  /** Whether the last render drew the phone in 3D. */
  drew3d = false;

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
    this.scene3d = phone3dActive(project).active ? scene3d(project, canvasSize) : null;
    // Zooms on a 3D phone push the 3D camera in (owner decision 20); the screen itself always shows the whole
    // recording, 1:1.
    if (this.scene3d && this.zoomOn) {
      const s3 = this.scene3d;
      s3.viewAt = (t) => this.zoomView3d(s3, t);
    }
  }

  /**
   * The 3D camera's push-in for the zoom at output time t (owner decision 20): the same zoom segments, easing and
   * timing as a flat zoom (cameraAt), aimed at the centre of what the flat zoom would show (the clamped crop) and
   * capped so the phone stays whole on the canvas (projection.ts zoomViewAt, ZOOM_PUSH). Null when no zoom plays.
   */
  private zoomView3d(s3: Scene3D, t: number): View2D | null {
    const cam = cameraAt(t, this.focusSegments, this.autofocusOpts);
    if (!(cam.scale > 1 + 1e-6)) return null;
    const fullW = this.project.recording.sourceSize.width;
    const fullH = this.project.recording.sourceSize.height;
    const crop = this.project.style.cropRect;
    const all = sourceCrop(crop, fullW, fullH, { center: { x: 0.5, y: 0.5 }, scale: 1 });
    const z = sourceCrop(crop, fullW, fullH, cam);
    const uv = { x: (z.sx + z.cropW / 2 - all.sx) / all.cropW, y: (z.sy + z.cropH / 2 - all.sy) / all.cropH };
    return zoomViewAt(s3, t, cam.scale, uv, this.zoomScaleMax());
  }

  /** The strongest zoom in the project (the push-in's full strength, zoomViewAt's kMax). */
  private zoomScaleMax(): number {
    let m = 1;
    for (const seg of this.focusSegments) m = Math.max(m, seg.scale);
    return m;
  }

  /** Whether this project draws a 3D phone (phone3dActive and a framed phone on this canvas). */
  get has3d(): boolean {
    return this.scene3d !== null;
  }

  /** Resolves once the 3D engine is loaded (at once for a flat project). Export and frames await it before frame 0. */
  async prepare3d(): Promise<void> {
    if (this.scene3d) await ensurePhone3d();
  }

  /** After a strict render lost the GPU: waits up to `ms` for the context to come back. True when it did. */
  async recover3d(ms = 3000): Promise<boolean> {
    const engine = engineSync();
    return engine ? engine.waitForRestore(ms) : false;
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
    if (m.phone3d) {
      // Through the turned screen (an exact homography), back to where the flat screen would be.
      const uv = canvasToScreenUV(m.phone3d.map, px, py);
      if (!uv) return null;
      const f = m.phone3d.flat;
      const fx = f.x + uv.x * f.w;
      const fy = f.y + uv.y * f.h;
      return { x: (fx - v.x) / v.w, y: (fy - v.y) / v.h };
    }
    if (px < s.x || py < s.y || px > s.x + s.w || py > s.y + s.h) return null;
    return { x: (px - v.x) / v.w, y: (py - v.y) / v.h };
  }

  /** Normalized full-source coords → canvas px, using the last render. */
  sourceToCanvas(p: Point): Point | null {
    const m = this.screenMap;
    if (!m) return null;
    const flat = { x: m.source.x + p.x * m.source.w, y: m.source.y + p.y * m.source.h };
    if (!m.phone3d) return flat;
    const { map, flat: f } = m.phone3d;
    if (map.facing < MIN_HIT_FACING) return null;
    return screenUVToCanvas(map, (flat.x - f.x) / f.w, (flat.y - f.y) / f.h);
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

    // The 3D phone draws only when its engine is loaded (the preview draws flat until then).
    this.error3d = null;
    this.drew3d = false;
    this.textBoxes = [];
    const strict3d = !!input.render3d?.strict;
    const engine = this.scene3d ? engineSync() : null;
    if (this.scene3d && !engine) {
      if (strict3d) this.error3d = 'the 3D renderer is not loaded';
      ensurePhone3d().catch(() => {});
    }

    // 1. Background.
    if (phone && this.project.layout.background === 'blurred') {
      drawBlurredBackground(ctx, input.frame, { width: fullW, height: fullH }, { width: W, height: H });
    } else {
      this.drawBackground(W, H);
    }
    // A 3D phone's depth of field can soften the backdrop too (dof.background).
    const p3 = this.scene3d?.p3;
    if (engine && p3?.dof.on && p3.dof.background > 0) {
      ctx.save();
      ctx.filter = `blur(${p3.dof.background * 0.012 * H}px)`;
      ctx.drawImage(canvas, 0, 0);
      ctx.restore();
    }

    // 2. Where the screen goes, and how to clip to it. The layout fits it
    // (`base`, the frame body or the screen); a hand move or resize
    // (style.contentTransform) then places that rect, and the screen inside
    // it rides along.
    const canvasSize = { width: W, height: H };
    const t = style.contentTransform;
    let rect: Rect;
    let clip: () => void;
    let frameBody: Rect | null = null;
    // A frameless phone screen's drop shadow, drawn just before it.
    let shadow: (() => void) | null = null;
    // The screen where the layout fits it, before the hand move (sizes the camera bubble).
    let fittedScreen: Rect;
    this.contentRect = null;
    this.contentBase = null;
    this.phoneRect = null;
    this.phoneBase = null;
    if (layout && phone) {
      if (layout.mode === 'full-bleed') {
        // App Store previews fill the canvas with the app itself: never moved.
        rect = layout.screen;
        fittedScreen = rect;
        clip = () => {
          ctx.beginPath();
          ctx.rect(0, 0, W, H);
          ctx.clip();
        };
      } else if (phone.frame && layout.device) {
        const base = layout.device;
        const body = placeContent(base, t, canvasSize);
        frameBody = body;
        fittedScreen = layout.screen;
        rect = mapRect(layout.screen, base, body);
        this.contentBase = base;
        this.contentRect = body;
        clip = () => clipToScreen(ctx, body, phone.device, { orientation: phone.orientation });
      } else {
        // No hardware: a floating screen with the device's real corners.
        const base = layout.screen;
        const placed = placeContent(base, t, canvasSize);
        fittedScreen = base;
        rect = placed;
        this.contentBase = base;
        this.contentRect = placed;
        const r = layout.screenRadius * (placed.w / base.w);
        shadow = () => {
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.38)';
          ctx.shadowBlur = Math.max(placed.w, placed.h) * 0.06;
          ctx.shadowOffsetY = Math.max(placed.w, placed.h) * 0.025;
          ctx.fillStyle = '#000';
          ctx.beginPath();
          continuousRectPath(ctx, placed.x, placed.y, placed.w, placed.h, r);
          ctx.fill();
          ctx.restore();
        };
        clip = () => {
          ctx.beginPath();
          continuousRectPath(ctx, placed.x, placed.y, placed.w, placed.h, r);
          ctx.clip();
        };
      }
    } else {
      const pad = Math.min(W, H) * style.paddingFraction;
      const contentRect = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 };
      if (phone?.frame) {
        // Phone in the classic padded frame: the body, fitted in the content rect.
        const opts = { orientation: phone.orientation };
        const base = deviceBodyRect(contentRect, phone.device, opts);
        const body = placeContent(base, t, canvasSize);
        frameBody = body;
        fittedScreen = screenRectFor(base, phone.device, opts);
        rect = screenRectFor(body, phone.device, opts);
        this.contentBase = base;
        this.contentRect = body;
        clip = () => clipToScreen(ctx, body, phone.device, opts);
      } else {
        const macAspect = style.cropRect ? (style.cropRect.w * fullW) / (style.cropRect.h * fullH) : fullW / fullH;
        // A phone layer beside the screen takes its share of the content rect first.
        const placed = this.phoneLayer ? phoneLayerRects(contentRect, macAspect, this.phoneLayer.aspect, this.project.phoneOverlay) : null;
        // The same rects the editor's snap guides and the bubble placement use.
        const base = macFittedRect(this.project, canvasSize);
        rect = macContentRect(this.project, canvasSize);
        fittedScreen = base;
        this.contentBase = base;
        this.contentRect = rect;
        // Beside the screen, the phone keeps its place; over its corner, it
        // moves with it. Then its own hand move and resize.
        this.phoneBase = placed ? (placed.arrangement === 'corner' ? mapRect(placed.phone, base, rect) : placed.phone) : null;
        this.phoneRect = this.phoneBase ? placeContent(this.phoneBase, this.project.phoneOverlay.transform, canvasSize) : null;
        const r = style.cornerRadius;
        const screen = rect;
        clip = () => {
          ctx.shadowColor = `rgba(0,0,0,${style.shadowOpacity})`;
          ctx.shadowBlur = style.shadowRadius;
          roundedPath(ctx, screen.x, screen.y, screen.w, screen.h, r);
          ctx.clip();
        };
      }
    }

    // A 3D phone never crops its own screen: a zoom pushes the 3D camera in instead (zoomView3d, owner decision 20),
    // so the screen keeps showing the whole recording, 1:1, and gets sharper as it gets bigger.
    const cam = this.zoomOn && !this.scene3d
      ? cameraAt(time, this.focusSegments, this.autofocusOpts)
      : { center: { x: 0.5, y: 0.5 }, scale: 1 };

    // The whole source frame as the camera places it (for taps and clicks).
    const { sx, sy, cropW, cropH } = sourceCrop(style.cropRect, fullW, fullH, cam);
    const kx = rect.w / cropW;
    const ky = rect.h / cropH;
    const source = { x: rect.x - sx * kx, y: rect.y - sy * ky, w: fullW * kx, h: fullH * ky };
    this.screenMap = { source, screen: intersect(rect, { x: 0, y: 0, w: W, h: H }) };

    // Overlays sit on the part of the screen that is on the canvas.
    const visible = this.screenMap.screen;

    // A 3D phone: plan it now (ROI, samples, screen texture, shadow); its tiles render and copy at the content slot.
    let phone3dOut: Extract<Render3DResult, { draw: unknown }> | null = null;
    const s3 = this.scene3d;
    if (engine && s3 && phone && frameBody) {
      const body = frameBody;
      const q = input.render3d;
      const out = engine.render({
        scene: s3,
        time,
        look: { hex: finish3dHex(phone.device, getFinish(phone.device, this.project.device.finishId)), back: s3.p3.back, glass: s3.p3.glass },
        bgMean: this.backgroundMean(),
        quality: {
          ss: q?.ss ?? 1,
          full: q?.quality === 'full',
          motion: q?.motionBlur ?? null,
          fps: q?.fps ?? this.project.outputFPS,
        },
        drawScreen: (tctx, dst, pxScale) => {
          // The screen content, clipped to the screen rect, then the island or notch on top.
          const clipDst = () => {
            tctx.beginPath();
            tctx.rect(dst.x, dst.y, dst.w, dst.h);
            tctx.clip();
          };
          this.drawScreenContent(tctx, dst, time, input, cam, { clip: clipDst, cursorOutsideClip: false, pxScale, phone3d: true });
          drawCutouts(tctx, mapRect(body, rect, dst), phone.device, { orientation: phone.orientation });
        },
      });
      if ('lost' in out) {
        if (strict3d) this.error3d = '3D renderer lost the GPU';
      } else {
        this.drew3d = true;
        if ('draw' in out) phone3dOut = out;
        const map = screenMap3d(s3, time);
        if (map) this.screenMap = { ...this.screenMap, phone3d: { map, flat: rect } };
      }
    }
    const use3d = this.drew3d;

    // The recording's own layer: the video, its touch indicators, cursor and ripples.
    const drawContent = () => {
      if (use3d) {
        // Tile by tile, each core 1:1 at integer coordinates (the output pass already did any supersample downsample).
        if (phone3dOut && !phone3dOut.draw((src, w, h, x, y) => ctx.drawImage(src, 0, 0, w, h, x, y, w, h)) && strict3d) {
          this.error3d = '3D renderer lost the GPU';
        }
        return;
      }
      shadow?.();
      this.drawScreenContent(ctx, rect, time, input, cam, { clip, cursorOutsideClip: true, pxScale: 1 });
    };

    // 5. Every layer, in the project's order (shared/canvasLayers). Each
    // reports the box it drew at, so the editor can pick and move it.
    const overlay = this.project.cameraOverlay;
    this.cameraBasis = intersect(fittedScreen, { x: 0, y: 0, w: W, h: H });
    this.cameraRect = overlay.enabled ? overlayRect(overlay, visible, canvasSize, this.cameraBasis) : null;
    const boxes = new Map<LayerId, LayerBox>();
    const draws = new Map<LayerId, () => void>([['content', drawContent]]);
    if (this.contentRect && this.contentBase) {
      const box: LayerBox = { id: 'content', rect: this.contentRect, base: this.contentBase };
      // A 3D phone keeps rect/base (move and resize math, D20); hit-testing and the outline use its drawn hull.
      if (use3d && s3) {
        const hull = bodyHull(s3, time);
        if (hull && hull.length >= 3) box.hull = hull;
      }
      boxes.set('content', box);
    }
    if (this.cameraRect && this.project.recording.cameraVideoFile) {
      boxes.set('camera', { id: 'camera', rect: this.cameraRect, round: overlay.circular, basis: this.cameraBasis });
    }
    if (this.cameraRect && input.cameraFrame) {
      const camRect = this.cameraRect;
      const camFrame = input.cameraFrame;
      draws.set('camera', () => this.drawCamera(camRect, camFrame));
    }
    // The phone layer, beside the screen or over its corner.
    if (this.phoneLayer && this.phoneRect && this.phoneBase) {
      const box = this.phoneRect;
      boxes.set('phone', { id: 'phone', rect: box, base: this.phoneBase });
      draws.set('phone', () => this.drawPhoneLayer(box, input.phoneFrame));
    }
    // Text overlays, above the hardware so the frame never cuts through them.
    for (const a of this.project.annotations ?? []) {
      if (a.hidden || !(time >= a.start && time <= a.end)) continue;
      const placed = this.annotationPlacement(a, visible, H, canvasSize);
      const id = textLayer(a.id);
      boxes.set(id, { id, rect: placed.rect, base: placed.base });
      draws.set(id, () => this.drawAnnotation(a, placed));
    }
    // The title card beside the phone.
    const title = this.project.layout.titleCard;
    if (layout?.title && title?.title.trim() && !title.hidden) {
      const base = layout.title;
      const placed = placeContent(base, title.transform, canvasSize);
      boxes.set('title', { id: 'title', rect: placed, base });
      draws.set('title', () => {
        const align = layout.titleTextAlign;
        const valign = layout.titleAlign;
        const own = layoutPreset({ ...this.project, exportPreset: undefined });
        const scale = own ? H / own.height : 1;
        const m = drawTitleCard(ctx, placed, { title: title.title, subtitle: title.subtitle }, { align, valign, scale });
        this.textBoxes.push({ kind: 'title', rect: { ...placed }, card: { ...m, align, valign } });
      });
    }
    // What rides on the recording: keystroke keycaps (bottom-left inside it)
    // and the device hardware drawn over the screen's edge.
    const decor = () => {
      if (input.keystrokes?.length) this.drawKeystrokes(input.keystrokes, visible, H);
      if (phone && frameBody && !use3d) drawDeviceFrame(ctx, frameBody, phone.device, this.project.device.finishId, { orientation: phone.orientation });
    };
    const cue = this.project.captions.find((c) => c.start <= time && time <= c.end);
    const captions = () => {
      if (cue && cue.text) this.drawCaption(cue, visible, W, H);
    };
    // In the order it has always had, the recording's extras go above the
    // camera and phone and captions sit under the title, exactly as before.
    // Reordered by hand, they ride on the recording and captions stay on top.
    const custom = !!this.project.layerOrder?.length;
    this.layers = [];
    for (const id of layerOrder(this.project)) {
      if (!custom && id === 'title') captions();
      draws.get(id)?.();
      if (custom ? id === 'content' : id === 'phone') decor();
      const box = boxes.get(id);
      if (box) this.layers.push(box);
    }
    if (custom) captions();
  }

  /**
   * The recording's screen content drawn into `dst`: the video (cropped and
   * zoomed by `cam`), its touch indicators, the cursor (trail and dot) and
   * click ripples. The flat path draws it on the canvas at the screen rect;
   * the 3D path draws it into the screen texture, with `dst` the screen rect
   * in texture space. Overlay sizes that follow the canvas height (cursor,
   * ripples) are multiplied by `pxScale`, the texture's texels per canvas px
   * (1 on the canvas), so they come out the same size once mapped back.
   * `clip` sets the screen clip; the cursor and ripples are drawn outside it
   * when `cursorOutsideClip` (the flat path, as it always has), else inside.
   */
  private drawScreenContent(
    ctx: CanvasRenderingContext2D,
    dst: Rect,
    time: number,
    input: FrameInputs,
    cam: { center: Point; scale: number },
    opts: { clip: () => void; cursorOutsideClip: boolean; pxScale: number; phone3d?: boolean },
  ): void {
    const { phone } = this;
    const H = this.canvas.height;
    const style = this.project.style;
    const fullW = this.project.recording.sourceSize.width;
    const fullH = this.project.recording.sourceSize.height;
    const { pxScale } = opts;
    // Camera crop: camera center is normalized over the FULL source —
    // remapped into effective-source space, then the zoom scale applied.
    const { sx, sy, cropW, cropH } = sourceCrop(style.cropRect, fullW, fullH, cam);
    // The whole source frame as the camera places it in `dst`.
    const kx = dst.w / cropW;
    const ky = dst.h / cropH;
    const source = { x: dst.x - sx * kx, y: dst.y - sy * ky, w: fullW * kx, h: fullH * ky };

    ctx.save();
    opts.clip();
    ctx.drawImage(input.frame, sx, sy, cropW, cropH, dst.x, dst.y, dst.w, dst.h);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    // Touch indicators ride the camera: same clip, same zoom as the video.
    if (phone && this.project.tapStyle.show && phone.taps.length) {
      const ts = this.project.tapStyle;
      drawTouchIndicators(ctx, phone.taps, time, source, pointScaleFor(dst, phone.device) * cam.scale, {
        style: ts.style,
        color: ts.color === 'accent' ? ACCENT_TOUCH_COLOR : '#FFFFFF',
        sizePt: ts.sizePt * (opts.phone3d ? PHONE3D_TOUCH_SIZE : 1),
        // On a 3D phone: a smaller, softer press, kept inside the screen.
        ...(opts.phone3d ? PHONE3D_TOUCH : {}),
      });
    }
    if (opts.cursorOutsideClip) ctx.restore();

    // 3. Cursor (full-source normalized → crop-relative → dst pixels).
    const dot = (px: number, py: number, d: number, fill: string) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.ellipse(px, py, d / 2, d / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    };
    const toPx = (p: Point) => ({
      x: dst.x + ((p.x * fullW - sx) / cropW) * dst.w,
      y: dst.y + ((p.y * fullH - sy) / cropH) * dst.h,
    });
    const d = H * style.cursorSize * pxScale;
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
      const rx = dst.x + ((r.position.x * fullW - sx) / cropW) * dst.w;
      const ry = dst.y + ((r.position.y * fullH - sy) / cropH) * dst.h;
      const maxR = H * 0.055 * pxScale;
      const rad = maxR * (0.25 + 0.75 * r.progress);
      const alpha = Math.max(0, 0.75 * (1 - r.progress));
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = Math.max(1.5, H * 0.002) * pxScale;
      ctx.beginPath();
      ctx.ellipse(rx, ry, rad, rad, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${alpha * 0.35})`;
      ctx.beginPath();
      ctx.ellipse(rx, ry, rad * 0.45, rad * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!opts.cursorOutsideClip) ctx.restore();
  }

  /** The camera bubble's video in its square: a round or soft-cornered cut of the frame. */
  private drawCamera(rect: Rect, cameraFrame: CanvasImageSource) {
    const { ctx } = this;
    const style = this.project.style;
    const overlay = this.project.cameraOverlay;
    const { x: ox, y: oy, w: d } = rect;
    const bubblePath = () => {
      ctx.beginPath();
      if (overlay.circular) ctx.ellipse(ox + d / 2, oy + d / 2, d / 2, d / 2, 0, 0, Math.PI * 2);
      else roundedPath(ctx, ox, oy, d, d, d * 0.18);
    };
    // Depth from a soft shadow, never an outline. The shadow comes from a
    // fill drawn before the clip; a shadow cast inside the clip is cut off.
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${style.shadowOpacity})`;
    ctx.shadowBlur = style.shadowRadius * 0.4;
    ctx.shadowOffsetY = d * 0.02;
    ctx.fillStyle = '#000';
    bubblePath();
    ctx.fill();
    ctx.restore();
    ctx.save();
    bubblePath();
    ctx.clip();
    // Cover-crop the camera frame to square.
    const cf = cameraFrame;
    const fw = (cf as HTMLVideoElement).videoWidth || (cf as HTMLCanvasElement).width || 1;
    const fh = (cf as HTMLVideoElement).videoHeight || (cf as HTMLCanvasElement).height || 1;
    const side = Math.min(fw, fh);
    ctx.drawImage(cf, (fw - side) / 2, (fh - side) / 2, side, side, ox, oy, d, d);
    ctx.restore();
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

  /** The backdrop's mean colour, linear RGB (the 3D environment's floor bounce). A pure function of the
   *  project's background: colour backdrops are painted small and averaged; an image or the blurred
   *  recording (which change with the media) count as a neutral grey. */
  private backgroundMean(): readonly [number, number, number] {
    const bg = this.project.style.background;
    if (this.project.layout.background === 'blurred' || !isColourBackground(bg)) return NEUTRAL_BG;
    const key = JSON.stringify(bg);
    let mean = bgMeans.get(key);
    if (!mean) {
      mean = NEUTRAL_BG;
      try {
        const c = document.createElement('canvas');
        c.width = 16;
        c.height = 16;
        const sctx = c.getContext('2d', { willReadFrequently: true });
        if (sctx) {
          paintBackdrop(sctx, bg, 16, 16);
          const d = sctx.getImageData(0, 0, 16, 16).data;
          const acc = [0, 0, 0];
          for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) acc[k] += srgbToLinear(d[i + k] / 255);
          const n = d.length / 4;
          mean = [acc[0] / n, acc[1] / n, acc[2] / n];
        }
      } catch {
        mean = NEUTRAL_BG;
      }
      bgMeans.set(key, mean);
    }
    return mean;
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

  /** Where a text overlay goes: its band in the recording (`base`), then its hand move and resize. */
  private annotationPlacement(a: Annotation, rect: Rect, H: number, canvas: Size) {
    const { ctx } = this;
    const fontSize = Math.max(20, H * 0.055);
    ctx.font = `800 ${fontSize}px -apple-system, sans-serif`;
    const tw = ctx.measureText(a.text).width;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + (a.band === 0 ? rect.h * 0.12 : a.band === 1 ? rect.h * 0.47 : rect.h * 0.82);
    const base = { x: cx - tw / 2, y: cy - fontSize * 0.6, w: tw, h: fontSize * 1.2 };
    const placed = placeContent(base, a.transform, canvas);
    return { base, rect: placed, fontSize: fontSize * (base.w > 0 ? placed.w / base.w : 1) };
  }

  private drawAnnotation(a: Annotation, at: { rect: Rect; fontSize: number }) {
    const { ctx } = this;
    const { fontSize } = at;
    this.textBoxes.push({ kind: 'annotation', rect: { ...at.rect } });
    ctx.font = `800 ${fontSize}px -apple-system, sans-serif`;
    const x = at.rect.x;
    const y = at.rect.y + at.rect.h / 2;
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
    this.textBoxes.push({ kind: 'caption', rect: { x: px, y: py, w: pw, h: ph } });
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
      this.textBoxes.push({ kind: 'keycap', rect: { x, y, w: cw, h: capH } });
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

const NEUTRAL_BG = [0.18, 0.18, 0.18] as const;
/** Backdrop means by background (JSON), shared by every compositor. */
const bgMeans = new Map<string, readonly [number, number, number]>();
const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

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

/** The part of the source the camera shows: the user crop (normalized →
 *  px) or the full frame, zoomed by `cam` (centre normalized over the FULL
 *  source) and kept inside the crop. */
function sourceCrop(
  cropRect: Project['style']['cropRect'],
  fullW: number,
  fullH: number,
  cam: { center: Point; scale: number },
): { sx: number; sy: number; cropW: number; cropH: number } {
  // Effective source rect = user crop (normalized → px) or full source.
  const crop = cropRect;
  const srcRect = crop
    ? { x: crop.x * fullW, y: crop.y * fullH, w: crop.w * fullW, h: crop.h * fullH }
    : { x: 0, y: 0, w: fullW, h: fullH };
  const cropW = srcRect.w / cam.scale;
  const cropH = srcRect.h / cam.scale;
  const cx = cam.center.x * fullW - srcRect.x;
  const cy = cam.center.y * fullH - srcRect.y;
  const sx = srcRect.x + Math.max(0, Math.min(srcRect.w - cropW, cx - cropW / 2));
  const sy = srcRect.y + Math.max(0, Math.min(srcRect.h - cropH, cy - cropH / 2));
  return { sx, sy, cropW, cropH };
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
