// Confirmation (spec: Confirmation; ticket 07). Tested at the CLI seam on a fixture product: we run
// lm-confirm and read what it printed and what it wrote to the product folder. A scenario is draft
// until the writer confirms it; the confirmation records who, when and a fingerprint of the
// scenario text and its action list, and lapses (broken) when either changes, not on a label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { bin, manualProduct, RECORD, FEATURE } from './manual-fixture.mjs';

const confirmCli = (folder, ...args) => spawnSync(process.execPath, [bin('lm-confirm.mjs'), '--folder', folder, ...args], { encoding: 'utf8' });
const status = (folder, id) => {
	const r = confirmCli(folder, 'status', id, '--json');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	return JSON.parse(r.stdout)[0];
};
const writeRecord = (folder, record) => writeFileSync(join(folder, 'build/runs', record.scenario.id, 'step-record.json'), JSON.stringify(record));

test('a scenario nobody confirmed is a draft', () => {
	const { root, folder } = manualProduct();
	const r = confirmCli(folder, 'status');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /^WIDGET-01: draft/m);
	assert.match(r.stdout, /^WIDGET-09: draft/m);
	rmSync(root, { recursive: true });
});

test('confirming records who, when and a fingerprint; the scenario is then confirmed', () => {
	const { root, folder } = manualProduct();
	const r = confirmCli(folder, 'confirm', 'WIDGET-01', '--by', 'Wendy', '--at', '2026-11-15T12:00:00.000Z');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /WIDGET-01: confirmed by Wendy/);
	const stored = JSON.parse(readFileSync(join(folder, 'confirmation.json'), 'utf8')).scenarios['WIDGET-01'];
	assert.equal(stored.status, 'confirmed');
	assert.equal(stored.by, 'Wendy');
	assert.equal(stored.at, '2026-11-15T12:00:00.000Z');
	assert.match(stored.fingerprint, /^[0-9a-f]{64}$/);
	assert.equal(status(folder, 'WIDGET-01').status, 'confirmed');
	assert.equal(status(folder, 'WIDGET-09').status, 'draft', 'the other scenario is untouched');
	rmSync(root, { recursive: true });
});

test('confirming needs a name: the writer confirms, not the kit', () => {
	const { root, folder } = manualProduct();
	const r = confirmCli(folder, 'confirm', 'WIDGET-01');
	assert.equal(r.status, 2);
	assert.match(r.stderr, /--by/);
	assert.equal(status(folder, 'WIDGET-01').status, 'draft');
	rmSync(root, { recursive: true });
});

test('a label change keeps the confirmation', () => {
	const { root, folder } = manualProduct();
	confirmCli(folder, 'confirm', 'WIDGET-01', '--by', 'Wendy');
	const renamed = structuredClone(RECORD);
	renamed.steps[0].actions[0].label = 'Add widget';
	writeRecord(folder, renamed);
	assert.equal(status(folder, 'WIDGET-01').status, 'confirmed');
	rmSync(root, { recursive: true });
});

test('a changed scenario text lapses the confirmation: the scenario is broken', () => {
	const { root, folder } = manualProduct();
	confirmCli(folder, 'confirm', 'WIDGET-01', '--by', 'Wendy');
	writeFileSync(join(folder, 'scenarios/widget.feature'), FEATURE.replace('When I start a new widget', 'When I add a widget'));
	const s = status(folder, 'WIDGET-01');
	assert.equal(s.status, 'broken');
	assert.match(s.reason, /scenario text changed/);
	rmSync(root, { recursive: true });
});

test('a changed action list lapses the confirmation (a locator or an added action)', () => {
	const { root, folder } = manualProduct();
	confirmCli(folder, 'confirm', 'WIDGET-01', '--by', 'Wendy');
	const healed = structuredClone(RECORD);
	healed.steps[0].actions[0].locator = { strategy: 'role', expression: "getByRole('button', { name: 'New widget' })" };
	writeRecord(folder, healed);
	const s = status(folder, 'WIDGET-01');
	assert.equal(s.status, 'broken');
	assert.match(s.reason, /action list changed/);

	writeRecord(folder, RECORD);
	assert.equal(status(folder, 'WIDGET-01').status, 'confirmed', 'the same actions again: the fingerprint matches');
	const added = structuredClone(RECORD);
	added.steps[1].actions.push({ ...RECORD.steps[1].actions[1], n: 9, kind: 'click' });
	writeRecord(folder, added);
	assert.equal(status(folder, 'WIDGET-01').status, 'broken');
	rmSync(root, { recursive: true });
});

test('a scenario whose last run did not pass cannot be confirmed', () => {
	const { root, folder } = manualProduct({ record: { ...RECORD, run: { ...RECORD.run, status: 'failed' } } });
	const r = confirmCli(folder, 'confirm', 'WIDGET-01', '--by', 'Wendy');
	assert.equal(r.status, 1);
	assert.match(r.stdout, /WIDGET-01: not confirmed: its last run did not pass/);
	assert.equal(status(folder, 'WIDGET-01').status, 'draft');
	rmSync(root, { recursive: true });
});

test('a @manual scenario is confirmed on its text alone; draft takes a confirmation back', () => {
	const { root, folder } = manualProduct();
	assert.equal(confirmCli(folder, 'confirm', 'WIDGET-09', '--by', 'Wendy').status, 0);
	assert.equal(status(folder, 'WIDGET-09').status, 'confirmed');
	const r = confirmCli(folder, 'draft', 'WIDGET-09');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(status(folder, 'WIDGET-09').status, 'draft');
	rmSync(root, { recursive: true });
});

test('an unknown scenario ID is refused', () => {
	const { root, folder } = manualProduct();
	const r = confirmCli(folder, 'confirm', 'WIDGET-77', '--by', 'Wendy');
	assert.equal(r.status, 1);
	assert.match(r.stdout, /WIDGET-77: no doc scenario/);
	rmSync(root, { recursive: true });
});

test('the writer session can mark a scenario broken (a mismatch filed as a bug); it stays broken until confirmed again', () => {
	const { root, folder } = manualProduct();
	confirmCli(folder, 'confirm', 'WIDGET-01', '--by', 'Wendy');
	const r = confirmCli(folder, 'broken', 'WIDGET-01', '--reason', 'bug: the list does not show the new widget');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const s = status(folder, 'WIDGET-01');
	assert.equal(s.status, 'broken');
	assert.match(s.reason, /bug: the list does not show the new widget/);
	assert.equal(confirmCli(folder, 'broken', 'WIDGET-01').status, 2, 'a reason is required');
	confirmCli(folder, 'confirm', 'WIDGET-01', '--by', 'Wendy');
	assert.equal(status(folder, 'WIDGET-01').status, 'confirmed');
	rmSync(root, { recursive: true });
});
