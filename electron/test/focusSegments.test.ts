import { describe, expect, it } from 'vitest';
import { AutofocusPlanner, defaultAutofocus, dwellFocusEvents, type FocusSegment } from '../src/shared/autofocus';
import { planTapZoom } from '../src/shared/autozoomTaps';
import { focusSegmentsFor } from '../src/shared/focusSegments';
import { isPhoneProject, layoutPreset, presetAllowsZoom, tapsToOutput } from '../src/shared/mobileProject';
import { Timeline, toOutputTime } from '../src/shared/timeline';
import { defaultProject, type CursorSample, type Project } from '../src/shared/types';
import { lcg, phoneProject } from './helpers/phone3dFixtures';

/**
 * The Editor's `segments` memo body as it is today (Editor.tsx:459-478),
 * copied verbatim with its closure variables passed in. focusSegmentsFor
 * must give the same list.
 */
function editorMemo(proj: Project, cursor: CursorSample[], duration: number): FocusSegment[] {
  const preset = layoutPreset(proj);
  const timeline = new Timeline(proj.recording.duration, proj.clips);
  const { autofocus: autofocusOn, dwell: dwellOn, depth: zoomDepth, motionEvents: motionEv } = proj.zoom;
  const manualSegments = proj.manualZooms;
  const isPhone = isPhoneProject(proj);
  const outTaps = tapsToOutput(proj.taps, timeline);
  const fromTaps = isPhone && proj.zoom.fromTaps;
  // ---- memo body, verbatim ----
  // App Store previews stay on the native UI.
  if (!presetAllowsZoom(preset)) return [];
  const taps = fromTaps ? planTapZoom(outTaps, timeline.outputDuration || duration, { scale: zoomDepth }) : [];
  const auto = autofocusOn
    ? new AutofocusPlanner({ ...defaultAutofocus, maxScale: zoomDepth }).planSegments(
        // Clicks, dwells and touches are source time; zooms play in output time.
        toOutputTime(
          [
            ...cursor.filter((s) => s.kind === 'clickDown'),
            ...(dwellOn ? dwellFocusEvents(cursor) : []),
            ...motionEv,
          ],
          timeline,
        ),
        timeline.outputDuration || duration,
      )
    : [];
  return [...auto, ...taps, ...manualSegments].sort((a, b) => a.inStart - b.inStart);
}

/** A cursor track: wandering moves with clicks and a few long dwells. */
function cursorTrack(seed: number, seconds: number): CursorSample[] {
  const r = lcg(seed);
  const out: CursorSample[] = [];
  let x = 0.5;
  let y = 0.5;
  for (let t = 0; t < seconds; t += 1 / 30) {
    const still = Math.floor(t) % 5 === 3; // a dwell every 5 s
    if (!still) {
      x = Math.min(1, Math.max(0, x + (r() - 0.5) * 0.03));
      y = Math.min(1, Math.max(0, y + (r() - 0.5) * 0.03));
    }
    out.push({ time: t, x, y, kind: 'move' });
    if (r() < 0.01) out.push({ time: t, x, y, kind: 'clickDown' }, { time: t + 0.08, x, y, kind: 'clickUp' });
  }
  return out;
}

function screenProject(): Project {
  const p = defaultProject({ screenVideoFile: 's.webm', sourceKind: 'display', sourceSize: { width: 2880, height: 1800 }, duration: 30 });
  p.clips = [
    { id: 'a', sourceStart: 0, sourceEnd: 12, speed: 1 },
    { id: 'b', sourceStart: 15, sourceEnd: 30, speed: 2 },
  ];
  p.zoom.motionEvents = [{ time: 20, x: 0.3, y: 0.7, kind: 'clickDown' }];
  p.manualZooms = [{ inStart: 4, holdStart: 4.5, holdEnd: 6, outEnd: 6.5, center: { x: 0.2, y: 0.3 }, scale: 1.8 }];
  return p;
}

function tappedPhone(): Project {
  const p = phoneProject({ duration: 20 });
  p.taps = [
    { id: 't1', t: 2, x: 0.5, y: 0.3, kind: 'tap', confidence: 1, settleT: 2.6 },
    { id: 't2', t: 6, x: 0.2, y: 0.8, kind: 'swipe', endX: 0.2, endY: 0.2, duration: 0.4, confidence: 0.9 },
    { id: 't3', t: 11, x: 0.6, y: 0.6, kind: 'typing', duration: 2, confidence: 0.8 },
  ];
  p.manualZooms = [{ inStart: 15, holdStart: 15.4, holdEnd: 16, outEnd: 16.5, center: { x: 0.5, y: 0.5 }, scale: 1.5 }];
  return p;
}

describe('focusSegmentsFor', () => {
  it('equals the Editor memo on clicks, dwells, motion events and manual zooms (a cut, sped-up timeline)', () => {
    const p = screenProject();
    const cursor = cursorTrack(3, 30);
    const want = editorMemo(p, cursor, 30);
    expect(want.length).toBeGreaterThan(2); // the fixture really produces zooms
    expect(focusSegmentsFor(p, cursor, 30)).toEqual(want);
    // Dwell off, autofocus off: still equal.
    for (const zoom of [{ ...p.zoom, dwell: false }, { ...p.zoom, autofocus: false }]) {
      const q = { ...p, zoom };
      expect(focusSegmentsFor(q, cursor, 30)).toEqual(editorMemo(q, cursor, 30));
    }
  });

  it('equals the Editor memo on an iPhone take with an empty cursor (taps + autofocus on motion events)', () => {
    const p = tappedPhone();
    p.zoom.motionEvents = [{ time: 8, x: 0.4, y: 0.4, kind: 'clickDown' }];
    const want = editorMemo(p, [], 20);
    expect(want.some((z) => z.inStart < 3)).toBe(true); // a tap zoom
    expect(focusSegmentsFor(p, [], 20)).toEqual(want);
    expect(focusSegmentsFor(p)).toEqual(want); // the fallback defaults to the recording's duration
    expect(focusSegmentsFor({ ...p, zoom: { ...p.zoom, fromTaps: false } }, [], 20)).toEqual(editorMemo({ ...p, zoom: { ...p.zoom, fromTaps: false } }, [], 20));
  });

  it('is [] on an App Store preview', () => {
    const p = tappedPhone();
    p.layout.presetId = 'appstore';
    expect(focusSegmentsFor(p, [], 20)).toEqual([]);
    expect(editorMemo(p, [], 20)).toEqual([]);
  });

  it('keeps the [auto, taps, manual] order for equal starts (stable sort)', () => {
    const p = tappedPhone();
    const tapZooms = focusSegmentsFor({ ...p, manualZooms: [] }, [], 20);
    const first = tapZooms[0];
    const twin = { ...first, center: { x: 0.9, y: 0.9 } };
    const segs = focusSegmentsFor({ ...p, manualZooms: [twin] }, [], 20);
    const i = segs.findIndex((z) => z.inStart === first.inStart && z.center.x !== 0.9);
    expect(segs[i + 1]).toEqual(twin);
  });
});
