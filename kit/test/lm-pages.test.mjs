// Manual generation (spec: Manual generation) beyond the how page: each page has one type from the
// page plan (how, why or reference); why and reference pages come from the feature's prose file
// and the facts; a @manual scenario's page is written from prose and marked not machine-verified;
// every page states its product version and whether it is machine-verified. Tested on a fixture
// product folder: we read the Markdown lm-manual wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { bin, manualProduct, PLAN } from './manual-fixture.mjs';

const manual = (folder) => spawnSync(process.execPath, [bin('lm-manual.mjs'), '--folder', folder], { encoding: 'utf8' });
const read = (folder, slug) => readFileSync(join(folder, 'build/manual', `${slug}.md`), 'utf8');

test('a why page is the prose section the plan names, not machine-verified', () => {
	const { root, folder } = manualProduct();
	const r = manual(folder);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const md = read(folder, 'what-a-widget-is');
	assert.match(md, /^type: why$/m);
	assert.match(md, /^verification: not-machine-verified$/m);
	assert.match(md, /^# What a widget is$/m);
	assert.match(md, /A widget is a small round thing that keeps \*\*gears\*\* in place\./);
	assert.match(md, /Widgets wear out after ten years\./);
	assert.doesNotMatch(md, /Widget fields/, 'only the named section');
	assert.match(md, /Fixture 9\.9\.9/, 'the product version of the latest run');
	assert.match(md, /Not machine-verified/);
	rmSync(root, { recursive: true });
});

test('a @manual scenario gets a how page written from prose, marked not machine-verified', () => {
	const { root, folder } = manualProduct();
	assert.equal(manual(folder).status, 0);
	const md = read(folder, 'print-a-widget-label');
	assert.match(md, /^type: how$/m);
	assert.match(md, /^scenario: WIDGET-09$/m);
	assert.match(md, /^verification: not-machine-verified$/m);
	assert.match(md, /^# Print a widget label$/m);
	assert.match(md, /Not machine-verified\*\*: this task cannot be run automatically/);
	assert.match(md, /^2\. Choose \*\*Print label\*\*\.$/m);
	assert.ok(!existsSync(join(folder, 'build/manual/assets/WIDGET-09')), 'no screenshots: it was never run');
	rmSync(root, { recursive: true });
});

test('a reference page lists the fields a run used on the screen, with the writer\'s descriptions', () => {
	const { root, folder } = manualProduct();
	assert.equal(manual(folder).status, 0);
	const md = read(folder, 'widget-fields');
	assert.match(md, /^type: reference$/m);
	assert.match(md, /^verification: not-machine-verified$/m);
	assert.match(md, /^## New widget form$/m);
	assert.match(md, /^\| \*\*Widget type\*\* \| Choose from a list \| The shape of the widget\. Round widgets fit every gear\. \|$/m);
	assert.match(md, /^\| \*\*Widget name\*\* \| Type it \| What the widget is called in the widget list\. \|$/m);
	assert.match(md, /## Also described[\s\S]*- \*\*Colour code\*\*: A code the factory uses\./, 'a described field no run used is listed apart');
	assert.match(md, /the run of WIDGET-01/);
	rmSync(root, { recursive: true });
});

test('a scenario the plan names gets its how page at the plan\'s slug', () => {
	const { root, folder } = manualProduct();
	assert.equal(manual(folder).status, 0);
	const md = read(folder, 'register-a-widget');
	assert.match(md, /^type: how$/m);
	assert.match(md, /^verification: machine-verified$/m);
	assert.match(md, /^1\. Click \*\*New widget\*\*\.$/m);
	assert.ok(!existsSync(join(folder, 'build/manual/widget-01-register-a-new-widget.md')), 'one page per scenario');
	rmSync(root, { recursive: true });
});

test('every page states its product version and whether it is machine-verified', () => {
	const { root, folder } = manualProduct();
	assert.equal(manual(folder).status, 0);
	const files = readdirSync(join(folder, 'build/manual')).filter((f) => f.endsWith('.md'));
	assert.equal(files.length, 4);
	for (const f of files) {
		const md = readFileSync(join(folder, 'build/manual', f), 'utf8');
		assert.match(md, /^productVersion: "9\.9\.9"$/m, f);
		assert.match(md, /^verification: (machine-verified|not-machine-verified)$/m, f);
		assert.match(md, /^> Fixture 9\.9\.9 · \*\*(Machine-verified|Not machine-verified)\*\*/m, f);
	}
	const index = JSON.parse(readFileSync(join(folder, 'build/manual/manual.json'), 'utf8'));
	assert.deepEqual(index.features.map((f) => [f.title, f.pages]), [['Widgets', PLAN.features[0].pages.map((p) => p.slug)]]);
	rmSync(root, { recursive: true });
});

test('a plan entry that names a missing prose section is reported and fails the build', () => {
	const plan = { features: [{ ...PLAN.features[0], pages: [{ slug: 'gone', type: 'why', section: 'No such section' }] }] };
	const { root, folder } = manualProduct({ plan });
	const r = manual(folder);
	assert.equal(r.status, 1, r.stdout);
	assert.match(r.stdout, /gone: no section "No such section" in prose\/widget\.md/);
	rmSync(root, { recursive: true });
});

test('a page type other than how, why or reference is refused', () => {
	const plan = { features: [{ ...PLAN.features[0], pages: [{ slug: 'tut', type: 'tutorial', section: 'What a widget is' }] }] };
	const { root, folder } = manualProduct({ plan });
	const r = manual(folder);
	assert.equal(r.status, 1, r.stdout);
	assert.match(r.stdout, /tut: type must be how, why or reference/);
	rmSync(root, { recursive: true });
});
