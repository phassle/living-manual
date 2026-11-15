#!/usr/bin/env node
// Runs one of the kit's Playwright agents (living-manual-planner, -generator, -healer; written by
// lm-agents.mjs into the kit's .claude/agents) headless with `claude -p`, against the live product.
// Exploration and every test the agent runs count as a run (spec: Data safety), so this holds the
// product's run lock for the whole session, resets the demo data, and starts the agent only after
// verify passes. The agent works in the kit's Playwright project (its .mcp.json gives it the
// playwright-test browser tools on the kit's playwright.config.ts) and sets its page up with the
// product's seed test, tests/seed.spec.ts, written here when missing.
//
// usage: node living-manual/kit/bin/lm-agent.mjs <product> planner|generator|healer [--log <file>] -- <prompt…>
// Exit: the agent's own; 3 verify refused (the agent never started); 1 reset failed; 2 usage.
// LM_CLAUDE names the claude executable (default `claude`).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productConfig, productFolder, workspaceRoot } from './lib/workspace.mjs';
import { takeRunLock } from './lib/lock.mjs';

const ROLES = ['planner', 'generator', 'healer'];
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const [product, role, ...opts] = sep >= 0 ? argv.slice(0, sep) : argv;
const prompt = sep >= 0 ? argv.slice(sep + 1).join(' ') : '';
const log = opts[0] === '--log' ? opts[1] : null;
if (!product || !ROLES.includes(role) || !prompt) {
	process.stderr.write(`usage: lm-agent.mjs <product> ${ROLES.join('|')} [--log <file>] -- <prompt…>\n`);
	process.exit(2);
}
const root = workspaceRoot();
productConfig(root, product);
const kit = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = (f) => join(kit, 'bin', f);
const node = (...a) => spawnSync(process.execPath, a, { cwd: root, stdio: 'inherit' }).status ?? 1;

takeRunLock(product, `lm-agent ${product} ${role}`);

// The seed every agent sets its page up with: signed in on the demo data the kit's fixture has
// just reset and verified (src/index.ts). Tagged @seed, so lm-run leaves it out of doc runs.
const seed = join(productFolder(root, product), 'tests/seed.spec.ts');
if (!existsSync(seed)) {
	mkdirSync(join(seed, '..'), { recursive: true });
	writeFileSync(seed, `// The seed the kit's Playwright agents set their page up with (bin/lm-agent.mjs): the kit's fixture\n// resets and verifies the demo data and signs in before it; the page opens on the base URL.\nimport { test } from '../../../kit/src/index.ts';\n\ntest('seed', { tag: '@seed' }, async ({ page }) => {\n\tawait page.goto('');\n});\n`);
}

if (node(bin('lm-env.mjs'), product, 'reset') !== 0) { console.log(`agent refused: reset failed for ${product}`); process.exit(1); }
if (node(bin('lm-env.mjs'), product, 'verify') !== 0) {
	console.log(`agent refused: verify failed for ${product}; nothing was explored (reset the demo data and try again)`);
	process.exit(3);
}

const args = ['-p', '--agent', `living-manual-${role}`,
	'--mcp-config', join(kit, '.mcp.json'), '--strict-mcp-config', '--add-dir', root,
	'--allowedTools', 'mcp__playwright-test__*', 'Read', 'Glob', 'Grep', 'LS', 'Write', 'Edit', 'MultiEdit', 'Bash(node:*)', 'Bash(cd:*)',
	'--permission-mode', 'acceptEdits', `Product: ${product}. ${prompt}`];
const out = log ? openSync(resolve(root, log), 'w') : 'inherit';
const r = spawnSync(process.env.LM_CLAUDE || 'claude', args, { cwd: kit, stdio: ['ignore', out, out] });
const code = r.status ?? 1;
console.log(`agent ${role} done: exit ${code}${log ? `, log ${log}` : ''}`);
process.exit(code);
