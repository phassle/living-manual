// lm-guide-serve with the question endpoint (spec: Guide; ticket 15): what a workspace gets when
// its product's guide section names a model and a sign-in check. Run as the real command on a
// fixture workspace with a fixture product (page + sign-in service) and a stand-in `claude`.
// Checks: the model key never reaches the browser; an unanswered question ends up in a batched
// issue in the workspace's tracker (lm-issues after-run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bin } from './manual-fixture.mjs';

const TRACKER = `# Issue tracker: Local Markdown

- Implementation issues are one file per ticket at \`.tracker/<feature-slug>/issues/<NN>-<slug>.md\`, numbered from \`01\`
- Triage state is recorded as a \`**Status:**\` line near the top of each issue file
- Comments append to the bottom of the file under a \`## Comments\` heading
`;
const LABELS = `| Label in mattpocock/skills | Label in our tracker | Meaning |
| --- | --- | --- |
| \`needs-triage\` | \`needs-triage\` | Maintainer needs to evaluate this issue |
`;
const KEY = 'sk-ant-SENTINEL-never-in-the-browser';

const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

async function workspace(t, answer) {
	const product = createServer((req, res) => {
		if (req.url.startsWith('/signin/validate')) {
			const ok = req.headers.sessiontoken === 'persona-shopper';
			res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
			return res.end(JSON.stringify({ valid: ok }));
		}
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end('<html><head><title>Shop</title></head><body>Shop</body></html>');
	});
	await new Promise((r) => product.listen(0, r));
	const origin = `http://127.0.0.1:${product.address().port}`;
	const root = mkdtempSync(join(tmpdir(), 'lm-guide-ws-'));
	const folder = join(root, 'living-manual/products/shop');
	mkdirSync(join(folder, 'build/guide'), { recursive: true });
	mkdirSync(join(folder, 'build/manual'), { recursive: true });
	mkdirSync(join(folder, 'build/preview'), { recursive: true });
	mkdirSync(join(root, 'docs/agents'), { recursive: true });
	mkdirSync(join(folder, 'facts'), { recursive: true });
	writeFileSync(join(folder, 'facts/pack.json'), JSON.stringify({ kind: 'living-manual/facts-pack', version: 1, product: 'Shop', newestRunAt: '2026-11-15T10:00:00.000Z', scenarios: [], stepRecords: {}, cases: null, mismatches: [], unknownTerms: [], languageBound: [] }));
	writeFileSync(join(root, 'docs/agents/issue-tracker.md'), TRACKER);
	writeFileSync(join(root, 'docs/agents/triage-labels.md'), LABELS);
	writeFileSync(join(folder, 'build/guide/lm-guide.js'), '/* the guide */');
	writeFileSync(join(folder, 'build/guide/guide-index.json'), JSON.stringify({ scenarios: [{ id: 'SHOP-01', title: 'Pay for the basket', role: 'shopper', startScreen: 'basket', actions: [] }] }));
	writeFileSync(join(folder, 'build/manual/manual.json'), JSON.stringify({ pages: [{ slug: 'returns', title: 'Returning a product' }, { slug: 'unbuilt', title: 'Not in the preview' }] }));
	writeFileSync(join(folder, 'build/preview/returns.html'), '<html><body>Returns</body></html>');
	writeFileSync(join(folder, 'build/preview/index.html'), '<html><body>Manual</body></html>');
	const claude = join(root, 'fake-claude');
	writeFileSync(claude, `#!/usr/bin/env node\nprocess.stdin.resume().on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify({ is_error: false, structured_output: answer }))}));\n`);
	chmodSync(claude, 0o755);
	const port = await freePort();
	writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({ products: { shop: {
		name: 'Shop', context: { from: 'docs/agents/' },
		environment: { baseUrl: `${origin}/shop/` },
		guide: {
			port, role: 'shopper',
			match: { model: 'claude-haiku-5-5', keyEnv: 'LM_TEST_MODEL_KEY', cli: claude },
			session: { cookie: 'se_app_shop', header: 'SessionToken', validate: `${origin}/signin/validate`, forward: { AppName: 'shop' } },
		},
	} } }));
	return { root, folder, port, product };
}

async function serve(t, w, env = {}) {
	const child = spawn(process.execPath, [bin('lm-guide-serve.mjs'), 'shop', '--include-drafts'], { cwd: w.root, env: { ...process.env, ...env } });
	t.after(() => { child.kill(); w.product.close(); });
	let out = '';
	await new Promise((resolve, reject) => {
		child.stdout.on('data', (d) => { out += d; if (/^guide: http/m.test(out)) resolve(); });
		child.stderr.on('data', (d) => (out += d));
		child.on('exit', (c) => reject(new Error(`lm-guide-serve exited ${c}: ${out}`)));
	});
	return { base: `http://127.0.0.1:${w.port}`, out: () => out };
}

test('the model key stays in the endpoint process: neither the page, the guide script nor the index carries it', async (t) => {
	const w = await workspace(t, { scenario: null, page: null });
	const s = await serve(t, w, { LM_TEST_MODEL_KEY: KEY });
	assert.match(s.out(), /claude-haiku-5-5 through the Anthropic SDK/);
	for (const path of ['/shop/', '/lm-guide/lm-guide.js', '/lm-guide/guide-index.json']) {
		const body = await (await fetch(s.base + path)).text();
		assert.ok(!body.includes(KEY) && !body.includes('LM_TEST_MODEL_KEY'), path);
	}
	assert.ok(!s.out().includes(KEY), 'nor its log');
});

test('T2.5: an unanswered question gets the closest preview page, and lm-issues after-run files it as a batched issue', async (t) => {
	const w = await workspace(t, { scenario: null, page: 'returns' });
	const s = await serve(t, w, { LM_TEST_MODEL_KEY: '' });
	assert.match(s.out(), /claude-haiku-5-5 through the claude CLI/);
	const ask = (cookie) => fetch(`${s.base}/lm-guide/match`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ question: 'Can I send a sweater back?', screen: 'basket', role: 'shopper' }) });
	assert.equal((await ask(null)).status, 401);
	const r = await ask('se_app_shop=persona-shopper');
	assert.deepEqual(await r.json(), { scenario: null, page: { title: 'Returning a product', url: '/lm-manual/returns.html' } });
	assert.match(await (await fetch(`${s.base}/lm-manual/returns.html`)).text(), /Returns/, 'the linked page opens');

	const filed = spawnSync(process.execPath, [bin('lm-issues.mjs'), 'shop', 'after-run'], { cwd: w.root, encoding: 'utf8' });
	assert.equal(filed.status, 0, filed.stdout + filed.stderr);
	const issues = join(w.root, '.tracker/living-manual-shop/issues');
	assert.deepEqual(readdirSync(issues), ['01-guide-questions-guide.md']);
	const text = readFileSync(join(issues, '01-guide-questions-guide.md'), 'utf8');
	assert.match(text, /"Can I send a sweater back\?" on the basket \(shopper\)/);
	assert.match(text, /^\*\*Labels:\*\* living-manual, needs-triage$/m);
});
