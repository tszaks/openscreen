// Old projects stay exactly as they were (SPEC §6.1, §1.2-1.3). Every project in
// test/fixtures/compat (shapes saved by older versions, a real 1.5.1 iPhone
// take, and damaged values) goes through the load and edit paths that the 3D
// work touches: normalizeProject (twice), applyOps with no ops, a cut through
// applyOps, and remapProject. The results must be byte-equal (key order
// included) to baseline.json, which was captured from main 3dea11b before any
// 3D code existed, and none of them may gain a `phone3d` key.
//
// To capture the baseline (only from main 3dea11b, never to bless a change):
//   COMPAT_BASELINE=write npx vitest run test/phone3dCompat.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeProject, type Project } from '../src/shared/types';
import { applyOps } from '../src/shared/agentOps';
import { remapProject } from '../src/shared/remap';
import { Timeline } from '../src/shared/timeline';

const ROOT = join(__dirname, 'fixtures', 'compat');
const BASELINE = join(ROOT, 'baseline.json');
const WRITE = process.env.COMPAT_BASELINE === 'write';

const FIXTURES = readdirSync(ROOT)
  .filter((f) => f.endsWith('.json') && f !== 'baseline.json')
  .sort();

/** Ids the code under test makes, in order: deterministic stand-ins for randomUUID. */
let idCounter = 0;
const nextId = () => `fixed-id-${++idCounter}`;
beforeEach(() => {
  idCounter = 0;
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => nextId() as `${string}-${string}-${string}-${string}-${string}`);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs `f`, returning its result or the error it threw (refusals are part of the contract too). */
function outcome<T>(f: () => T): T | { error: string } {
  try {
    return f();
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function raw(file: string): Project {
  return JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as Project;
}

/** Everything the baseline pins for one old project. */
function compatOutputs(file: string) {
  idCounter = 0;
  const normalized = normalizeProject(raw(file));
  const renormalized = normalizeProject(structuredClone(normalized));
  const d = normalized.recording.duration;
  const applyEmpty = outcome(() => applyOps(structuredClone(normalized), [], { newId: nextId }).project);
  const cut = outcome(
    () => applyOps(structuredClone(normalized), [{ op: 'cut', ranges: [{ start: d * 0.25, end: d * 0.35 }] }], { newId: nextId }).project,
  );
  // The last clip loses the last fifth of its footage: same ids, so no random ids.
  const clips = normalized.clips.map((c, i, all) =>
    i === all.length - 1 ? { ...c, sourceEnd: c.sourceEnd - (c.sourceEnd - c.sourceStart) * 0.2 } : { ...c },
  );
  const remap = outcome(() => remapProject(structuredClone(normalized), new Timeline(d, normalized.clips), new Timeline(d, clips)));
  return { normalized, renormalized, applyEmpty, cut, remap };
}

const baseline: Record<string, unknown> = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};

describe('phone3d compat: old projects are unchanged', () => {
  it('has the compat fixtures', () => {
    expect(FIXTURES).toEqual([
      'early-display.json',
      'early-iphone-styleframe.json',
      'hostile.json',
      'v151-imported-phone-preset.json',
      'v151-iphone-take.json',
      'v151-mac-iphone-full.json',
    ]);
  });

  if (WRITE) {
    it('writes the baseline', () => {
      const out: Record<string, unknown> = {};
      for (const f of FIXTURES) out[f] = compatOutputs(f);
      writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n');
    });
    return;
  }

  it('the baseline covers every fixture', () => {
    expect(Object.keys(baseline).sort()).toEqual(FIXTURES);
  });

  for (const f of FIXTURES) {
    describe(f, () => {
      const outputs = () => compatOutputs(f);

      it('normalize, applyOps([]), a cut and remapProject are byte-equal to the main baseline', () => {
        const got = outputs();
        const want = baseline[f] as Record<string, unknown>;
        for (const key of ['normalized', 'renormalized', 'applyEmpty', 'cut', 'remap'] as const) {
          expect(JSON.stringify(got[key]), `${f}: ${key}`).toBe(JSON.stringify(want[key]));
        }
      });

      it('gains no phone3d key anywhere', () => {
        const got = outputs();
        for (const [key, value] of Object.entries(got)) {
          expect(value && typeof value === 'object' && 'phone3d' in value, `${f}: ${key}`).toBe(false);
          expect(JSON.stringify(value), `${f}: ${key}`).not.toContain('phone3d');
        }
      });

      it('normalizing twice changes nothing', () => {
        const got = outputs();
        expect(JSON.stringify(got.renormalized)).toBe(JSON.stringify(got.normalized));
      });
    });
  }

  it('applyOps with no ops returns every valid old project unchanged', () => {
    for (const f of FIXTURES) {
      const got = compatOutputs(f);
      if ('error' in got.applyEmpty) continue; // refused: pinned by the baseline instead
      expect(JSON.stringify(got.applyEmpty), f).toBe(JSON.stringify(got.normalized));
    }
  });

  it('the comparison can fail: one changed value is caught', () => {
    const got = compatOutputs('v151-iphone-take.json');
    const want = (baseline['v151-iphone-take.json'] as { normalized: Project }).normalized;
    const tweaked = { ...got.normalized, outputFPS: got.normalized.outputFPS + 1 };
    expect(JSON.stringify(tweaked)).not.toBe(JSON.stringify(want));
    // Key order counts: the same values in another order are a different file.
    const { recording, ...rest } = got.normalized;
    expect(JSON.stringify({ ...rest, recording })).not.toBe(JSON.stringify(want));
  });
});
