// Flat-identity gate, draw-call half (SPEC §6.1, D11). Every golden fixture
// (test/fixtures/3d-golden/<name>) is drawn by the real compositor through the
// harness at a fixed list of output times, and the full call log must equal
// <name>/compositor.log, which was captured from main's compositor (3dea11b)
// before anything touched it. Any change to what the flat path draws (an
// argument, an order, a style set, a box the editor reads) fails here with the
// first differing line.
//
// To capture logs (only from main's compositor, never to bless a change):
//   COMPOSITOR_GOLDEN=write npx vitest run test/compositorGolden.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHarness,
  GOLDEN_DIR,
  goldenFixtureNames,
  loadGoldenFixture,
  type Harness,
  type HarnessInputs,
} from './helpers/compositorHarness';
import type { CursorSample, Point, Project } from '../src/shared/types';
import { AutofocusPlanner, defaultAutofocus, dwellFocusEvents, type FocusSegment } from '../src/shared/autofocus';
import { planTapZoom } from '../src/shared/autozoomTaps';
import { Timeline, toOutputTime } from '../src/shared/timeline';
import { isPhoneProject, layoutPreset, presetAllowsZoom, projectCanvasSize, tapsToOutput } from '../src/shared/mobileProject';
import { clickEvents, ripplesAt } from '../src/shared/ripples';
import { keysAt } from '../src/shared/keystrokes';
import { phoneLayerOn } from '../src/shared/phoneLayer';

const WRITE = process.env.COMPOSITOR_GOLDEN === 'write';

/** Output times drawn for every fixture, in this order on one compositor (as
 *  an export does): before any zoom, taps and clicks, glides, holds, the end. */
const GOLDEN_TIMES = [0.25, 1.3, 1.75, 2.4, 3.1, 4.25, 5.7, 6.95];

const GOLDEN_FIXTURES = goldenFixtureNames();

/** The Editor's `segments` memo as it is at 3dea11b (Editor.tsx:459-478),
 *  frozen here so the golden depends on the compositor, not on the memo's
 *  later home (WP1's focusSegmentsFor has its own equality test). */
function segmentsAt3dea11b(p: Project, cursor: CursorSample[]): FocusSegment[] {
  const timeline = new Timeline(p.recording.duration, p.clips);
  const duration = p.recording.duration;
  if (!presetAllowsZoom(layoutPreset(p))) return [];
  const taps =
    isPhoneProject(p) && p.zoom.fromTaps
      ? planTapZoom(tapsToOutput(p.taps, timeline), timeline.outputDuration || duration, { scale: p.zoom.depth })
      : [];
  const auto = p.zoom.autofocus
    ? new AutofocusPlanner({ ...defaultAutofocus, maxScale: p.zoom.depth }).planSegments(
        toOutputTime(
          [...cursor.filter((s) => s.kind === 'clickDown'), ...(p.zoom.dwell ? dwellFocusEvents(cursor) : []), ...p.zoom.motionEvents],
          timeline,
        ),
        timeline.outputDuration || duration,
      )
    : [];
  return [...auto, ...taps, ...p.manualZooms].sort((a, b) => a.inStart - b.inStart);
}

/** The cursor at source time t: linear between the recorded samples. */
function cursorAt(samples: CursorSample[], t: number): Point | null {
  if (!samples.length) return null;
  if (t <= samples[0].time) return { x: samples[0].x, y: samples[0].y };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (t <= b.time) {
      const k = b.time > a.time ? (t - a.time) / (b.time - a.time) : 1;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  const last = samples[samples.length - 1];
  return { x: last.x, y: last.y };
}

/** Draws fixture `name` at every golden time and returns the log. */
async function goldenLog(name: string, edit?: (p: Project) => Project): Promise<string[]> {
  const fx = loadGoldenFixture(name);
  const project = edit ? edit(fx.project) : fx.project;
  const h: Harness = await createHarness();
  try {
    const tl = new Timeline(project.recording.duration, project.clips);
    const canvas = projectCanvasSize(project);
    h.log.push(`# fixture ${name} canvas ${canvas.width}x${canvas.height}`);
    const comp = h.compositor(project, canvas, segmentsAt3dea11b(project, fx.cursor));
    const rec = project.recording;
    const screen = h.video('screen', rec.sourceSize.width, rec.sourceSize.height);
    const camera = rec.cameraVideoFile ? h.video('camera', 640, 480) : undefined;
    const phone = phoneLayerOn(project) && rec.phoneSize ? h.video('phone', rec.phoneSize.width, rec.phoneSize.height) : undefined;
    const moves = fx.cursor.filter((s) => s.kind === 'move');
    const clicks = clickEvents(fx.cursor, tl);
    GOLDEN_TIMES.forEach((outT, i) => {
      const srcT = tl.sourceTime(outT);
      if (srcT === null) return;
      const inputs: HarnessInputs = {
        frame: screen,
        cursor: rec.sourceKind === 'iosDevice' ? null : cursorAt(moves, srcT),
        cursorTrail: project.style.cursorTrail ? [0.2, 0.15, 0.1, 0.05].flatMap((d) => cursorAt(moves, srcT - d) ?? []) : undefined,
        ripples: ripplesAt(outT, clicks),
        keystrokes: keysAt(srcT, fx.keys),
        // The first frame draws before the side videos have loaded.
        cameraFrame: i === 0 ? undefined : camera,
        phoneFrame: i === 0 ? undefined : phone,
      };
      h.render(comp, outT, inputs);
    });
    return h.log;
  } finally {
    h.dispose();
  }
}

const logFile = (name: string) => join(GOLDEN_DIR, name, 'compositor.log');

/** The first line where two logs differ, with a little context. */
function firstDifference(actual: string[], expected: string[]): string | null {
  const n = Math.max(actual.length, expected.length);
  for (let i = 0; i < n; i++) {
    if (actual[i] !== expected[i]) {
      const render = [...expected.slice(0, i + 1)].reverse().find((l) => l.startsWith('# render')) ?? '(before the first render)';
      return [
        `line ${i + 1} (in ${render}) of ${expected.length} expected / ${actual.length} actual`,
        `  expected: ${expected[i] ?? '(end of log)'}`,
        `  actual:   ${actual[i] ?? '(end of log)'}`,
      ].join('\n');
    }
  }
  return null;
}

describe('compositor golden: flat draw calls equal main 3dea11b', () => {
  it('has fixtures', () => {
    expect(GOLDEN_FIXTURES).toEqual(['display', 'ios-16x9', 'ios-appstore', 'ios-landscape', 'ios-social', 'mac-iphone', 'window']);
  });

  for (const name of GOLDEN_FIXTURES) {
    it(`${name}: the call log equals the committed main log`, async () => {
      const log = await goldenLog(name);
      if (WRITE) {
        writeFileSync(logFile(name), log.join('\n') + '\n');
        return;
      }
      expect(existsSync(logFile(name)), `${logFile(name)} is missing: capture it from main 3dea11b`).toBe(true);
      const expected = readFileSync(logFile(name), 'utf8').replace(/\n$/, '').split('\n');
      expect(firstDifference(log, expected)).toBeNull();
    });
  }
});

describe('compositor golden: the gate can fail', () => {
  it('every fixture draws all its renders and its recording', async () => {
    for (const name of GOLDEN_FIXTURES) {
      const log = await goldenLog(name);
      const renders = log.filter((l) => l.startsWith('# render')).length;
      const expectedRenders = GOLDEN_TIMES.filter((t) => {
        const p = loadGoldenFixture(name).project;
        return new Timeline(p.recording.duration, p.clips).sourceTime(t) !== null;
      }).length;
      expect(renders, name).toBe(expectedRenders);
      expect(log.some((l) => l.includes('.drawImage(video:screen,')), name).toBe(true);
    }
  });

  it('the same fixture logs the same calls twice (no state leaks between harnesses)', async () => {
    const a = await goldenLog('window');
    const b = await goldenLog('window');
    expect(firstDifference(b, a)).toBeNull();
  });

  it('a sub-pixel change in placement changes the log', async () => {
    const base = await goldenLog('ios-landscape');
    const moved = await goldenLog('ios-landscape', (p) => ({
      ...p,
      style: { ...p.style, contentTransform: { ...p.style.contentTransform!, x: p.style.contentTransform!.x! + 1e-4 } },
    }));
    expect(firstDifference(moved, base)).not.toBeNull();
  });

  it('a change in draw order changes the log', async () => {
    const base = await goldenLog('window');
    const reordered = await goldenLog('window', (p) => ({ ...p, layerOrder: ['camera', 'content', 'text:ann-1'] }));
    expect(firstDifference(reordered, base)).not.toBeNull();
  });

  it('the log covers what the flat path draws', async () => {
    const all = (await Promise.all(GOLDEN_FIXTURES.map((n) => goldenLog(n)))).flat();
    const has = (s: string) => all.some((l) => l.includes(s));
    // Backdrops: gradient, mesh + grain tile, solid, the blurred recording.
    expect(has('.createLinearGradient(')).toBe(true);
    expect(has('.putImageData(imageData<256x256')).toBe(true);
    expect(has('.filter = "blur(')).toBe(true);
    // The recording, the camera bubble, the phone layer, cursor, ripples, keys.
    expect(has('.drawImage(video:camera,')).toBe(true);
    expect(has('.drawImage(video:phone,')).toBe(true);
    expect(has('.ellipse(')).toBe(true);
    expect(has('.fillText("⌘"')).toBe(true);
    // Text overlay, caption, title card.
    expect(has('.fillText("Look here"')).toBe(true);
    expect(has('.fillText("Tap, swipe, hold, type"')).toBe(true);
    expect(has('.fillText("Golden title"')).toBe(true);
    // A landscape device frame is drawn rotated.
    expect(has('.rotate(')).toBe(true);
  });
});
