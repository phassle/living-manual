// Batched issues (spec: Issues; ticket 10). Problems the kit finds land in the tracker the
// workspace configuration names (docs/agents/issue-tracker.md, triage-labels.md), labelled with
// the kit's label and the workspace's needs-triage label, one issue per kind per feature per run.
// Tested at the files seam: lm-issues on a fixture workspace, then we read the tracker's folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bin } from './manual-fixture.mjs';

// A workspace whose tracker is local markdown under .tracker/ and whose needs-triage label is
// spelled "to-triage": what the kit writes must follow these files, not a layout of its own.
const TRACKER = `# Issue tracker: Local Markdown

Issues live as markdown files in \`.tracker/\`.

- Implementation issues are one file per ticket at \`.tracker/<feature-slug>/issues/<NN>-<slug>.md\`, numbered from \`01\`
- Triage state is recorded as a \`**Status:**\` line near the top of each issue file
- Comments append to the bottom of the file under a \`## Comments\` heading
`;
const LABELS = `# Triage Labels

| Label in mattpocock/skills | Label in our tracker | Meaning |
| --- | --- | --- |
| \`needs-triage\` | \`to-triage\` | Maintainer needs to evaluate this issue |
| \`wontfix\` | \`wontfix\` | Will not be actioned |
`;

function ws({ tracker = TRACKER } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'lm-issues-'));
	const folder = join(root, 'living-manual/products/fixture');
	mkdirSync(join(folder, 'facts/step-records'), { recursive: true });
	mkdirSync(join(root, 'docs/agents'), { recursive: true });
	writeFileSync(join(root, 'docs/agents/issue-tracker.md'), tracker);
	writeFileSync(join(root, 'docs/agents/triage-labels.md'), LABELS);
	writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({
		products: { fixture: { name: 'Fixture', context: { from: 'docs/agents/' } } },
	}));
	return { root, folder, issues: join(root, '.tracker/living-manual-fixture/issues') };
}

const lmIssues = (root, ...args) => spawnSync(process.execPath, [bin('lm-issues.mjs'), 'fixture', ...args], { cwd: root, encoding: 'utf8' });
const files = (dir) => readdirSync(dir).sort();
const read = (dir, f) => readFileSync(join(dir, f), 'utf8');

test('an issue lands in the tracker the workspace names, with the kit\'s label and the workspace\'s needs-triage label', () => {
	const w = ws();
	const items = [{ key: 'LO card|Edit', text: 'The "Edit" button on the order object card' }, 'The "Save" button on the order object card'];
	const r = lmIssues(w.root, 'file', 'missing-test-ids', 'Order line', '--run', 'run-1', '--items', JSON.stringify(items));
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.deepEqual(files(w.issues), ['01-missing-test-ids-order-line.md']);
	const text = read(w.issues, '01-missing-test-ids-order-line.md');
	assert.match(text, /^# Missing test IDs: Order line$/m);
	assert.match(text, /^\*\*Status:\*\* to-triage$/m);
	assert.match(text, /^\*\*Labels:\*\* living-manual, to-triage$/m);
	assert.match(text, /The "Edit" button on the order object card/);
	assert.match(text, /The "Save" button on the order object card/);
	assert.match(text, /^## Comments$/m);
	assert.match(r.stdout, /^issues: filed 01-missing-test-ids-order-line\.md \(2 item\(s\)\)/m);
});

test('an item already listed in an open issue is not filed again; a new item of a later run gets its own issue', () => {
	const w = ws();
	const items = (...xs) => JSON.stringify(xs);
	assert.equal(lmIssues(w.root, 'file', 'missing-case', 'Order', '--run', 'run-1', '--items', items('Archive an order', 'Split an order')).status, 0);
	const again = lmIssues(w.root, 'file', 'missing-case', 'Order', '--run', 'run-2', '--items', items('Archive an order', 'Split an order'));
	assert.equal(again.status, 0, again.stdout + again.stderr);
	assert.match(again.stdout, /^issues: missing-case Order: nothing new \(2 already in an open issue\)$/m);
	assert.deepEqual(files(w.issues), ['01-missing-case-order.md']);
	const third = lmIssues(w.root, 'file', 'missing-case', 'Order', '--run', 'run-3', '--items', items('Archive an order', 'Change the order type'));
	assert.deepEqual(files(w.issues), ['01-missing-case-order.md', '02-missing-case-order.md']);
	const second = read(w.issues, '02-missing-case-order.md');
	assert.match(second, /Change the order type/);
	assert.doesNotMatch(second, /Archive an order/);
	assert.match(third.stdout, /filed 02-missing-case-order\.md \(1 item\(s\)\) \(1 already in an open issue\)/);
});

test('one issue per kind per feature per run: items of the same run join that run\'s issue, other kinds and features get their own', () => {
	const w = ws();
	const file = (kind, feature, ...xs) => assert.equal(lmIssues(w.root, 'file', kind, feature, '--run', 'run-1', '--items', JSON.stringify(xs)).status, 0);
	file('product-bug', 'Order', 'ORDER-02 step 3: the end date is not computed');
	file('product-bug', 'Order', 'ORDER-04 step 2: the cause list is empty');
	file('product-bug', 'Order line', 'OLINE-02 step 2: the description is not saved');
	file('broken-scenario', 'Order', 'ORDER-02');
	assert.deepEqual(files(w.issues), ['01-product-bug-order.md', '02-product-bug-order-line.md', '03-broken-scenario-order.md']);
	const bugs = read(w.issues, '01-product-bug-order.md');
	assert.match(bugs, /the end date is not computed[\s\S]*the cause list is empty[\s\S]*## Comments/);
});

test('an item in a closed issue is filed again', () => {
	const w = ws();
	assert.equal(lmIssues(w.root, 'file', 'missing-case', 'Order', '--run', 'run-1', '--items', '["Archive an order"]').status, 0);
	const path = join(w.issues, '01-missing-case-order.md');
	writeFileSync(path, read(w.issues, '01-missing-case-order.md').replace('**Status:** to-triage', '**Status:** wontfix'));
	assert.equal(lmIssues(w.root, 'file', 'missing-case', 'Order', '--run', 'run-2', '--items', '["Archive an order"]').status, 0);
	assert.deepEqual(files(w.issues), ['01-missing-case-order.md', '02-missing-case-order.md']);
});

test('a tracker the kit cannot write to refuses with its name, and nothing is written', () => {
	const w = ws({ tracker: '# Issue tracker: GitHub\n\nIssues live in GitHub Issues.\n' });
	const r = lmIssues(w.root, 'file', 'missing-case', 'Order', '--items', '["Archive an order"]');
	assert.equal(r.status, 1);
	assert.match(r.stdout, /^issues refused: .*"GitHub"/m);
});

// A facts pack as lm-facts writes it, after a run of two features: Widgets and Widget racks.
const PACK = {
	kind: 'living-manual/facts-pack', version: 1, product: 'Fixture', productVersion: '9.9.9', newestRunAt: '2026-11-15T10:00:09.000Z',
	scenarios: [
		{ id: 'WIDGET-01', title: 'Register a widget', file: 'scenarios/widget.feature', run: 'passed', status: 'draft', reason: 'not confirmed by the writer' },
		{ id: 'WIDGET-02', title: 'Delete a widget', file: 'scenarios/widget.feature', run: 'failed', status: 'broken', reason: 'the run failed' },
		{ id: 'RACK-01', title: 'Open a widget rack', file: 'scenarios/widget-rack.feature', run: 'passed', status: 'draft', reason: 'not confirmed by the writer' },
		{ id: 'RACK-02', title: 'Rename a widget rack', file: 'scenarios/widget-rack.feature', run: 'passed', status: 'draft', reason: 'not confirmed by the writer' },
	],
	cases: { total: 3, covered: [{ id: 'widget.register', area: 'Widgets', title: 'Register a widget', scenario: 'WIDGET-01' }],
		notCovered: [{ id: 'widget.paint', area: 'Widgets', title: 'Paint a widget' }, { id: 'rack.move', area: 'Widget rack', title: 'Move a widget rack' }] },
	mismatches: [],
	languageBound: [
		{ scenario: 'RACK-01', step: 2, action: 1, kind: 'click', screen: 'Rack list', label: 'Open', locator: "getByRole('button', { name: 'Open' })", testIdTried: 'racklist-open-button' },
		{ scenario: 'RACK-02', step: 2, action: 1, kind: 'click', screen: 'Rack list', label: 'Open', locator: "getByRole('button', { name: 'Open' })", testIdTried: 'racklist-open-button' },
		{ scenario: 'RACK-02', step: 3, action: 1, kind: 'fill', screen: 'Rack card', label: 'Name:', locator: "getByRole('textbox', { name: 'Name:' })", testIdTried: null },
	],
};

test('after a run, the facts pack\'s problems are filed as one issue per kind per feature, and a second run files nothing new', () => {
	const w = ws();
	writeFileSync(join(w.folder, 'facts/pack.json'), JSON.stringify(PACK));
	const r = lmIssues(w.root, 'after-run');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.deepEqual(files(w.issues), ['01-broken-scenario-widgets.md', '02-missing-case-widgets.md', '03-missing-case-widget-rack.md', '04-missing-test-ids-widget-rack.md']);
	const ids = read(w.issues, '04-missing-test-ids-widget-rack.md');
	assert.match(ids, /^\*\*Run:\*\* 2026-11-15T10:00:09\.000Z$/m);
	// The Open button is one element, used by two scenarios: one item naming both.
	assert.equal(ids.match(/^- /gm).length, 2);
	assert.match(ids, /^- .*Open.*Rack list.*racklist-open-button.*RACK-01 step 2.*RACK-02 step 2/m);
	assert.match(ids, /^- .*Name.*Rack card.*RACK-02 step 3/m);
	assert.match(read(w.issues, '01-broken-scenario-widgets.md'), /WIDGET-02.*Delete a widget.*the run failed/);
	assert.match(read(w.issues, '02-missing-case-widgets.md'), /Paint a widget/);
	const again = lmIssues(w.root, 'after-run');
	assert.equal(again.status, 0);
	assert.equal(files(w.issues).length, 4);
	assert.doesNotMatch(again.stdout, /filed|added/);
});

test('ticket 08 files a mismatch bug through fileIssue, joining the run\'s issue', async () => {
	const w = ws();
	writeFileSync(join(w.folder, 'facts/pack.json'), JSON.stringify(PACK));
	const { fileIssue } = await import(bin('lib/issues.mjs'));
	const first = fileIssue('product-bug', 'Widgets', [{ key: 'WIDGET-01 step 2', text: 'WIDGET-01 step 2: the widget is not listed' }], { product: 'fixture', root: w.root });
	const second = fileIssue('product-bug', 'Widgets', ['WIDGET-01 step 3: the colour is wrong'], { product: 'fixture', root: w.root });
	assert.equal(first.file, second.file);
	assert.match(readFileSync(first.file, 'utf8'), /^\*\*Run:\*\* 2026-11-15T10:00:09\.000Z$/m);
	assert.deepEqual(files(w.issues), ['01-product-bug-widgets.md']);
});

test('unanswered guide questions the guide counted are filed as one issue, a question asked twice listed once', () => {
	const w = ws();
	writeFileSync(join(w.folder, 'facts/pack.json'), JSON.stringify({ ...PACK, scenarios: [], cases: null, languageBound: [] }));
	mkdirSync(join(w.folder, 'build/guide'), { recursive: true });
	const q = (question) => JSON.stringify({ question, screen: 'Order list', role: 'order manager' });
	writeFileSync(join(w.folder, 'build/guide/unanswered.jsonl'), [q('How do I print an order?'), q('How do I print an order?'), q('Where is the rent roll?')].join('\n') + '\n');
	const r = lmIssues(w.root, 'after-run');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.deepEqual(files(w.issues), ['01-guide-questions-guide.md']);
	const text = read(w.issues, '01-guide-questions-guide.md');
	assert.match(text, /^# Unanswered guide questions: Guide$/m);
	assert.equal(text.match(/^- /gm).length, 2);
	assert.match(text, /"Where is the rent roll\?" on the Order list/);
});

test('an element found by CSS has no test ID either and is named too; a demo-data element is not', () => {
	const w = ws();
	const action = (kind, label, locator, extra = {}) => ({ kind, screen: 'Rack card', label, dataSpecific: false, languageBound: false, missingTestId: true, locator: { strategy: 'css', expression: locator, testIdTried: null }, ...extra });
	const record = { scenario: { id: 'RACK-02' }, steps: [
		{ text: 'I open the rack', actions: [action('click', 'Rack 7', "getByText('Rack 7')", { dataSpecific: true, languageBound: true, locator: { strategy: 'text', expression: "getByText('Rack 7')" } })] },
		{ text: 'I name the rack', actions: [action('fill', 'Name:', "locator('td:has(> label) [data-role=\"input\"]')", { locator: { strategy: 'css', expression: "locator('td:has(> label) [data-role=\"input\"]')", testIdTried: 'rackcard-name-edit' } })] },
		{ text: 'I save', actions: [action('click', 'Save', "getByTestId('rackcard-save')", { missingTestId: false, locator: { strategy: 'testid', expression: "getByTestId('rackcard-save')" } })] },
	] };
	writeFileSync(join(w.folder, 'facts/step-records/RACK-02.json'), JSON.stringify(record));
	writeFileSync(join(w.folder, 'facts/pack.json'), JSON.stringify({ ...PACK, scenarios: PACK.scenarios.filter((s) => s.id === 'RACK-02'), cases: null, languageBound: [], stepRecords: { 'RACK-02': 'step-records/RACK-02.json' } }));
	assert.equal(lmIssues(w.root, 'after-run').status, 0);
	assert.deepEqual(files(w.issues), ['01-missing-test-ids-widget-rack.md']);
	const text = read(w.issues, '01-missing-test-ids-widget-rack.md');
	assert.equal(text.match(/^- /gm).length, 1);
	assert.match(text, /^- \*\*Name\*\* \(fill\) on the Rack card: found by .*rackcard-name-edit.*RACK-02 step 2/m);
});
