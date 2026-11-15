// Comparing a run with the one before it (spec: Repeatable runs; T1.3). Each scenario's previous
// run is kept beside the new one; lm-compare reports, per scenario, whether every screenshot is
// byte-identical and whether the step record is the same once its times are left out. Two runs of
// an unchanged fixture page must compare identical; a changed label must show up as a difference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspace, playwright } from './fixture-workspace.mjs';

const LM_COMPARE = join(dirname(fileURLToPath(import.meta.url)), '../bin/lm-compare.mjs');

const PAGE = (label) => `<style>body{margin:0;font:16px sans-serif}</style>
<h1>Widgets</h1><div id="today"></div><script>today.textContent = new Date().toDateString()</script>
<label for="n">Widget name:</label><input id="n"><button onclick="out.textContent=n.value">${label}</button><div id="out"></div>`;

const SPEC = () => `
test('WIDGET-01 Name a widget', { tag: '@doc' }, async ({ page, lm }) => {
	await test.step('I name the widget "Blue"', async () => {
		await page.goto('w.html');
		lm.screen('Widget list');
		await lm.fill({ role: 'textbox', name: 'Widget name:' }, 'Blue');
		await lm.click({ css: 'button' });
	});
	await test.step('the widget "Blue" is shown', async () => {
		await lm.see({ css: '#out' }, { dataSpecific: true });
	});
});`;

const compare = (root) => spawnSync(process.execPath, [LM_COMPARE, '--folder', join(root, 'living-manual/products/fixture')], { cwd: root, encoding: 'utf8' });

test('two runs of unchanged code give byte-identical screenshots and the same step record', { timeout: 180_000 }, () => {
	const { root } = workspace({ environment: { clock: { time: '2025-01-15T09:30:00+01:00', timezone: 'Europe/Stockholm' } }, pages: { 'w.html': PAGE('Save') }, spec: SPEC });
	for (let i = 0; i < 2; i++) { const r = playwright(root); assert.equal(r.status, 0, r.stdout + r.stderr); }
	const c = compare(root);
	assert.equal(c.status, 0, c.stdout + c.stderr);
	assert.match(c.stdout, /WIDGET-01: identical \(3 of 3 screenshots byte-identical, step record same\)/);
	const report = readFileSync(join(root, 'living-manual/products/fixture/build/compare.md'), 'utf8');
	assert.match(report, /\| WIDGET-01 \| shots\/01-01\.png \| byte-identical \|/);
	rmSync(root, { recursive: true });
});

test('a changed label shows up in the screenshot and the step record', { timeout: 180_000 }, () => {
	const { root } = workspace({ pages: { 'w.html': PAGE('Save') }, spec: SPEC });
	assert.equal(playwright(root).status, 0);
	writeFileSync(join(root, 'pages/w.html'), PAGE('Store'));
	assert.equal(playwright(root).status, 0);
	const c = compare(root);
	assert.equal(c.status, 1, c.stdout + c.stderr);
	assert.match(c.stdout, /WIDGET-01: differs/);
	const report = readFileSync(join(root, 'living-manual/products/fixture/build/compare.md'), 'utf8');
	assert.match(report, /\| WIDGET-01 \| shots\/01-02\.png \| different: \d+ pixels differ \|/);
	assert.match(report, /steps\[0\]\.actions\[1\]\.label: "Save" → "Store"/);
	rmSync(root, { recursive: true });
});

test('a scenario with no earlier run is reported as such, not as a difference', { timeout: 120_000 }, () => {
	const { root } = workspace({ pages: { 'w.html': PAGE('Save') }, spec: SPEC });
	assert.equal(playwright(root).status, 0);
	const c = compare(root);
	assert.equal(c.status, 0, c.stdout + c.stderr);
	assert.match(c.stdout, /WIDGET-01: no earlier run to compare with/);
	rmSync(root, { recursive: true });
});

// A record the product creates gets a new id from the server on every run (a server may keep its
// id counter in memory, past the reset), so the page address differs while nothing on screen does.
test('a different page address alone is reported but is not a difference', { timeout: 180_000 }, () => {
	const { root } = workspace({ pages: { 'w.html': PAGE('Save') }, spec: SPEC });
	for (let i = 0; i < 2; i++) assert.equal(playwright(root).status, 0);
	const prev = join(root, 'living-manual/products/fixture/build/previous/WIDGET-01/step-record.json');
	const rec = JSON.parse(readFileSync(prev, 'utf8'));
	rec.steps[1].actions[0].url += '?rid=r1i905317';
	writeFileSync(prev, JSON.stringify(rec));
	const c = compare(root);
	assert.equal(c.status, 0, c.stdout + c.stderr);
	assert.match(c.stdout, /WIDGET-01: identical/);
	const report = readFileSync(join(root, 'living-manual/products/fixture/build/compare.md'), 'utf8');
	assert.match(report, /Not compared \(page addresses hold server-assigned ids\):\n\n- steps\[1\]\.actions\[0\]\.url: ".*\?rid=r1i905317" → ".*w\.html"/);
	rmSync(root, { recursive: true });
});

test('the same spec in another checkout (another absolute path) is not a difference', { timeout: 180_000 }, () => {
	const { root } = workspace({ pages: { 'w.html': PAGE('Save') }, spec: SPEC });
	for (let i = 0; i < 2; i++) assert.equal(playwright(root).status, 0);
	const prev = join(root, 'living-manual/products/fixture/build/previous/WIDGET-01/step-record.json');
	const rec = JSON.parse(readFileSync(prev, 'utf8'));
	rec.scenario.spec = '/elsewhere/checkout-2/living-manual/products/fixture/tests/fixture.spec.ts';
	writeFileSync(prev, JSON.stringify(rec));
	const c = compare(root);
	assert.equal(c.status, 0, c.stdout + c.stderr);
	assert.match(c.stdout, /WIDGET-01: identical/);
	rmSync(root, { recursive: true });
});
