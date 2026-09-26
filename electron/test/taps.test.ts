import { describe, expect, it } from 'vitest';
import {
  analysisFrameSize,
  analyzeFrames,
  detectTaps,
  noiseThreshold,
  estimateTranslation,
  findDeadTime,
  splitRawGray,
  tapAnalysisFfmpegArgs,
  type TapSuggestion,
} from '../src/shared/taps';
import { H, PhoneSim, W, type Truth } from './helpers/phoneSim';

function score(pred: TapSuggestion[], truth: Truth[]) {
  const used = new Set<number>();
  let matched = 0;
  let kindOk = 0;
  const misses: Truth[] = [];
  for (const tr of truth) {
    let best = -1;
    let bestD = Infinity;
    pred.forEach((p, i) => {
      if (used.has(i)) return;
      const touch = (k: string) => k === 'tap' || k === 'longpress';
      const sameClass = touch(tr.kind) ? touch(p.kind) : p.kind === tr.kind;
      if (!sameClass) return;
      const dt = Math.abs(p.t - tr.t);
      if (dt > 0.25) return;
      if (touch(tr.kind) && Math.hypot(p.x - tr.x, (p.y - tr.y) * (H / W)) > 0.12) return;
      if (tr.kind === 'swipe') {
        const d = tr.axis === 'y' ? (p.endY ?? p.y) - p.y : (p.endX ?? p.x) - p.x;
        if (Math.sign(d) !== tr.sign) return;
      }
      if (dt < bestD) {
        bestD = dt;
        best = i;
      }
    });
    if (best >= 0) {
      used.add(best);
      matched++;
      if (pred[best].kind === tr.kind) kindOk++;
    } else misses.push(tr);
  }
  const extras = pred.filter((_, i) => !used.has(i));
  return { matched, kindOk, misses, extras, precision: matched / Math.max(1, pred.length), recall: matched / Math.max(1, truth.length) };
}

describe('detectTaps on synthetic recordings', () => {
  it('finds a row tap at the highlight, before the push, and not the push itself', () => {
    const sim = new PhoneSim(7);
    sim.hold(1);
    sim.tapRow();
    sim.hold(1);
    const taps = detectTaps(sim.frames);
    expect(taps).toHaveLength(1);
    const [tap] = taps;
    expect(tap.kind).toBe('tap');
    expect(tap.confidence).toBeGreaterThanOrEqual(0.85);
    // Placed 50-100 ms before the first visible response.
    expect(sim.truth[0].t - tap.t).toBeGreaterThanOrEqual(0.04);
    expect(sim.truth[0].t - tap.t).toBeLessThanOrEqual(0.12);
    expect(Math.abs(tap.y - sim.truth[0].y)).toBeLessThan(0.03);
    expect(tap.settleT).toBeGreaterThan(tap.t + 0.3);
  });

  it('finds a toggle tap with no navigation at lower confidence', () => {
    const sim = new PhoneSim(3);
    sim.hold(1);
    sim.toggle();
    sim.hold(1);
    const taps = detectTaps(sim.frames);
    expect(taps.map((t) => t.kind)).toEqual(['tap']);
    expect(taps[0].confidence).toBeLessThan(0.7);
    expect(Math.abs(taps[0].x - sim.truth[0].x)).toBeLessThan(0.08);
  });

  it('turns a drag + fling into one swipe with the finger direction', () => {
    const sim = new PhoneSim(11);
    sim.hold(1);
    sim.scrollList();
    sim.hold(1);
    const taps = detectTaps(sim.frames);
    expect(taps).toHaveLength(1);
    expect(taps[0].kind).toBe('swipe');
    // Content scrolled up, so the finger moved up.
    expect(taps[0].endY!).toBeLessThan(taps[0].y);
    expect(taps[0].duration!).toBeGreaterThan(0.1);
  });

  it('detects an edge swipe back as a rightward swipe', () => {
    const sim = new PhoneSim(5);
    sim.hold(1);
    sim.swipeBack();
    sim.hold(1);
    const taps = detectTaps(sim.frames);
    expect(taps.map((t) => t.kind)).toEqual(['swipe']);
    expect(taps[0].endX!).toBeGreaterThan(taps[0].x);
  });

  it('collapses key presses into one typing marker', () => {
    const sim = new PhoneSim(21);
    sim.hold(1);
    sim.type(6);
    sim.hold(1);
    const taps = detectTaps(sim.frames);
    expect(taps.map((t) => t.kind)).toEqual(['tap', 'typing']);
    expect(taps[1].y).toBeGreaterThan(0.6);
    expect(taps[1].duration!).toBeGreaterThan(1);
  });

  it('recognizes a long press by the sustained lift before the menu', () => {
    const sim = new PhoneSim(9);
    sim.hold(1);
    sim.longPress();
    sim.hold(1);
    const taps = detectTaps(sim.frames);
    expect(taps.map((t) => t.kind)).toEqual(['longpress']);
    expect(taps[0].duration!).toBeGreaterThan(0.4);
  });

  it('locates a tab-bar tap even when the content swaps in the same frame', () => {
    const sim = new PhoneSim(13);
    sim.hold(1);
    sim.tabTap();
    sim.hold(1);
    const taps = detectTaps(sim.frames);
    expect(taps).toHaveLength(1);
    expect(Math.abs(taps[0].x - sim.truth[0].x)).toBeLessThan(0.06);
    expect(taps[0].y).toBeGreaterThan(0.9);
  });

  it('ignores a spinner and reports the wait as dead time', () => {
    const sim = new PhoneSim(17);
    sim.hold(1);
    sim.tapRow({ spinner: 2.6 });
    sim.hold(0.6);
    const an = analyzeFrames(sim.frames);
    expect(detectTaps(an)).toHaveLength(1);
    const dead = findDeadTime(an).filter((d) => !d.edge);
    expect(dead).toHaveLength(1);
    expect(dead[0].duration).toBeGreaterThan(1.5);
  });

  it('meets precision and recall targets on randomized demos', () => {
    let pred = 0;
    let truthN = 0;
    let matched = 0;
    let kindOk = 0;
    const report: string[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      const sim = new PhoneSim(seed * 7919);
      sim.randomScript(10);
      const taps = detectTaps(sim.frames);
      const s = score(taps, sim.truth);
      pred += taps.length;
      truthN += sim.truth.length;
      matched += s.matched;
      kindOk += s.kindOk;
      for (const m of s.misses) report.push(`seed ${seed} MISS ${m.kind} t=${m.t.toFixed(2)} (${m.x.toFixed(2)},${m.y.toFixed(2)})`);
      for (const e of s.extras) report.push(`seed ${seed} EXTRA ${e.kind} t=${e.t.toFixed(2)} (${e.x.toFixed(2)},${e.y.toFixed(2)}) c=${e.confidence}`);
    }
    const precision = matched / pred;
    const recall = matched / truthN;
    const kindAccuracy = kindOk / matched;
    console.log(
      `tap detection: ${truthN} gestures, ${pred} suggestions, precision ${(precision * 100).toFixed(1)}%, recall ${(recall * 100).toFixed(1)}%, kind accuracy ${(kindAccuracy * 100).toFixed(1)}%`,
    );
    if (report.length) console.log(report.join('\n'));
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(kindAccuracy).toBeGreaterThanOrEqual(0.9);
  }, 60_000);

  it('adapts to heavy codec noise', () => {
    let pred = 0;
    let truthN = 0;
    let matched = 0;
    for (const seed of [31, 32, 33]) {
      const sim = new PhoneSim(seed * 7919, 10);
      sim.randomScript(8);
      const taps = detectTaps(sim.frames);
      const s = score(taps, sim.truth);
      pred += taps.length;
      truthN += sim.truth.length;
      matched += s.matched;
    }
    console.log(`tap detection at noise +-10: ${truthN} gestures, precision ${((matched / pred) * 100).toFixed(1)}%, recall ${((matched / truthN) * 100).toFixed(1)}%`);
    expect(matched / pred).toBeGreaterThanOrEqual(0.85);
    expect(matched / truthN).toBeGreaterThanOrEqual(0.85);
  }, 60_000);

  it('measures the noise floor', () => {
    const quiet = new PhoneSim(1, 2);
    quiet.hold(1);
    expect(noiseThreshold(quiet.frames)).toBeLessThanOrEqual(16);
    const noisy = new PhoneSim(1, 10);
    noisy.hold(1);
    const thr = noiseThreshold(noisy.frames);
    expect(thr).toBeGreaterThan(20); // pure noise reaches +-20 between frames
    expect(thr).toBeLessThan(32); // a row highlight (32 levels) must stay visible
  });

  it('suggests nothing for a static recording', () => {
    const sim = new PhoneSim(1);
    sim.hold(3);
    expect(detectTaps(sim.frames)).toEqual([]);
    const dead = findDeadTime(sim.frames);
    expect(dead).toHaveLength(1);
    expect(dead[0].start).toBe(0);
    expect(dead[0].end).toBeCloseTo(sim.frames[sim.frames.length - 1].t, 2);
    expect(dead[0].edge).toBeUndefined();
  });
});

describe('findDeadTime', () => {
  it('reports stillness over 1.5 s, including the recording edges', () => {
    const sim = new PhoneSim(2);
    sim.hold(2); // leading
    sim.toggle();
    sim.hold(1); // too short
    sim.toggle();
    sim.hold(2.2); // interior... then trailing
    const dead = findDeadTime(sim.frames);
    expect(dead[0].edge).toBe('start');
    expect(dead[0].duration).toBeGreaterThan(1.9);
    expect(dead[dead.length - 1].edge).toBe('end');
    expect(dead.every((d) => d.duration > 1.5)).toBe(true);
    expect(findDeadTime(sim.frames, { minDuration: 0.8 }).length).toBe(dead.length + 1);
  });
});

describe('estimateTranslation', () => {
  it('recovers vertical and horizontal shifts of textured content', () => {
    const w = 120;
    const h = 200;
    const a = new Uint8Array(w * h);
    let s = 12345;
    for (let i = 0; i < a.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      a[i] = (s >> 16) & 255;
    }
    const shift = (dx: number, dy: number) => {
      const b = new Uint8Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const sx = Math.min(w - 1, Math.max(0, x - dx));
          const sy = Math.min(h - 1, Math.max(0, y - dy));
          b[y * w + x] = a[sy * w + sx];
        }
      return b;
    };
    const box = { x0: 0, y0: 0, x1: 1, y1: 1 };
    expect(estimateTranslation(a, shift(0, -13), w, h, box)).toMatchObject({ dx: 0, dy: -13 });
    expect(estimateTranslation(a, shift(7, 0), w, h, box)).toMatchObject({ dx: 7, dy: 0 });
    expect(estimateTranslation(a, a, w, h, box)).toBeNull();
    // A solid block appearing is not a translation.
    const b = a.slice();
    for (let y = 50; y < 150; y++) b.fill(0, y * w + 20, y * w + 100);
    expect(estimateTranslation(a, b, w, h, box)).toBeNull();
  });
});

describe('frame extraction helpers', () => {
  it('builds the ffmpeg grayscale pipe command', () => {
    const args = tapAnalysisFfmpegArgs('/r/screen.mov');
    expect(args).toContain('/r/screen.mov');
    expect(args[args.indexOf('-vf') + 1]).toBe('fps=30,scale=180:-2:flags=area,format=gray');
    expect(args.slice(-5)).toEqual(['-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
    expect(tapAnalysisFfmpegArgs('x', { fps: 15, width: 120 })).toContain('fps=15,scale=120:-2:flags=area,format=gray');
  });

  it('predicts the scaled frame size and splits raw output', () => {
    expect(analysisFrameSize(1206, 2622)).toEqual({ w: 180, h: 392 });
    expect(analysisFrameSize(1179, 2556)).toEqual({ w: 180, h: 390 });
    expect(analysisFrameSize(2556, 1179)).toEqual({ w: 180, h: 84 });
    const buf = new Uint8Array(4 * 2 * 3 + 5);
    const frames = splitRawGray(buf, 4, 2, 30, 1);
    expect(frames).toHaveLength(3);
    expect(frames[2].t).toBeCloseTo(1 + 2 / 30);
    expect(frames[1].data.length).toBe(8);
  });
});
