// Setup's live check (ticket 03's handback: setup steps that drive the live environment take the
// run lock). `lm-setup check <product>` starts the product, resets and verifies the demo data
// under the product's run lock, so it waits for a run in progress instead of resetting under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../bin');

function workspace(verify = 'echo verify >> order.txt; echo "verify PASS: demo data only"') {
	const root = mkdtempSync(join(tmpdir(), 'lm-setup-check-'));
	mkdirSync(join(root, 'living-manual'), { recursive: true });
	writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({ products: { shop: { name: 'Shop', environment: {
		start: 'echo start >> order.txt', reset: 'echo reset >> order.txt', verify, baseUrl: 'http://localhost/',
	} } } }));
	return { root, env: { ...process.env, LM_CACHE_DIR: join(root, 'cache'), LM_RUN_LOCK: '' } };
}
function run(w, script, ...args) {
	const child = spawn(process.execPath, [join(BIN, script), ...args], { cwd: w.root, env: w.env });
	let out = '';
	child.stdout.on('data', (d) => (out += d));
	child.stderr.on('data', (d) => (out += d));
	return new Promise((done) => child.on('exit', (code) => done({ code, out })));
}
const until = async (cond) => { while (!cond()) await new Promise((r) => setTimeout(r, 50)); };

test('check waits for a run that holds the lock, then starts, resets and verifies', async () => {
	const w = workspace();
	const running = run(w, 'lm-lock.mjs', 'shop', '--', 'sleep 1.5; echo run >> order.txt');
	await until(() => existsSync(join(w.root, 'cache/shop/run.lock')));
	const [a, b] = await Promise.all([running, run(w, 'lm-setup.mjs', 'check', 'shop')]);
	assert.equal(a.code, 0, a.out);
	assert.equal(b.code, 0, b.out);
	assert.equal(readFileSync(join(w.root, 'order.txt'), 'utf8'), 'run\nstart\nreset\nverify\n');
	assert.match(b.out, /lock: waiting for the run lock/);
	assert.match(b.out.trim().split('\n').pop(), /^setup check PASS: shop started, reset and verified/);
});

test('check fails when verify fails', async () => {
	const w = workspace('echo "verify FAIL: foreign rows"; exit 1');
	const r = await run(w, 'lm-setup.mjs', 'check', 'shop');
	assert.equal(r.code, 1, r.out);
	assert.match(r.out.trim().split('\n').pop(), /^setup check FAIL: verify failed/);
});
