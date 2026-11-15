#!/usr/bin/env node
// The kit's environment contract (spec: Configuration, Data safety). Runs a product's own start,
// reset and verify commands, as living-manual.config.json names them, from the workspace root.
// `run` is the gate every run goes through: it runs verify first and starts the run's command
// only when verify passes, so a database holding anything but the demo data is never shown to a
// run (or to the planner, whose exploration counts as a run).
//
// usage: node living-manual/kit/bin/lm-env.mjs <product> start|reset|verify|stop
//        node living-manual/kit/bin/lm-env.mjs <product> run [--fresh] -- <command…>
// `run --fresh` resets first, then verifies, then runs the command; the command's first scenario
// then skips its own reset and verify (they just ran), so a one-scenario run resets once.
// Exit codes: the product command's own; `run` exits 3 when verify failed (or there is no verify
// command) and nothing ran, 1 when --fresh's reset failed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const CONFIG = 'living-manual/living-manual.config.json';

/** The workspace root: the nearest folder upwards from cwd that holds the kit's configuration. */
function workspaceRoot(from = process.cwd()) {
	for (let d = resolve(from); ; d = dirname(d)) {
		if (existsSync(join(d, CONFIG))) return d;
		if (dirname(d) === d) throw new Error(`no ${CONFIG} in ${from} or any folder above it`);
	}
}

function fail(message, code = 2) {
	process.stderr.write(`lm-env: ${message}\n`);
	process.exit(code);
}

const sh = (root, command) => spawnSync(command, { cwd: root, shell: '/bin/sh', stdio: 'inherit' }).status ?? 1;

const [product, action, ...rest] = process.argv.slice(2);
const ACTIONS = ['start', 'reset', 'verify', 'stop', 'run'];
if (!product || !ACTIONS.includes(action)) fail(`usage: lm-env.mjs <product> ${ACTIONS.join('|')} [-- <command>]`);

let root;
try { root = workspaceRoot(); } catch (e) { fail(e.message); }
const configPath = join(root, CONFIG);
const env = JSON.parse(readFileSync(configPath, 'utf8')).products?.[product]?.environment;
if (!env) fail(`no product "${product}" in ${configPath}`);

if (action !== 'run') {
	if (!env[action]) fail(`product "${product}" has no ${action} command in ${configPath}`);
	process.exit(sh(root, env[action]));
}

const fresh = rest[0] === '--fresh';
const after = fresh ? rest.slice(1) : rest;
const command = after[0] === '--' ? after.slice(1) : after;
if (command.length === 0) fail('run needs a command after --');
if (fresh) {
	if (!env.reset) fail(`run refused: product "${product}" has no reset command in ${configPath}`, 3);
	if (sh(root, env.reset) !== 0) fail(`run refused: reset failed for ${product}`, 1);
}
if (!env.verify) fail(`run refused: product "${product}" has no verify command in ${configPath}, so nothing can show the data is the demo data`, 3);
if (sh(root, env.verify) !== 0) fail(`run refused: verify failed for ${product}; reset the demo data (lm-env.mjs ${product} reset) and try again`, 3);
// After --fresh the data was reset and verified just now: the first scenario's own reset and
// verify (src/index.ts, lmFresh) is skipped once, by taking this token.
if (fresh) {
	const token = join(mkdtempSync(join(tmpdir(), 'lm-fresh-')), 'token');
	writeFileSync(token, `${product}\n`);
	process.env.LM_FRESH_TOKEN = token;
}
process.exit(sh(root, command.join(' ')));
