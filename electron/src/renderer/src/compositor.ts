// Canvas compositor — port of the RenderKit compositor. Draw order:
// background → screen frame (zoomed via camera, rounded corners, shadow)
// → software cursor → click ripples → caption pill.
import type { CaptionCue, Point, Project, Size } from '../../shared/types';
import { cameraAt, type AutofocusOptions, type FocusSegment } from '../../shared/autofocus';
import type { Ripple } from '../../shared/ripples';

export interface FrameInputs {
  frame: CanvasImageSource; // source frame at this output time
  cursor: Point | null; // normalized position, or null to hide
  ripples: Ripple[];
  cameraFrame?: CanvasImageSource;
}

export class CanvasCompositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

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
  }

  render(time: number, input: FrameInputs): void {
    const { ctx, canvas } = this;
    const { width: W, height: H } = canvas;
    const style = this.project.style;

    // 1. Background.
    this.drawBackground(W, H);

    // 2. Screen frame inside padded content rect, camera-cropped.
    const pad = Math.min(W, H) * style.paddingFraction;
    const contentRect = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 };
    // Fit source aspect inside content rect.
    const srcAspect = this.project.recording.sourceSize.width / this.project.recording.sourceSize.height;
    let rect = { ...contentRect };
    if (contentRect.w / contentRect.h > srcAspect) {
      rect.w = contentRect.h * srcAspect;
      rect.x = contentRect.x + (contentRect.w - rect.w) / 2;
    } else {
      rect.h = contentRect.w / srcAspect;
      rect.y = contentRect.y + (contentRect.h - rect.h) / 2;
    }

    const cam = cameraAt(time, this.focusSegments, this.autofocusOpts);

    // Camera crop in source space: center on cam.center, visible size =
    // source/scale — normalized → source pixels.
    const srcW = this.project.recording.sourceSize.width;
    const srcH = this.project.recording.sourceSize.height;
    const cropW = srcW / cam.scale;
    const cropH = srcH / cam.scale;
    const cx = cam.center.x * srcW;
    const cy = cam.center.y * srcH;
    const sx = Math.max(0, Math.min(srcW - cropW, cx - cropW / 2));
    const sy = Math.max(0, Math.min(srcH - cropH, cy - cropH / 2));

    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${style.shadowOpacity})`;
    ctx.shadowBlur = style.shadowRadius;
    roundedPath(ctx, rect.x, rect.y, rect.w, rect.h, style.cornerRadius);
    ctx.clip();
    // Source may not cover the full crop (edge clamp): scale crop→rect.
    ctx.drawImage(input.frame, sx, sy, cropW, cropH, rect.x, rect.y, rect.w, rect.h);
    ctx.restore();

    // 3. Cursor (source normalized → crop-relative → rect pixels).
    if (input.cursor) {
      const p = input.cursor;
      const cropRelX = (p.x * srcW - sx) / cropW;
      const cropRelY = (p.y * srcH - sy) / cropH;
      const cxp = rect.x + cropRelX * rect.w;
      const cyp = rect.y + cropRelY * rect.h;
      const d = H * 0.012;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.ellipse(cxp, cyp, d / 2, d / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 4. Click ripples — same normalized→crop-relative mapping.
    for (const r of input.ripples) {
      const rx = rect.x + ((r.position.x * srcW - sx) / cropW) * rect.w;
      const ry = rect.y + ((r.position.y * srcH - sy) / cropH) * rect.h;
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

    // 5. Camera overlay PiP in a corner of the content frame.
    const overlay = this.project.cameraOverlay;
    if (overlay.enabled && input.cameraFrame) {
      const d = Math.min(rect.w, rect.h) * overlay.sizeFraction;
      const margin = Math.min(rect.w, rect.h) * 0.04;
      const ox = /Right/.test(overlay.corner) ? rect.x + rect.w - d - margin : rect.x + margin;
      const oy = /bottom/i.test(overlay.corner) ? rect.y + rect.h - d - margin : rect.y + margin;
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

    // 6. Caption pill near content bottom.
    const cue = this.project.captions.find((c) => c.start <= time && time <= c.end);
    if (cue && cue.text) this.drawCaption(cue, rect, W, H);
  }

  private drawBackground(W: number, H: number) {
    const { ctx } = this;
    const bg = this.project.style.background;
    if (bg.kind === 'solid') {
      ctx.fillStyle = bg.hex;
      ctx.fillRect(0, 0, W, H);
    } else if (bg.kind === 'gradient') {
      const rad = (bg.angle * Math.PI) / 180;
      const x0 = W / 2 - (Math.cos(rad) * W) / 2;
      const y0 = H / 2 - (Math.sin(rad) * H) / 2;
      const x1 = W / 2 + (Math.cos(rad) * W) / 2;
      const y1 = H / 2 + (Math.sin(rad) * H) / 2;
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, bg.startHex);
      g.addColorStop(1, bg.endHex);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, W, H);
    }
  }

  private drawCaption(cue: CaptionCue, rect: { x: number; y: number; w: number; h: number }, W: number, H: number) {
    const { ctx } = this;
    const fontSize = Math.max(16, H * 0.032);
    ctx.font = `600 ${fontSize}px -apple-system, sans-serif`;
    const tw = ctx.measureText(cue.text).width;
    const padX = fontSize * 0.5;
    const padY = fontSize * 0.28;
    const pw = tw + padX * 2;
    const ph = fontSize * 1.35 + padY * 2;
    const px = rect.x + rect.w / 2 - pw / 2;
    const py = rect.y + rect.h - ph - H * 0.03;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    roundedPath(ctx, px, py, pw, ph, ph / 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(cue.text, px + padX, py + ph / 2);
  }
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
