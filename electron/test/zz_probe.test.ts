import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { planDirect } from '../src/shared/phone3d/direct';
import { normalizeProject } from '../src/shared/types';
it('probe', () => {
  const raw = JSON.parse(readFileSync('/tmp/openscreen-3d/wf4/plan/take/project.json', 'utf8'));
  const p = normalizeProject(raw);
  for (const style of ['subtle','hero','bold'] as const) {
    const t0 = Date.now();
    const plan = planDirect(p, { style, replace: true });
    const counts: Record<string, number> = {};
    for (const s of plan.shots) counts[s.recipe] = (counts[s.recipe] ?? 0) + 1;
    console.log(style, Date.now()-t0, 'ms', JSON.stringify(counts), 'moving', plan.shots.filter(s=>s.recipe!=='float').reduce((a,s)=>a+s.end-s.start,0).toFixed(1), 'note', plan.note, 'dropped', plan.check.dropped.length);
  }
}, 600000);
