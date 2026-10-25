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

describe('install-skill.mjs', { timeout: 60_000 }, () => {
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

  // Step 0 runs as one block in one shell call (each tool call is a new shell), under zsh (the macOS shell,
  // which does not split a variable into words) and bash. These run it against a fake checkout whose CLI is a
  // stub and whose `npm run build` makes the stub ready, so no real build ever runs.
  describe('Step 0, run as written', () => {
    const block = () => {
      const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
      const step0 = skill.slice(skill.indexOf('## Step 0'), skill.indexOf('## Step 1'));
      const m = step0.match(/```sh\n([\s\S]*?)```/);
      expect(m, 'Step 0 has one sh block').not.toBeNull();
      return m![1];
    };
    const STUB = (ready: boolean) => `const c = process.argv[2];
process.stdout.write(JSON.stringify(c === 'ops' ? { ok: true, ops: ${JSON.stringify(ready ? ['trim', 'phone3d', 'direct'] : ['trim'])} } : { ok: true, commands: { ${ready ? 'frames: "x", ' : ''}info: "x" } }));`;
    /** A checkout with the real SKILL.md, a CLI stub, and a build script that makes the stub ready (or fails). */
    function fakeCheckout(builds: boolean) {
      const co = join(home, 'checkout with space');
      mkdirSync(join(co, 'skills', 'openscreen'), { recursive: true });
      mkdirSync(join(co, 'electron', 'scripts'), { recursive: true });
      writeFileSync(join(co, 'skills', 'openscreen', 'SKILL.md'), readFileSync(join(SKILL_DIR, 'SKILL.md')));
      const cli = join(co, 'electron', 'scripts', 'openscreen-agent.mjs');
      writeFileSync(cli, STUB(false));
      writeFileSync(join(co, 'electron', 'ready.mjs'), STUB(true));
      const build = builds ? 'node -e "require(\'fs\').copyFileSync(\'ready.mjs\', \'scripts/openscreen-agent.mjs\')"' : 'echo compile error >&2; exit 1';
      writeFileSync(join(co, 'electron', 'package.json'), JSON.stringify({ name: 'fake', private: true, scripts: { build } }));
      return { co, cli };
    }
    const runBlock = (shell: string) =>
      spawnSync(shell, ['-c', block()], { env: { ...process.env, HOME: home, TMPDIR: home }, cwd: tmpdir(), encoding: 'utf8' });

    for (const shell of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
      it(`${shell}: finds the checkout through either home, builds once when the CLI is not ready, prints READY with the full command`, () => {
        const { co, cli } = fakeCheckout(true);
        // Only ~/.codex has the skill: the ~/.claude line must not clobber the path.
        mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
        symlinkSync(join(co, 'skills', 'openscreen'), join(home, '.codex', 'skills', 'openscreen'));
        const r = runBlock(shell);
        expect(r.stdout, r.stderr).toContain(`building ${realpathSync(co)}/electron/dist (once)`);
        expect(r.stdout.trim().split('\n').at(-1)).toBe(`READY: node ${realpathSync(cli)}`);
        // Built now: a second run is READY with no build.
        const again = runBlock(shell);
        expect(again.stdout.trim()).toBe(`READY: node ${realpathSync(cli)}`);
      });
    }

    it('prints NOT READY and the build output when the build fails, and never READY', () => {
      const { co } = fakeCheckout(false);
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
      symlinkSync(join(co, 'skills', 'openscreen'), join(home, '.claude', 'skills', 'openscreen'));
      const r = runBlock('/bin/zsh');
      expect(r.stdout).toContain(`NOT READY (checkout: ${realpathSync(co)})`);
      expect(r.stdout).toContain('compile error');
      expect(r.stdout).not.toContain('READY:');
    });

    it('prints NOT READY when the skill is not installed in either home', () => {
      const r = runBlock('/bin/zsh');
      expect(r.stdout).toContain('NOT READY (checkout: not found)');
      expect(r.stdout).not.toContain('READY:');
    });

    it('install-skill.mjs links the real skill so Step 0 resolves this checkout', () => {
      mkdirSync(join(home, '.claude'));
      run();
      const os = execFileSync('/bin/zsh', ['-c', `${block().split('\n')[0]}; printf %s "$OS"`], { env: { ...process.env, HOME: home }, cwd: tmpdir(), encoding: 'utf8' });
      expect(os).toBe(CHECKOUT);
    });

    it("the READY probe's patterns match the real CLI's ops and help", async () => {
      const { main } = await import('../src/node/agentCli');
      const capture = async (cmd: string) => {
        let text = '';
        const write = process.stdout.write;
        process.stdout.write = ((t: string) => ((text += t), true)) as typeof process.stdout.write;
        try {
          await main([cmd]);
        } finally {
          process.stdout.write = write;
        }
        return JSON.stringify(JSON.parse(text));
      };
      const probes = [...block().matchAll(/node "\$CLI" (ops|help) \| grep -q '([^']+)'/g)].map((m) => ({ cmd: m[1], pattern: m[2] }));
      expect(probes.map((p) => p.pattern)).toEqual(['"phone3d"', '"direct"', '"frames"']);
      for (const p of probes) expect(await capture(p.cmd), p.pattern).toContain(p.pattern);
    });
  });

  it("AGENTS.md's CLI shorthand is a shell function, and it runs under zsh and bash", () => {
    const agents = readFileSync(join(CHECKOUT, 'AGENTS.md'), 'utf8');
    expect(agents).not.toMatch(/^\s*[A-Z]+="node /m);
    const defs = [...agents.matchAll(/^osa\(\) \{ node \/abs\/path\/electron\/scripts\/openscreen-agent\.mjs "\$@"; \}$/gm)];
    expect(defs.length).toBeGreaterThanOrEqual(4); // the loop and each block of the example
    // A stub CLI that echoes its arguments, at a path like the doc's (no build needed).
    const stub = join(home, 'abs', 'path', 'electron', 'scripts', 'openscreen-agent.mjs');
    mkdirSync(join(stub, '..'), { recursive: true });
    writeFileSync(stub, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const def = defs[0][0].replace('/abs/path', join(home, 'abs', 'path'));
    for (const shell of ['/bin/zsh', '/bin/bash']) {
      const out = execFileSync(shell, ['-c', `${def}\nB='/tmp/my take.openscreen'\nosa frames "$B" --moves --sheet`], { cwd: tmpdir(), encoding: 'utf8' });
      expect(JSON.parse(out), shell).toEqual(['frames', '/tmp/my take.openscreen', '--moves', '--sheet']);
    }
  });

  it('refuses arguments, and no npm script runs it (a person runs it)', () => {
    expect(run(['--force']).code).toBe(2);
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    for (const [name, cmd] of Object.entries(pkg.scripts as Record<string, string>)) expect(cmd, `npm script ${name}`).not.toMatch(/install-skill/);
  });

  it('the skill is written for agents: name, trigger branches, Step 0, the loop, and AGENTS.md as the reference', async () => {
    const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const front = skill.match(/^---\n([\s\S]*?)\n---\n/)![1];
    expect(front).toMatch(/^name: openscreen$/m);
    const description = front.match(/^description: (.+)$/m)![1];
    for (const trigger of ['use openscreen', 'world class', '3D phone', 'export']) expect(description).toContain(trigger);
    for (const step of ['<cli> info <bundle>', '<cli> review <bundle>', '"op":"trim"', '<cli> polish <bundle>', '<cli> direct <bundle>', '<cli> frames <bundle> --moves --sheet --draft', '<cli> apply <bundle>', '<cli> validate <bundle>', '<cli> export <bundle>', '<cli> review /abs/out.mp4']) {
      expect(skill, step).toContain(step);
    }
    // The loop order: review → cut to the best moments → polish → direct → frames → apply → validate → export → review the mp4.
    const at = (t: string) => skill.indexOf(t);
    const order = ['<cli> review <bundle>', '"op":"trim"', '<cli> polish <bundle>', '<cli> direct <bundle>', '<cli> frames <bundle> --moves --sheet --draft', "<cli> apply <bundle> '[…]'", '<cli> validate <bundle>', '<cli> export <bundle>', '<cli> review /abs/out.mp4'];
    for (let i = 1; i < order.length; i++) expect(at(order[i - 1]), `${order[i - 1]} before ${order[i]}`).toBeLessThan(at(order[i]));
    // No command goes through a variable holding "node …" (zsh runs that as one program name).
    expect(skill).not.toMatch(/^\s*[A-Z]+="node /m);
    expect(skill).not.toMatch(/\$[A-Z]+ (info|review|apply|polish|direct|frames|validate|export|ops|help|latest|undo)\b/);
    // Every command the skill runs is one the CLI has.
    const { main } = await import('../src/node/agentCli');
    let text = '';
    const write = process.stdout.write;
    process.stdout.write = ((t: string) => ((text += t), true)) as typeof process.stdout.write;
    try {
      await main(['help']);
    } finally {
      process.stdout.write = write;
    }
    const commands = Object.keys(JSON.parse(text).commands);
    const used = [...skill.matchAll(/<cli> ([a-z]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(10);
    for (const c of used) expect(commands, `<cli> ${c}`).toContain(c);
    expect(skill).toContain('AGENTS.md');
    expect(skill).toContain('npm --prefix "$OS/electron" run build');
  });
});
