// Draft from the writer's material (spec: Starting material from the writer; Doc scenarios; stories
// 13, 14, 31). `lm-draft from <product> manual|text|gherkin|recording <source>` turns what the
// writer hands in into intent-level draft scenarios with a source reference, and `lm-draft check`
// refuses any step written at the UI level. Tested on a fixture workspace: what the CLI prints and
// what lands in scenarios/ (the .feature and its .corrections.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../bin');

const ORDERS = `@doc
Feature: Orders

  @ORDERS-01 @draft
  Scenario: Create an order
    Sources: text notes/orders.txt
    Given I am a clerk on the order list
    When I create an order
    Then the order is listed
`;

function workspace({ feature = ORDERS, limit = 10, files = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'lm-from-'));
	const folder = join(root, 'living-manual/products/shop');
	mkdirSync(join(folder, 'scenarios'), { recursive: true });
	mkdirSync(join(folder, 'facts'), { recursive: true });
	writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({ products: { shop: {
		name: 'Shop', firstArea: 'Orders', limits: { scenariosPerRun: limit, runMinutes: 60 },
	} } }));
	if (feature !== null) writeFileSync(join(folder, 'scenarios/orders.feature'), feature);
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, name)), { recursive: true });
		writeFileSync(join(root, name), text);
	}
	return { root, folder, feature: () => readFileSync(join(folder, 'scenarios/orders.feature'), 'utf8'),
		corrections: () => JSON.parse(readFileSync(join(folder, 'scenarios/orders.corrections.json'), 'utf8')) };
}
const cli = (root, ...args) => spawnSync(process.execPath, [join(BIN, 'lm-draft.mjs'), ...args], { cwd: root, encoding: 'utf8' });
const last = (r) => r.stdout.trim().split('\n').pop();
/** The scenario block for an ID, from its tag line to the next blank line. */
const block = (text, id) => text.slice(text.indexOf(`@${id}`)).split(/\n\s*\n/)[0].trimEnd();

test('check refuses a step written at the UI level and names the word', () => {
	const w = workspace({ feature: ORDERS.replace('When I create an order', 'When I click the "New order" button\n    And I type "A-100" into the Number field') });
	const r = cli(w.root, 'check', 'shop');
	assert.equal(r.status, 1, r.stdout);
	assert.match(r.stdout, /ORDERS-01: step "I click the "New order" button" is UI level \(click, button\); write what the user wants done, e\.g\. "I save the order"/);
	assert.match(r.stdout, /ORDERS-01: step "I type "A-100" into the Number field" is UI level \(type into, field\)/);
	assert.match(last(r), /^draft FAIL: 2 problem\(s\)/);
});

test('check does not read quoted data or the noun "type" as UI words', () => {
	const w = workspace({ feature: ORDERS.replace('When I create an order', 'When I start an order of the type "Click and collect"\n    And I name the order "Big button box"') });
	const r = cli(w.root, 'check', 'shop');
	assert.equal(r.status, 0, r.stdout);
});

const WRITER_GHERKIN = `Feature: Cancelling orders

  Scenario: Cancel an order
    Given I am logged in as a clerk
    And I am on the order list page
    When I click on "A-100"
    And I click the "Cancel order" button
    And I click the "OK" button
    Then the order "A-100" shows the status "Cancelled"

  @confirmed
  Scenario: Find an order
    Given the user is on the order list
    When the user types "A-100" into the Search field
    And the user presses Enter
    And the order "A-100" is listed
`;

test('the writer\'s Gherkin is corrected to the scenario rules and every correction is recorded', () => {
	const w = workspace({ files: { 'notes/writer.feature': WRITER_GHERKIN } });
	const r = cli(w.root, 'from', 'shop', 'gherkin', 'notes/writer.feature', '--role', 'clerk');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(last(r), 'draft from gherkin: 2 draft scenario(s) written to scenarios/orders.feature (ORDERS-02, ORDERS-03); 14 correction(s) recorded in scenarios/orders.corrections.json');
	assert.equal(block(w.feature(), 'ORDERS-02'), `@ORDERS-02 @draft
  Scenario: Cancel an order
    Sources: gherkin notes/writer.feature:3
    Given I am a clerk on the order list
    When I open "A-100"
    And I cancel the order
    And I confirm
    Then the order "A-100" shows the status "Cancelled"`);
	assert.equal(block(w.feature(), 'ORDERS-03'), `@ORDERS-03 @draft
  Scenario: Find an order
    Sources: gherkin notes/writer.feature:12
    Given I am a clerk on the order list
    When I set the search to "A-100"
    Then the order "A-100" is listed`);

	const c = w.corrections();
	assert.equal(c.kind, 'living-manual/corrections');
	const of = (id) => c.corrections.filter((x) => x.scenario === id).map(({ rule, before, after }) => ({ rule, before, after }));
	assert.deepEqual(of('ORDERS-02'), [
		{ rule: 'stable ID', before: null, after: '@ORDERS-02' },
		{ rule: 'draft until the writer confirms', before: null, after: '@draft' },
		{ rule: 'source reference', before: null, after: 'Sources: gherkin notes/writer.feature:3' },
		{ rule: 'role and start screen in the first step', before: 'Given I am logged in as a clerk / And I am on the order list page', after: 'Given I am a clerk on the order list' },
		{ rule: 'intent level', before: 'When I click on "A-100"', after: 'When I open "A-100"' },
		{ rule: 'intent level', before: 'And I click the "Cancel order" button', after: 'And I cancel the order' },
		{ rule: 'intent level', before: 'And I click the "OK" button', after: 'And I confirm' },
	]);
	assert.deepEqual(of('ORDERS-03'), [
		{ rule: 'stable ID', before: null, after: '@ORDERS-03' },
		{ rule: 'draft until the writer confirms', before: '@confirmed', after: '@draft' },
		{ rule: 'source reference', before: null, after: 'Sources: gherkin notes/writer.feature:12' },
		{ rule: 'role and start screen in the first step', before: 'Given the user is on the order list (role from --role: clerk)', after: 'Given I am a clerk on the order list' },
		{ rule: 'intent level', before: 'When the user types "A-100" into the Search field', after: 'When I set the search to "A-100"' },
		{ rule: 'intent level', before: 'And the user presses Enter', after: null },
		{ rule: 'final step asserts the visible result', before: 'And the order "A-100" is listed', after: 'Then the order "A-100" is listed' },
	]);
	assert.ok(c.corrections.every((x) => x.source === 'gherkin notes/writer.feature' && x.feature === 'scenarios/orders.feature'));
	assert.equal(cli(w.root, 'check', 'shop').status, 0, cli(w.root, 'check', 'shop').stdout);
});

test('a step it cannot bring to intent level is left as an open question, and check still refuses it', () => {
	const w = workspace({ files: { 'notes/plus.feature': `Feature: X\n  Scenario: Start an order\n    Given I am a clerk on the order list\n    When I click the "+" button\n    Then a new order is shown\n` } });
	const r = cli(w.root, 'from', 'shop', 'gherkin', 'notes/plus.feature');
	assert.equal(r.status, 1, r.stdout);
	assert.match(r.stdout, /open: ORDERS-02 step "I click the "\+" button": cannot write it at intent level; ask the writer what the user wants done/);
	assert.match(last(r), /1 open question\(s\) for the writer session$/);
	const open = w.corrections().corrections.find((x) => x.open);
	assert.equal(open.before, 'When I click the "+" button');
	assert.equal(open.after, null);
	assert.equal(cli(w.root, 'check', 'shop').status, 1);
});

// What `npx playwright codegen` writes when the writer clicks through a task with the recorder.
const RECORDING = `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('http://localhost:8080/shop/?view=orders');
  await page.getByRole('button', { name: 'New order' }).click();
  await page.getByLabel('Customer').click();
  await page.getByLabel('Customer').fill('Blue');
  await page.getByLabel('Customer').fill('Acme');
  await page.getByLabel('Customer').press('Enter');
  await page.getByRole('combobox', { name: 'Delivery' }).selectOption('Express');
  await page.getByRole('tab', { name: 'Notes' }).click();
  await page.getByRole('checkbox', { name: 'Gift wrap' }).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('row', { name: 'Acme' }).getByRole('cell').first()).toBeVisible();
  await expect(page.locator('#status')).toContainText('Saved');
});
`;

test('a click recording becomes one intent-level draft, each step traced to its recorded line', () => {
	const w = workspace({ files: { 'notes/new-order.ts': RECORDING } });
	const r = cli(w.root, 'from', 'shop', 'recording', 'notes/new-order.ts', '--role', 'clerk', '--screen', 'order list');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(last(r), /^draft from recording: 1 draft scenario\(s\) written to scenarios\/orders\.feature \(ORDERS-02\)/);
	assert.equal(block(w.feature(), 'ORDERS-02'), `@ORDERS-02 @draft
  Scenario: New order
    Sources: recording notes/new-order.ts
    Given I am a clerk on the order list
    When I start a new order
    And I set the customer to "Acme"
    And I choose the delivery "Express"
    And I open the Notes tab
    And I turn on "Gift wrap"
    And I save
    Then "Acme" is shown
    And "Saved" is shown`);
	const c = w.corrections().corrections;
	const line = (n) => c.find((x) => x.line === n);
	assert.deepEqual({ ...line(4), scenario: undefined, title: undefined, source: undefined, feature: undefined }, { scenario: undefined, title: undefined, source: undefined, feature: undefined,
		rule: 'role and start screen in the first step', line: 4, before: "await page.goto('http://localhost:8080/shop/?view=orders');", after: 'Given I am a clerk on the order list' });
	assert.equal(line(5).after, 'When I start a new order');
	assert.equal(line(6).after, null, 'the click into a field before typing is no step');
	assert.equal(line(7).after, null, 'only the last text typed into a field counts');
	assert.equal(line(9).after, null, 'a key press is no step');
	assert.equal(line(14).after, 'Then "Acme" is shown');
	assert.equal(cli(w.root, 'check', 'shop').status, 0);
});

test('a recording with no assertion or no start screen is drafted with open questions', () => {
	const w = workspace({ files: { 'notes/rec.ts': RECORDING.replace(/\n\s*await expect.*/g, '') } });
	const r = cli(w.root, 'from', 'shop', 'recording', 'notes/rec.ts', '--role', 'clerk');
	assert.equal(r.status, 1, r.stdout);
	assert.match(r.stdout, /open: ORDERS-02 name the start screen/);
	assert.match(r.stdout, /open: ORDERS-02 the recording asserts nothing: record what the user sees at the end \(the recorder's "Assert visibility" or "Assert text"\), or add a final Then/);
});

const TEXT = `Cancelling an order

As a clerk you can cancel an order that has not been shipped.

1. Open the order list.
2. Click "A-100" in the order list.
3. Click Cancel order.
4. Click OK. A confirmation closes.

The order shows the status "Cancelled".

Finding an order

1. Type the order number into the Search field.
2. Press Enter.

The order is listed.
`;

test('plain text gives one draft per procedure, each pointing at the lines it came from', () => {
	const w = workspace({ files: { 'notes/orders.txt': TEXT } });
	const r = cli(w.root, 'from', 'shop', 'text', 'notes/orders.txt', '--role', 'clerk', '--screen', 'order list');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(last(r), /^draft from text: 2 draft scenario\(s\) written to scenarios\/orders\.feature \(ORDERS-02, ORDERS-03\)/);
	assert.equal(block(w.feature(), 'ORDERS-02'), `@ORDERS-02 @draft
  Scenario: Cancelling an order
    Sources: text notes/orders.txt#L1-L10
    Given I am a clerk on the order list
    When I open "A-100"
    And I cancel the order
    And I confirm
    Then the order shows the status "Cancelled"`);
	assert.equal(block(w.feature(), 'ORDERS-03'), `@ORDERS-03 @draft
  Scenario: Finding an order
    Sources: text notes/orders.txt#L12-L17
    Given I am a clerk on the order list
    When I set the search to the order number
    Then the order is listed`);
	const c = w.corrections().corrections;
	assert.ok(c.some((x) => x.scenario === 'ORDERS-02' && x.before === 'Click Cancel order.' && x.after === 'And I cancel the order'));
	assert.ok(c.some((x) => x.scenario === 'ORDERS-03' && x.before === 'Press Enter.' && x.after === null));
	assert.equal(cli(w.root, 'check', 'shop').status, 0);
});

const MANUAL_PAGE = `<!doctype html><html><head><title>Cancel an order</title></head><body>
<h1>Orders</h1>
<h2 id="cancel">Cancel an order</h2>
<p>As a clerk you can cancel an order.</p>
<ol><li>Open the order list.</li><li>Click &quot;A-100&quot;.</li><li>Click the <b>Cancel order</b> button.</li></ol>
<p>The order shows the status &quot;Cancelled&quot;.</p>
</body></html>`;

test('a manual folder gives drafts that each name the page and heading they came from', () => {
	const w = workspace({ files: { 'manual/orders/cancel.html': MANUAL_PAGE, 'manual/index.md': '# Shop manual\n\nWelcome. See the order pages.\n' } });
	const r = cli(w.root, 'from', 'shop', 'manual', 'manual', '--current', 'Wendy, 2026-11-15');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /manual: 2 page\(s\) read, 1 procedure\(s\) found/);
	assert.equal(block(w.feature(), 'ORDERS-02'), `@ORDERS-02 @draft
  Scenario: Cancel an order
    Sources: manual manual/orders/cancel.html#cancel
    Given I am a clerk on the order list
    When I open "A-100"
    And I cancel the order
    Then the order shows the status "Cancelled"`);
	assert.equal(cli(w.root, 'check', 'shop').status, 0);
});

test('a manual nobody confirmed as the live one is drafted with that open question', () => {
	const w = workspace({ files: { 'manual/cancel.html': MANUAL_PAGE } });
	const r = cli(w.root, 'from', 'shop', 'manual', 'manual');
	assert.equal(r.status, 1, r.stdout);
	assert.match(r.stdout, /open: ORDERS-02 confirm that manual is the manual in use before drafting from it \(spec risk "Which manual is current"\); then pass --current <who, when>/);
});

test('a manual given as a URL is read with the pages it links to on the same site', async () => {
	const pages = { '/help/index.html': '<h1>Help</h1><ul><li><a href="cancel.html">Cancel an order</a></li><li><a href="https://elsewhere.example/x.html">Other</a></li></ul>', '/help/cancel.html': MANUAL_PAGE };
	const server = createServer((req, res) => { const p = pages[req.url]; res.writeHead(p ? 200 : 404, { 'content-type': 'text/html' }); res.end(p ?? 'no'); });
	await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
	const url = `http://127.0.0.1:${server.address().port}/help/index.html`;
	try {
		const w = workspace();
		const r = await new Promise((done) => {
			const child = spawn(process.execPath, [join(BIN, 'lm-draft.mjs'), 'from', 'shop', 'manual', url, '--current', 'test'], { cwd: w.root });
			let stdout = '';
			child.stdout.on('data', (d) => (stdout += d));
			child.stderr.on('data', (d) => (stdout += d));
			child.on('exit', (status) => done({ status, stdout }));
		});
		assert.equal(r.status, 0, r.stdout);
		assert.match(r.stdout, /manual: 2 page\(s\) read, 1 procedure\(s\) found/);
		assert.match(w.feature(), new RegExp(`Sources: manual http://127\\.0\\.0\\.1:\\d+/help/cancel\\.html#cancel`));
	} finally { server.close(); }
});

test('drafts from the writer count against the scenario limit of the run', () => {
	const w = workspace({ limit: 2, files: { 'notes/writer.feature': WRITER_GHERKIN, 'notes/orders.txt': TEXT } });
	const ok = cli(w.root, 'from', 'shop', 'gherkin', 'notes/writer.feature', '--role', 'clerk');
	assert.equal(ok.status, 0, ok.stdout);
	const plan = JSON.parse(readFileSync(join(w.folder, 'facts/draft-plan.json'), 'utf8'));
	assert.deepEqual(plan.fromWriter.map((d) => [d.id, d.source]), [['ORDERS-02', 'gherkin notes/writer.feature:3'], ['ORDERS-03', 'gherkin notes/writer.feature:12']]);
	const before = w.feature();
	const r = cli(w.root, 'from', 'shop', 'text', 'notes/orders.txt', '--role', 'clerk', '--screen', 'order list');
	assert.equal(r.status, 1, r.stdout);
	assert.equal(last(r), 'draft from text refused: this run has 2 of its 2 scenario(s) drafted and the material gives 2 more; lm-draft plan --new starts the next run');
	assert.equal(w.feature(), before, 'nothing written');
});

test('--out drafts into another file, and check --file checks that file against the scenario rules', () => {
	const w = workspace({ files: { 'notes/writer.feature': WRITER_GHERKIN } });
	const r = cli(w.root, 'from', 'shop', 'gherkin', 'notes/writer.feature', '--role', 'clerk', '--out', 'evidence/drafts.feature');
	assert.equal(r.status, 0, r.stdout);
	assert.match(last(r), /written to evidence\/drafts\.feature \(ORDERS-02, ORDERS-03\); 14 correction\(s\) recorded in evidence\/drafts\.corrections\.json$/);
	assert.ok(existsSync(join(w.root, 'evidence/drafts.corrections.json')));
	assert.ok(!existsSync(join(w.folder, 'facts/draft-plan.json')), 'drafts outside scenarios/ are no part of the run');
	const c = cli(w.root, 'check', 'shop', '--file', 'evidence/drafts.feature');
	assert.equal(c.status, 0, c.stdout);
	assert.equal(last(c), 'draft PASS: 2 doc scenario(s) in evidence/drafts.feature follow the rules');
});

test('prose: a trailing key press is dropped, a choice from a list is a choice, a button named by a noun is opened', () => {
	const w = workspace({ files: { 'notes/notice.txt': `Recording a notice

As a clerk you record a customer's notice on the order.

1. Open the order list.
2. Type "A-100" into the Search field and press Enter.
3. Select "Moved away" in the Reason list.
4. Click Notice of cancellation.
5. Click Save.

The order shows the notice.
` } });
	const r = cli(w.root, 'from', 'shop', 'text', 'notes/notice.txt');
	assert.equal(r.status, 0, r.stdout);
	assert.equal(block(w.feature(), 'ORDERS-02').split('\n').slice(3).join('\n'), `    Given I am a clerk on the order list
    When I set the search to "A-100"
    And I choose the reason "Moved away"
    And I open "Notice of cancellation"
    And I save
    Then the order shows the notice`);
});

test('a recording that names an element only by its test ID leaves that step to the writer', () => {
	const w = workspace({ files: { 'notes/rec.ts': `test('test', async ({ page }) => {
  await page.goto('http://localhost/orders');
  await page.getByTestId('order-new-button').click();
  await expect(page.getByTestId('order-card')).toBeVisible();
});
` } });
	const r = cli(w.root, 'from', 'shop', 'recording', 'notes/rec.ts', '--role', 'clerk', '--screen', 'order list');
	assert.equal(r.status, 1, r.stdout);
	assert.match(r.stdout, /open: ORDERS-02 line 3: "await page\.getByTestId\('order-new-button'\)\.click\(\);" names the element only by its test ID \(order-new-button\); ask the writer what the user wants done/);
	assert.match(r.stdout, /open: ORDERS-02 line 4: cannot say what "await expect\(page\.getByTestId\('order-card'\)\)\.toBeVisible\(\);" shows; ask the writer what the user sees/);
});
