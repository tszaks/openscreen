// scripts/install-skill.mjs links R/skills/openscreen into ~/.claude/skills
// and ~/.codex/skills. Every test runs the real script in a child process
// with HOME pointed at a fresh temp folder, so the real homes are never
// touched (the first test proves the child sees the temp HOME).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'install-skill.mjs');
const CHECKOUT = realpathSync(resolve(__dirname, '..', '..'));
const SKILL_DIR = join(CHECKOUT, 'skills', 'openscreen');

let home: string;

function run(args: string[] = []): { code: number; out: Record<string, any> } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home }, cwd: tmpdir(), encoding: 'utf8' });
  return { code: r.status ?? -1, out: JSON.parse(r.stdout) };
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'openscreen-skill-home-')));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('install-skill.mjs', () => {
  it('the child process sees the temp HOME, not the real one', () => {
    const seen = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    expect(seen).toBe(home);
  });

  it('links the skill into both homes and reports the checkout it resolves through the link', () => {
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.OS).toBe(CHECKOUT);
    expect(out.homes.map((h: any) => h.status)).toEqual(['linked', 'linked']);
    for (const tool of ['.claude', '.codex']) {
      const link = join(home, tool, 'skills', 'openscreen');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(SKILL_DIR));
      expect(readFileSync(join(link, 'SKILL.md'), 'utf8')).toMatch(/^---\nname: openscreen\n/);
    }
  });

  it('is idempotent: a second run changes nothing', () => {
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    run();
    const before = readlinkSync(join(home, '.claude', 'skills', 'openscreen'));
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out.homes.map((h: any) => h.status)).toEqual(['already linked', 'already linked']);
    expect(readlinkSync(join(home, '.claude', 'skills', 'openscreen'))).toBe(before);
  });

  it('moves a link that points at another checkout, and reports where it pointed', () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    const other = join(home, 'old-checkout', 'skills', 'openscreen');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'SKILL.md'), 'old');
    symlinkSync(other, join(home, '.claude', 'skills', 'openscreen'));
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out.homes[0]).toMatchObject({ status: 'relinked', was: other });
    expect(realpathSync(join(home, '.claude', 'skills', 'openscreen'))).toBe(realpathSync(SKILL_DIR));
    expect(readFileSync(join(other, 'SKILL.md'), 'utf8')).toBe('old'); // the old checkout is untouched
  });

  it('repairs a dangling link', () => {
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
    symlinkSync(join(home, 'gone'), join(home, '.codex', 'skills', 'openscreen'));
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out.homes.find((h: any) => h.home.endsWith('.codex')).status).toBe('relinked');
  });

  it('never replaces a real folder: that home fails, exit 1, the folder is kept', () => {
    mkdirSync(join(home, '.claude', 'skills', 'openscreen'), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', 'openscreen', 'mine.md'), 'keep me');
    mkdirSync(join(home, '.codex'));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.homes[0].status).toBe('blocked');
    expect(out.homes[1].status).toBe('linked');
    expect(readFileSync(join(home, '.claude', 'skills', 'openscreen', 'mine.md'), 'utf8')).toBe('keep me');
  });

  it('skips a tool that is not installed, and fails when neither is', () => {
    mkdirSync(join(home, '.claude'));
    const one = run();
    expect(one.code).toBe(0);
    expect(one.out.homes.map((h: any) => h.status)).toEqual(['linked', 'skipped']);
    expect(existsSync(join(home, '.codex'))).toBe(false);
    rmSync(join(home, '.claude'), { recursive: true });
    const none = run();
    expect(none.code).toBe(1);
    expect(none.out.ok).toBe(false);
  });

  it('works when ~/.claude/skills is itself a link to ~/.codex/skills (one shared folder)', () => {
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
    mkdirSync(join(home, '.claude'));
    symlinkSync(join(home, '.codex', 'skills'), join(home, '.claude', 'skills'));
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out.homes.map((h: any) => h.status)).toEqual(['linked', 'already linked']);
  });

  it("the skill's Step 0 line finds the checkout from another folder", () => {
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    run();
    const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
    for (const tool of ['claude', 'codex']) {
      const line = skill.split('\n').find((l) => l.startsWith('OS=') && l.includes(`~/.${tool}/`));
      expect(line, `Step 0 line for ~/.${tool}`).toBeDefined();
      const os = execFileSync('/bin/sh', ['-c', `${line!.replace(/~\//g, '$HOME/')}; printf %s "$OS"`], { env: { ...process.env, HOME: home }, cwd: tmpdir(), encoding: 'utf8' });
      expect(os).toBe(CHECKOUT);
    }
  });

  it('refuses arguments, and no npm script runs it (a person runs it)', () => {
    expect(run(['--force']).code).toBe(2);
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    for (const [name, cmd] of Object.entries(pkg.scripts as Record<string, string>)) expect(cmd, `npm script ${name}`).not.toMatch(/install-skill/);
  });

  it('the skill is written for agents: name, trigger branches, Step 0, the loop, and AGENTS.md as the reference', () => {
    const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const front = skill.match(/^---\n([\s\S]*?)\n---\n/)![1];
    expect(front).toMatch(/^name: openscreen$/m);
    const description = front.match(/^description: (.+)$/m)![1];
    for (const trigger of ['use openscreen', 'world class', '3D phone', 'export']) expect(description).toContain(trigger);
    for (const step of ['$A info', '$A review', '$A polish', '$A direct', '$A frames $B --moves --sheet --draft', '$A validate', '$A export', 'review /abs/out.mp4']) {
      expect(skill, step).toContain(step);
    }
    // The loop order: review → direct → frames → apply → validate → export → review the mp4.
    const at = (s: string) => skill.indexOf(s);
    expect(at('$A review $B')).toBeLessThan(at('$A direct $B'));
    expect(at('$A direct $B')).toBeLessThan(at('$A frames $B --moves --sheet --draft'));
    expect(at('$A frames $B --moves --sheet --draft')).toBeLessThan(at('$A apply $B'));
    expect(at('$A apply $B')).toBeLessThan(at('$A validate $B'));
    expect(at('$A validate $B')).toBeLessThan(at('$A export $B'));
    expect(at('$A export $B')).toBeLessThan(at('$A review /abs/out.mp4'));
    expect(skill).toContain('AGENTS.md');
    expect(skill).toContain('npm --prefix "$OS/electron" run build');
  });
});
