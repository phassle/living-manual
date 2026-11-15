// Manual generation (spec: Manual generation): a how page is built from a step record. Numbered
// actions worded with the recorded labels, a screenshot per action, the product version and
// whether the page is machine-verified. Tested on a fixture product folder holding a step record:
// we read the Markdown and the assets the generator wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LM_MANUAL = join(dirname(fileURLToPath(import.meta.url)), '../bin/lm-manual.mjs');
// A 1×1 white PNG stands in for a screenshot.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');

const action = (n, kind, label, extra = {}) => ({
	n, kind, screen: 'Widget list', label, labelSource: 'page', dataSpecific: false, languageBound: false, missingTestId: false,
	locator: { strategy: 'testid', expression: `getByTestId('w-${n}')` }, screenshot: `shots/01-0${n}.png`, box: { x: 1, y: 1, width: 1, height: 1 },
	startedAt: '2026-11-15T10:00:00.000Z', endedAt: '2026-11-15T10:00:01.000Z', ...extra,
});

function product(status = 'passed') {
	const dir = mkdtempSync(join(tmpdir(), 'lm-manual-'));
	const run = join(dir, 'build/runs/WIDGET-01');
	mkdirSync(join(run, 'shots'), { recursive: true });
	for (let n = 1; n <= 5; n++) writeFileSync(join(run, `shots/01-0${n}.png`), PNG);
	writeFileSync(join(run, 'step-record.json'), JSON.stringify({
		kind: 'living-manual/step-record', version: 1, product: 'Fixture', productVersion: '9.9.9',
		scenario: { id: 'WIDGET-01', title: 'Register a new widget', role: 'widget keeper', startScreen: 'widget list' },
		run: { startedAt: '2026-11-15T10:00:00.000Z', endedAt: '2026-11-15T10:00:09.000Z', status },
		steps: [
			{ text: 'I start a new widget', actions: [action(1, 'click', 'New widget', { labelVisible: false })] },
			{ text: 'I name the widget "Blue"', actions: [
				action(2, 'select', 'Widget type:', { value: 'Round', dataSpecific: true, screen: 'New widget form' }),
				action(3, 'fill', 'Widget name:', { value: 'Blue', screen: 'New widget form' }),
				action(4, 'click', '', { labelSource: 'author', label: 'close button', screen: 'New widget form' }),
			] },
			{ text: 'the widget "Blue" is listed', actions: [action(5, 'verify', 'Blue', { dataSpecific: true })] },
		],
	}));
	return dir;
}

const manual = (dir) => spawnSync(process.execPath, [LM_MANUAL, '--folder', dir], { encoding: 'utf8' });

test('a how page is built from a passed step record', () => {
	const dir = product();
	const r = manual(dir);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const page = join(dir, 'build/manual/widget-01-register-a-new-widget.md');
	assert.ok(existsSync(page), r.stdout);
	const md = readFileSync(page, 'utf8');
	assert.match(md, /^# Register a new widget$/m);
	assert.match(md, /Fixture 9\.9\.9/);
	assert.match(md, /Machine-verified/);
	assert.match(md, /^1\. Click \*\*New widget\*\* \(the marked icon\)\.$/m);
	assert.match(md, /^2\. In \*\*Widget type\*\*, choose the one you need \(in this example \*\*Round\*\*\)\.$/m);
	assert.match(md, /^3\. In \*\*Widget name\*\*, type "Blue"\.$/m);
	assert.match(md, /^4\. Click the close button\.$/m);
	assert.match(md, /^5\. Check that the result is shown \(in this example \*\*Blue\*\*\)\.$/m);
	for (let n = 1; n <= 5; n++) {
		assert.match(md, new RegExp(`!\\[[^\\]]+\\]\\(assets/WIDGET-01/0${n}\\.png\\)`));
		assert.ok(existsSync(join(dir, `build/manual/assets/WIDGET-01/0${n}.png`)));
	}
	assert.match(r.stdout, /manual: 1 how page/);
	rmSync(dir, { recursive: true });
});

test('a failed run gives no page', () => {
	const dir = product('failed');
	const r = manual(dir);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /WIDGET-01: run failed; no page written/);
	assert.ok(!existsSync(join(dir, 'build/manual/widget-01-register-a-new-widget.md')));
	rmSync(dir, { recursive: true });
});

// Repeatable runs: an output is regenerated only when its step record or a screenshot differs.
// A note added to the page stands for "the file was not rewritten"; it survives a rerun on the
// same sources and disappears when the sources change.
test('a page is regenerated only when its step record or a screenshot differs', () => {
	const dir = product();
	const runDir = join(dir, 'build/runs/WIDGET-01');
	const page = join(dir, 'build/manual/widget-01-register-a-new-widget.md');
	const recFile = join(runDir, 'step-record.json');
	const edit = (fn) => { const rec = JSON.parse(readFileSync(recFile, 'utf8')); fn(rec); writeFileSync(recFile, JSON.stringify(rec)); };
	const KEPT = '\n<!-- still the first build -->\n';
	assert.equal(manual(dir).status, 0);

	writeFileSync(page, readFileSync(page, 'utf8') + KEPT);
	edit((rec) => { rec.run.startedAt = '2026-11-16T08:00:00.000Z'; rec.run.endedAt = '2026-11-16T08:00:09.000Z'; rec.steps[0].actions[0].startMs = 777; });
	let r = manual(dir);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /WIDGET-01: unchanged \(same step record and screenshots\); page kept/);
	assert.ok(readFileSync(page, 'utf8').endsWith(KEPT), 'a rerun with only new clock readings keeps the page');

	writeFileSync(join(runDir, 'shots/01-03.png'), Buffer.concat([PNG, Buffer.from([0])]));
	r = manual(dir);
	assert.doesNotMatch(r.stdout, /unchanged/);
	assert.ok(!readFileSync(page, 'utf8').includes(KEPT), 'a changed screenshot rebuilds the page');

	writeFileSync(page, readFileSync(page, 'utf8') + KEPT);
	edit((rec) => { rec.steps[1].actions[1].label = 'Widget title:'; });
	manual(dir);
	const md = readFileSync(page, 'utf8');
	assert.ok(!md.includes(KEPT), 'a changed step record rebuilds the page');
	assert.match(md, /^3\. In \*\*Widget title\*\*, type "Blue"\.$/m);
	rmSync(dir, { recursive: true });
});

test('run by product name, the page goes where setup recorded the publish location', () => {
	const root = mkdtempSync(join(tmpdir(), 'lm-manual-ws-'));
	const dir = product();
	mkdirSync(join(root, 'living-manual/products'), { recursive: true });
	spawnSync('mv', [dir, join(root, 'living-manual/products/fixture')]);
	writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({ products: { fixture: { publish: { to: 'site/manual' } } } }));
	const r = spawnSync(process.execPath, [LM_MANUAL, 'fixture'], { cwd: root, encoding: 'utf8' });
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.ok(existsSync(join(root, 'site/manual/widget-01-register-a-new-widget.md')), r.stdout);
	assert.ok(existsSync(join(root, 'site/manual/assets/WIDGET-01/01.png')));
	assert.match(r.stdout, /written to site\/manual/);
	rmSync(root, { recursive: true });
});
