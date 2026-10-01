import { describe, expect, it } from 'vitest';
import { OpError } from '../src/shared/agentOps';
import { History } from '../src/shared/history';
import { autoEditSummary, planPolish, runPolish } from '../src/shared/polish';
import { defaultProject, type Project } from '../src/shared/types';

// A 72 s phone take: 3 s of dead air at each end, one 9 s still in the middle.
const phone = (): Project => ({
  ...defaultProject({ screenVideoFile: 'screen.mov', sourceKind: 'iosDevice', sourceSize: { width: 1206, height: 2622 }, duration: 72 }),
  taps: [{ id: 't1', t: 10, x: 0.5, y: 0.5, kind: 'tap', confidence: 0.9 }],
  waits: [
    { start: 0, end: 3, edge: 'start' },
    { start: 30, end: 39 },
    { start: 69, end: 72, edge: 'end' },
  ],
  tapsAnalyzed: true,
});
const desktop = (): Project =>
  defaultProject({ screenVideoFile: 'screen.webm', sourceKind: 'display', sourceSize: { width: 1920, height: 1080 }, duration: 40 });

describe('runPolish (Auto-edit and agent polish)', () => {
  it('applies exactly the planned recipe and reports the new length', () => {
    const p = phone();
    const r = runPolish(p, {}, { style: 'clean' });
    expect(r.ops).toEqual(planPolish(p, { style: 'clean', analyzed: false, transcript: false }));
    expect(r.before).toBeCloseTo(72);
    // Ends cut (6 s), the middle still at 3x: (9 - 2 × margin) shrinks by 2/3.
    expect(r.after).toBeLessThan(66);
    expect(r.project.device.frame).toBe(true);
    expect(r.project.zoom.fromTaps).toBe(true);
    expect(r.project.taps).toEqual(p.taps);
    expect(r.notes.length).toBe(r.ops.length);
  });

  it('never touches the input project', () => {
    const p = phone();
    const copy = JSON.parse(JSON.stringify(p));
    runPolish(p, {}, { style: 'clean' });
    expect(p).toEqual(copy);
  });

  it('uses a fresh tap analysis when one is passed', () => {
    const p = { ...phone(), taps: [], waits: [], tapsAnalyzed: false };
    const r = runPolish(p, { tapAnalysis: { taps: phone().taps, deadTime: phone().waits } }, { style: 'clean' });
    expect(r.ops[0]).toEqual({ op: 'analyzeTaps' });
    expect(r.project.tapsAnalyzed).toBe(true);
    expect(r.project.taps).toHaveLength(1);
    expect(r.after).toBeLessThan(66);
  });

  it('is safe to press twice: waits already handled are left alone', () => {
    const once = runPolish(phone(), {}, { style: 'clean' });
    const twice = runPolish(once.project, {}, { style: 'clean' });
    expect(twice.after).toBeCloseTo(once.after);
    expect(twice.project.clips).toEqual(once.project.clips);
  });

  it('keeps the look-only behaviour for Mac takes', () => {
    const r = runPolish(desktop(), {}, { style: 'clean' });
    expect(r.after).toBeCloseTo(r.before);
    expect(r.project.zoom.autofocus).toBe(true);
    expect(r.ops.map((o) => o.op)).not.toContain('cutWaits');
  });

  it('throws OpError on an unusable project instead of half-applying', () => {
    const p = phone();
    expect(() => runPolish({ ...p, recording: { ...p.recording, duration: 0 } }, {}, { style: 'clean' })).toThrow(OpError);
  });
});

describe('autoEditSummary', () => {
  it('shows the length change, or that only the look changed', () => {
    expect(autoEditSummary({ before: 72, after: 48.4 })).toBe('Auto-edit: 1:12 → 0:48 · ⌘Z to undo');
    expect(autoEditSummary({ before: 40, after: 40 })).toBe('Auto-edit: look applied · ⌘Z to undo');
  });
});

describe('Auto-edit is one undo step', () => {
  it('seal before and after keeps it apart from edits on either side', () => {
    // The editor seals before swapping the project in and right after
    // recording it, so edits 100 ms either side stay separate steps.
    const h = new History<string>();
    h.record('original', 1000); // a slider edit: original → edited
    h.seal();
    h.record('edited', 1100); // Auto-edit: edited → auto
    h.seal();
    h.record('auto', 1200); // the next tweak: auto → tweaked
    expect(h.undo('tweaked')).toBe('auto');
    expect(h.undo('auto')).toBe('edited');
    expect(h.undo('edited')).toBe('original');
  });
});
