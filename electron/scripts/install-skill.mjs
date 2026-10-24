#!/usr/bin/env node
// Links this checkout's agent skill (R/skills/openscreen) into the skill
// folders of Claude Code (~/.claude/skills/openscreen) and Codex
// (~/.codex/skills/openscreen), so "use openscreen" works from any project.
//
//   node electron/scripts/install-skill.mjs
//
// Run it by hand: no build, test or install step runs it. It is idempotent:
// a link that already points here is left alone; a link that points to
// another checkout is moved here (the old target is printed); a real folder
// or file in the way is never touched (that home fails, exit 1). A home whose
// tool is not installed (no ~/.codex at all, say) is skipped.
//
// It prints one JSON object: the checkout ($OS, resolved through the
// installed link the same way the skill's Step 0 does it), and per home the
// link path and what happened.

import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = resolve(HERE, '..', '..');
const SKILL_DIR = join(CHECKOUT, 'skills', 'openscreen');

/** The checkout the skill's Step 0 line finds from an installed SKILL.md: dirname(realpath(SKILL.md))/../.. */
export function checkoutFromSkill(skillMd) {
  return resolve(dirname(realpathSync(skillMd)), '..', '..');
}

/** Link `skillDir` at `<skillsDir>/openscreen`. Returns {path, status, was?, error?}. */
export function linkInto(skillsDir, skillDir) {
  const path = join(skillsDir, 'openscreen');
  let st = null;
  try {
    st = lstatSync(path);
  } catch {
    st = null;
  }
  if (st && !st.isSymbolicLink()) {
    return { path, status: 'blocked', error: `${path} is a real ${st.isDirectory() ? 'folder' : 'file'}, not a link; move it away and run again` };
  }
  if (st) {
    let same = false;
    try {
      same = realpathSync(path) === realpathSync(skillDir);
    } catch {
      same = false; // a dangling link
    }
    if (same) return { path, status: 'already linked' };
    const was = readlinkSync(path);
    rmSync(path);
    symlinkSync(skillDir, path, 'dir');
    return { path, status: 'relinked', was };
  }
  mkdirSync(skillsDir, { recursive: true });
  symlinkSync(skillDir, path, 'dir');
  return { path, status: 'linked' };
}

export function install({ home = homedir(), skillDir = SKILL_DIR } = {}) {
  if (!existsSync(join(skillDir, 'SKILL.md'))) {
    return { ok: false, error: `no SKILL.md in ${skillDir}` };
  }
  const homes = [];
  for (const tool of ['.claude', '.codex']) {
    const toolHome = join(home, tool);
    if (!existsSync(toolHome)) {
      homes.push({ home: toolHome, status: 'skipped', note: `${toolHome} does not exist (tool not installed)` });
      continue;
    }
    try {
      homes.push({ home: toolHome, ...linkInto(join(toolHome, 'skills'), skillDir) });
    } catch (e) {
      homes.push({ home: toolHome, status: 'failed', error: e.message });
    }
  }
  const installed = homes.filter((h) => h.status === 'linked' || h.status === 'relinked' || h.status === 'already linked');
  // The check the skill's Step 0 makes: through the installed link back to this checkout.
  const resolved = installed.map((h) => checkoutFromSkill(join(h.path, 'SKILL.md')));
  const expected = realpathSync(resolve(skillDir, '..', '..'));
  const bad = homes.some((h) => h.status === 'blocked' || h.status === 'failed');
  const mismatch = resolved.some((r) => r !== expected);
  return {
    ok: !bad && !mismatch && installed.length > 0,
    OS: resolved[0] ?? expected,
    skill: skillDir,
    homes,
    ...(installed.length ? {} : { error: 'neither ~/.claude nor ~/.codex exists: nothing to install into' }),
    ...(mismatch ? { error: `a link resolves to ${resolved.find((r) => r !== expected)}, not ${expected}` } : {}),
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const extra = process.argv.slice(2);
  if (extra.length) {
    process.stdout.write(JSON.stringify({ ok: false, error: `install-skill takes no arguments (got ${extra.join(' ')})` }) + '\n');
    process.exit(2);
  }
  const result = install();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}
