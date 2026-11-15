// The step record (spec: Locators and the step record). A doc scenario's test, run through the
// kit's Playwright project against a static fixture page, must leave a step record on disk: per
// step its text and actions, each with kind, screen, locator, visible label, data-specific flag,
// screenshot and timings; test ID first, role and name second (flagged language-bound); and each
// screenshot marks the element used. We check the JSON and the pixels the run wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PAGE = `<style>body{margin:0;background:#fff;font:16px sans-serif} *{position:absolute}</style>
<div class="ver" style="left:10px;top:10px">v9.9.9</div>
<button data-testid="widget-new-button" style="left:100px;top:100px;width:140px;height:40px">New widget</button>
<label for="name" style="left:100px;top:200px">Widget name:</label><input id="name" style="left:100px;top:230px">
<button style="left:100px;top:300px" onclick="document.getElementById('out').textContent=document.getElementById('name').value">Save</button>
<div id="out" style="left:100px;top:400px;min-width:50px;height:20px"></div>`;

const SPEC = `import { test, expect } from ${JSON.stringify(join(KIT, 'src/index.ts'))};

test('WIDGET-01 Register a new widget', {
	tag: '@doc',
	annotation: [{ type: 'role', description: 'widget keeper' }, { type: 'start screen', description: 'widget list' }],
}, async ({ page, lm }) => {
	await test.step('I start a new widget', async () => {
		await page.setContent(${JSON.stringify(PAGE)});
		lm.screen('Widget list');
		await lm.click({ testId: 'widget-new-button' });
	});
	await test.step('I name the widget "Blue"', async () => {
		lm.screen('New widget form');
		await lm.fill({ testId: 'widget-name-edit', role: 'textbox', name: 'Widget name:' }, 'Blue');
		await lm.click({ role: 'button', name: 'Save' });
	});
	await test.step('the widget "Blue" is shown', async () => {
		await lm.see({ css: '#out' }, { dataSpecific: true });
		await expect(page.locator('#out')).toHaveText('Blue');
	});
});
`;

function workspace(spec = SPEC) {
	const root = mkdtempSync(join(tmpdir(), 'lm-record-'));
	mkdirSync(join(root, 'living-manual/products/fixture/tests'), { recursive: true });
	writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({
		products: { fixture: { name: 'Fixture', environment: { productVersion: { css: '.ver', pattern: '^v?(\\S+)' } } } },
	}));
	writeFileSync(join(root, 'living-manual/products/fixture/tests/widgets.spec.ts'), spec);
	return root;
}

test('a doc scenario run writes a step record with marked screenshots', { timeout: 120_000 }, () => {
	const root = workspace();
	const run = spawnSync(join(KIT, 'node_modules/.bin/playwright'), ['test', '--project=fixture'], {
		cwd: KIT, encoding: 'utf8', env: { ...process.env, LM_WORKSPACE: root },
	});
	assert.equal(run.status, 0, run.stdout + run.stderr);

	const runDir = join(root, 'living-manual/products/fixture/build/runs/WIDGET-01');
	const rec = JSON.parse(readFileSync(join(runDir, 'step-record.json'), 'utf8'));
	assert.equal(rec.scenario.id, 'WIDGET-01');
	assert.equal(rec.scenario.title, 'Register a new widget');
	assert.equal(rec.scenario.role, 'widget keeper');
	assert.equal(rec.scenario.startScreen, 'widget list');
	assert.equal(rec.productVersion, '9.9.9');
	assert.equal(rec.run.status, 'passed');
	assert.deepEqual(rec.steps.map((s) => s.text), ['I start a new widget', 'I name the widget "Blue"', 'the widget "Blue" is shown']);

	const [newWidget] = rec.steps[0].actions;
	assert.equal(newWidget.kind, 'click');
	assert.equal(newWidget.screen, 'Widget list');
	assert.equal(newWidget.locator.strategy, 'testid');
	assert.match(newWidget.locator.expression, /getByTestId\('widget-new-button'\)/);
	assert.equal(newWidget.label, 'New widget');
	assert.equal(newWidget.labelVisible, true);
	assert.equal(newWidget.languageBound, false);
	assert.equal(newWidget.dataSpecific, false);
	assert.ok(Date.parse(newWidget.startedAt) <= Date.parse(newWidget.endedAt));

	const [name, save] = rec.steps[1].actions;
	assert.equal(name.kind, 'fill');
	assert.equal(name.screen, 'New widget form');
	assert.equal(name.locator.strategy, 'role', 'no element has the test ID, so role and name is used');
	assert.equal(name.languageBound, true);
	assert.equal(name.label, 'Widget name:');
	assert.equal(name.value, 'Blue');
	assert.equal(save.label, 'Save');
	assert.equal(save.languageBound, true);

	const [shown] = rec.steps[2].actions;
	assert.equal(shown.kind, 'verify');
	assert.equal(shown.dataSpecific, true);
	assert.equal(shown.label, 'Blue');

	// The screenshot marks the element: the marker's colour on the box's edge, page white beside it.
	const png = readPng(readFileSync(join(runDir, newWidget.screenshot)));
	const { x, y, width, height } = newWidget.box;
	const [r, g, b] = png.pixel(Math.round(x - 4), Math.round(y + height / 2));
	assert.ok(r > 180 && g < 90 && b < 110, `marker colour at the box's left edge, got ${[r, g, b]}`);
	assert.deepEqual(png.pixel(Math.round(x + width + 40), Math.round(y + height / 2)), [255, 255, 255]);
	for (const a of rec.steps.flatMap((s) => s.actions)) assert.ok(existsSync(join(runDir, a.screenshot)), a.screenshot);
	rmSync(root, { recursive: true });
});

// The mark is drawn into the screenshot, never into the page: an element added to the page for the
// picture changed how Chromium composited a rounded dialog, so the same shot differed between runs
// by a few corner pixels (ORDER-02, ticket 06). The page counts what is added to it and shows the count.
const WATCHED = `<style>body{margin:0;background:#fff;font:16px sans-serif} *{position:absolute}</style>
<button data-testid="widget-new-button" style="left:100px;top:100px;width:140px;height:40px">New widget</button>
<div id="added" style="left:100px;top:300px">0</div>
<script>let n = 0; new MutationObserver((ms) => { for (const m of ms) n += [...m.addedNodes].filter((a) => a.nodeType === 1).length; document.getElementById('added').textContent = String(n); })
.observe(document.body, { childList: true });</script>`;

test('marking an element leaves the page untouched and draws the mark into the screenshot', { timeout: 120_000 }, () => {
	const root = workspace(`import { test } from ${JSON.stringify(join(KIT, 'src/index.ts'))};
test('WIDGET-02 Look at a widget', { tag: '@doc' }, async ({ page, lm }) => {
	await test.step('I start a new widget', async () => {
		await page.setContent(${JSON.stringify(WATCHED)});
		await lm.click({ testId: 'widget-new-button' });
		await lm.click({ testId: 'widget-new-button' });
	});
	await test.step('nothing was added to the page', async () => {
		await lm.see({ css: '#added' });
	});
});
`);
	const run = spawnSync(join(KIT, 'node_modules/.bin/playwright'), ['test', '--project=fixture'], {
		cwd: KIT, encoding: 'utf8', env: { ...process.env, LM_WORKSPACE: root },
	});
	assert.equal(run.status, 0, run.stdout + run.stderr);
	const runDir = join(root, 'living-manual/products/fixture/build/runs/WIDGET-02');
	const rec = JSON.parse(readFileSync(join(runDir, 'step-record.json'), 'utf8'));
	assert.equal(rec.steps[1].actions[0].label, '0', 'the page saw no element added while it was marked and shot');
	const click = rec.steps[0].actions[0];
	const png = readPng(readFileSync(join(runDir, click.screenshot)));
	const { x, y, width, height } = click.box;
	const [r, g, b] = png.pixel(Math.round(x - 4), Math.round(y + height / 2));
	assert.ok(r > 180 && g < 90 && b < 110, `marker colour at the box's left edge, got ${[r, g, b]}`);
	assert.deepEqual(png.pixel(Math.round(x + width + 40), Math.round(y + height / 2)), [255, 255, 255]);
	rmSync(root, { recursive: true });
});

// Review findings 9 and 10. A select whose trigger has no label of its own keeps the author's
// description (an empty page label must not overwrite it); a test.step nested inside a Gherkin
// step belongs to that step: the actions after it still land in the outer step's record.
const BARE = `<style>body{margin:0;background:#fff;font:16px sans-serif} *{position:absolute}</style>
<div id="trigger" style="left:100px;top:100px;width:24px;height:24px;background:#888" onclick="document.getElementById('menu').hidden=false"></div>
<ul id="menu" hidden style="left:100px;top:130px;margin:0;padding:0;list-style:none"><li role="option" style="position:static">Round</li></ul>
<button style="left:300px;top:100px" onclick="this.textContent='Saved'">Save</button>`;

test('an unlabelled trigger keeps its description, and a nested test.step stays inside its Gherkin step', { timeout: 120_000 }, () => {
	const root = workspace(`import { test } from ${JSON.stringify(join(KIT, 'src/index.ts'))};
test('WIDGET-03 Choose a widget type', { tag: '@doc' }, async ({ page, lm }) => {
	await test.step('I choose the type "Round"', async () => {
		await page.setContent(${JSON.stringify(BARE)});
		await lm.select({ css: '#trigger' }, { role: 'option', name: 'Round' }, { describe: 'widget type list' });
		await test.step('a helper step', async () => {
			await lm.click({ role: 'button', name: 'Save' });
		});
		await lm.see({ text: 'Saved' });
	});
});
`);
	const run = spawnSync(join(KIT, 'node_modules/.bin/playwright'), ['test', '--project=fixture'], {
		cwd: KIT, encoding: 'utf8', env: { ...process.env, LM_WORKSPACE: root },
	});
	assert.equal(run.status, 0, run.stdout + run.stderr);
	const rec = JSON.parse(readFileSync(join(root, 'living-manual/products/fixture/build/runs/WIDGET-03/step-record.json'), 'utf8'));
	assert.deepEqual(rec.steps.map((s) => s.text), ['I choose the type "Round"'], 'only the Gherkin step is a step');
	const [select, save, saved] = rec.steps[0].actions;
	assert.equal(select.label, 'widget type list');
	assert.equal(select.labelSource, 'author');
	assert.equal(save.label, 'Save');
	assert.equal(saved.kind, 'verify');
	rmSync(root, { recursive: true });
});

// Test 1 (an open screenshot flake): the pointer rested where the previous
// click left it, so a field that had moved under it was drawn hovered in some runs and not in
// others. Before each screenshot the pointer now moves onto the element being marked: the marked
// element is the one hovered, and the element clicked before is not.
const HOVER = `<style>body{margin:0;background:#fff;font:16px sans-serif} *{position:absolute}
button{background:rgb(200,200,200);border:0} button:hover{background:rgb(0,0,255)}</style>
<button id="a" style="left:100px;top:100px;width:140px;height:40px">First</button>
<button id="b" style="left:100px;top:300px;width:140px;height:40px">Second</button>`;

test('before a screenshot the pointer rests on the marked element, not where the last click left it', { timeout: 120_000 }, () => {
	const root = workspace(`import { test } from ${JSON.stringify(join(KIT, 'src/index.ts'))};
test('WIDGET-04 Press two buttons', { tag: '@doc' }, async ({ page, lm }) => {
	await test.step('I press both buttons', async () => {
		await page.setContent(${JSON.stringify(HOVER)});
		await lm.click({ css: '#a' }, { describe: 'First' });
		await lm.click({ css: '#b' }, { describe: 'Second' });
	});
});
`);
	const run = spawnSync(join(KIT, 'node_modules/.bin/playwright'), ['test', '--project=fixture'], {
		cwd: KIT, encoding: 'utf8', env: { ...process.env, LM_WORKSPACE: root },
	});
	assert.equal(run.status, 0, run.stdout + run.stderr);
	const runDir = join(root, 'living-manual/products/fixture/build/runs/WIDGET-04');
	const rec = JSON.parse(readFileSync(join(runDir, 'step-record.json'), 'utf8'));
	const second = rec.steps[0].actions[1];
	const png = readPng(readFileSync(join(runDir, second.screenshot)));
	assert.deepEqual(png.pixel(120, 320), [0, 0, 255], 'the marked button (Second) is drawn hovered');
	assert.deepEqual(png.pixel(120, 120), [200, 200, 200], 'the button clicked before (First) is not drawn hovered');
	rmSync(root, { recursive: true });
});

// A field wrapped in its label (no for=, no id) is named by the label's words.
test('a field inside its <label> is recorded with the label\'s words', { timeout: 120_000 }, () => {
	const page = '<label>Colour <input></label><label><input type="checkbox"> Express</label>';
	const spec = `import { test } from ${JSON.stringify(join(KIT, 'src/index.ts'))};

test('WIDGET-03 Colour a widget', { tag: '@doc' }, async ({ page, lm }) => {
	await test.step('I colour the widget "Blue" and send it express', async () => {
		await page.setContent(${JSON.stringify(page)});
		lm.screen('Widget form');
		await lm.fill({ role: 'textbox', name: 'Colour' }, 'Blue');
		await lm.click({ role: 'checkbox', name: 'Express' });
	});
});
`;
	const root = workspace(spec);
	const run = spawnSync(join(KIT, 'node_modules/.bin/playwright'), ['test', '--project=fixture'], {
		cwd: KIT, encoding: 'utf8', env: { ...process.env, LM_WORKSPACE: root },
	});
	assert.equal(run.status, 0, run.stdout + run.stderr);
	const rec = JSON.parse(readFileSync(join(root, 'living-manual/products/fixture/build/runs/WIDGET-03/step-record.json'), 'utf8'));
	assert.deepEqual(rec.steps[0].actions.map((a) => a.label), ['Colour', 'Express']);
	rmSync(root, { recursive: true, force: true });
});
