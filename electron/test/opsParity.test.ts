// The equal test, automatic part (SPEC §6.6a): an agent with only AGENTS.md
// and the CLI can do everything a person does in the editor.
//
// - every op is documented, and every op the switch handles is a named op
// - every op field a 3D editor control sends is accepted by its op and named
//   in AGENTS.md's parity table
// - the 3D numbers AGENTS.md states (recipe lengths, warning codes, easing
//   names, ranges) match the code, so the doc cannot go stale silently
// - every CLI command is documented
// - the editor's 3D controls write only through apply3d (the shared op path)
//
// The source-parse cases came from WP2 (/tmp/openscreen-3d/wf/wp2/requests.md).
// They read the source and PHONE3D_OP_FIELDS, so no case depends on a
// hand-copied list.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps, OP_NAMES } from '../src/shared/agentOps';
import { defaultProject } from '../src/shared/types';
import { PHONE3D_OP_FIELDS, PHONE3D_OP_NAMES } from '../src/shared/phone3d/ops';
import { defaultShotDuration, SHOTS } from '../src/shared/phone3d/shots';
import { WARNING_CODES } from '../src/shared/phone3d/warnings';
import { EASING_NAMES, LIGHT_PRESET_NAMES, POSE_KEYS, POSE_RANGE, SHOT_RECIPES } from '../src/shared/phone3d/model';

const E = join(__dirname, '..');
const SRC = (f: string) => readFileSync(join(E, f), 'utf8');
const AGENTS = readFileSync(join(E, '..', 'AGENTS.md'), 'utf8');

/** The body of `export function <name>(` up to the next top-level `\n}`. */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`export function ${name}(`);
  expect(at, `${name} exists`).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf('\n}\n', at));
}
const cases = (body: string) => [...body.matchAll(/case '([^']+)'/g)].map((m) => m[1]);

/** The markdown under `heading` up to the next heading of the same or a higher level. */
function section(md: string, heading: string): string {
  const at = md.indexOf(`\n${heading}\n`);
  expect(at, `AGENTS.md has "${heading}"`).toBeGreaterThan(-1);
  const level = heading.match(/^#+/)![0].length;
  const rest = md.slice(at + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
}
const word = (w: string) => new RegExp(`(^|[^\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`);

const PARITY = section(AGENTS, '### Parity with the editor');
const COMMANDS = section(AGENTS, '### Commands');
const P3D = section(AGENTS, '## 3D phone (iPhone and iPad takes)');

describe('ops parity: source parse (WP2 cases)', () => {
  it('OP_NAMES has no duplicates', () => {
    expect(new Set(OP_NAMES).size).toBe(OP_NAMES.length);
  });

  it("every case '…' in applyOp is in OP_NAMES, and every OP_NAMES entry has a case", () => {
    const c = cases(fnBody(SRC('src/shared/agentOps.ts'), 'applyOp'));
    for (const name of c) expect(OP_NAMES as readonly string[], `case '${name}'`).toContain(name);
    for (const name of OP_NAMES) expect(c, `OP_NAMES '${name}' has a case`).toContain(name);
  });

  it('the 3D op switch (phone3d/ops.ts applyPhone3dOp) handles exactly PHONE3D_OP_NAMES', () => {
    expect(cases(fnBody(SRC('src/shared/phone3d/ops.ts'), 'applyPhone3dOp')).sort()).toEqual([...PHONE3D_OP_NAMES].sort());
  });

  it('PHONE3D_OP_FIELDS lists every 3D op plus direct', () => {
    expect(Object.keys(PHONE3D_OP_FIELDS).sort()).toEqual([...PHONE3D_OP_NAMES, 'direct'].sort());
  });
});

describe('ops parity: AGENTS.md names every op and every editor field', () => {
  it('every OP_NAMES entry appears in AGENTS.md as an op', () => {
    for (const name of OP_NAMES) expect(AGENTS, `op ${name}`).toMatch(word(name));
  });

  it('every 3D op appears in the parity table', () => {
    for (const name of [...PHONE3D_OP_NAMES, 'direct']) expect(PARITY, `parity row for ${name}`).toMatch(word(name));
  });

  // §4.3: every field a 3D editor control sends, by op.
  const EDITOR_FIELDS: [keyof typeof PHONE3D_OP_FIELDS, string][] = [
    ['direct', 'style'], ['direct', 'replace'], ['direct', 'scenes'],
    ['shot', 'recipe'], ['shot', 'at'], ['shot', 'duration'], ['shot', 'return'], ['shot', 'intensity'], ['shot', 'direction'],
    ['setPose', 'at'], ['setPose', 'target'], ['setPose', 'id'], ['setPose', 'end'], ['setPose', 'focus'],
    ['editTransition', 'start'], ['editTransition', 'end'], ['editTransition', 'by'], ['editTransition', 'from'],
    ['editTransition', 'easing'], ['editTransition', 'stiffness'], ['editTransition', 'damping'], ['editTransition', 'bezier'],
    ['editTransition', 'fitDuration'], ['editTransition', 'swap'], ['editTransition', 'resetEnd'],
    ['addTransition', 'start'], ['addTransition', 'end'], ['addTransition', 'to'], ['addTransition', 'fitDuration'],
    ['phone3d', 'enabled'], ['phone3d', 'clear'], ['phone3d', 'camera'], ['phone3d', 'light'], ['phone3d', 'glass'], ['phone3d', 'back'],
    ['phone3d', 'shadow'], ['phone3d', 'dof'], ['phone3d', 'float'], ['phone3d', 'motionBlur'], ['phone3d', 'supersample'],
  ];

  it.each(EDITOR_FIELDS)('%s.%s is accepted by the op and named in the parity table', (op, field) => {
    expect(PHONE3D_OP_FIELDS[op] as readonly string[], `${op} accepts ${field}`).toContain(field);
    // The field sits in a parity row that also names its op (or, for the direct command, the row's flag).
    const rows = PARITY.split('\n').filter((l) => l.startsWith('|') && word(op).test(l));
    expect(rows.some((r) => word(field).test(r)), `a parity row for ${op} names ${field}`).toBe(true);
  });

  it('every pose channel is a setPose field and in the parity table', () => {
    for (const k of POSE_KEYS) {
      expect(PHONE3D_OP_FIELDS.setPose as readonly string[]).toContain(k);
      expect(PARITY, `pose channel ${k}`).toMatch(word(k));
    }
  });

  it('the direct command flags map to the op fields in the same row', () => {
    for (const [field, flag] of [['style', '--style'], ['replace', '--keep'], ['scenes', '--no-scenes']] as const) {
      const row = PARITY.split('\n').find((l) => l.includes(`direct {${field}`));
      expect(row, `parity row for direct {${field}}`).toBeDefined();
      expect(row).toContain(flag);
    }
  });

  it('exportSettings.preset (D18) documents uhd4k for layout presets', () => {
    const row = PARITY.split('\n').find((l) => l.includes('exportSettings {preset'));
    expect(row).toBeDefined();
    expect(row).toMatch(/uhd4k/);
    expect(row).toMatch(/App Store/);
  });

  it('the editor has the preset Resolution control the row names, writing exportPreset through the exportSettings op', () => {
    const row = PARITY.split('\n').find((l) => l.includes('exportSettings {preset'))!;
    expect(row).toMatch(/for a layout preset: Resolution/);
    const panel = SRC('src/renderer/src/components/ExportPanel.tsx');
    // The preset branch renders the Resolution picker (not for App Store presets), and its hint uses the size the
    // export writes (presetCanvasSize). Integration: WP5's ExportPanel owns the picker; the editor passes onResolution.
    const branch = panel.slice(panel.indexOf('{layoutPreset ? ('), panel.indexOf(') : (', panel.indexOf('{layoutPreset ? (')));
    expect(branch, 'the preset branch').not.toBe('');
    expect(branch).toMatch(/Uses the \{layoutPreset\.label\} layout: \{sizeText\(layoutPreset, exportPreset\)\}/);
    expect(panel).toMatch(/function sizeText\([^)]*\) \{\s*const s = presetCanvasSize\(p, exportPreset\);/);
    expect(branch).toMatch(/layoutPreset\.group !== 'App Store' &&/);
    expect(branch).toMatch(/label="Resolution"/);
    expect(branch).toMatch(/value: 'uhd4k'/);
    expect(branch).toMatch(/onChange=\{onResolution\}/);
    const editor = SRC('src/renderer/src/Editor.tsx');
    expect(editor).toMatch(/exportPreset=\{proj\.exportPreset\}/);
    // The op is the only path: the editor's apply path with the agent's exportSettings op, no direct field write.
    expect(editor).toMatch(/onResolution=\{\(preset\) => apply3d\(\{ op: 'exportSettings', preset \}\)\}/);
    // The op it sends writes exportPreset, and a layout preset at uhd4k exports at 2160x3840.
    const p = defaultProject({ screenVideoFile: 'screen.mov', sourceKind: 'iosDevice', sourceSize: { width: 1206, height: 2622 }, duration: 20 });
    expect(applyOps(p, [{ op: 'exportSettings', preset: 'uhd4k' }]).project.exportPreset).toBe('uhd4k');
  });

  it('exportSettings.fps follows the editor: no frame-rate control on a layout preset, so the op refuses it there', () => {
    const row = PARITY.split('\n').find((l) => l.includes('exportSettings {preset'))!;
    expect(row).toMatch(/`fps` applies only with no layout preset/);
    expect(row).toMatch(/info\.export\.fps/);
    // The editor: the Frame rate control lives in singleSettings, which ExportPanel shows only without a layout preset.
    const panel = SRC('src/renderer/src/components/ExportPanel.tsx');
    expect(panel).toMatch(/\{layoutPreset \? \([\s\S]*?\) : \(\s*singleSettings/);
    expect(SRC('src/renderer/src/Editor.tsx')).toMatch(/const fps = preset \? preset\.fps : proj\.outputFPS;/);
    // The op: refused on a layout preset (an iPhone take starts on social-9x16), applied without one.
    const p = defaultProject({ screenVideoFile: 'screen.mov', sourceKind: 'iosDevice', sourceSize: { width: 1206, height: 2622 }, duration: 20 });
    expect(() => applyOps(p, [{ op: 'exportSettings', fps: 24 }])).toThrow(/fps applies only with no layout preset/);
    expect(applyOps(p, [{ op: 'layout', presetId: 'none' }, { op: 'exportSettings', fps: 24 }]).project.outputFPS).toBe(24);
  });

  it('Reset 3D Pose is documented as the exact op pair (clearTransitions + base FRONT)', () => {
    const row = PARITY.split('\n').find((l) => l.includes('Reset 3D Pose'));
    expect(row).toBeDefined();
    const json = row!.match(/`(\[.*\])`/)?.[1];
    expect(json, 'the pair as JSON').toBeDefined();
    const ops = JSON.parse(json!);
    expect(ops).toEqual([
      { op: 'clearTransitions' },
      { op: 'setPose', target: 'base', turn: 0, tilt: 0, rotate: 0, size: 1, x: 0, y: 0, light: 0, focus: 1 },
    ]);
  });
});

describe('ops parity: the rest pose after Auto 3D and the worked example', () => {
  const SKILL = readFileSync(join(E, '..', 'skills', 'openscreen', 'SKILL.md'), 'utf8');
  /** The note setPose gives when later moves still hold the old rest pose (restPose.test.ts runs the recipe). */
  function restNote(): string {
    const p = applyOps(defaultProject({ screenVideoFile: 'screen.mov', sourceKind: 'iosDevice', sourceSize: { width: 1206, height: 2622 }, duration: 20 }), [
      { op: 'phone3d', enabled: true },
      { op: 'shot', recipe: 'spin-in', at: 0 },
      { op: 'shot', recipe: 'hero-layback', at: 6 },
    ]).project;
    // The intro's rest is the End of its last move (index 1: spin-in writes the spin and a settle).
    return applyOps(p, [{ op: 'setPose', index: 1, end: 'to', turn: -8, tilt: 5 }]).notes[0];
  }

  it('AGENTS.md and the skill tell the agent to apply the ops the setPose note lists, in the words the note uses', () => {
    const phrase = restNote().match(/(For one rest pose, apply:)/)?.[1];
    expect(phrase, 'the note ends with the ops to apply').toBeDefined();
    const flat = (md: string) => md.replace(/\s+/g, ' ');
    expect(flat(AGENTS)).toContain(phrase!);
    expect(flat(SKILL)).toContain(phrase!);
    // Both say a planned shot after the intro holds the rest pose too (the old text said the intro alone).
    expect(AGENTS).toMatch(/every planned\s+shot\s+that\s+returns\s+to\s+rest/);
    expect(SKILL).toMatch(/every\s+planned shot that returns to rest/);
    expect(AGENTS).not.toMatch(/rest pose is the End of the intro \(and of each later move\), so\s+edit that End/);
  });

  it('the worked example checks its fixes with --dry-run before it applies them, and keeps decision 18\'s restraint', () => {
    const ex = section(AGENTS, '### Example: "make this world class" (an iPhone take)');
    const dry = ex.indexOf('apply "$B" fixes.json --dry-run');
    const real = ex.search(/apply "\$B" fixes\.json\s+#/);
    expect(dry, 'a dry run of fixes.json').toBeGreaterThan(-1);
    expect(real, 'the real apply').toBeGreaterThan(dry);
    const fixes = JSON.parse(ex.match(/```json\n([\s\S]*?)```/)![1]);
    // Every op in it is a real op. Owner decision 18 (restraint): after the spin-in at 0, the only big move it adds
    // is one layback at least 20 s later (the bold limit for a promo); the quiet middle gets float.
    for (const o of fixes) expect(OP_NAMES as readonly string[]).toContain(o.op);
    const shots = fixes.filter((o: { op: string }) => o.op === 'shot') as { recipe: string; at?: number }[];
    expect(shots.map((o) => o.recipe)).toEqual(['float', 'hero-layback']);
    const big = shots.filter((o) => o.recipe !== 'float');
    expect(big.every((o) => (o.at ?? 0) >= 20)).toBe(true);
  });
});

describe('ops parity: the 3D numbers in AGENTS.md match the code', () => {
  it('every warning code is in the warnings table', () => {
    const table = section(P3D, '### Warnings');
    for (const code of WARNING_CODES) expect(table, `warning ${code}`).toMatch(new RegExp(`\\| \`${code}\` \\|`));
  });

  it('every shot recipe row states its real default length (and the one-way length)', () => {
    const table = section(P3D, '### Shot recipes (`shot`)');
    for (const r of SHOT_RECIPES) {
      const row = table.split('\n').find((l) => l.startsWith(`| \`${r}\` |`));
      expect(row, `recipe row ${r}`).toBeDefined();
      const cell = row!.split('|')[2];
      if (SHOTS[r].float) {
        expect(cell.trim()).toBe('—');
        continue;
      }
      expect(cell, `${r} length`).toContain(`${SHOTS[r].duration.toFixed(1)} s`);
      const stay = defaultShotDuration(r, 'stay');
      if (stay !== SHOTS[r].duration) expect(cell, `${r} one-way length`).toContain(`${stay} s`);
    }
  });

  it('every easing name and light preset is named', () => {
    for (const e of EASING_NAMES) expect(P3D, `easing ${e}`).toMatch(new RegExp(`\`${e}\``));
    for (const l of LIGHT_PRESET_NAMES) expect(P3D, `light preset ${l}`).toMatch(new RegExp(`\`${l}\``));
  });

  it('the pose table states each channel range', () => {
    const table = section(P3D, '### Pose: units and signs');
    for (const k of POSE_KEYS) {
      const row = table.split('\n').find((l) => l.startsWith('|') && l.includes(`\`${k}\``));
      expect(row, `pose row ${k}`).toBeDefined();
      const [lo, hi] = POSE_RANGE[k];
      expect(row, `${k} range`).toContain(`${lo}..${hi}`);
    }
  });
});

describe('ops parity: every CLI command is documented', () => {
  const src = SRC('src/node/agentCli.ts');
  const help = src.slice(src.indexOf('const HELP = {'), src.indexOf('};', src.indexOf('const HELP = {')));
  const commands = [...help.matchAll(/^\s{4}(?:'([^']+)'|(\w+)):/gm)].map((m) => m[1] ?? m[2]);

  it('HELP lists the 3D commands', () => {
    expect(commands).toEqual(expect.arrayContaining(['direct', 'frames', 'validate', 'info', 'export']));
  });

  it.each(commands)('%s has a row in the Commands table', (name) => {
    // The first cell names the command (`latest` / `list` share a row; `record start` is under `record …`).
    const first = (l: string) => l.split('|')[1] ?? '';
    expect(COMMANDS.split('\n').some((l) => l.startsWith('| `') && new RegExp(`\`${name}( |\`)`).test(first(l)))).toBe(true);
  });

  it('the direct and frames rows list every flag the CLI parses', () => {
    const directRow = COMMANDS.split('\n').find((l) => l.startsWith('| `direct '))!;
    for (const f of ['--style', '--keep', '--no-scenes', '--dry-run']) expect(directRow).toContain(f);
    const framesSrc = SRC('src/node/framesCmd.ts');
    const parsed = [...fnBody(framesSrc, 'parseFramesArgs').matchAll(/(?:flag|bool)\(args, '(--[\w-]+)'\)/g)].map((m) => m[1]);
    expect(parsed.length).toBeGreaterThanOrEqual(8);
    const framesRow = COMMANDS.split('\n').find((l) => l.startsWith('| `frames '))!;
    for (const f of parsed) expect(framesRow, `frames ${f}`).toContain(f);
  });
});

// The editor half (D1): every 3D control writes through apply3d, which runs
// the same applyOps3d as the CLI. The editor UI (WP5) is built in parallel;
// these checks arm themselves the moment Editor.tsx defines apply3d, and from
// then on the 3D UI files must exist and pass.
describe('ops parity: the editor writes 3D state only through apply3d', () => {
  const EDITOR = 'src/renderer/src/Editor.tsx';
  const UI_FILES = ['src/renderer/src/phone3d/Phone3DPanel.tsx', 'src/renderer/src/phone3d/TransitionLane.tsx', 'src/renderer/src/phone3d/EasingCurve.tsx'];
  const editor = SRC(EDITOR);
  const wp5 = /\bconst apply3d\b/.test(editor);

  /** Every `setProj(…)` call's argument text (balanced parentheses). */
  const setProjCalls = (src: string): string[] => {
    const out: string[] = [];
    for (const m of src.matchAll(/\bsetProj\(/g)) {
      let depth = 1;
      let i = m.index! + m[0].length;
      for (; i < src.length && depth; i++) depth += src[i] === '(' ? 1 : src[i] === ')' ? -1 : 0;
      out.push(src.slice(m.index!, i));
    }
    return out;
  };

  it('the parser finds setProj calls and their arguments', () => {
    expect(setProjCalls('a; setProj((p) => ({ ...p, x: f(1) })); setProj(q);')).toEqual(['setProj((p) => ({ ...p, x: f(1) }))', 'setProj(q)']);
    expect(setProjCalls(editor).length, 'Editor.tsx has setProj calls').toBeGreaterThan(5);
  });

  it.skipIf(!wp5)('the 3D UI files exist and contain no setProj(', () => {
    for (const f of UI_FILES) {
      expect(existsSync(join(E, f)), `${f} exists`).toBe(true);
      expect(SRC(f), `${f} has no setProj(`).not.toMatch(/\bsetProj\(/);
    }
  });

  it.skipIf(!wp5)('no setProj( call in Editor.tsx writes phone3d (each 3D handler calls apply3d)', () => {
    const direct = setProjCalls(editor).filter((c) => /phone3d|transitions/.test(c) && !/\bapply3d\b|applyOps3d/.test(c));
    expect(direct, 'setProj calls that write 3D state directly').toEqual([]);
  });

  it.skipIf(!wp5)('apply3d runs the shared applyOps3d, and the panel and lane get apply3d', () => {
    expect(editor).toMatch(/applyOps3d\(/);
    expect(editor).toMatch(/<Phone3DPanel[\s\S]*?\bapply3d=\{apply3d\}/);
    // The lane gets callbacks, not apply3d itself (WP5's props): its writes (retime) go through apply3d.
    const lane = editor.slice(editor.indexOf('<TransitionLane'), editor.indexOf('/>', editor.indexOf('<TransitionLane')));
    expect(lane, 'the lane JSX').not.toBe('');
    expect(lane).toMatch(/onRetime=\{[^\n]*\bapply3d\(\{ op: 'editTransition'/);
    expect(lane).not.toMatch(/setProj\(/);
  });

  it.skipIf(!wp5)('every op the 3D UI sends is a real op, with fields the op accepts', () => {
    for (const f of [EDITOR, ...UI_FILES.filter((x) => existsSync(join(E, x)))]) {
      for (const m of SRC(f).matchAll(/\{\s*op:\s*'(\w+)'([^{}]*)\}/g)) {
        const [, op, rest] = m;
        expect(OP_NAMES as readonly string[], `${f}: op '${op}'`).toContain(op);
        const known = (PHONE3D_OP_FIELDS as Record<string, readonly string[]>)[op];
        if (!known) continue;
        for (const k of [...rest.matchAll(/(?:^|,)\s*(\w+)\s*:/g)].map((x) => x[1])) expect(known, `${f}: ${op}.${k}`).toContain(k);
      }
    }
  });

  it.skipIf(!wp5)('after WP5: the preset Resolution still writes exportPreset through the op path (apply3d or applyOps3d)', () => {
    expect(editor).toMatch(/onResolution=\{\(\w+\) => (apply3d|applyOps3d)\([^)]*\{ op: 'exportSettings', preset(: \w+)? \}/);
  });

  it('before WP5 lands, Editor.tsx has no 3D write path at all (so nothing escapes the checks above)', () => {
    if (wp5) return;
    expect(editor).not.toMatch(/phone3d\s*:/);
    expect(setProjCalls(editor).filter((c) => /phone3d/.test(c))).toEqual([]);
  });
});
