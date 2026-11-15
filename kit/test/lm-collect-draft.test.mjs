// Collect and draft (spec: Solution 2–3, Doc scenarios, Configuration; criterion T1.14). The
// planner writes the case inventory (facts/cases.json) and draft .feature files; lm-collect
// checks the inventory and writes what is and is not yet covered (facts/cases.md); lm-draft plans
// which cases to draft within the first area and the scenario limit, and checks the drafts
// against the scenario rules. Tested on a fixture workspace: what the CLIs print and write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../bin');

const evidence = [{ type: 'code', location: 'shop-web/orders.js:10' }, { type: 'app', location: 'order list' }];
const kase = (id, area, title, more = {}) => ({ id, area, title, role: 'clerk', startScreen: 'order list', evidence, humanIntent: null, manual: null, scenario: null, ...more });
const CASES = [
	kase('orders.create', 'Orders', 'Create an order', { scenario: 'ORDERS-01', humanIntent: { type: 'manual', location: 'manual/orders.md' } }),
	kase('orders.cancel', 'Orders', 'Cancel an order'),
	kase('orders.find', 'Orders', 'Find an order'),
	kase('orders.ship', 'Orders', 'Ship an order'),
	kase('orders.refund', 'Orders', 'Refund an order'),
	kase('orders.print', 'Orders', 'Print a packing slip', { manual: 'printing' }),
	kase('billing.invoice', 'Billing', 'Send an invoice'),
];
const ORDERS_01 = `@doc
Feature: Orders

  @ORDERS-01 @draft
  Scenario: Create an order
    Sources: manual manual/orders.md
    Given I am a clerk on the order list
    When I create an order
    Then the order is listed
`;
const draft = (id, title, { note = true, sources = 'code shop-web/orders.js:10; app order list', first = 'I am a clerk on the order list', last = 'Then the order shows its new state' } = {}) => `
  @${id} @draft
  Scenario: ${title}
    Sources: ${sources}
${note ? '    Note: no human text stated the intent.\n' : ''}    Given ${first}
    When I open the order "A-100"
    ${last}
`;

function workspace({ limit = 3, cases = CASES, feature = ORDERS_01, more = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'lm-draft-'));
	const folder = join(root, 'living-manual/products/shop');
	mkdirSync(join(folder, 'scenarios'), { recursive: true });
	mkdirSync(join(folder, 'facts'), { recursive: true });
	writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({ products: { shop: {
		name: 'Shop', firstArea: 'Orders', limits: { scenariosPerRun: limit, runMinutes: 60 },
		sources: [{ type: 'code', location: 'shop-web' }, { type: 'app', location: 'http://localhost/' }], ...more,
	} } }));
	writeFileSync(join(folder, 'facts/cases.json'), JSON.stringify({ kind: 'living-manual/case-inventory', version: 1, product: 'shop', cases }, null, '\t'));
	writeFileSync(join(folder, 'scenarios/orders.feature'), feature);
	return { root, folder };
}
const cli = (root, name, ...args) => spawnSync(process.execPath, [join(BIN, name), ...args], { cwd: root, encoding: 'utf8' });
const last = (r) => r.stdout.trim().split('\n').pop();

test('collect writes the inventory with what is and is not yet covered by a doc scenario', () => {
	const w = workspace();
	const r = cli(w.root, 'lm-collect.mjs', 'shop');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(last(r), 'collect PASS: 7 case(s) in 2 area(s); 1 covered by a doc scenario, 6 not yet');
	const md = readFileSync(join(w.folder, 'facts/cases.md'), 'utf8');
	assert.match(md, /\| Create an order \| clerk \| order list \| ORDERS-01 \| manual manual\/orders\.md \|/);
	assert.match(md, /\| Cancel an order \| clerk \| order list \| not yet covered \| none: app and code only \|/);
	assert.match(md, /\| Print a packing slip \|.*\| not yet covered \(@manual: printing\) \|/);
	assert.match(md, /## Billing/);
});

test('collect refuses an inventory whose case has no evidence or names a scenario that does not exist', () => {
	const w = workspace({ cases: [kase('a', 'Orders', 'A', { evidence: [] }), kase('b', 'Orders', 'B', { scenario: 'ORDERS-09' }), kase('b', 'Orders', 'B again')] });
	const r = cli(w.root, 'lm-collect.mjs', 'shop');
	assert.equal(r.status, 1, r.stdout);
	assert.match(r.stdout, /a: no evidence/);
	assert.match(r.stdout, /b: scenario ORDERS-09 is not a doc scenario in scenarios\/\*\.feature/);
	assert.match(r.stdout, /b: case id used twice/);
	assert.match(last(r), /^collect FAIL: 3 problem\(s\)/);
});

test('with the scenario limit at three, the plan drafts three and reports the rest as not drafted (T1.14)', () => {
	const w = workspace({ limit: 3 });
	const r = cli(w.root, 'lm-draft.mjs', 'plan', 'shop');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /draft ORDERS-02 Cancel an order \(orders\.cancel\) into scenarios\/orders\.feature/);
	assert.match(r.stdout, /draft ORDERS-04 Ship an order/);
	assert.match(r.stdout, /not drafted: Refund an order \(orders\.refund\): limit of 3 scenarios per run reached/);
	assert.match(r.stdout, /not drafted: Print a packing slip \(orders\.print\): limit of 3 scenarios per run reached/);
	assert.match(r.stdout, /not drafted: Send an invoice \(billing\.invoice\): outside the first area \(Orders\)/);
	assert.equal(last(r), 'draft plan: 3 to draft (limit 3), 3 not drafted (2 over the limit, 1 outside the first area), 1 already covered');
	const plan = JSON.parse(readFileSync(join(w.folder, 'facts/draft-plan.json'), 'utf8'));
	assert.deepEqual(plan.toDraft.map((d) => d.id), ['ORDERS-02', 'ORDERS-03', 'ORDERS-04']);
	assert.equal(plan.notDrafted.length, 3);
	assert.ok(existsSync(join(w.folder, 'facts/draft-report.md')));
});

test('the config can name an area\'s ID prefix; the plan numbers new scenarios after it', () => {
	const w = workspace({ limit: 2, more: { idPrefixes: { Orders: 'ORD' } }, feature: ORDERS_01.replace('@ORDERS-01', '@ORD-01') });
	const r = cli(w.root, 'lm-draft.mjs', 'plan', 'shop');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const plan = JSON.parse(readFileSync(join(w.folder, 'facts/draft-plan.json'), 'utf8'));
	assert.deepEqual(plan.toDraft.map((d) => d.id), ['ORD-02', 'ORD-03']);
});

test('check passes drafts that follow the scenario rules and match the plan', () => {
	const w = workspace();
	cli(w.root, 'lm-draft.mjs', 'plan', 'shop');
	writeFileSync(join(w.folder, 'scenarios/orders.feature'), ORDERS_01 + draft('ORDERS-02', 'Cancel an order') + draft('ORDERS-03', 'Find an order') + draft('ORDERS-04', 'Ship an order'));
	const r = cli(w.root, 'lm-draft.mjs', 'check', 'shop');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(last(r), 'draft PASS: 4 doc scenario(s) follow the rules; 3 drafted this run (limit 3)');
});

test('check refuses a fourth draft over the limit, a missing intent note and a broken rule', () => {
	const w = workspace();
	cli(w.root, 'lm-draft.mjs', 'plan', 'shop');
	writeFileSync(join(w.folder, 'scenarios/orders.feature'), ORDERS_01
		+ draft('ORDERS-02', 'Cancel an order', { note: false })
		+ draft('ORDERS-03', 'Find an order', { first: 'I open the order list' })
		+ draft('ORDERS-04', 'Ship an order', { last: 'And the order is shipped' })
		+ draft('ORDERS-05', 'Refund an order'));
	const r = cli(w.root, 'lm-draft.mjs', 'check', 'shop');
	assert.equal(r.status, 1, r.stdout);
	assert.match(r.stdout, /ORDERS-02: drafted from app and code only; add "Note: no human text stated the intent\."/);
	assert.match(r.stdout, /ORDERS-03: the first step must name the role and the start screen \("I am a <role> on the <screen>"\)/);
	assert.match(r.stdout, /ORDERS-04: the last step must be a Then that asserts the visible result/);
	assert.match(r.stdout, /ORDERS-05: not in this run's draft plan \(limit 3\); it is not drafted/);
	assert.match(last(r), /^draft FAIL: 4 problem\(s\)/);
});

test('check refuses the note on a scenario a human text stated', () => {
	const w = workspace();
	cli(w.root, 'lm-draft.mjs', 'plan', 'shop');
	writeFileSync(join(w.folder, 'scenarios/orders.feature'), ORDERS_01.replace('    Given', '    Note: no human text stated the intent.\n    Given'));
	const r = cli(w.root, 'lm-draft.mjs', 'check', 'shop');
	assert.equal(r.status, 1, r.stdout);
	assert.match(r.stdout, /ORDERS-01: a human text \(manual\) states the intent; remove the note/);
});

test('planning again after drafting keeps this run\'s plan, so its drafts still count against the limit', () => {
	const w = workspace();
	cli(w.root, 'lm-draft.mjs', 'plan', 'shop');
	writeFileSync(join(w.folder, 'scenarios/orders.feature'), ORDERS_01 + draft('ORDERS-02', 'Cancel an order') + draft('ORDERS-03', 'Find an order') + draft('ORDERS-04', 'Ship an order'));
	const again = cli(w.root, 'lm-draft.mjs', 'plan', 'shop');
	assert.equal(again.status, 0, again.stdout);
	assert.match(last(again), /^draft plan kept: 3 of its 3 planned scenario\(s\) are drafted; plan --new starts the next run$/);
	assert.equal(last(cli(w.root, 'lm-draft.mjs', 'check', 'shop')), 'draft PASS: 4 doc scenario(s) follow the rules; 3 drafted this run (limit 3)');
	const linked = CASES.map((c) => ({ ...c, scenario: { 'orders.cancel': 'ORDERS-02', 'orders.find': 'ORDERS-03', 'orders.ship': 'ORDERS-04' }[c.id] ?? c.scenario }));
	writeFileSync(join(w.folder, 'facts/cases.json'), JSON.stringify({ product: 'shop', cases: linked }));
	const next = cli(w.root, 'lm-draft.mjs', 'plan', 'shop', '--new');
	assert.match(next.stdout, /draft ORDERS-05 Refund an order/);
});
