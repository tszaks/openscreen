import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SHARED = join(__dirname, '../src/shared');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('the shared 3D math stays pure', () => {
  it('nothing under src/shared imports three (the CLI build and node tests load it)', () => {
    const hits = files(SHARED).filter((f) => /from\s+['"]three(\/[^'"]*)?['"]|import\(\s*['"]three/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('src/shared/phone3d and devices3d use no clock and no randomness', () => {
    const list = [...files(join(SHARED, 'phone3d')), join(SHARED, 'devices3d.ts'), join(SHARED, 'focusSegments.ts')];
    expect(list.length).toBeGreaterThan(8);
    const hits = list.filter((f) => /Date\.now|performance\.now|Math\.random|crypto\.randomUUID/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
