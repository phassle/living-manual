// Repeatable runs (spec: Repeatable runs). Doc scenarios run through the kit's Playwright project
// against fixture pages in a temporary workspace: the product's reset command runs before every
// scenario, the page sees the configured fixed clock and time zone, animations are off and the
// window has the configured size. We check what lands on disk: the reset's own log, the step
// record and the screenshots' pixels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readPng } from './png.mjs';
import { createServer } from 'node:http';
import { workspace, playwright, playwrightAsync } from './fixture-workspace.mjs';

const record = (runs, id) => JSON.parse(readFileSync(join(runs, id, 'step-record.json'), 'utf8'));
const actions = (rec) => rec.steps.flatMap((s) => s.actions);

test('the reset command runs before every scenario, so no scenario sees what another changed', { timeout: 120_000 }, () => {
	const { root } = workspace({
		environment: { reset: 'rm -f dirty.txt; echo reset >> resets.log' },
		pages: { 'a.html': '<button>Go</button>' },
		spec: (root) => `
for (const id of ['DIRT-01', 'DIRT-02']) {
	test(id + ' Leave a mark', { tag: '@doc' }, async ({ page, lm }) => {
		await test.step('the data is clean and I change it', async () => {
			expect(existsSync(${JSON.stringify(join(root, 'dirty.txt'))}), 'a change from another scenario').toBe(false);
			writeFileSync(${JSON.stringify(join(root, 'dirty.txt'))}, id);
			await page.goto('a.html');
			await lm.click({ role: 'button', name: 'Go' });
		});
	});
}`,
	});
	const r = playwright(root);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(readFileSync(join(root, 'resets.log'), 'utf8'), 'reset\nreset\n');
	rmSync(root, { recursive: true });
});

test('every run starts the page clock at the configured time, in the configured time zone', { timeout: 120_000 }, () => {
	const { root, runs } = workspace({
		environment: { clock: { time: '2025-01-15T09:30:00+01:00', timezone: 'America/New_York' } },
		pages: { 'clock.html': `<div id="now"></div><script>
			const show = () => { const d = new Date(); document.getElementById('now').textContent = d.toISOString().slice(0, 16) + ' local hour ' + d.getHours() + ' ' + Math.floor((Date.now() - 1736929800000) / 60000); };
			show(); setTimeout(show, 300);</script>` },
		spec: () => `
test('CLOCK-01 Read the clock', { tag: '@doc' }, async ({ page, lm }) => {
	await test.step('the date is shown', async () => {
		await page.goto('clock.html');
		await page.waitForTimeout(600);
		await lm.see({ css: '#now' });
	});
});`,
	});
	const r = playwright(root);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const [seen] = actions(record(runs, 'CLOCK-01'));
	// 09:30 at +01:00 is 08:30 UTC (Date.now() 1736929800000), and 03:30 in New York in January
	// (UTC-5). Time flows from there, so less than a minute later the page still shows 08:30.
	assert.equal(seen.label, '2025-01-15T08:30 local hour 3 0');
	rmSync(root, { recursive: true });
});

test('the window has the configured size and animations are off', { timeout: 120_000 }, () => {
	const { root, runs } = workspace({
		environment: { viewport: { width: 800, height: 600 } },
		pages: { 'grow.html': `<style>body{margin:0}
			#bar{position:absolute;left:20px;top:20px;height:30px;width:10px;background:#00f;transition:width 20s linear}
			#bar.long{width:400px}
			#spin{position:absolute;left:20px;top:100px;width:40px;height:40px;background:#0a0;animation:fade 20s linear infinite}
			@keyframes fade{from{opacity:1}to{opacity:0}}</style>
			<div id="bar"></div><div id="spin"></div><button style="position:absolute;top:200px" onclick="bar.classList.add('long')">Grow</button>` },
		spec: () => `
test('GROW-01 Grow the bar', { tag: '@doc' }, async ({ page, lm }) => {
	await test.step('I grow the bar', async () => {
		await page.goto('grow.html');
		await lm.click({ role: 'button', name: 'Grow' });
		await page.waitForTimeout(200);
		await lm.see({ css: '#bar' }, { describe: 'bar' });
	});
});`,
	});
	const r = playwright(root);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const [, bar] = actions(record(runs, 'GROW-01'));
	assert.equal(bar.box.width, 400, 'the transition ended at once: the bar has its final width');
	const png = readPng(readFileSync(join(runs, 'GROW-01', bar.screenshot)));
	assert.deepEqual([png.width, png.height], [800, 600]);
	assert.deepEqual(png.pixel(380, 35), [0, 0, 255], 'the bar is drawn at its final width');
	rmSync(root, { recursive: true });
});

test('an action waits for the page\'s requests to finish, and a screenshot for the page to stop changing', { timeout: 120_000 }, async () => {
	const server = createServer((req, res) => {
		if (req.url === '/slow') return setTimeout(() => res.end('Saved'), 800);
		res.setHeader('content-type', 'text/html');
		res.end(`<style>body{margin:0}#box{position:absolute;left:0;top:100px;width:100px;height:100px;background:#f00}</style>
			<button onclick="fetch('/slow').then(r => r.text()).then(t => out.textContent = t)">Save</button><div id="out" style="min-height:20px"></div>
			<button onclick="let n = 0; const t = setInterval(() => { box.style.width = (100 + ++n * 5) + 'px'; if (n >= 20) { box.style.background = '#00f'; clearInterval(t); } }, 30)">Paint</button><div id="box"></div>`);
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const { root, runs } = workspace({
		environment: { baseUrl: `http://127.0.0.1:${server.address().port}/` },
		spec: () => `
test('SETTLE-01 Save and paint', { tag: '@doc' }, async ({ page, lm }) => {
	await test.step('I save', async () => {
		await page.goto('');
		await lm.click({ role: 'button', name: 'Save' });
		await lm.see({ css: '#out' }, { describe: 'result' });
	});
	await test.step('I paint the box', async () => {
		await lm.click({ role: 'button', name: 'Paint' });
		await lm.see({ css: '#box' }, { describe: 'box' });
	});
});`,
	});
	const r = await playwrightAsync(root);
	server.close();
	assert.equal(r.status, 0, r.out);
	const [save, paint] = record(runs, 'SETTLE-01').steps;
	assert.equal(save.actions[1].label, 'Saved', 'the result was read after the request finished');
	const png = readPng(readFileSync(join(runs, 'SETTLE-01', paint.actions[1].screenshot)));
	assert.deepEqual(png.pixel(50, 150), [0, 0, 255], 'the box is shot in its final colour, not mid-change');
	rmSync(root, { recursive: true });
});

// A field that filters as the user types, after a pause (a debounce: no request in flight, so the
// network-quiet wait cannot see it). Ticket 06: ORDER-03's search shot showed the old count about
// one run in five. With the fixed clock the page's pending timers are run before every screenshot.
test('a screenshot shows what the page does once its pending timers have run', { timeout: 120_000 }, () => {
	const { root, runs } = workspace({
		environment: { clock: { time: '2025-01-15T09:30:00+01:00', timezone: 'Europe/Stockholm' } },
		pages: { 'debounce.html': `<style>body{margin:0;background:#fff}</style>
<input id="q" style="position:absolute;left:10px;top:10px">
<div id="hit" style="position:absolute;left:300px;top:200px;width:100px;height:100px;background:#fff"></div>
<script>let t; document.getElementById('q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { document.getElementById('hit').style.background = '#000'; }, 800); });</script>` },
		spec: () => `
test('DEBOUNCE-01 Filter as you type', { tag: '@doc' }, async ({ page, lm }) => {
	await test.step('I search for "Blue"', async () => {
		await page.goto('debounce.html');
		await lm.fill({ css: '#q' }, 'Blue');
	});
});`,
	});
	const r = playwright(root);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const [typed] = actions(record(runs, 'DEBOUNCE-01'));
	const png = readPng(readFileSync(join(runs, 'DEBOUNCE-01', typed.screenshot)));
	assert.deepEqual(png.pixel(350, 250), [0, 0, 0], 'the debounced result is in the shot');
	rmSync(root, { recursive: true });
});

