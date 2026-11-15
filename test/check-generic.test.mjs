// The genericity check (ticket 16): nothing in the pack names a product it was used on. The words
// it hunts come from the workspace: every product section of the configuration, the product's
// scenario IDs, and the product folder's private-terms.txt. Tested on a fixture workspace and a
// fixture pack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = join(dirname(fileURLToPath(import.meta.url)), '../bin/check-generic.mjs');

function fixture(files) {
	const root = mkdtempSync(join(tmpdir(), 'lm-generic-'));
	const ws = join(root, 'ws');
	mkdirSync(join(ws, 'living-manual/products/acmeshop/scenarios'), { recursive: true });
	writeFileSync(join(ws, 'living-manual/living-manual.config.json'), JSON.stringify({ products: { acmeshop: {
		name: 'AcmeShop', repos: ['acme-frontend'], firstArea: 'Basket',
		environment: { baseUrl: 'http://localhost:7123/acme/', signIn: { kind: 'cookie', cookie: 'acme_session' } },
		demoData: { database: 'acme_demo', forbiddenDatabases: ['acme_live'] },
		people: { writer: 'Wilhelmina', testReviewer: 'Rex Reviewer' },
	} } }));
	writeFileSync(join(ws, 'living-manual/products/acmeshop/scenarios/basket.feature'), 'Feature: Basket\n  @BSK-01 @doc\n  Scenario: Add\n');
	writeFileSync(join(ws, 'living-manual/products/acmeshop/private-terms.txt'), '# words only this product uses\nWidgetCorp\n\nGrommet Street\n');
	const pack = join(root, 'pack');
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(pack, path)), { recursive: true });
		writeFileSync(join(pack, path), text);
	}
	return { ws, pack };
}
const check = ({ ws, pack }) => spawnSync(process.execPath, [CHECK, pack, '--workspace', ws], { encoding: 'utf8' });

test('a clean pack passes and says how many files and words it checked', () => {
	const r = check(fixture({ 'kit/a.mjs': '// Saves the order (e.g. "I save the order").\n', 'skills/x/SKILL.md': 'Run from the workspace root.\n' }));
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout.trim().split('\n').pop(), /^generic OK: 2 files, no product words \(\d+ words from 1 product\)$/);
});

test('every product word found is reported with file, line and the word; the check fails', () => {
	const r = check(fixture({
		'kit/a.mjs': 'const url = "http://localhost:7123/acme/";\n// AcmeShop does this\n',
		'kit/test/b.test.mjs': 'writer: "Wilhelmina"\nconst db = "acme_demo"; // and acme_live\n',
		'skills/x/SKILL.md': 'Open the basket list (BSK-01).\nThe WidgetCorp logo on grommet street.\n',
		'README.md': 'Repos: acme-frontend. Cookie acme_session. Rex Reviewer reviews.\n',
	}));
	assert.equal(r.status, 1, r.stdout + r.stderr);
	for (const hit of [/kit\/a\.mjs:1: 7123/, /kit\/a\.mjs:2: AcmeShop/, /kit\/test\/b\.test\.mjs:1: Wilhelmina/,
		/kit\/test\/b\.test\.mjs:2: acme_demo/, /kit\/test\/b\.test\.mjs:2: acme_live/, /skills\/x\/SKILL\.md:1: basket/i,
		/skills\/x\/SKILL\.md:1: BSK/, /skills\/x\/SKILL\.md:2: WidgetCorp/, /skills\/x\/SKILL\.md:2: Grommet Street/i,
		/README\.md:1: acme-frontend/, /README\.md:1: acme_session/, /README\.md:1: Rex Reviewer/]) assert.match(r.stdout, hit);
	assert.match(r.stdout.trim().split('\n').pop(), /^generic FAIL: \d+ product words in 4 files$/);
});

test('a word inside a longer word is not a hit (port 7123 in 171234, "basket" in "basketball" is)', () => {
	const r = check(fixture({ 'kit/a.mjs': 'const n = 171234; // basketball\n' }));
	assert.equal(r.status, 1);
	assert.doesNotMatch(r.stdout, /7123/);
	assert.match(r.stdout, /kit\/a\.mjs:1: basket/i);
});

test('node_modules and .git are not checked', () => {
	const r = check(fixture({ 'kit/node_modules/x/index.js': 'AcmeShop', '.git/config': 'AcmeShop', 'kit/a.mjs': 'ok\n' }));
	assert.equal(r.status, 0, r.stdout);
});

test('without a workspace configuration the check refuses (exit 2)', () => {
	const f = fixture({ 'kit/a.mjs': 'ok\n' });
	const r = spawnSync(process.execPath, [CHECK, f.pack, '--workspace', join(f.pack, 'nowhere')], { encoding: 'utf8' });
	assert.equal(r.status, 2);
	assert.match(r.stdout + r.stderr, /generic refused: no living-manual\/living-manual\.config\.json/);
});
