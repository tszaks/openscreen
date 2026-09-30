import { describe, expect, it } from 'vitest';
import { applyOp, applyOps, OpError, parsePointer, setPointer, setRangeSpeed, validateProject, OP_NAMES } from '../src/shared/agentOps';
import { planPolish } from '../src/shared/polish';
import { parseHeadlessArgs } from '../src/shared/headless';
import { parseFreezes, parseSilences } from '../src/shared/silence';
import { defaultProject, type Project } from '../src/shared/types';
import { Timeline } from '../src/shared/timeline';

let n = 0;
const newId = () => `id-${++n}`;
const ctx = { newId };

const phone = (): Project =>
  defaultProject({ screenVideoFile: 'screen.mov', sourceKind: 'iosDevice', sourceSize: { width: 1206, height: 2622 }, duration: 20 });
const desktop = (): Project =>
  defaultProject({ screenVideoFile: 'screen.webm', sourceKind: 'display', sourceSize: { width: 1920, height: 1080 }, duration: 10 });
const outDur = (p: Project) => new Timeline(p.recording.duration, p.clips).outputDuration;

describe('agent ops: clips', () => {
  it('trim keeps only the range and moves captions with the footage', () => {
    let p = applyOp(desktop(), { op: 'addCaption', start: 3, end: 4, text: 'hi' }, ctx).project;
    p = applyOp(p, { op: 'trim', start: 2, end: 8 }, ctx).project;
    expect(p.clips).toHaveLength(1);
    expect(p.clips[0].sourceStart).toBeCloseTo(2);
    expect(p.clips[0].sourceEnd).toBeCloseTo(8);
    expect(outDur(p)).toBeCloseTo(6);
    expect(p.captions[0].start).toBeCloseTo(1);
  });

  it('cut removes source ranges', () => {
    const p = applyOp(desktop(), { op: 'cut', ranges: [{ start: 1, end: 2 }, { start: 5, end: 6 }] }, ctx).project;
    expect(outDur(p)).toBeCloseTo(8);
    expect(p.clips).toHaveLength(3);
  });

  it('speed splits a range out at a new speed', () => {
    const p = applyOp(desktop(), { op: 'speed', start: 2, end: 6, speed: 2 }, ctx).project;
    expect(p.clips.map((c) => [c.sourceStart, c.sourceEnd, c.speed])).toEqual([[0, 2, 1], [2, 6, 2], [6, 10, 1]]);
    expect(outDur(p)).toBeCloseTo(8);
  });

  it('setRangeSpeed leaves clips outside the range alone', () => {
    const clips = setRangeSpeed([{ id: 'a', sourceStart: 0, sourceEnd: 4, speed: 1.5 }], 1, 2, 3);
    expect(clips.map((c) => c.speed)).toEqual([1.5, 3, 1.5]);
  });

  it('split, reorder, clipSpeed, trimClip, deleteClip', () => {
    let p = applyOp(desktop(), { op: 'split', at: 4 }, ctx).project;
    expect(p.clips).toHaveLength(2);
    p = applyOp(p, { op: 'reorder', from: 1, to: 0 }, ctx).project;
    expect(p.clips[0].sourceStart).toBeCloseTo(4);
    p = applyOp(p, { op: 'clipSpeed', index: 0, speed: 2 }, ctx).project;
    expect(outDur(p)).toBeCloseTo(3 + 4);
    p = applyOp(p, { op: 'trimClip', index: 1, sourceEnd: 3 }, ctx).project;
    expect(p.clips[1].sourceEnd).toBe(3);
    p = applyOp(p, { op: 'deleteClip', index: 1 }, ctx).project;
    expect(p.clips).toHaveLength(1);
    expect(() => applyOp(p, { op: 'deleteClip', index: 0 }, ctx)).toThrow(/only clip/);
  });
});

describe('agent ops: overlays', () => {
  it('zoom add / move / remove', () => {
    let p = applyOp(desktop(), { op: 'addZoom', at: 2, x: 0.3, y: 0.4, scale: 2.5 }, ctx).project;
    expect(p.manualZooms[0]).toMatchObject({ inStart: 2, holdStart: 2.5, center: { x: 0.3, y: 0.4 }, scale: 2.5 });
    p = applyOp(p, { op: 'moveZoom', index: 0, at: 5, scale: 1.5 }, ctx).project;
    expect(p.manualZooms[0].inStart).toBe(5);
    expect(p.manualZooms[0].holdStart).toBe(5.5);
    expect(p.manualZooms[0].scale).toBe(1.5);
    p = applyOp(p, { op: 'removeZoom', index: 0 }, ctx).project;
    expect(p.manualZooms).toHaveLength(0);
  });

  it('captions: add, edit, remove, import SRT', () => {
    let p = applyOp(desktop(), { op: 'addCaption', start: 1, end: 2, text: 'one' }, ctx).project;
    const id = p.captions[0].id;
    p = applyOp(p, { op: 'editCaption', id, text: 'uno' }, ctx).project;
    expect(p.captions[0].text).toBe('uno');
    p = applyOp(p, { op: 'removeCaption', id }, ctx).project;
    expect(p.captions).toHaveLength(0);
    p = applyOp(p, { op: 'importCaptions', text: '1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n' }, ctx).project;
    expect(p.captions.map((c) => c.text)).toEqual(['Hello', 'World']);
  });

  it('cutCue removes the cue footage; cutFillers uses word timing', () => {
    let p = applyOp(desktop(), { op: 'setCaptions', captions: [{ start: 2, end: 3, text: 'um so', words: [{ start: 2, end: 2.4, text: 'um' }, { start: 2.5, end: 3, text: 'so' }] }] }, ctx).project;
    const filled = applyOp(p, { op: 'cutFillers' }, ctx).project;
    expect(outDur(filled)).toBeCloseTo(9.6, 1);
    p = applyOp(p, { op: 'cutCue', index: 0 }, ctx).project;
    expect(outDur(p)).toBeCloseTo(9, 1);
  });

  it('cutSilences uses the detected silences (the same planner as Smart cut)', () => {
    const p = applyOp(desktop(), { op: 'cutSilences' }, { ...ctx, silences: [{ start: 2, end: 5 }] }).project;
    // Smart cut insets each edge by 0.1s.
    expect(outDur(p)).toBeCloseTo(7.2);
    expect(() => applyOp(desktop(), { op: 'cutSilences' }, ctx)).toThrow(/silences were not detected/);
  });

  it('chapters and annotations', () => {
    let p = applyOp(desktop(), { op: 'addChapter', start: 0, title: 'Intro' }, ctx).project;
    p = applyOp(p, { op: 'addAnnotation', start: 1, text: 'Look', band: 0, hex: '#ff0000' }, ctx).project;
    expect(p.chapters[0].title).toBe('Intro');
    expect(p.annotations[0]).toMatchObject({ start: 1, end: 4, band: 0 });
    p = applyOp(p, { op: 'editAnnotation', index: 0, text: 'Here' }, ctx).project;
    expect(p.annotations[0].text).toBe('Here');
  });
});

describe('agent ops: style, phone, set', () => {
  it('background swatch and style fields', () => {
    let p = applyOp(desktop(), { op: 'background', swatch: 'ocean' }, ctx).project;
    expect(p.style.background).toMatchObject({ kind: 'gradient', startHex: '#0f2027' });
    p = applyOp(p, { op: 'style', cornerRadius: 40, paddingFraction: 0.1 }, ctx).project;
    expect(p.style.cornerRadius).toBe(40);
  });

  it('taps and waits', () => {
    let p = applyOp(phone(), { op: 'addTap', t: 3, x: 0.2, y: 0.8 }, ctx).project;
    p = applyOp(p, { op: 'moveTap', index: 0, x: 0.5 }, ctx).project;
    expect(p.taps[0]).toMatchObject({ t: 3, x: 0.5, y: 0.8, kind: 'tap' });
    p = applyOp(p, { op: 'setWaits', waits: [{ start: 5, end: 12 }] }, ctx).project;
    const sped = applyOp(p, { op: 'speedUpWaits', speed: 3 }, ctx).project;
    expect(outDur(sped)).toBeLessThan(20);
    const cut = applyOp(p, { op: 'cutWaits' }, ctx).project;
    expect(outDur(cut)).toBeCloseTo(20 - 6.5);
    // A wait that is most of the recording is left alone when capped.
    const whole = applyOp(phone(), { op: 'setWaits', waits: [{ start: 0, end: 20 }] }, ctx).project;
    expect(applyOp(whole, { op: 'speedUpWaits', maxFraction: 0.5 }, ctx).project.clips).toEqual(whole.clips);
  });

  it('set checks JSON types and refuses /recording', () => {
    expect(setPointer(desktop(), '/style/cornerRadius', 12).style.cornerRadius).toBe(12);
    expect(() => setPointer(desktop(), '/style/cornerRadius', 'x')).toThrow(/is a number/);
    expect(() => setPointer(desktop(), '/recording/duration', 3)).toThrow(/read-only/);
    expect(parsePointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
  });

  it('applyOps validates and reports the failing op', () => {
    expect(() => applyOps(desktop(), [{ op: 'style', paddingFraction: 0.9 }], ctx)).toThrow(/paddingFraction/);
    try {
      applyOps(desktop(), [{ op: 'addCaption', start: 1, end: 2, text: 'ok' }, { op: 'nope' }], ctx);
    } catch (e) {
      expect(e).toBeInstanceOf(OpError);
      expect((e as OpError).index).toBe(1);
    }
    expect(validateProject(desktop())).toEqual([]);
    expect(OP_NAMES).toContain('set');
  });
});

describe('polish', () => {
  it('is deterministic and frames phone recordings', () => {
    const a = planPolish(phone(), { style: 'clean', analyzed: false, transcript: false });
    expect(planPolish(phone(), { style: 'clean', analyzed: false, transcript: false })).toEqual(a);
    expect(a).toContainEqual({ op: 'device', frame: true });
    const p = applyOps(phone(), a, ctx).project;
    expect(p.device.frame).toBe(true);
    expect(p.layout.presetId).toBe('social-9x16');
    expect(p.zoom.fromTaps).toBe(true);
  });
});

describe('headless args and ffmpeg parsers', () => {
  it('parses --export', () => {
    expect(parseHeadlessArgs(['electron', '.'])).toBeNull();
    expect(parseHeadlessArgs(['x', '--export', '/b', '--out', '/o.mp4'])).toMatchObject({ bundleDir: '/b', out: '/o.mp4', gif: false });
    expect(parseHeadlessArgs(['x', '--export', '/b', '--out', '/o.gif'])).toMatchObject({ gif: true });
    expect(parseHeadlessArgs(['x', '--export', '/b', '--out', '/dir', '--preset', 'square,feed-4x5'])).toMatchObject({ presets: ['square', 'feed-4x5'] });
    expect(parseHeadlessArgs(['x', '--export', '/b'])).toEqual({ error: '--out needs an output path' });
  });

  it('parses silencedetect and freezedetect', () => {
    expect(parseSilences('silence_start: 1.5\nsilence_end: 3.25 | silence_duration: 1.75\nsilence_start: 8', 10)).toEqual([
      { start: 1.5, end: 3.25 },
      { start: 8, end: 10 },
    ]);
    expect(parseFreezes('lavfi.freezedetect.freeze_start: 2\nlavfi.freezedetect.freeze_end: 4.5')).toEqual([{ start: 2, end: 4.5 }]);
  });
});
