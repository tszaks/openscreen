#!/usr/bin/env node
// Stable entry point for agents: node /abs/path/electron/scripts/openscreen-agent.mjs <command> ...
// Prints one JSON object on stdout per command; see AGENTS.md at the repo root.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'node', 'agentCli.js');
if (!existsSync(cli)) {
  process.stdout.write(JSON.stringify({ ok: false, error: `not built: ${cli} is missing. Run \`npm run build\` in ${join(here, '..')}` }) + '\n');
  process.exit(1);
}
const { main } = createRequire(import.meta.url)(cli);
process.exitCode = await main(process.argv.slice(2));
