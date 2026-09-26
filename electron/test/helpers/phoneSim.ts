// Synthetic iPhone screen recordings for tap-detection tests. Renders a
// 180x390 grayscale "app" (nav bar, scrolling list, tab bar, keyboard) at
// 30 fps with codec-like noise, performs scripted gestures, and records the
// ground truth of what the finger did.

import type { GrayFrame } from '../../src/shared/taps';

export const W = 180;
export const H = 390;
const FPS = 30;
const VIEW_TOP = 40;
const VIEW_BOTTOM = 356;
const ROW_H = 24;
const CONTENT_H = 1400;

export interface Truth {
  kind: 'tap' | 'swipe' | 'longpress' | 'typing';
  t: number;
  x: number;
  y: number;
  /** Swipe: sign of finger motion along its axis. */
  axis?: 'x' | 'y';
  sign?: number;
}

type Rect = [number, number, number, number, number]; // x, y, w, h, value

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

interface Page {
  rects: Rect[];
  rows: number;
  toggleRow: number;
}

function makePage(rand: () => number): Page {
  const rects: Rect[] = [];
  const rows = Math.floor(CONTENT_H / ROW_H);
  for (let i = 0; i < rows; i++) {
    const y = i * ROW_H;
    rects.push([10, y + 5, 14, 14, 110 + Math.floor(rand() * 90)]);
    rects.push([30, y + 6, 40 + Math.floor(rand() * 70), 5, 50 + Math.floor(rand() * 30)]);
    rects.push([30, y + 14, 25 + Math.floor(rand() * 50), 3, 150]);
    const aw = 18 + Math.floor(rand() * 18);
    rects.push([W - 10 - aw, y + 9, aw, 5, 60]);
    rects.push([30, y + ROW_H - 1, W - 30, 1, 222]);
  }
  return { rects, rows, toggleRow: 2 + Math.floor(rand() * 6) };
}

export class PhoneSim {
  frames: GrayFrame[] = [];
  truth: Truth[] = [];
  private rand: () => number;
  private page: Page;
  private prevPage: Page;
  private scroll = 0;
  private highlight: { row: number; value: number; shift: number } | null = null;
  private toggleOn = false;
  private togglePos = 0;
  private tab = 0;
  private keyboard = 0; // 0 hidden .. 1 shown
  private typed = 0;
  private pop: { x: number; y: number } | null = null;
  private spinner = -1;
  private menu = false;
  private menuRow: [number, number] = [0, 0];
  private pageShift = 0; // horizontal offset of the current page (push / back)
  private prevShift = 0;
  private fieldFocus = false;

  /** `noise`: per-pixel luma jitter amplitude (codec noise). */
  constructor(seed: number, private noise = 2) {
    this.rand = rng(seed);
    this.page = makePage(this.rand);
    this.prevPage = makePage(this.rand);
  }

  get now(): number {
    return this.frames.length / FPS;
  }

  private emit() {
    const buf = new Uint8Array(W * H);
    buf.fill(246);
    const fill = (x: number, y: number, w: number, h: number, v: number, clipTop = 0, clipBottom = H) => {
      const x0 = Math.max(0, Math.round(x));
      const x1 = Math.min(W, Math.round(x + w));
      const y0 = Math.max(clipTop, Math.round(y));
      const y1 = Math.min(clipBottom, Math.round(y + h));
      for (let yy = y0; yy < y1; yy++) buf.fill(v, yy * W + x0, yy * W + x1);
    };
    const drawPage = (p: Page, dx: number, isCurrent: boolean) => {
      fill(dx, VIEW_TOP, W, VIEW_BOTTOM - VIEW_TOP, 246, VIEW_TOP, VIEW_BOTTOM);
      const top = VIEW_TOP - (isCurrent ? this.scroll : 0);
      if (isCurrent && this.highlight) {
        fill(dx, top + this.highlight.row * ROW_H, W, ROW_H, this.highlight.value, VIEW_TOP, VIEW_BOTTOM);
      }
      for (const [x, y, w, h, v] of p.rects) {
        const row = Math.floor(y / ROW_H);
        const sx = isCurrent && this.highlight && this.highlight.row === row ? this.highlight.shift : 0;
        const yy = top + y;
        if (yy + h < VIEW_TOP || yy > VIEW_BOTTOM) continue;
        fill(x + dx + sx, yy, w, h, v, VIEW_TOP, VIEW_BOTTOM);
      }
      if (isCurrent) {
        // Toggle switch on one row.
        const ty = top + p.toggleRow * ROW_H + 6;
        fill(W - 38 + dx, ty, 24, 12, this.toggleOn ? 90 : 205, VIEW_TOP, VIEW_BOTTOM);
        fill(W - 37 + dx + this.togglePos * 12, ty + 1, 10, 10, 255, VIEW_TOP, VIEW_BOTTOM);
      }
    };
    if (this.prevShift !== 0 || this.pageShift !== 0) drawPage(this.prevPage, this.prevShift, false);
    drawPage(this.page, this.pageShift, true);
    // Search field under the nav bar.
    fill(8, VIEW_TOP + 2, W - 16, 14, this.fieldFocus ? 205 : 228, VIEW_TOP, VIEW_BOTTOM);
    for (let i = 0; i < this.typed; i++) fill(14 + i * 5, VIEW_TOP + 6, 3, 6, 40);
    // Spinner (loops every 8 frames).
    if (this.spinner >= 0) {
      const a = (this.spinner % 8) / 8;
      fill(W / 2 - 6, 200, 12, 12, 246);
      fill(W / 2 - 1 + Math.round(Math.cos(a * 6.283) * 4), 205 + Math.round(Math.sin(a * 6.283) * 4), 3, 3, 90);
      fill(W / 2 - 1 - Math.round(Math.cos(a * 6.283) * 4), 205 - Math.round(Math.sin(a * 6.283) * 4), 3, 3, 170);
      this.spinner++;
    }
    // Nav bar + status bar (static chrome).
    fill(0, 0, W, VIEW_TOP, 250);
    fill(12, 6, 20, 6, 30);
    fill(W - 34, 6, 22, 6, 30);
    fill(60, 26, 60, 7, 30);
    // Tab bar.
    fill(0, VIEW_BOTTOM, W, H - VIEW_BOTTOM, 250);
    // Selected tab is tinted; the tint is darker in luma than the unselected grey.
    for (let i = 0; i < 4; i++) fill(18 + i * 42, 364, 18, 12, i === this.tab ? 95 : 150);
    // Keyboard slides up from the bottom.
    if (this.keyboard > 0) {
      const kbTop = Math.round(H - 140 * this.keyboard);
      fill(0, kbTop, W, H - kbTop, 205);
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 10; c++) fill(3 + c * 17.5, kbTop + 10 + r * 30, 14, 22, 252);
        fill(4, kbTop + 10 + r * 30 + 8, 6, 5, 60 + r * 20);
      }
      if (this.pop) {
        fill(this.pop.x - 9, this.pop.y - 34, 18, 30, 255);
        fill(this.pop.x - 3, this.pop.y - 24, 6, 9, 40);
      }
    }
    // Context menu over dimmed content.
    if (this.menu) {
      // The pressed row stays sharp above the dimmed screen.
      const keep = this.menuRow;
      for (let y = VIEW_TOP; y < VIEW_BOTTOM; y++) {
        if (y >= keep[0] && y < keep[1]) continue;
        for (let x = 0; x < W; x++) buf[y * W + x] = Math.round(buf[y * W + x] * 0.55);
      }
      // The menu opens beside the preview, never over it.
      const my = keep[0] < 200 ? keep[1] + 6 : keep[0] - 116;
      fill(30, my, 120, 110, 240);
      for (let k = 0; k < 4; k++) fill(40, my + 12 + k * 26, 60, 6, 40);
    }
    // Codec-ish noise.
    for (let i = 0; i < buf.length; i++) {
      const n = Math.floor(this.rand() * (this.noise * 2 + 1)) - this.noise;
      buf[i] = Math.max(0, Math.min(255, buf[i] + n));
    }
    this.frames.push({ t: this.frames.length / FPS, w: W, h: H, data: buf });
  }

  hold(sec: number) {
    const n = Math.round(sec * FPS);
    for (let i = 0; i < n; i++) this.emit();
  }

  private anim(sec: number, step: (p: number) => void) {
    const n = Math.max(1, Math.round(sec * FPS));
    for (let i = 1; i <= n; i++) {
      step(i / n);
      this.emit();
    }
  }

  private visibleRow(): number {
    const first = Math.ceil((this.scroll + 30) / ROW_H);
    const last = Math.floor((this.scroll + VIEW_BOTTOM - VIEW_TOP - 40) / ROW_H);
    return first + Math.floor(this.rand() * Math.max(1, last - first));
  }

  private rowCenterY(row: number) {
    return (VIEW_TOP - this.scroll + row * ROW_H + ROW_H / 2) / H;
  }

  /** Tap a row: highlight, then push a new screen. */
  tapRow(opts: { spinner?: number } = {}) {
    const row = this.visibleRow();
    this.truth.push({ kind: 'tap', t: this.now, x: 0.5, y: this.rowCenterY(row) });
    this.highlight = { row, value: 214, shift: 0 };
    this.hold(0.15 + this.rand() * 0.2);
    // Push: new page slides in from the right, old one parallaxes left.
    this.prevPage = this.page;
    const next = makePage(this.rand);
    this.anim(0.35, (p) => {
      const e = 1 - (1 - p) ** 3;
      this.prevShift = -e * W * 0.3;
      this.pageShift = (1 - e) * W;
      if (this.page !== next) {
        this.page = next;
        this.highlight = null;
        this.scroll = 0;
      }
    });
    this.prevShift = 0;
    this.pageShift = 0;
    if (opts.spinner) {
      this.spinner = 0;
      this.hold(opts.spinner);
      this.spinner = -1;
      this.page = makePage(this.rand);
      this.emit();
    }
  }

  /** Flip the row's toggle: a small, local change with no navigation. */
  toggle() {
    const row = this.page.toggleRow;
    // Make sure the toggle row is on screen.
    if (this.rowCenterY(row) < 0.15 || this.rowCenterY(row) > 0.85) {
      this.scroll = 0;
      this.hold(0.6);
    }
    const y = (VIEW_TOP - this.scroll + row * ROW_H + 12) / H;
    this.truth.push({ kind: 'tap', t: this.now, x: (W - 26) / W, y });
    const on = !this.toggleOn;
    this.anim(0.22, (p) => {
      this.togglePos = on ? p : 1 - p;
      if (p > 0.3) this.toggleOn = on;
    });
  }

  /** Drag and fling the list. */
  scrollList() {
    const maxScroll = CONTENT_H - (VIEW_BOTTOM - VIEW_TOP);
    const up = this.scroll < maxScroll / 2 ? 1 : -1; // content moves up when scroll grows
    this.truth.push({ kind: 'swipe', t: this.now, x: 0.5, y: 0.5, axis: 'y', sign: up > 0 ? -1 : 1 });
    let v = 6 + this.rand() * 6;
    let pos = this.scroll;
    this.anim(0.25, () => {
      pos = Math.max(0, Math.min(maxScroll, pos + v * up));
      this.scroll = Math.round(pos);
    });
    while (v > 0.3) {
      v *= 0.86;
      pos = Math.max(0, Math.min(maxScroll, pos + v * up));
      this.scroll = Math.round(pos);
      this.emit();
    }
  }

  /** Tap a tab: the icon lights up and the content swaps in the same frame. */
  tabTap() {
    const next = (this.tab + 1 + Math.floor(this.rand() * 3)) % 4;
    this.truth.push({ kind: 'tap', t: this.now, x: (18 + next * 42 + 9) / W, y: 370 / H });
    this.tab = next;
    this.page = makePage(this.rand);
    this.scroll = 0;
    this.emit();
  }

  /** Tap the search field, type `n` keys, press return (keyboard hides). */
  type(n: number) {
    this.truth.push({ kind: 'tap', t: this.now, x: 0.5, y: (VIEW_TOP + 9) / H });
    this.fieldFocus = true;
    this.emit();
    this.hold(0.1);
    this.anim(0.3, (p) => (this.keyboard = 1 - (1 - p) ** 2));
    this.hold(0.5 + this.rand() * 0.4);
    const kbTop = H - 140;
    this.truth.push({ kind: 'typing', t: this.now, x: 0.5, y: 0.8 });
    for (let i = 0; i < n; i++) {
      const c = Math.floor(this.rand() * 10);
      const r = Math.floor(this.rand() * 3);
      this.pop = { x: 3 + c * 17.5 + 7, y: kbTop + 10 + r * 30 + 11 };
      this.typed++;
      this.hold(0.1);
      this.pop = null;
      this.hold(0.1 + this.rand() * 0.2);
    }
    // Return key, then the keyboard slides away.
    this.pop = { x: 150, y: kbTop + 10 + 3 * 30 + 11 };
    this.hold(0.1);
    this.pop = null;
    this.fieldFocus = false;
    this.anim(0.3, (p) => (this.keyboard = (1 - p) ** 2));
    this.keyboard = 0;
    this.typed = 0;
    this.emit();
  }

  /** Press and hold a row until the context menu appears. */
  longPress() {
    const row = this.visibleRow();
    this.truth.push({ kind: 'longpress', t: this.now, x: 0.5, y: this.rowCenterY(row) });
    // Touch-down highlight, held; the row eases into its lift.
    this.highlight = { row, value: 214, shift: 0 };
    this.anim(0.55, (p) => {
      this.highlight = { row, value: Math.round(214 - 10 * p), shift: Math.round(p * 3) };
    });
    const top = VIEW_TOP - this.scroll + row * ROW_H;
    this.menuRow = [top, top + ROW_H];
    this.menu = true;
    this.emit();
    this.hold(0.8);
    // Dismissed by tapping the dimmed background. Nothing local reacts to that
    // tap, so it is not detectable from pixels and is left out of the truth.
    this.menu = false;
    this.highlight = null;
    this.emit();
  }

  /** Edge-swipe back: the page follows the finger to the right. */
  swipeBack() {
    this.truth.push({ kind: 'swipe', t: this.now, x: 0.1, y: 0.5, axis: 'x', sign: 1 });
    const back = makePage(this.rand);
    this.prevPage = back;
    this.anim(0.4, (p) => {
      const e = p * p * (3 - 2 * p);
      this.pageShift = e * W;
      this.prevShift = -(1 - e) * W * 0.3;
    });
    this.page = back;
    this.pageShift = 0;
    this.prevShift = 0;
    this.scroll = 0;
    this.emit();
  }

  /** A random demo: `n` gestures separated by human pauses. */
  randomScript(n: number) {
    this.hold(0.8);
    const actions = ['tapRow', 'toggle', 'scroll', 'tab', 'type', 'longpress', 'back', 'spinner'] as const;
    for (let i = 0; i < n; i++) {
      const a = actions[Math.floor(this.rand() * actions.length)];
      if (a === 'tapRow') this.tapRow();
      else if (a === 'toggle') this.toggle();
      else if (a === 'scroll') this.scrollList();
      else if (a === 'tab') this.tabTap();
      else if (a === 'type') this.type(3 + Math.floor(this.rand() * 5));
      else if (a === 'longpress') this.longPress();
      else if (a === 'back') this.swipeBack();
      else this.tapRow({ spinner: 1.2 + this.rand() * 1.5 });
      this.hold(0.5 + this.rand() * 0.8);
    }
    this.hold(0.5);
  }
}
