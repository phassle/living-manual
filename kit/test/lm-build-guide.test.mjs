// Guide index (spec: Guide): lm-build-guide reads a product folder's step records and writes the
// guide index and the guide script to build/guide/. Tested on a fixture product folder: we read
// the files the builder wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD_GUIDE = join(dirname(fileURLToPath(import.meta.url)), '../bin/lm-build-guide.mjs');

const action = (n, kind, label, extra = {}) => ({
	n, kind, screen: 'Widget list', label, labelSource: 'page', labelVisible: true, dataSpecific: false, languageBound: false, missingTestId: false,
	locator: { strategy: 'testid', expression: `getByTestId('w-${n}')`, testIdTried: `w-${n}` }, screenshot: `shots/0${n}.png`, box: null,
	url: 'http://localhost:9/app/?view=widgets', startedAt: '2026-11-15T10:00:00.000Z', endedAt: '2026-11-15T10:00:01.000Z', ...extra,
});

/** A product folder with one feature and one step record per scenario: { id, status, tags, confirmed }. */
function product(scenarios) {
	const dir = mkdtempSync(join(tmpdir(), 'lm-guide-'));
	mkdirSync(join(dir, 'scenarios'), { recursive: true });
	writeFileSync(join(dir, 'scenarios/widgets.feature'), ['@doc', 'Feature: Widgets', '',
		...scenarios.flatMap(({ id, tags = [] }) => [`  @${id} ${tags.join(' ')}`, `  Scenario: Register widget ${id}`, '    Given I am a widget keeper on the widget list', '    When I start a new widget', '']),
	].join('\n'));
	for (const { id, status = 'passed' } of scenarios) {
		const run = join(dir, 'build/runs', id);
		mkdirSync(join(run, 'shots'), { recursive: true });
		writeFileSync(join(run, 'step-record.json'), JSON.stringify({
			kind: 'living-manual/step-record', version: 1, product: 'Fixture', productVersion: '9.9.9',
			scenario: { id, title: `Register widget ${id}`, role: 'widget keeper', startScreen: 'widget list' },
			run: { status },
			steps: [
				{ text: 'I am a widget keeper on the widget list', actions: [
					action(1, 'click', 'Widgets', { screen: 'Main menu', locator: { strategy: 'css', expression: `locator('.menu [data-name="W"]')` }, url: 'http://localhost:9/app/?view=widgets&tab=' }),
				] },
				{ text: 'I start a new widget', actions: [
					action(2, 'click', 'New widget', { labelVisible: false }),
					action(3, 'select', 'Widget type:', { value: 'Round', dataSpecific: true, screen: 'New widget form',
						option: { strategy: 'role', expression: `locator('#types').getByRole('link', { name: 'Round' })` } }),
					action(4, 'fill', 'Name:', { value: 'Blue', screen: 'New widget form', url: 'http://localhost:9/app/?view=widgets&card=w9' }),
					action(5, 'click', 'close button', { labelSource: 'author', locator: { strategy: 'css', expression: `locator('.window:has([data-role="card"]) img.close')` } }),
					action(6, 'verify', 'Blue', { locator: { strategy: 'text', expression: `locator('#list').getByText('Blue', { exact: true })` } }),
				] },
			],
		}));
	}
	// Confirmed scenarios, through the kit's confirmation CLI (as the writer session records them).
	for (const { id } of scenarios.filter((s) => s.confirmed)) {
		const c = spawnSync(process.execPath, [join(dirname(BUILD_GUIDE), 'lm-confirm.mjs'), '--folder', dir, 'confirm', id, '--by', 'Fixture writer'], { encoding: 'utf8' });
		if (c.status !== 0) throw new Error(c.stdout + c.stderr);
	}
	return dir;
}

const build = (dir, ...args) => spawnSync(process.execPath, [BUILD_GUIDE, '--folder', dir, ...args], { encoding: 'utf8' });
const index = (dir) => JSON.parse(readFileSync(join(dir, 'build/guide/guide-index.json'), 'utf8'));

test('the guide index holds each scenario with its start screen and every action', () => {
	const dir = product([{ id: 'WIDGET-01' }]);
	const r = build(dir, '--include-drafts');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const [sc] = index(dir).scenarios;
	assert.equal(sc.id, 'WIDGET-01');
	assert.equal(sc.title, 'Register widget WIDGET-01');
	assert.equal(sc.role, 'widget keeper');
	assert.equal(sc.startScreen, 'widget list');
	// The start screen as the route shows it: where the first step (the way there) ends.
	assert.deepEqual(sc.startRoute, { view: 'widgets' });
	assert.deepEqual(sc.actions.map((a) => [a.n, a.kind, a.label, a.dataSpecific, a.wayToStart]), [
		[1, 'click', 'Widgets', false, true],
		[2, 'click', 'New widget', false, false],
		[3, 'select', 'Widget type:', true, false],
		[4, 'fill', 'Name:', false, false],
		[5, 'click', 'close button', false, false],
		[6, 'verify', 'Blue', false, false],
	]);
	assert.equal(sc.actions[1].step, 'I start a new widget');
});

test('each action is worded for the user, a data-specific one without naming it as the one to pick', () => {
	const dir = product([{ id: 'WIDGET-01' }]);
	build(dir, '--include-drafts');
	const say = index(dir).scenarios[0].actions.map((a) => a.text);
	assert.deepEqual(say, [
		'Click “Widgets”.',
		'Click “New widget” (the marked icon).',
		'In “Widget type”, choose the one you need (in this example “Round”).',
		'In “Name”, type “Blue”.',
		'Click the close button.',
		'Check that “Blue” is shown.',
	]);
});

test('each locator is turned into a chain the script can follow in the page', () => {
	const dir = product([{ id: 'WIDGET-01' }]);
	build(dir, '--include-drafts');
	const a = index(dir).scenarios[0].actions;
	assert.deepEqual(a[0].locator.chain, [{ css: '.menu [data-name="W"]' }]);
	assert.deepEqual(a[1].locator.chain, [{ testId: 'w-2' }]);
	assert.deepEqual(a[2].option.chain, [{ css: '#types' }, { role: 'link', name: 'Round', exact: true }]);
	assert.deepEqual(a[5].locator.chain, [{ css: '#list' }, { text: 'Blue', exact: true }]);
	assert.equal(a[2].locator.expression, "getByTestId('w-3')", 'the recorded expression is kept');
});

test('only confirmed scenarios go into the index; drafts only on request', () => {
	const dir = product([{ id: 'WIDGET-01', tags: ['@draft'] }, { id: 'WIDGET-02', confirmed: true }]);
	const r = build(dir);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.deepEqual(index(dir).scenarios.map((s) => [s.id, s.confirmed]), [['WIDGET-02', true]]);
	assert.match(r.stdout, /WIDGET-01: draft \(not confirmed by the writer\), left out/);
	build(dir, '--include-drafts');
	assert.deepEqual(index(dir).scenarios.map((s) => [s.id, s.confirmed]), [['WIDGET-01', false], ['WIDGET-02', true]]);
});

test('a scenario whose run did not pass is left out', () => {
	const dir = product([{ id: 'WIDGET-01', status: 'failed' }, { id: 'WIDGET-02' }]);
	const r = build(dir, '--include-drafts');
	assert.deepEqual(index(dir).scenarios.map((s) => s.id), ['WIDGET-02']);
	assert.match(r.stdout, /WIDGET-01: run failed, left out/);
});

test('the guide script is written beside the index, with the one line that loads it', () => {
	const dir = product([{ id: 'WIDGET-01' }]);
	const r = build(dir, '--include-drafts');
	const script = join(dir, 'build/guide/lm-guide.js');
	assert.ok(existsSync(script));
	assert.match(readFileSync(script, 'utf8'), /livingManualGuide/);
	assert.match(r.stdout, /<script src="\/lm-guide\/lm-guide\.js" defer><\/script>/);
});

test('a scenario whose confirmation lapsed leaves the guide index', () => {
	const dir = product([{ id: 'WIDGET-02', confirmed: true }]);
	const feature = join(dir, 'scenarios/widgets.feature');
	writeFileSync(feature, readFileSync(feature, 'utf8').replace('When I start a new widget', 'When I add a widget'));
	const r = build(dir);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.deepEqual(index(dir).scenarios, []);
	assert.match(r.stdout, /WIDGET-02: broken/);
});

test('in a checkout without runs, the facts pack\'s step records build the index', async () => {
	const { renameSync } = await import('node:fs');
	const dir = product([{ id: 'WIDGET-01' }]);
	mkdirSync(join(dir, 'facts/step-records'), { recursive: true });
	renameSync(join(dir, 'build/runs/WIDGET-01/step-record.json'), join(dir, 'facts/step-records/WIDGET-01.json'));
	writeFileSync(join(dir, 'facts/pack.json'), JSON.stringify({ kind: 'living-manual/facts-pack', version: 1, scenarios: [], stepRecords: { 'WIDGET-01': 'step-records/WIDGET-01.json' } }));
	const r = build(dir, '--include-drafts');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.deepEqual(index(dir).scenarios.map((s) => s.id), ['WIDGET-01']);
});

test('a locator that takes the last match (the topmost of stacked dialogs) becomes a chain step', async () => {
	const { locatorChain } = await import('../bin/lib/guide-index.mjs');
	assert.deepEqual(locatorChain(`locator('#modals > [data-role="modal"]').last().getByText('List', { exact: true })`),
		[{ css: '#modals > [data-role="modal"]' }, { last: true }, { text: 'List', exact: true }]);
});

// Review finding 11: a filtered or nested locator becomes a chain the script can follow; a locator
// the guide cannot follow leaves that one action not highlightable (said in words), and the index
// is still built.
test('filter({ hasText }) and a nested locator() become chain steps', async () => {
	const { locatorChain } = await import('../bin/lib/guide-index.mjs');
	assert.deepEqual(locatorChain(`locator('.row').filter({ hasText: 'Main Street' }).getByRole('button', { name: 'Open' })`),
		[{ css: '.row' }, { hasText: 'Main Street' }, { role: 'button', name: 'Open', exact: true }]);
	assert.deepEqual(locatorChain(`locator('.row').filter({ hasText: /harbour/i })`), [{ css: '.row' }, { hasTextRegex: { regex: 'harbour', flags: 'i' } }]);
	assert.deepEqual(locatorChain(`getByRole('dialog').locator(getByText('Save', { exact: true }))`), [{ role: 'dialog' }, { text: 'Save', exact: true }]);
});

test('an action whose locator the guide cannot follow is kept, not highlightable, and the index is still built', () => {
	const dir = product([{ id: 'WIDGET-01' }]);
	const file = join(dir, 'build/runs/WIDGET-01/step-record.json');
	const rec = JSON.parse(readFileSync(file, 'utf8'));
	rec.steps[1].actions[0].locator = { strategy: 'css', expression: `locator('#a').and(locator('.b'))` };
	writeFileSync(file, JSON.stringify(rec));
	const r = build(dir, '--include-drafts');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const a = index(dir).scenarios[0].actions;
	assert.equal(a.length, 6, 'every action is still in the index');
	assert.equal(a[1].highlightable, false);
	assert.equal(a[1].locator.chain, null);
	assert.equal(a[1].text, 'Click “New widget” (the marked icon).', 'still said in words');
	assert.equal(a[0].highlightable, true);
	assert.deepEqual(a[0].locator.chain, [{ css: '.menu [data-name="W"]' }]);
});
