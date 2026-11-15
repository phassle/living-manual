// The parity check (spec: From scenario to test code; criterion T1.2): every doc scenario in a
// product's .feature files has a spec test titled with its ID, and the test's test.step() titles
// are the scenario's step texts, verbatim and in order. Tested on a fixture product folder: we
// check the exit code and the message a person reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LM_PARITY = join(dirname(fileURLToPath(import.meta.url)), '../bin/lm-parity.mjs');

const FEATURE = `@doc
Feature: Widgets
  Widgets are things a widget keeper keeps.

  @WIDGET-01
  Scenario: Register a new widget
    Given I am a widget keeper on the widget list
    When I start a new widget
    And I name the widget "Blue – small"
    Then the widget "Blue – small" is listed
`;

const SPEC = `import { test, expect } from '../../../kit/src/index.ts';

test('WIDGET-01 Register a new widget', { tag: '@doc' }, async ({ lm }) => {
	await test.step('I am a widget keeper on the widget list', async () => {});
	await test.step('I start a new widget', async () => {});
	await test.step("I name the widget \\"Blue – small\\"", async () => {});
	await test.step(\`the widget "Blue – small" is listed\`, async () => {});
});
`;

function product() {
	const dir = mkdtempSync(join(tmpdir(), 'lm-parity-'));
	mkdirSync(join(dir, 'scenarios'));
	mkdirSync(join(dir, 'tests'));
	writeFileSync(join(dir, 'scenarios/widgets.feature'), FEATURE);
	writeFileSync(join(dir, 'tests/widgets.spec.ts'), SPEC);
	return dir;
}

const parity = (dir) => spawnSync(process.execPath, [LM_PARITY, '--folder', dir], { encoding: 'utf8' });

test('parity passes when IDs, step texts and order match', () => {
	const dir = product();
	const r = parity(dir);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /parity PASS: 1 doc scenario/);
	rmSync(dir, { recursive: true });
});

test('parity fails when one step text is changed', () => {
	const dir = product();
	const f = join(dir, 'tests/widgets.spec.ts');
	writeFileSync(f, readFileSync(f, 'utf8').replace("'I start a new widget'", "'I begin a new widget'"));
	const r = parity(dir);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /WIDGET-01 step 2: feature says "I start a new widget", test says "I begin a new widget"/);
	rmSync(dir, { recursive: true });
});

test('parity fails when steps are reordered', () => {
	const dir = product();
	const f = join(dir, 'scenarios/widgets.feature');
	writeFileSync(f, readFileSync(f, 'utf8').replace(
		'    When I start a new widget\n    And I name the widget "Blue – small"\n',
		'    When I name the widget "Blue – small"\n    And I start a new widget\n'));
	const r = parity(dir);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /WIDGET-01 step 2/);
	rmSync(dir, { recursive: true });
});

test('parity fails when a doc scenario has no test, or a test names no scenario', () => {
	const dir = product();
	writeFileSync(join(dir, 'tests/widgets.spec.ts'), SPEC.replace('WIDGET-01', 'WIDGET-02'));
	const r = parity(dir);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /WIDGET-01: no test titled "WIDGET-01 …"/);
	assert.match(r.stdout, /WIDGET-02: test has no doc scenario/);
	rmSync(dir, { recursive: true });
});

test('a doc scenario without an ID tag is reported', () => {
	const dir = product();
	const f = join(dir, 'scenarios/widgets.feature');
	writeFileSync(f, readFileSync(f, 'utf8').replace('  @WIDGET-01\n', ''));
	const r = parity(dir);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /"Register a new widget" has no ID tag/);
	rmSync(dir, { recursive: true });
});

// Doc scenarios: a task tagged @manual is never run, so it needs no test.
test('a @manual scenario needs no test', () => {
	const dir = product();
	writeFileSync(join(dir, 'scenarios/widgets.feature'), FEATURE + `
  @WIDGET-09 @manual
  Scenario: Print a widget label
    Given I am a widget keeper on the widget card
    Then the printer prints the label
`);
	const r = spawnSync(process.execPath, [LM_PARITY, '--folder', dir], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stdout);
	assert.match(r.stdout, /parity PASS: 1 doc scenario\(s\).*1 @manual scenario\(s\) not run/);
	rmSync(dir, { recursive: true });
});
