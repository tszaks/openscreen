// Tap / swipe / long-press / typing suggestions from screen pixels alone.
//
// A wired iPhone capture has no touch data, and no shipping tool infers it
// (Screen Studio: "cannot record your finger taps"; Matte: manual on real
// devices). This module reads the recording itself: iOS reacts to a finger
// in characteristic ways, and those reactions show up as frame differences.
//
//  - Tap: a small, compact change (a row or button highlight) right after a
//    stable period, usually followed 150-600 ms later by a big change (push,
//    sheet, new screen). The finger was where the FIRST small change was.
//  - Long press: the pressed element keeps changing (the lift animation) for
//    ~0.5 s before a big change (the context menu).
//  - Swipe / scroll: a large region translating coherently between frames.
//    Direction and speed come from 1-D block matching.
//  - Typing: a run of key-pop changes in the bottom 40% (the keyboard);
//    collapsed into one marker instead of dozens of taps.
//
// Suggestions are meant to be edited on the taps track, never shipped blind;
// every one carries a confidence.
//
// Input frames come from ffmpeg (see tapAnalysisFfmpegArgs): grayscale,
// ~180 px wide, constant frame rate.

export interface GrayFrame {
  /** Seconds since recording start. */
  t: number;
  w: number;
  h: number;
  /** w*h luma bytes, row-major. */
  data: Uint8Array;
}

export type TapKind = 'tap' | 'swipe' | 'longpress' | 'typing';

export interface TapSuggestion {
  id: string;
  /** Touch-down time (s), already shifted slightly before the UI reacted. */
  t: number;
  /** Normalized 0..1 position on the screen. For swipes, the start point. */
  x: number;
  y: number;
  kind: TapKind;
  /** Swipe end point, normalized. */
  endX?: number;
  endY?: number;
  /** Seconds the finger was down (swipe drag, long press hold, typing run). */
  duration?: number;
  /** 0..1 */
  confidence: number;
  /** When the screen stopped changing after this gesture (s). Auto-zoom uses it. */
  settleT?: number;
}

export interface TapDetectOptions {
  /** Block edge in analysis pixels. */
  blockSize: number;
  /** Per-pixel luma difference that counts as change (absorbs codec noise). */
  pixelThreshold: number;
  /** Raise pixelThreshold above the recording's measured noise floor. */
  adaptiveThreshold: boolean;
  /** Fraction of a block's pixels that must change for the block to count. */
  blockFraction: number;
  /** Ignore the status bar band (fraction of height). The clock ticks there. */
  ignoreTop: number;
  /** Smallest component that can be a touch response (fraction of screen). */
  minTouchArea: number;
  /** Largest change still treated as "small" (fraction of screen). */
  maxTouchArea: number;
  /** Seconds of stillness required before a tap candidate. */
  minStable: number;
  /** Shift tap time this much earlier than the first visible response (s). */
  touchLead: number;
  /** Window after a tap in which a big change counts as its result (s). */
  followWindow: number;
  /** Bottom fraction of the screen where key pops mean typing. */
  keyboardTop: number;
  /** Minimum key pops for a typing run. */
  minKeyPops: number;
  /** Max gap between key pops in one typing run (s). */
  typingGap: number;
}

export const defaultTapDetect: TapDetectOptions = {
  blockSize: 6,
  pixelThreshold: 16,
  adaptiveThreshold: true,
  blockFraction: 0.1,
  ignoreTop: 0.055,
  minTouchArea: 0.002,
  maxTouchArea: 0.15,
  minStable: 0.15,
  touchLead: 0.075,
  followWindow: 0.7,
  keyboardTop: 0.6,
  minKeyPops: 3,
  typingGap: 1.2,
};

// ---------------------------------------------------------------------------
// Per-transition analysis

export interface ChangeComponent {
  /** Fraction of analysed blocks. */
  area: number;
  /** Normalized bounding box. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Normalized centroid, weighted by changed pixels. */
  cx: number;
  cy: number;
  /** Mean signed luma change of the changed pixels (small components only). */
  dl: number;
}

export type TransitionKind = 'static' | 'small' | 'large' | 'translate';

export interface Transition {
  /** Time of the frame where the change is visible. */
  t: number;
  kind: TransitionKind;
  /** Fraction of blocks changed. */
  changed: number;
  /** Components, largest first. */
  components: ChangeComponent[];
  /** Content displacement in analysis px (translate only). */
  dx: number;
  dy: number;
  /** Changed-block grid (cols x rows), kept for non-static transitions. */
  grid?: Uint8Array;
  /** Big changes only: components inside the nav bar and tab bar bands, found
   *  separately so a lit-up bar button is not swallowed by the content change. */
  bars?: ChangeComponent[];
}

export interface FrameAnalysis {
  w: number;
  h: number;
  /** Times of every frame. */
  times: number[];
  /** transitions[i] compares frame i to frame i+1. */
  transitions: Transition[];
  /** Block grid geometry for Transition.grid. */
  cols: number;
  rows: number;
  blockSize: number;
}

/** Blocks changing in this many of the last CHURN_WINDOW small transitions are animation (spinners, video, carets). */
const CHURN_WINDOW = 24;
/** iOS bars (fractions of screen height): nav bar buttons sit above this… */
const TOP_BAR_BOTTOM = 0.105;
/** …and tab bar icons below this. */
const BOTTOM_BAR_TOP = 0.92;
const CHURN_LIMIT = 20;

export function analyzeFrames(frames: GrayFrame[], options: Partial<TapDetectOptions> = {}): FrameAnalysis {
  const o = { ...defaultTapDetect, ...options };
  if (frames.length === 0) return { w: 0, h: 0, times: [], transitions: [], cols: 0, rows: 0, blockSize: o.blockSize };
  const { w, h } = frames[0];
  const B = o.blockSize;
  const cols = Math.ceil(w / B);
  const rows = Math.ceil(h / B);
  const firstRow = Math.floor((o.ignoreTop * h) / B);
  const analysed = cols * (rows - firstRow);
  const counts = new Uint16Array(cols * rows);
  const changed = new Uint8Array(cols * rows);
  const churn = new Uint8Array(cols * rows);
  const history: number[][] = [];
  const transitions: Transition[] = [];
  const threshold = o.adaptiveThreshold ? Math.max(o.pixelThreshold, noiseThreshold(frames)) : o.pixelThreshold;

  for (let i = 0; i + 1 < frames.length; i++) {
    const a = frames[i].data;
    const b = frames[i + 1].data;
    counts.fill(0);
    for (let y = firstRow * B; y < h; y++) {
      const rowBase = ((y / B) | 0) * cols;
      const off = y * w;
      for (let x = 0; x < w; x++) {
        const d = a[off + x] - b[off + x];
        if (d > threshold || d < -threshold) counts[rowBase + ((x / B) | 0)]++;
      }
    }
    const need = Math.max(2, Math.round(B * B * o.blockFraction));
    const changedList: number[] = [];
    let nChanged = 0;
    for (let k = firstRow * cols; k < counts.length; k++) {
      const on = counts[k] >= need;
      changed[k] = on && churn[k] < CHURN_LIMIT ? 1 : 0;
      if (on) changedList.push(k);
      if (changed[k]) nChanged++;
    }

    const components = nChanged > 0 ? findComponents(changed, counts, cols, rows, B, w, h, analysed) : [];
    for (const c of components) c.dl = c.area <= 0.05 ? meanLumaChange(a, b, w, h, c, threshold) : 0;
    const frac = nChanged / analysed;
    let kind: TransitionKind = 'static';
    let dx = 0;
    let dy = 0;
    if (components.length > 0 && components[0].area >= o.minTouchArea * 0.5) {
      // Small = localized: one compact component carries most of the change.
      const compact = components[0].area >= frac * 0.5 || frac <= 0.03;
      kind = frac <= o.maxTouchArea && bboxArea(components[0]) <= 0.2 && compact ? 'small' : 'large';
      if (frac >= 0.04) {
        const m = estimateTranslation(a, b, w, h, unionBox(components), firstRow * B);
        if (m) {
          kind = 'translate';
          dx = m.dx;
          dy = m.dy;
        }
      }
    }

    // Animation mask: only small changes feed it, so a long scroll never masks
    // the screen. Neighbours count too: a spinner moves between blocks.
    let bars: ChangeComponent[] | undefined;
    if (kind === 'large' || kind === 'translate') {
      const band = new Uint8Array(changed.length);
      for (let r = firstRow; r < rows; r++) {
        const top = r * B;
        const inTop = top + B <= TOP_BAR_BOTTOM * h;
        const inBottom = top >= BOTTOM_BAR_TOP * h;
        if (inTop || inBottom) band.set(changed.subarray(r * cols, (r + 1) * cols), r * cols);
      }
      bars = findComponents(band, counts, cols, rows, B, w, h, analysed, 1);
      for (const c of bars) c.dl = meanLumaChange(a, b, w, h, c, threshold);
    }

    // Masked blocks keep counting while they churn, so a spinner stays masked.
    history.push(kind === 'small' || kind === 'static' ? dilate(changedList, cols, rows) : []);
    for (const k of history[history.length - 1]) churn[k]++;
    if (history.length > CHURN_WINDOW) for (const k of history.shift()!) churn[k]--;

    transitions.push({
      t: frames[i + 1].t, kind, changed: frac, components, dx, dy,
      ...(kind === 'static' ? {} : { grid: changed.slice() }),
      ...(bars ? { bars } : {}),
    });
  }
  return { w, h, times: frames.map((f) => f.t), transitions, cols, rows, blockSize: B };
}

/**
 * Pixel threshold that sits above the recording's noise. A still screen
 * differs from the previous frame only by codec noise, so the median pixel
 * difference of the quietest quarter of transitions measures it; UI changes
 * are local and barely move a median.
 */
export function noiseThreshold(frames: GrayFrame[]): number {
  if (frames.length < 2) return 0;
  const medians: number[] = [];
  const step = Math.max(1, Math.floor(frames.length / 120));
  for (let i = 0; i + 1 < frames.length; i += step) {
    const a = frames[i].data;
    const b = frames[i + 1].data;
    const hist = new Uint32Array(256);
    const stride = Math.max(1, Math.floor(a.length / 4000));
    let n = 0;
    for (let k = 0; k < a.length; k += stride) {
      const d = a[k] - b[k];
      hist[d < 0 ? -d : d]++;
      n++;
    }
    let acc = 0;
    let med = 0;
    while (med < 255 && acc + hist[med] <= n / 2) acc += hist[med++];
    medians.push(med);
  }
  medians.sort((x, y) => x - y);
  const floor = medians[Math.floor(medians.length / 4)];
  return Math.round(floor * 3 + 6);
}

function dilate(list: number[], cols: number, rows: number): number[] {
  const set = new Set<number>();
  for (const k of list) {
    const c = k % cols;
    const r = (k / cols) | 0;
    for (let y = Math.max(0, r - 1); y <= Math.min(rows - 1, r + 1); y++)
      for (let x = Math.max(0, c - 1); x <= Math.min(cols - 1, c + 1); x++) set.add(y * cols + x);
  }
  return [...set];
}

function meanLumaChange(a: Uint8Array, b: Uint8Array, w: number, h: number, c: ChangeComponent, thr: number): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(c.y0 * h); y < Math.ceil(c.y1 * h); y++) {
    for (let x = Math.floor(c.x0 * w); x < Math.ceil(c.x1 * w); x++) {
      const d = b[y * w + x] - a[y * w + x];
      if (d > thr || d < -thr) {
        sum += d;
        n++;
      }
    }
  }
  return n ? sum / n : 0;
}

/** Is a's centroid inside b's box grown by `pad`? */
function inside(a: ChangeComponent, b: ChangeComponent, pad: number): boolean {
  return a.cx >= b.x0 - pad && a.cx <= b.x1 + pad && a.cy >= b.y0 - pad && a.cy <= b.y1 + pad;
}

function shrink(c: ChangeComponent, k: number) {
  const mx = ((c.x1 - c.x0) * (1 - k)) / 2;
  const my = ((c.y1 - c.y0) * (1 - k)) / 2;
  return { x0: c.x0 + mx, x1: c.x1 - mx, y0: c.y0 + my, y1: c.y1 - my };
}

/** Fraction of changed blocks inside a normalized box in one transition. */
function changedFractionIn(an: FrameAnalysis, tr: Transition, box: { x0: number; y0: number; x1: number; y1: number }): number {
  if (!tr.grid) return 0;
  const c0 = Math.floor((box.x0 * an.w) / an.blockSize);
  const c1 = Math.max(c0 + 1, Math.ceil((box.x1 * an.w) / an.blockSize));
  const r0 = Math.floor((box.y0 * an.h) / an.blockSize);
  const r1 = Math.max(r0 + 1, Math.ceil((box.y1 * an.h) / an.blockSize));
  let n = 0;
  let on = 0;
  for (let r = r0; r < Math.min(an.rows, r1); r++)
    for (let c = c0; c < Math.min(an.cols, c1); c++) {
      n++;
      on += tr.grid[r * an.cols + c];
    }
  return n ? on / n : 0;
}

function bboxArea(c: ChangeComponent): number {
  return (c.x1 - c.x0) * (c.y1 - c.y0);
}

function unionBox(cs: ChangeComponent[]) {
  return {
    x0: Math.min(...cs.map((c) => c.x0)),
    y0: Math.min(...cs.map((c) => c.y0)),
    x1: Math.max(...cs.map((c) => c.x1)),
    y1: Math.max(...cs.map((c) => c.y1)),
  };
}

/** Connected components over changed blocks; blocks one apart still connect (text glyphs). */
function findComponents(
  changed: Uint8Array,
  counts: Uint16Array,
  cols: number,
  rows: number,
  B: number,
  w: number,
  h: number,
  analysed: number,
  reach = 2,
): ChangeComponent[] {
  const label = new Int32Array(changed.length).fill(-1);
  const out: ChangeComponent[] = [];
  const stack: number[] = [];
  for (let s = 0; s < changed.length; s++) {
    if (!changed[s] || label[s] >= 0) continue;
    let n = 0;
    let wsum = 0;
    let sx = 0;
    let sy = 0;
    let c0 = cols;
    let r0 = rows;
    let c1 = 0;
    let r1 = 0;
    label[s] = out.length;
    stack.push(s);
    while (stack.length) {
      const k = stack.pop()!;
      const c = k % cols;
      const r = (k / cols) | 0;
      n++;
      const wt = counts[k];
      wsum += wt;
      sx += (c + 0.5) * wt;
      sy += (r + 0.5) * wt;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
      for (let yy = Math.max(0, r - reach); yy <= Math.min(rows - 1, r + reach); yy++) {
        for (let xx = Math.max(0, c - reach); xx <= Math.min(cols - 1, c + reach); xx++) {
          const q = yy * cols + xx;
          if (changed[q] && label[q] < 0) {
            label[q] = out.length;
            stack.push(q);
          }
        }
      }
    }
    out.push({
      area: n / analysed,
      x0: (c0 * B) / w,
      y0: (r0 * B) / h,
      x1: Math.min(1, ((c1 + 1) * B) / w),
      y1: Math.min(1, ((r1 + 1) * B) / h),
      cx: Math.min(1, ((sx / wsum) * B) / w),
      cy: Math.min(1, ((sy / wsum) * B) / h),
      dl: 0,
    });
  }
  return out.sort((p, q) => q.area - p.area);
}

/**
 * Coherent translation of the changed region between two frames, by 1-D
 * block matching along each axis. Returns the content displacement in px, or
 * null when no shift explains the change much better than "no shift".
 */
export function estimateTranslation(
  a: Uint8Array,
  b: Uint8Array,
  w: number,
  h: number,
  box: { x0: number; y0: number; x1: number; y1: number },
  minY = 0,
): { dx: number; dy: number; ratio: number } | null {
  const X0 = Math.max(0, Math.floor(box.x0 * w));
  const X1 = Math.min(w, Math.ceil(box.x1 * w));
  const Y0 = Math.max(minY, Math.floor(box.y0 * h));
  const Y1 = Math.min(h, Math.ceil(box.y1 * h));
  const bw = X1 - X0;
  const bh = Y1 - Y0;
  if (bw < 8 || bh < 8) return null;

  // err(d) = mean |b(x, y) - a(x - dx, y - dy)| over the overlap, sampled every 2 px.
  const err = (ddx: number, ddy: number): number => {
    let sum = 0;
    let n = 0;
    const ys = Math.max(Y0, Y0 + ddy);
    const ye = Math.min(Y1, Y1 + ddy);
    const xs = Math.max(X0, X0 + ddx);
    const xe = Math.min(X1, X1 + ddx);
    for (let y = ys; y < ye; y += 2) {
      const ob = y * w;
      const oa = (y - ddy) * w - ddx;
      for (let x = xs; x < xe; x += 2) {
        const d = b[ob + x] - a[oa + x];
        sum += d < 0 ? -d : d;
        n++;
      }
    }
    return n > 0 ? sum / n : Infinity;
  };

  const zero = err(0, 0);
  if (zero < 3) return null; // nothing textured changed
  let best = { dx: 0, dy: 0, e: zero };
  const search = (axis: 'x' | 'y', max: number) => {
    // Every integer shift: sharp text decorrelates within one pixel.
    let local = { d: 0, e: Infinity };
    for (let d = -max; d <= max; d++) {
      if (d === 0) continue;
      const e = axis === 'y' ? err(0, d) : err(d, 0);
      if (e < local.e) local = { d, e };
    }
    if (local.e < best.e) best = axis === 'y' ? { dx: 0, dy: local.d, e: local.e } : { dx: local.d, dy: 0, e: local.e };
  };
  search('y', Math.min(64, Math.floor(bh * 0.45)));
  search('x', Math.min(64, Math.floor(bw * 0.45)));
  const ratio = best.e / zero;
  if (best.dx === 0 && best.dy === 0) return null;
  return ratio < 0.5 ? { dx: best.dx, dy: best.dy, ratio } : null;
}

// ---------------------------------------------------------------------------
// Events: runs of consecutive change

interface ChangeEvent {
  start: number;
  end: number;
  items: Transition[];
  stableBefore: number;
  kind: 'motion' | 'touch' | 'large';
}

function groupEvents(an: FrameAnalysis): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  const mergeGap = 0.07;
  let cur: ChangeEvent | null = null;
  let lastEnd = an.times[0] ?? 0;
  for (const tr of an.transitions) {
    if (tr.kind === 'static') continue;
    if (cur && tr.t - cur.end <= mergeGap) {
      cur.items.push(tr);
      cur.end = tr.t;
      continue;
    }
    if (cur) {
      events.push(cur);
      lastEnd = cur.end;
    }
    cur = { start: tr.t, end: tr.t, items: [tr], stableBefore: tr.t - lastEnd, kind: 'large' };
  }
  if (cur) events.push(cur);
  for (const ev of events) {
    const translates = ev.items.filter((x) => x.kind === 'translate').length;
    // One translate frame alone is usually a content swap that happens to
    // line up (lists are periodic); a real drag moves over several frames.
    if (translates >= 2 && translates >= ev.items.length * 0.3) ev.kind = 'motion';
    else if (ev.items[0].kind === 'small') ev.kind = 'touch';
    else ev.kind = 'large';
  }
  return events;
}

// ---------------------------------------------------------------------------
// Detection

function isAnalysis(x: GrayFrame[] | FrameAnalysis): x is FrameAnalysis {
  return !Array.isArray(x);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Editable touch suggestions for a recording, sorted by time. */
export function detectTaps(
  input: GrayFrame[] | FrameAnalysis,
  options: Partial<TapDetectOptions> = {},
): TapSuggestion[] {
  const o = { ...defaultTapDetect, ...options };
  const an = isAnalysis(input) ? input : analyzeFrames(input, o);
  if (an.transitions.length === 0) return [];
  const events = groupEvents(an);
  const out: TapSuggestion[] = [];

  // Settle time: end of the change chain starting at event i (gaps under 0.3 s).
  const settleFrom = (i: number): number => {
    let end = events[i].end;
    for (let k = i + 1; k < events.length && events[k].start - end < 0.3; k++) end = events[k].end;
    return end;
  };

  let lastTouch: { start: number; end: number; follow?: number } | null = null;
  // A change is the result of a touch when it starts soon after it, and the
  // touch's own response has not gone quiet in between.
  const followsTouch = (ev: ChangeEvent) =>
    !!lastTouch && ev.start - lastTouch.start <= o.followWindow && ev.start - lastTouch.end <= 0.4;
  let lastSwipe: { s: TapSuggestion; end: number; axis: 'x' | 'y'; sign: number } | null = null;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    if (ev.kind === 'motion') {
      const moves = ev.items.filter((x) => x.kind === 'translate');
      const sx = moves.reduce((s, m) => s + m.dx, 0);
      const sy = moves.reduce((s, m) => s + m.dy, 0);
      const axis: 'x' | 'y' = Math.abs(sy) >= Math.abs(sx) ? 'y' : 'x';
      const sign = Math.sign(axis === 'y' ? sy : sx);
      const total = Math.abs(axis === 'y' ? sy : sx);
      // The result of a tap (push, sheet, keyboard) - not a finger swipe.
      if (followsTouch(ev)) continue;
      // Momentum tail or a pause mid-scroll: extend the previous swipe.
      if (lastSwipe && lastSwipe.axis === axis && lastSwipe.sign === sign && ev.start - lastSwipe.end <= (total <= 3 ? 1.0 : 0.35)) {
        lastSwipe.end = ev.end;
        lastSwipe.s.settleT = round3(settleFrom(i));
        continue;
      }
      if (total <= 2) continue;
      out.push((lastSwipe = { s: swipeFrom(ev, moves, axis, an, o), end: ev.end, axis, sign }).s);
      lastSwipe.s.settleT = round3(settleFrom(i));
      continue;
    }

    if (ev.kind === 'touch') {
      const first = ev.items[0];
      const comp = first.components[0];
      if (comp.area < o.minTouchArea) continue;
      // Every touch-like change can explain a motion that follows it (a key
      // press then the keyboard hiding), even when it is not a tap itself.
      const prev = lastTouch as { start: number; end: number; follow?: number } | null;
      lastTouch = { start: ev.start, end: ev.end };
      if (ev.stableBefore < o.minStable) continue;
      // Too soon after the previous touch, or while its finger is still down
      // (before its big change): part of that touch, not a new one.
      if (prev && prev.follow !== undefined && ev.start < prev.follow) {
        lastTouch = prev;
        continue;
      }
      if (prev && ev.start - prev.start < 0.45) continue;

      // Time of the first big change after the touch (within 1.6 s), skipping
      // small changes such as the pressed element's own animation.
      let follow: number | null = null;
      for (let k = i; k < events.length && events[k].start - ev.start <= 1.6; k++) {
        const e = events[k];
        // A separate touch elsewhere starts a new gesture; stop looking.
        if (k > i && e.kind === 'touch' && e.stableBefore >= o.minStable) {
          const c = e.items[0].components[0];
          if (!inside(c, comp, 0.05)) break;
        }
        const big = events[k].items.find((x) => x.kind === 'large' || x.kind === 'translate');
        if (big) {
          follow = big.t;
          break;
        }
      }
      const gap = follow === null ? Infinity : follow - ev.start;

      // Long press: the finger stays down well past a tap's ~120 ms, then a
      // context menu appears. Evidence: the pressed element keeps changing
      // (lift animation), or the big change leaves a hole where the pressed
      // element stays put (the preview floats above the blurred screen).
      let longpress = false;
      if (gap > 0.45 && gap <= 1.6) {
        const win = an.transitions.filter((x) => x.t >= ev.start && x.t < follow!);
        const near = win.filter(
          (x) => x.kind === 'small' && x.components.some((c) => Math.hypot(c.cx - comp.cx, c.cy - comp.cy) < 0.12),
        ).length;
        const sustained = win.length > 0 ? near / win.length : 0;
        const followTr = an.transitions.find((x) => x.t === follow);
        const hole =
          !!followTr && followTr.kind === 'large' && followTr.changed >= 0.3 && changedFractionIn(an, followTr, shrink(comp, 0.6)) <= 0.35;
        longpress = sustained >= 0.5 || hole;
      }

      let kind: TapKind = 'tap';
      let confidence: number;
      let duration: number | undefined;
      if (longpress) {
        kind = 'longpress';
        duration = round3(gap);
        confidence = 0.75;
      } else if (gap <= o.followWindow) confidence = 0.9;
      else if (gap <= 1.6) confidence = 0.6;
      else confidence = 0.55; // highlight or toggle with no navigation
      // Very large or sprawling first changes are less likely to be one finger.
      if (comp.area > 0.08) confidence -= 0.1;

      out.push({
        id: '',
        t: round3(Math.max(0, ev.start - o.touchLead)),
        x: round3(comp.cx),
        y: round3(comp.cy),
        kind,
        ...(duration !== undefined ? { duration } : {}),
        confidence: round3(confidence),
        settleT: round3(settleFrom(i)),
      });
      lastTouch = { start: ev.start, end: ev.end, ...(follow !== null ? { follow } : {}) };
      lastSwipe = null;
      continue;
    }

    // Large change out of stillness with no touch before it: look for the
    // pressed control lighting up separately (tab bar icon, nav button).
    if (ev.stableBefore >= 0.3 && !followsTouch(ev)) {
      // Icon-sized blobs only: a whole bar changing (keyboard, toolbar swap) says nothing.
      const cands = (ev.items[0].bars ?? []).filter(
        (c) => c.area >= o.minTouchArea * 0.5 && c.area <= 0.03 && c.x1 - c.x0 <= 0.3,
      );
      // In a bar, the old and new selection both change. The tint iOS uses for
      // the selected item (systemBlue by default) is darker in luma than the
      // grey of unselected items in both light and dark mode, so prefer the
      // component that got darker.
      const pressed = cands.sort((p, q) => p.dl - q.dl)[0];
      if (pressed) {
        out.push({
          id: '',
          t: round3(Math.max(0, ev.start - o.touchLead)),
          x: round3(pressed.cx),
          y: round3(pressed.cy),
          kind: 'tap',
          confidence: cands.length > 1 ? 0.4 : 0.45,
          settleT: round3(settleFrom(i)),
        });
        lastTouch = { start: ev.start, end: ev.end };
        lastSwipe = null;
      }
    }
  }

  const merged = collapseTyping(out, events, o);
  merged.sort((p, q) => p.t - q.t);
  merged.forEach((s, i) => (s.id = `${s.kind}-${Math.round(s.t * 1000)}-${i}`));
  return merged;
}

function swipeFrom(
  ev: ChangeEvent,
  moves: Transition[],
  axis: 'x' | 'y',
  an: FrameAnalysis,
  o: TapDetectOptions,
): TapSuggestion {
  // The finger drags for roughly the first 0.3 s; the rest is momentum.
  const t0 = moves[0].t;
  const drag = moves.filter((m) => m.t - t0 <= 0.3);
  const px = drag.reduce((s, m) => s + (axis === 'y' ? m.dy : m.dx), 0);
  const size = axis === 'y' ? an.h : an.w;
  const dist = clamp(Math.abs(px) / size, 0.12, 0.5) * Math.sign(px || 1);
  const box = unionBox(moves[0].components);
  const across = axis === 'y' ? clamp((box.x0 + box.x1) / 2, 0.2, 0.8) : clamp((box.y0 + box.y1) / 2, 0.2, 0.8);
  // Finger travels with the content: content moving up = finger moving up.
  const start = clamp(0.5 - dist / 2, 0.05, 0.95);
  const end = clamp(start + dist, 0.05, 0.95);
  const ratioQuality = 0.6 + 0.3 * Math.min(1, moves.length / 6);
  return {
    id: '',
    t: round3(Math.max(0, ev.start - o.touchLead)),
    x: round3(axis === 'y' ? across : start),
    y: round3(axis === 'y' ? start : across),
    endX: round3(axis === 'y' ? across : end),
    endY: round3(axis === 'y' ? end : across),
    kind: 'swipe',
    duration: round3(Math.max(0.12, (drag[drag.length - 1]?.t ?? t0) - t0 + 1 / 30)),
    confidence: round3(ratioQuality),
  };
}

/** Replace runs of key pops with one typing marker. */
function collapseTyping(out: TapSuggestion[], events: ChangeEvent[], o: TapDetectOptions): TapSuggestion[] {
  const pops = events.filter((ev) => {
    if (ev.kind !== 'touch') return false;
    const c = ev.items[0].components[0];
    return c.cy >= o.keyboardTop && c.x1 - c.x0 <= 0.25 && c.y1 - c.y0 <= 0.15;
  });
  const runs: ChangeEvent[][] = [];
  for (const p of pops) {
    const run = runs[runs.length - 1];
    if (run && p.start - run[run.length - 1].end <= o.typingGap) run.push(p);
    else runs.push([p]);
  }
  let result = out;
  for (const run of runs) {
    if (run.length < o.minKeyPops) continue;
    const start = run[0].start;
    const end = run[run.length - 1].end;
    result = result.filter((s) => s.t < start - o.touchLead - 0.01 || s.t > end);
    const cs = run.map((r) => r.items[0].components[0]);
    result.push({
      id: '',
      t: round3(Math.max(0, start - o.touchLead)),
      x: round3(cs.reduce((s, c) => s + c.cx, 0) / cs.length),
      y: round3(cs.reduce((s, c) => s + c.cy, 0) / cs.length),
      kind: 'typing',
      duration: round3(end - start + o.touchLead),
      confidence: round3(Math.min(0.95, 0.6 + 0.05 * run.length)),
      settleT: round3(end),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Dead time

export interface DeadStretch {
  start: number;
  end: number;
  duration: number;
  /** Stillness at the very start or end of the recording (trim candidates). */
  edge?: 'start' | 'end';
}

/**
 * Stretches with no visible change for longer than `minDuration` seconds:
 * candidates for a 2-4x speed-up or a cut. Spinners and other looping
 * animation are masked, so a network wait with a spinner still counts.
 */
export function findDeadTime(
  input: GrayFrame[] | FrameAnalysis,
  opts: Partial<TapDetectOptions> & { minDuration?: number } = {},
): DeadStretch[] {
  const an = isAnalysis(input) ? input : analyzeFrames(input, opts);
  const minDuration = opts.minDuration ?? 1.5;
  if (an.times.length < 2) return [];
  const t0 = an.times[0];
  const tEnd = an.times[an.times.length - 1];
  const out: DeadStretch[] = [];
  let lastChange = t0;
  let seenChange = false;
  const push = (start: number, end: number, edge?: 'start' | 'end') => {
    if (end - start > minDuration)
      out.push({ start: round3(start), end: round3(end), duration: round3(end - start), ...(edge ? { edge } : {}) });
  };
  for (const tr of an.transitions) {
    if (tr.kind === 'static') continue;
    // The change becomes visible at tr.t; stillness ran until the frame before.
    push(lastChange, tr.t - frameStep(an), seenChange ? undefined : 'start');
    lastChange = tr.t;
    seenChange = true;
  }
  push(lastChange, tEnd, seenChange ? 'end' : undefined);
  return out;
}

function frameStep(an: FrameAnalysis): number {
  return an.times.length > 1 ? (an.times[an.times.length - 1] - an.times[0]) / (an.times.length - 1) : 0;
}

// ---------------------------------------------------------------------------
// Frame extraction (the main process runs ffmpeg with these)

export interface AnalysisFrameSpec {
  width: number;
  fps: number;
}

export const defaultAnalysisFrames: AnalysisFrameSpec = { width: 180, fps: 30 };

/**
 * ffmpeg arguments that write raw 8-bit grayscale frames to stdout:
 * `ffmpeg -i in -vf fps=30,scale=180:-2,format=gray -f rawvideo -`.
 */
export function tapAnalysisFfmpegArgs(input: string, spec: Partial<AnalysisFrameSpec> = {}): string[] {
  const { width, fps } = { ...defaultAnalysisFrames, ...spec };
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', input,
    '-an',
    '-vf', `fps=${fps},scale=${width}:-2:flags=area,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray',
    '-',
  ];
}

/** Output size of `scale=W:-2` for a source (height rounded to even). */
export function analysisFrameSize(sourceW: number, sourceH: number, width = defaultAnalysisFrames.width) {
  return { w: width, h: Math.max(2, Math.round((sourceH * width) / sourceW / 2) * 2) };
}

/** Split ffmpeg's raw stdout into frames at a constant frame rate. */
export function splitRawGray(buf: Uint8Array, w: number, h: number, fps: number, startT = 0): GrayFrame[] {
  const size = w * h;
  const n = Math.floor(buf.length / size);
  const frames: GrayFrame[] = [];
  for (let i = 0; i < n; i++) {
    frames.push({ t: startT + i / fps, w, h, data: buf.subarray(i * size, (i + 1) * size) });
  }
  return frames;
}
