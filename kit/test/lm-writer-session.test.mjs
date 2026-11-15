// The writer session (spec: Writer session, Decision records, Glossary; ticket 08). Tested at the
// CLI seam on a fixture product: we run lm-writer-session the way the lm-writer-session skill does
// (start, next, answer, summary, confirm) and read what it printed and what it wrote to the
// product folder: decision records, the documentation glossary, the page plan, the scenario file,
// the queue for the next run, bug issues and confirmation.json. No test starts a product.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bin, manualProduct, RECORD } from './manual-fixture.mjs';

// A scenario whose steps are the step record's, so the only mismatch is the planted one: the
// scenario says the widget "Green" is listed; the run saw "Blue".
const feature = (last) => `@doc
Feature: Widgets

  @WIDGET-01 @draft
  Scenario: Register a new widget
    Given I start a new widget
    When I name the widget "Blue"
    Then ${last}

  @WIDGET-09 @manual @draft
  Scenario: Print a widget label
    Given I am a widget keeper on the widget card
    When I print the widget's label
    Then the printer prints the label
`;
const PLANTED = feature('the widget "Green" is listed');
const CLEAN = feature('the widget "Blue" is listed');
const PLANTED_RECORD = structuredClone(RECORD);
PLANTED_RECORD.steps[2].text = 'the widget "Green" is listed';
const CASES = {
	cases: [
		{ id: 'widget.register', area: 'Widget', title: 'Register a new widget', role: 'widget keeper', startScreen: 'widget list', scenario: 'WIDGET-01' },
		{ id: 'widget.print', area: 'Widget', title: 'Print a widget label', role: 'widget keeper', startScreen: 'widget card', scenario: 'WIDGET-09', manual: 'printing' },
		{ id: 'widget.retire', area: 'Widget', title: 'Retire a widget', role: 'widget keeper', startScreen: 'widget card' },
	],
};

/** A fixture product with a facts pack (lm-facts ran on it), so the session has facts to read. */
function sessionProduct({ feature = PLANTED, record = PLANTED_RECORD, config = null, pack = null, cases = CASES } = {}) {
	const p = manualProduct({ feature, record, config });
	mkdirSync(join(p.folder, 'facts'), { recursive: true });
	writeFileSync(join(p.folder, 'facts/cases.json'), JSON.stringify(cases));
	const r = spawnSync(process.execPath, [bin('lm-facts.mjs'), '--folder', p.folder], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stdout + r.stderr);
	if (pack) {
		const file = join(p.folder, 'facts/pack.json');
		writeFileSync(file, JSON.stringify(pack(JSON.parse(readFileSync(file, 'utf8')))));
	}
	return p;
}

const session = (folder, ...args) => spawnSync(process.execPath, [bin('lm-writer-session.mjs'), '--folder', folder, ...args], { encoding: 'utf8' });
const ok = (r) => { assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout; };
const nextQ = (folder) => JSON.parse(ok(session(folder, 'next', '--json')));

/** Answers every question with `pick(question)` (default: the recommended option); returns the questions asked. */
function answerAll(folder, pick = () => ['--choice', '1']) {
	const asked = [];
	for (let q = nextQ(folder); q.question; q = nextQ(folder)) {
		asked.push(q.question);
		ok(session(folder, 'answer', q.question.key, ...pick(q.question)));
		assert.ok(asked.length < 100, 'the session never ends');
	}
	return asked;
}
const decisions = (folder) => (existsSync(join(folder, 'decisions')) ? readdirSync(join(folder, 'decisions')).sort() : []);

test('T1.6: a planted mismatch is asked once and saved as a decision record; a second session asks nothing about it and names the record', () => {
	const { root, folder } = sessionProduct();
	ok(session(folder, 'start', '--writer', 'Wendy'));
	const first = answerAll(folder);
	const mismatch = first.filter((q) => q.type === 'mismatch');
	assert.equal(mismatch.length, 1, 'the planted mismatch is asked exactly once');
	assert.match(mismatch[0].text, /Green/);
	assert.equal(mismatch[0].options.length, 3, 'three options');
	assert.equal(mismatch[0].recommended, 1, 'the first is recommended');
	const record = decisions(folder).map((f) => [f, readFileSync(join(folder, 'decisions', f), 'utf8')]).find(([, t]) => t.includes(`**Question:** ${mismatch[0].key}`));
	assert.ok(record, 'a decision record holds the answer');
	assert.match(record[0], /^\d{4}-/, 'the record is numbered');
	assert.match(record[1], /\*\*Status:\*\* active/);
	assert.match(record[1], /\*\*Scope:\*\* feature/);

	ok(session(folder, 'start', '--writer', 'Wendy'));
	const second = answerAll(folder);
	assert.deepEqual(second.filter((q) => q.type === 'mismatch'), [], 'the second session asks nothing about it');
	const summary = ok(session(folder, 'summary'));
	assert.match(summary, new RegExp(`${mismatch[0].key}.*${record[0].slice(0, 4)}`), 'the summary names the record that answered it');
	rmSync(root, { recursive: true });
});

const pickFor = (type, args) => (q) => (q.type === type ? args : ['--choice', '1']);

test('a mismatch where the product is right corrects the scenario', () => {
	const { root, folder } = sessionProduct();
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	answerAll(folder);
	const text = readFileSync(join(folder, 'scenarios/widget.feature'), 'utf8');
	assert.match(text, /Then the widget "Blue" is listed/);
	assert.doesNotMatch(text, /Green/);
	assert.match(ok(session(folder, 'summary')), /Scenarios corrected[\s\S]*Green[\s\S]*Blue/);
	rmSync(root, { recursive: true });
});

test('a mismatch where the text is right files a bug issue and marks the scenario broken', () => {
	const { root, folder } = sessionProduct();
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	answerAll(folder, pickFor('mismatch', ['--choice', '2']));
	assert.match(readFileSync(join(folder, 'scenarios/widget.feature'), 'utf8'), /"Green"/, 'the scenario is not changed');
	const issues = readdirSync(join(folder, 'issues'));
	assert.equal(issues.length, 1);
	const issue = readFileSync(join(folder, 'issues', issues[0]), 'utf8');
	assert.match(issue, /\*\*Status:\*\* needs-triage/);
	assert.match(issue, /living-manual/);
	assert.match(issue, /WIDGET-01 step 3.*"Green"/);
	const stored = JSON.parse(readFileSync(join(folder, 'confirmation.json'), 'utf8')).scenarios['WIDGET-01'];
	assert.equal(stored.status, 'broken');
	assert.match(stored.reason, /bug/);
	rmSync(root, { recursive: true });
});

test('in a workspace with a tracker, the bug issue lands there through the kit\'s batched issues (ticket 10)', () => {
	const { root, folder } = sessionProduct({ config: { name: 'Fixture', context: { from: 'docs/agents/' } } });
	mkdirSync(join(root, 'docs/agents'), { recursive: true });
	writeFileSync(join(root, 'docs/agents/issue-tracker.md'), '# Issue tracker: Local Markdown\n\nOne file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`.\n');
	writeFileSync(join(root, 'docs/agents/triage-labels.md'), '| mattpocock | ours |\n|---|---|\n| `needs-triage` | `needs-triage` |\n');
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	answerAll(folder, pickFor('mismatch', ['--choice', '2']));
	const dir = join(root, '.scratch/living-manual-fixture/issues');
	const issues = readdirSync(dir);
	assert.equal(issues.length, 1);
	const issue = readFileSync(join(dir, issues[0]), 'utf8');
	assert.match(issue, /^\*\*Kind:\*\* product-bug$/m);
	assert.match(issue, /^\*\*Labels:\*\* living-manual, needs-triage$/m);
	assert.match(issue, /WIDGET-01 step 3.*"Green"/);
	assert.equal(JSON.parse(readFileSync(join(folder, 'confirmation.json'), 'utf8')).scenarios['WIDGET-01'].status, 'broken');
	rmSync(root, { recursive: true });
});

test('a settled term goes into the documentation glossary; the codebase glossary is never written', () => {
	const config = { name: 'Fixture', context: { glossary: 'GLOSSARY-MAP.md' } };
	const { root, folder } = sessionProduct({ config });
	mkdirSync(join(root, 'docs/widgets'), { recursive: true });
	const codebase = '# Widgets\n\n## Language\n\n**Gear**:\nA toothed wheel a widget holds.\n_Avoid_: Cog\n';
	writeFileSync(join(root, 'docs/widgets/GLOSSARY.md'), codebase);
	writeFileSync(join(root, 'GLOSSARY-MAP.md'), '| [Widgets](docs/widgets/GLOSSARY.md) |\n');
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	const asked = answerAll(folder, pickFor('term', ['--text', 'The list of every widget the keeper looks after.']));
	const terms = asked.filter((q) => q.type === 'term');
	assert.ok(terms.length >= 1, 'the pack\'s unknown terms are asked');
	const glossary = readFileSync(join(folder, 'GLOSSARY.md'), 'utf8');
	assert.match(glossary, /^\*\*Widget list\*\*:\nThe list of every widget the keeper looks after\.$/m);
	assert.equal(readFileSync(join(root, 'docs/widgets/GLOSSARY.md'), 'utf8'), codebase, 'the codebase glossary is untouched');

	// A word the writer uses that a glossary says to avoid becomes a term question.
	const t = ok(session(folder, 'term', 'cog'));
	assert.match(t, /"Gear" instead of "cog"/);
	const q = nextQ(folder).question;
	assert.equal(q.type, 'term');
	assert.match(q.options[0], /"Gear"/);
	rmSync(root, { recursive: true });
});

test('a fact the pack lacks is queued for the next run and the session carries on', () => {
	const { root, folder } = sessionProduct();
	const start = ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	assert.match(start, /queued for the next run: the warnings and errors "Register a new widget" \(WIDGET-01\) can show/);
	const queue = JSON.parse(readFileSync(join(folder, 'facts/queue.json'), 'utf8')).items;
	assert.ok(queue.some((i) => i.kind === 'fact' && i.scenario === 'WIDGET-01'));
	const asked = answerAll(folder);
	assert.ok(asked.length > 0, 'the other questions are still asked');
	assert.deepEqual(asked.filter((q) => q.type === 'failure'), [], 'the question that needs the fact waits');
	assert.match(ok(session(folder, 'summary')), /Waiting for the next run[\s\S]*warnings and errors/);
	rmSync(root, { recursive: true });
});

test('a failure the pack names is asked as a question', () => {
	const { root, folder } = sessionProduct({ pack: (p) => ({ ...p, failures: [{ scenario: 'WIDGET-01', message: 'Widget name is required' }] }) });
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	const failure = answerAll(folder).filter((q) => q.type === 'failure');
	assert.equal(failure.length, 1);
	assert.match(failure[0].options[0], /Widget name is required/);
	rmSync(root, { recursive: true });
});

test('questions come one at a time, in tree order, of every type, each with three options and the first recommended', () => {
	const { root, folder } = sessionProduct({ pack: (p) => ({ ...p, failures: [{ scenario: 'WIDGET-01', message: 'Widget name is required' }] }) });
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	const asked = answerAll(folder);
	assert.deepEqual([...new Set(asked.map((q) => q.type))].sort(), ['boundaries', 'coverage', 'failure', 'mismatch', 'page-type', 'reader', 'term']);
	for (const q of asked) {
		assert.equal(q.options.length, 3, q.key);
		assert.equal(q.recommended, 1, q.key);
		assert.equal(q.freeText, true, q.key);
	}
	const order = asked.map((q) => q.key);
	assert.ok(order.indexOf('reader:widget') < order.indexOf('coverage:widget'));
	assert.ok(order.indexOf('coverage:widget') < order.indexOf('page-type:WIDGET-01'));
	assert.ok(order.indexOf('page-type:WIDGET-01') < order.indexOf('boundaries:WIDGET-01'));
	assert.ok(order.indexOf('boundaries:WIDGET-01') < order.findIndex((k) => k.startsWith('mismatch:WIDGET-01')));
	assert.match(asked.find((q) => q.type === 'coverage').text, /Retire a widget/, 'coverage names the cases without a page');
	rmSync(root, { recursive: true });
});

test('page type answers are written to the page plan', () => {
	const { root, folder } = sessionProduct();
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	answerAll(folder, (q) => (q.key === 'page-type:WIDGET-01' ? ['--text', 'a reference page please'] : ['--choice', '1']));
	const plan = JSON.parse(readFileSync(join(folder, 'page-plan.json'), 'utf8'));
	const widget = plan.features.find((f) => f.feature === 'widget');
	assert.equal(widget.reader, 'daily user');
	assert.equal(widget.pages.find((p) => p.scenario === 'WIDGET-01').type, 'reference');
	assert.equal(widget.pages.find((p) => p.section === 'What a widget is').type, 'why');
	rmSync(root, { recursive: true });
});

test('the session shows the preview page and screenshots; the scenario text only on request', () => {
	const { root, folder } = sessionProduct();
	const start = ok(session(folder, 'start', '--writer', 'Wendy'));
	assert.match(start, /preview: open .*build\/preview\/index\.html/);
	let q = nextQ(folder);
	while (q.question && q.question.scenario !== 'WIDGET-01') { ok(session(folder, 'answer', q.question.key, '--choice', '1')); q = nextQ(folder); }
	assert.match(q.show.previewPage, /build\/preview\/register-a-widget\.html$/);
	assert.ok(q.show.screenshots.length >= 1);
	assert.ok(q.show.screenshots.every((s) => existsSync(join(process.cwd(), s)) || existsSync(s)));
	assert.doesNotMatch(q.question.text, /Given|When|Then/, 'no Gherkin in the question');
	const text = ok(session(folder, 'show', 'WIDGET-01'));
	assert.match(text, /@WIDGET-01[\s\S]*Scenario: Register a new widget[\s\S]*Then the widget "Green" is listed/);
	rmSync(root, { recursive: true });
});

test('confirming: refused while questions are open; then every scenario covered is confirmed by the writer', () => {
	const { root, folder } = sessionProduct({ feature: CLEAN, record: RECORD });
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	const early = session(folder, 'confirm', '--by', 'Wendy');
	assert.equal(early.status, 1);
	assert.match(early.stdout, /still open/);
	answerAll(folder);
	assert.match(ok(session(folder, 'summary')), /become confirmed: WIDGET-01, WIDGET-09/);
	const r = session(folder, 'confirm', '--by', 'Wendy');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const stored = JSON.parse(readFileSync(join(folder, 'confirmation.json'), 'utf8')).scenarios;
	assert.equal(stored['WIDGET-01'].status, 'confirmed');
	assert.equal(stored['WIDGET-01'].by, 'Wendy');
	assert.equal(stored['WIDGET-09'].status, 'confirmed');
	rmSync(root, { recursive: true });
});

test('a scenario filed as a bug, or waiting for a change, is not confirmed', () => {
	const { root, folder } = sessionProduct();
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	answerAll(folder, (q) => (q.type === 'mismatch' ? ['--choice', '2'] : q.key === 'boundaries:WIDGET-09' ? ['--choice', '3'] : ['--choice', '1']));
	const r = session(folder, 'confirm', '--by', 'Wendy');
	assert.match(r.stdout, /WIDGET-01: not confirmed; it stays broken/);
	assert.match(r.stdout, /WIDGET-09: not confirmed; it stays a draft/);
	assert.equal(JSON.parse(readFileSync(join(folder, 'confirmation.json'), 'utf8')).scenarios['WIDGET-09'], undefined);
	rmSync(root, { recursive: true });
});

test('T1.5: a whole session needs no running product: the environment is never started or reached', () => {
	const touch = (what) => `node -e "require('fs').writeFileSync('ENV-${what}','')"`;
	const config = { name: 'Fixture', environment: { baseUrl: 'http://127.0.0.1:9/', start: touch('START'), reset: touch('RESET'), verify: touch('VERIFY'), stop: touch('STOP') } };
	const { root, folder } = sessionProduct({ feature: CLEAN, record: RECORD, config });
	rmSync(join(folder, 'build/runs'), { recursive: true }); // the writer's machine: no runs, only the versioned pack
	const run = (...a) => spawnSync(process.execPath, [bin('lm-writer-session.mjs'), 'fixture', ...a], { encoding: 'utf8', cwd: root });
	assert.equal(run('start', '--writer', 'Wendy').status, 0);
	for (let q = JSON.parse(run('next', '--json').stdout).question; q; q = JSON.parse(run('next', '--json').stdout).question) {
		assert.equal(run('answer', q.key, '--choice', '1').status, 0);
	}
	const r = run('confirm', '--by', 'Wendy');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.deepEqual(readdirSync(root).filter((f) => f.startsWith('ENV-')), [], 'no environment command ran');
	assert.ok(existsSync(join(folder, 'build/preview/register-a-widget.html')), 'the preview was built from the pack alone');
	assert.ok(readdirSync(join(folder, 'build/manual/assets/WIDGET-01')).length >= 1, 'with the screenshots the pack carries');
	rmSync(root, { recursive: true });
});

test('one term question per term: a label "Extend..." and a screen "Extend" are the same term', () => {
	const { root, folder } = sessionProduct({ pack: (p) => ({ ...p, unknownTerms: [
		{ term: 'Extend...', kinds: ['label'], scenarios: ['WIDGET-01'] },
		{ term: 'Extend', kinds: ['screen'], scenarios: ['WIDGET-01'] },
	] }) });
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	const terms = answerAll(folder).filter((q) => q.type === 'term');
	assert.equal(terms.length, 1);
	assert.match(terms[0].text, /"Extend" \(label, screen\)/);
	assert.match(readFileSync(join(folder, 'GLOSSARY.md'), 'utf8'), /^\*\*Extend\*\*:/m, 'a screen is recommended for the glossary, without the ellipsis');
	rmSync(root, { recursive: true });
});

// Review finding 5: a feature's coverage question lists the tasks of its own area only: not those
// of an area whose name merely starts the same ("Widget parts"), nor a task with no area.
test('a coverage question names only its own area\'s tasks, not an area with a longer name or none', () => {
	const cases = { cases: [...CASES.cases,
		{ id: 'parts.fit', area: 'Widget parts', title: 'Fit a spare gear', role: 'widget keeper', startScreen: 'parts list' },
		{ id: 'misc.order', area: '', title: 'Order a catalogue', role: 'widget keeper', startScreen: 'shop' },
	] };
	const { root, folder } = sessionProduct({ cases });
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	const coverage = answerAll(folder).find((q) => q.type === 'coverage');
	assert.ok(coverage, 'the widget feature has a coverage question');
	assert.match(coverage.text, /Retire a widget/);
	assert.doesNotMatch(coverage.text, /Fit a spare gear/);
	assert.doesNotMatch(coverage.text, /Order a catalogue/);
	rmSync(root, { recursive: true });
});

// Review finding 12: the product's value goes into the scenario as written ("$&" stays "$&"), and
// a correction that finds nothing to correct says so instead of reporting success.
test('a corrected value is written as the product shows it, even with $ patterns', () => {
	const record = structuredClone(PLANTED_RECORD);
	record.steps[2].actions[0].label = 'Blue $& Co';
	const { root, folder } = sessionProduct({ record });
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	answerAll(folder);
	const text = readFileSync(join(folder, 'scenarios/widget.feature'), 'utf8');
	assert.match(text, /Then the widget "Blue \$& Co" is listed/);
	rmSync(root, { recursive: true });
});

test('a correction whose scenario text has changed since the run is refused, and nothing is written', () => {
	const { root, folder } = sessionProduct();
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	let q = nextQ(folder).question;
	for (; q && q.type !== 'mismatch'; q = nextQ(folder).question) ok(session(folder, 'answer', q.key, '--choice', '1'));
	assert.ok(q, 'the planted mismatch is asked');
	const file = join(folder, 'scenarios/widget.feature');
	writeFileSync(file, readFileSync(file, 'utf8').replace('"Green"', '"Teal"'));
	const before = decisions(folder);
	const r = session(folder, 'answer', q.key, '--choice', '1');
	assert.notEqual(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout + r.stderr, /no longer says "Green"/);
	assert.match(readFileSync(file, 'utf8'), /"Teal"/, 'the scenario is left as it is');
	assert.deepEqual(decisions(folder), before, 'no decision record for an answer that did nothing');
	rmSync(root, { recursive: true });
});

// Review finding 15: decision records are numbered once each. Two records with one number are
// refused by name (the next record's number would be ambiguous); a record whose status says
// "accepted" counts as active, so its answer is not asked again.
test('two decision records with the same number are refused, naming both', () => {
	const { root, folder } = sessionProduct();
	mkdirSync(join(folder, 'decisions'), { recursive: true });
	writeFileSync(join(folder, 'decisions/0002-one.md'), '# 0002 One\n\n**Status:** active\n');
	writeFileSync(join(folder, 'decisions/0002-two.md'), '# 0002 Two\n\n**Status:** active\n');
	const r = session(folder, 'start', '--writer', 'Wendy', '--no-preview');
	assert.notEqual(r.status, 0, r.stdout);
	assert.match(r.stdout + r.stderr, /0002-one\.md.*0002-two\.md|0002-two\.md.*0002-one\.md/);
	rmSync(root, { recursive: true });
});

test('a decision record with status accepted answers its question', () => {
	const { root, folder } = sessionProduct();
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	const asked = answerAll(folder);
	const mismatch = asked.find((q) => q.type === 'mismatch');
	const dir = join(folder, 'decisions');
	const file = readdirSync(dir).find((f) => readFileSync(join(dir, f), 'utf8').includes(`**Question:** ${mismatch.key}`));
	writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf8').replace(/\*\*Status:\*\* active/, '**Status:** accepted, 2026-11-15'));
	ok(session(folder, 'start', '--writer', 'Wendy', '--no-preview'));
	assert.deepEqual(answerAll(folder).filter((q) => q.type === 'mismatch'), [], 'an accepted record answers it');
	rmSync(root, { recursive: true });
});
