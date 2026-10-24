// Source rules for the 3D renderer (SPEC §3.1, §3.9, D9, D17):
// - determinism: no clock and no randomness in renderer/src/phone3d (timing
//   only inside the stats guard, never on a path that affects pixels);
// - three is loaded lazily: only the engine chunk imports it; the compositor
//   and the loader never import three or the engine at runtime;
// - one WebGL context: only engine.ts creates a WebGLRenderer.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src', 'renderer', 'src');
const DIR = join(SRC, 'phone3d');
const files = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f));
const read = (f: string) => readFileSync(f, 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('3D renderer source rules', () => {
  it('has the WP4b modules', () => {
    for (const f of ['loader.ts', 'engine.ts', 'screenTexture.ts', 'shadow.ts', 'passes.ts', 'view.ts']) expect(files).toContain(f);
  });

  it('no Date.now / Math.random anywhere; performance.now only on lines marked "stats only"', () => {
    for (const f of files) {
      const raw = read(join(DIR, f)).split('\n');
      code(read(join(DIR, f)))
        .split('\n')
        .forEach((l, i) => expect(l, `${f}:${i + 1}`).not.toMatch(/Date\.now|Math\.random|crypto\.getRandomValues/));
      raw.forEach((l, i) => {
        if (/performance\.now\(/.test(l.replace(/\/\/.*$/, ''))) expect(l, `${f}:${i + 1} reads the clock outside the stats guard`).toMatch(/\/\/ stats only$/);
      });
    }
  });

  it('the stats guard only reads the clock when stats are on', () => {
    const view = code(read(join(DIR, 'view.ts')));
    expect(view).toMatch(/const t0 = timing \? performance\.now\(\) : 0;/);
    expect(view).toMatch(/if \(timing\) \{[\s\S]*st\.lastMs = performance\.now\(\) - t0;/);
    expect(view).toMatch(/const prof = timing && /);
    expect(view).toMatch(/const mark = \(k: string\) => \{\s*if \(!prof\) return;/);
  });

  it('three is imported only by the engine chunk; the loader imports the engine only dynamically', () => {
    const loader = code(read(join(DIR, 'loader.ts')));
    expect(loader).not.toMatch(/from 'three'/);
    expect(loader).not.toMatch(/^import (?!type).*from '\.\/engine'/m);
    expect(loader).toMatch(/import\('\.\/engine'\)/);
    const comp = code(read(join(SRC, 'compositor.ts')));
    expect(comp).not.toMatch(/from 'three/);
    for (const m of ['engine', 'view', 'passes', 'shadow', 'screenTexture']) expect(comp).not.toMatch(new RegExp(`^import (?!type).*from '\\./phone3d/${m}'`, 'm'));
    const editor = code(read(join(SRC, 'Editor.tsx')));
    expect(editor).not.toMatch(/from 'three/);
    for (const m of ['engine', 'view', 'passes', 'shadow', 'screenTexture']) expect(editor).not.toMatch(new RegExp(`from '\\./phone3d/${m}'`));
  });

  it('only engine.ts makes a WebGLRenderer (one context per process)', () => {
    for (const f of files) {
      const n = (code(read(join(DIR, f))).match(/new THREE\.WebGLRenderer\(/g) ?? []).length;
      expect(n, f).toBe(f === 'engine.ts' ? 1 : 0);
    }
    expect(code(read(join(DIR, 'engine.ts')))).toMatch(/if \(!engine\) \{\s*engine = new Engine\(\);/);
  });
});
