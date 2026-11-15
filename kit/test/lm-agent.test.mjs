// Driving a Playwright agent headless against the live product (spec: Data safety: exploration
// by the planner counts as a run). lm-agent takes the product's run lock, resets, and starts the
// agent only after verify passes. Tested on a fixture workspace with a stand-in for `claude`
// (LM_CLAUDE) that records its arguments and whether the run lock was held while it ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../bin');

function workspace({ verifyPasses }) {
	const root = mkdtempSync(join(tmpdir(), 'lm-agent-'));
	mkdirSync(join(root, 'living-manual/products/shop/tests'), { recursive: true });
	writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({ products: { shop: { name: 'Shop', environment: {
		reset: 'echo reset >> events.txt; echo "reset OK"',
		verify: verifyPasses ? 'echo verify >> events.txt; echo "verify PASS"' : 'echo verify >> events.txt; echo "verify FAIL: a foreign row"; exit 1',
		baseUrl: 'http://localhost/',
	} } } }));
	const fake = join(root, 'fake-claude.sh');
	writeFileSync(fake, '#!/bin/sh\n{ echo "agent $*"; [ -f "$LM_RUN_LOCK" ] && echo "lock held"; pwd; } >> "$EVENTS"\necho "agent says done"\n');
	chmodSync(fake, 0o755);
	const env = { ...process.env, LM_CLAUDE: fake, EVENTS: join(root, 'events.txt'), LM_CACHE_DIR: join(root, 'cache'), LM_RUN_LOCK: '' };
	return { root, env };
}
const agent = (w, ...args) => spawnSync(process.execPath, [join(BIN, 'lm-agent.mjs'), ...args], { cwd: w.root, env: w.env, encoding: 'utf8' });

test('the planner starts only after reset and verify, holding the run lock', () => {
	const w = workspace({ verifyPasses: true });
	const r = agent(w, 'shop', 'planner', '--log', 'planner.log', '--', 'Collect the Order cases');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const events = readFileSync(join(w.root, 'events.txt'), 'utf8').split('\n');
	assert.deepEqual(events.slice(0, 2), ['reset', 'verify']);
	assert.match(events[2], /^agent -p --agent living-manual-planner .*--mcp-config \S+\/kit\/\.mcp\.json .*Product: shop\. Collect the Order cases$/);
	assert.equal(events[3], 'lock held');
	assert.match(events[4], /\/kit$/, 'the agent runs in the kit\'s Playwright project');
	assert.match(readFileSync(join(w.root, 'planner.log'), 'utf8'), /agent says done/);
	assert.ok(existsSync(join(w.root, 'living-manual/products/shop/tests/seed.spec.ts')), 'the seed the agents set the page up with');
	assert.equal(existsSync(join(w.root, 'cache/shop/run.lock')), false, 'released afterwards');
	assert.match(r.stdout.trim().split('\n').pop(), /^agent planner done: exit 0, log planner\.log$/);
});

test('when verify fails the agent is never started', () => {
	const w = workspace({ verifyPasses: false });
	const r = agent(w, 'shop', 'planner', '--log', 'planner.log', '--', 'Collect the Order cases');
	assert.equal(r.status, 3, r.stdout + r.stderr);
	assert.equal(readFileSync(join(w.root, 'events.txt'), 'utf8'), 'reset\nverify\n');
	assert.match(r.stdout.trim().split('\n').pop(), /^agent refused: verify failed for shop; nothing was explored/);
});
