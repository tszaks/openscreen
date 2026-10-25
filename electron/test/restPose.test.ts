// The rest pose after Auto 3D (AGENTS.md "Which keyframe a pose edit changes", skill step 5). Auto 3D bakes
// the rest pose into the End of the intro AND of every planned shot that returns to rest, so editing only the
// intro's End changes the rest until the first planned shot. setPose's note names the later moves that still
// hold the old pose, with the ops that fix them; the documented recipe is: edit the intro's End, then apply
// the ops the note lists. These tests run that recipe on real Auto 3D plans and check every rest moment.
import { describe, expect, it } from 'vitest';
import { applyOps, type EditOp } from '../src/shared/agentOps';
import { type Pose, POSE_KEYS } from '../src/shared/phone3d/model';
import { poseAt } from '../src/shared/phone3d/pose';
import type { Project } from '../src/shared/types';
import { phoneProject } from './helpers/phone3dFixtures';

let n = 0;
const ctx = { newId: () => `r${++n}` };
const apply = (p: Project, ops: EditOp[]) => applyOps(p, ops, ctx);

/** A 40 s take with two long waits: hero plans a layback in each (gaps >= 2.4 s), bold plans turns. */
function planned(style: 'hero' | 'bold'): Project {
  const p = phoneProject({ duration: 40 });
  p.taps = [3, 20, 36].map((t, i) => ({ id: `t${i}`, t, x: 0.5, y: 0.5, kind: 'tap' as const, confidence: 1 }));
  p.waits = [
    { start: 5, end: 18 },
    { start: 22, end: 34 },
  ];
  p.tapsAnalyzed = true;
  return apply(p, [{ op: 'direct', style, scenes: false }]).project;
}

/** Same pose up to whole turns (a turn-to-back ends one full turn on). */
function samePose(a: Pose, b: Pose): boolean {
  const k = Math.round((a.turn - b.turn) / 360);
  return POSE_KEYS.every((key) => Math.abs(a[key] - b[key] - (key === 'turn' ? 360 * k : 0)) < 1e-6);
}

/** The ops the setPose note asks for ("For one rest pose, apply: [...]"), or [] when it asks for none. */
function noteOps(note: string): EditOp[] {
  const m = note.match(/For one rest pose, apply: (\[.*\])$/);
  return m ? JSON.parse(m[1]) : [];
}

const NEW_REST = { turn: -12, tilt: 6, size: 0.9 };
const times = Array.from({ length: 800 }, (_, i) => i * 0.05);

describe('rest pose after Auto 3D', () => {
  for (const style of ['hero', 'bold'] as const) {
    it(`${style}: the intro End edit plus the ops its note lists rest at the new pose everywhere the plan rested`, () => {
      const before = planned(style);
      const p3 = before.phone3d!;
      const oldRest = p3.transitions[0].to;
      // The plan has shots after the intro that return to rest (the case the old recipe got wrong).
      expect(p3.transitions.length).toBeGreaterThan(2);
      const restTimes = times.filter((t) => samePose(poseAt(p3, t), oldRest) && t > p3.transitions[0].end);
      expect(restTimes.some((t) => t > p3.transitions[1].end)).toBe(true);
      const newRest: Pose = { ...oldRest, ...NEW_REST };

      const step1 = apply(before, [{ op: 'setPose', index: 0, end: 'to', ...NEW_REST }]);
      const fix = noteOps(step1.notes[0]);
      expect(fix.length, step1.notes[0]).toBeGreaterThan(0);
      // Editing only the intro's End leaves the old rest after the first planned shot: the bug the note warns of.
      expect(restTimes.filter((t) => !samePose(poseAt(step1.project.phone3d!, t), newRest)).length).toBeGreaterThan(0);

      const after = apply(step1.project, fix).project.phone3d!;
      const wrong = restTimes.filter((t) => !samePose(poseAt(after, t), newRest));
      expect(wrong, `still off the new rest at ${wrong.slice(0, 5).join(', ')} s`).toEqual([]);
      // The phone does not unwind a turn it already made: a whole-turn End keeps its whole turns.
      for (const [i, t] of after.transitions.entries()) {
        const was = p3.transitions[i];
        expect(Math.abs(Math.round((t.to.turn - was.to.turn) / 360)), `${t.id}`).toBe(0);
      }
    });
  }

  it('the note is silent when no later move holds the old pose', () => {
    const p = apply(phoneProject({ duration: 10 }), [{ op: 'phone3d', enabled: true }, { op: 'shot', recipe: 'spin-in', at: 0 }]).project;
    const r = apply(p, [{ op: 'setPose', index: 0, end: 'to', turn: -8, tilt: 5 }]);
    expect(r.notes[0]).toMatch(/^setPose edited End of \S+$/);
  });

  it('the note names each later move that holds the old pose, as End or Start', () => {
    const p = apply(phoneProject({ duration: 20 }), [
      { op: 'phone3d', enabled: true },
      { op: 'shot', recipe: 'spin-in', at: 0 },
      { op: 'shot', recipe: 'hero-layback', at: 6 },
    ]).project;
    const r = apply(p, [{ op: 'setPose', index: 0, end: 'to', turn: -8, tilt: 5 }]);
    const last = r.project.phone3d!.transitions.length - 1;
    expect(r.notes[0]).toContain(`End of ${r.project.phone3d!.transitions[last].id} (index ${last}) still holds the old pose (turn 0, tilt 0)`);
    expect(noteOps(r.notes[0])).toEqual([{ op: 'setPose', index: last, end: 'to', turn: -8, tilt: 5 }]);
  });
});
