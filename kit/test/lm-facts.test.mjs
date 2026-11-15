// Facts pack (spec: Facts pack; ticket 07). A run writes one facts pack into the product folder's
// facts/ (versioned), so the writer session can decide without a running product. Tested at the
// files seam: lm-facts on a fixture product, then we read facts/pack.json, facts/pack.md and
// facts/step-records/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bin, manualProduct, RECORD } from './manual-fixture.mjs';

const facts = (folder) => spawnSync(process.execPath, [bin('lm-facts.mjs'), '--folder', folder], { encoding: 'utf8' });
const pack = (folder) => JSON.parse(readFileSync(join(folder, 'facts/pack.json'), 'utf8'));

// The scenario as the writer wrote it: its steps match the record's steps one to one.
const FEATURE = `@doc
Feature: Widgets

  @WIDGET-01 @draft
  Scenario: Register a new widget
    When I start a new widget
    And I name the widget "Blue"
    Then the widget "Blue" is listed

  @WIDGET-09 @manual @draft
  Scenario: Print a widget label
    Given I am a widget keeper on the widget card
    When I print the widget's label
`;

function product(opts = {}) {
	const p = manualProduct({ feature: FEATURE, config: { name: 'Fixture' }, ...opts });
	mkdirSync(join(p.folder, 'facts'), { recursive: true });
	return p;
}

test('a run writes one facts pack with the step records of every scenario that ran', () => {
	const p = product();
	const r = facts(p.folder);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /^facts: .*facts\/pack\.json/m);
	const f = pack(p.folder);
	assert.equal(f.kind, 'living-manual/facts-pack');
	assert.equal(f.productVersion, '9.9.9');
	assert.deepEqual(f.stepRecords, { 'WIDGET-01': 'step-records/WIDGET-01.json' });
	const saved = JSON.parse(readFileSync(join(p.folder, 'facts/step-records/WIDGET-01.json'), 'utf8'));
	assert.deepEqual(saved.steps, RECORD.steps);
	assert.deepEqual(f.scenarios.map((s) => [s.id, s.run, s.status]), [['WIDGET-01', 'passed', 'draft'], ['WIDGET-09', 'manual', 'draft']]);
	assert.ok(existsSync(join(p.folder, 'facts/pack.md')));
	rmSync(p.root, { recursive: true });
});

test('the pack holds the case inventory with what is and is not covered', () => {
	const p = product();
	writeFileSync(join(p.folder, 'facts/cases.json'), JSON.stringify({ product: 'Fixture', cases: [
		{ id: 'widget-register', area: 'Widgets', title: 'Register a widget', role: 'widget keeper', startScreen: 'widget list', evidence: ['x'], scenario: 'WIDGET-01' },
		{ id: 'widget-delete', area: 'Widgets', title: 'Delete a widget', role: 'widget keeper', startScreen: 'widget card', evidence: ['x'] },
	] }));
	assert.equal(facts(p.folder).status, 0);
	const { cases } = pack(p.folder);
	assert.deepEqual(cases.covered.map((c) => [c.id, c.scenario]), [['widget-register', 'WIDGET-01']]);
	assert.deepEqual(cases.notCovered.map((c) => c.id), ['widget-delete']);
	assert.match(readFileSync(join(p.folder, 'facts/pack.md'), 'utf8'), /Delete a widget.*not yet covered/);
	rmSync(p.root, { recursive: true });
});

test('the pack lists every mismatch between the writer\'s text and what the product did', () => {
	const feature = FEATURE.replace('I name the widget "Blue"', 'I name the widget "Green"').replace('Then the widget "Blue" is listed', 'Then the widget "Blue" is listed under drafts');
	const p = product({ feature });
	assert.equal(facts(p.folder).status, 0);
	const m = pack(p.folder).mismatches;
	const quoted = m.find((x) => x.kind === 'quoted-value');
	assert.equal(quoted.scenario, 'WIDGET-01');
	assert.equal(quoted.quoted, 'Green');
	assert.match(quoted.message, /"Green".*not.*product/);
	const text = m.find((x) => x.kind === 'step-text' && x.step === 3);
	assert.equal(text.step, 3);
	assert.equal(text.writer, 'the widget "Blue" is listed under drafts');
	assert.equal(text.product, 'the widget "Blue" is listed');
	rmSync(p.root, { recursive: true });
});

test('a failed run is a mismatch: the product did not do what the text says', () => {
	const failed = structuredClone(RECORD);
	failed.run = { ...failed.run, status: 'failed', error: 'locator getByTestId(\'w-3\') not found' };
	const p = product({ record: failed });
	assert.equal(facts(p.folder).status, 0);
	const m = pack(p.folder).mismatches.find((x) => x.kind === 'run-failed');
	assert.equal(m.scenario, 'WIDGET-01');
	assert.match(m.message, /w-3/);
	rmSync(p.root, { recursive: true });
});

test('terms in neither glossary are listed: the codebase glossaries (via the glossary map) and the documentation glossary', () => {
	const p = product();
	mkdirSync(join(p.root, 'docs/widgets'), { recursive: true });
	writeFileSync(join(p.root, 'GLOSSARY-MAP.md'), '| Context | Glossary |\n|---|---|\n| Widgets | [`docs/widgets/GLOSSARY.md`](docs/widgets/GLOSSARY.md) |\n');
	writeFileSync(join(p.root, 'docs/widgets/GLOSSARY.md'), '# Widgets\n\n**Widget type**:\nThe shape of a widget.\n_Avoid_: Kind\n');
	writeFileSync(join(p.folder, 'GLOSSARY.md'), '# Documentation glossary\n\n**Widget list**:\nThe screen listing every widget.\n');
	assert.equal(facts(p.folder).status, 0);
	const terms = pack(p.folder).unknownTerms;
	const names = terms.map((t) => t.term);
	assert.ok(names.includes('New widget'), 'a button label in neither glossary');
	assert.ok(names.includes('Widget name'), 'a field label, without its colon');
	assert.ok(names.includes('New widget form'), 'a screen name');
	assert.ok(!names.includes('Widget type'), 'in the codebase glossary');
	assert.ok(!names.includes('Widget list'), 'in the documentation glossary');
	assert.ok(!names.includes('Blue'), 'data-specific values are not terms');
	assert.ok(!names.includes('Kind'), 'an avoided word is not a term of the glossary');
	assert.deepEqual(terms.find((t) => t.term === 'New widget').scenarios, ['WIDGET-01']);
	rmSync(p.root, { recursive: true });
});

test('the language-bound actions are listed', () => {
	const record = structuredClone(RECORD);
	record.steps[0].actions[0] = { ...record.steps[0].actions[0], languageBound: true, missingTestId: true, locator: { strategy: 'role', expression: "getByRole('button', { name: 'New widget' })", testIdTried: 'w-new' } };
	const p = product({ record });
	assert.equal(facts(p.folder).status, 0);
	assert.deepEqual(pack(p.folder).languageBound, [
		{ scenario: 'WIDGET-01', step: 1, action: 1, kind: 'click', screen: 'Widget list', label: 'New widget', locator: "getByRole('button', { name: 'New widget' })", testIdTried: 'w-new' },
	]);
	rmSync(p.root, { recursive: true });
});

test('the facts pack alone carries what confirmation needs: no build folder required', () => {
	const p = product({ confirmed: ['WIDGET-01'] });
	assert.equal(facts(p.folder).status, 0);
	rmSync(join(p.folder, 'build'), { recursive: true });
	const r = spawnSync(process.execPath, [bin('lm-confirm.mjs'), '--folder', p.folder, 'status', 'WIDGET-01'], { encoding: 'utf8' });
	assert.match(r.stdout, /^WIDGET-01: confirmed/m);
	rmSync(p.root, { recursive: true });
});

test('the pack carries the screenshots, so the manual builds without a build folder (the writer\'s machine)', () => {
	const p = product();
	assert.equal(facts(p.folder).status, 0);
	assert.ok(existsSync(join(p.folder, 'facts/screenshots/WIDGET-01', RECORD.steps[0].actions[0].screenshot)));
	rmSync(join(p.folder, 'build'), { recursive: true });
	const r = spawnSync(process.execPath, [bin('lm-manual.mjs'), '--folder', p.folder], { encoding: 'utf8' });
	assert.match(r.stdout, /WIDGET-01: .*register-a-widget\.md \(4 actions\)/);
	assert.ok(existsSync(join(p.folder, 'build/manual/assets/WIDGET-01/04.png')));
	rmSync(p.root, { recursive: true });
});

test('a run that finds a confirmed scenario broken records it, and it stays broken until the writer confirms again', () => {
	const p = product({ confirmed: ['WIDGET-01'] });
	const healed = structuredClone(RECORD);
	healed.steps[0].actions[0].locator = { strategy: 'css', expression: "locator('button.new')" };
	writeFileSync(join(p.folder, 'build/runs/WIDGET-01/step-record.json'), JSON.stringify(healed));
	const r = facts(p.folder);
	assert.match(r.stdout, /WIDGET-01: confirmation lapsed: the action list changed/);
	assert.equal(JSON.parse(readFileSync(join(p.folder, 'confirmation.json'), 'utf8')).scenarios['WIDGET-01'].status, 'broken');
	assert.equal(pack(p.folder).scenarios[0].status, 'broken');
	// The old actions come back (say the healer is undone): still broken, the writer decides.
	writeFileSync(join(p.folder, 'build/runs/WIDGET-01/step-record.json'), JSON.stringify(RECORD));
	facts(p.folder);
	const s = spawnSync(process.execPath, [bin('lm-confirm.mjs'), '--folder', p.folder, 'status', 'WIDGET-01'], { encoding: 'utf8' });
	assert.match(s.stdout, /^WIDGET-01: broken/m);
	rmSync(p.root, { recursive: true });
});
