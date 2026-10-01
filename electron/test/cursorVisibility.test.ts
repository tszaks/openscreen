import { describe, expect, it } from 'vitest';
import { applyOp, validateProject } from '../src/shared/agentOps';
import { defaultProject, normalizeProject, type Project } from '../src/shared/types';

const screen = () =>
  defaultProject({ screenVideoFile: 'screen.webm', sourceKind: 'display', sourceSize: { width: 1920, height: 1080 }, duration: 10 });

describe('cursor show / opacity', () => {
  it('defaults to shown at the opacity the cursor always had', () => {
    const p = screen();
    expect(p.style.cursorShow).toBe(true);
    expect(p.style.cursorOpacity).toBe(0.85);
  });
  it('fills both in for projects saved before they existed', () => {
    // A project saved before these fields existed.
    const old = screen();
    const style: Record<string, unknown> = { ...old.style };
    delete style.cursorShow;
    delete style.cursorOpacity;
    const p = normalizeProject({ ...old, style } as unknown as Project);
    expect(p.style.cursorShow).toBe(true);
    expect(p.style.cursorOpacity).toBe(0.85);
  });
  it('keeps saved choices', () => {
    const p = screen();
    p.style.cursorShow = false;
    p.style.cursorOpacity = 0.3;
    const n = normalizeProject(structuredClone(p));
    expect(n.style.cursorShow).toBe(false);
    expect(n.style.cursorOpacity).toBe(0.3);
  });
  it('the agent cursor op sets show and opacity, and validation bounds opacity', () => {
    const r = applyOp(screen(), { op: 'cursor', show: false, opacity: 0.5 });
    expect(r.project.style.cursorShow).toBe(false);
    expect(r.project.style.cursorOpacity).toBe(0.5);
    expect(validateProject(r.project)).toEqual([]);
    const bad = applyOp(screen(), { op: 'cursor', opacity: 1.5 }).project;
    expect(validateProject(bad).join(' ')).toMatch(/cursorOpacity/);
  });
});
