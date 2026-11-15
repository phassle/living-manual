// Watch (spec: Watch; From scenario to test code, Healer; Confirmation). After the product changes,
// lm-watch reruns every doc scenario, lets the healer repair locators and waits only, regenerates
// the outputs whose step records changed and reports what changed, what was healed and what broke;
// it stops at the time limit and reports what it did not reach.
// Tested at the files seam on a fixture workspace: the product is a static page the test rewrites,
// the healer is a fake `claude` (LM_CLAUDE) that applies a fixture diff to the spec; we read the
// watch report, the manual page, the site, the confirmation state and the tracker on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bin, KIT } from './manual-fixture.mjs';

const TRACKER = `# Issue tracker: Local Markdown

Issues are one file per ticket at \`.tracker/<feature-slug>/issues/<NN>-<slug>.md\`.

- Triage state is recorded as a \`**Status:**\` line near the top of each issue file
- Comments append to the bottom of the file under a \`## Comments\` heading
`;
const LABELS = `| Label in mattpocock/skills | Label in our tracker | Meaning |
| --- | --- | --- |
| \`needs-triage\` | \`needs-triage\` | Maintainer needs to evaluate this issue |
`;

const FEATURE = `@doc
Feature: Widgets

  @WIDGET-01
  Scenario: Register a widget
    Given I am a widget keeper on the widget list
    When I add the widget "Blue"
    And I close the widget card
    Then the widget "Blue" is listed
`;
const MORE = (n) => `
  @WIDGET-0${n}
  Scenario: Look at the widget list ${n}
    Given I am a widget keeper on the widget list
    Then the widget list is shown
`;

const SPEC = (extra = 0, wait = 0) => `import { test, expect } from ${JSON.stringify(join(KIT, 'src/index.ts'))};

test('WIDGET-01 Register a widget', { tag: '@doc', annotation: [{ type: 'role', description: 'widget keeper' }, { type: 'start screen', description: 'widget list' }] }, async ({ page, lm }) => {
	test.setTimeout(10_000);
	await test.step('I am a widget keeper on the widget list', async () => {
		await page.goto('widgets.html');
		lm.screen('Widget list');
		await lm.click({ css: '#tab-proposals' });${wait ? `\n\t\tawait page.waitForTimeout(${wait});` : ''}
	});
	await test.step('I add the widget "Blue"', async () => {
		await lm.click({ css: '#new' });
		lm.screen('Widget card');
		await lm.fill({ css: '#name' }, 'Blue');
	});
	await test.step('I close the widget card', async () => {
		await lm.click({ css: '#close' }, { describe: 'close button' });
		await expect(page.locator('#card')).toBeHidden({ timeout: 2_000 });
	});
	await test.step('the widget "Blue" is listed', async () => {
		lm.screen('Widget list');
		await lm.see({ text: 'Blue' }, { within: page.locator('#list') });
	});
});
${Array.from({ length: extra }, (_, i) => `
test('WIDGET-0${i + 2} Look at the widget list ${i + 2}', { tag: '@doc' }, async ({ page, lm }) => {
	await test.step('I am a widget keeper on the widget list', async () => {
		await page.goto('widgets.html');
		lm.screen('Widget list');
		await lm.click({ css: '#tab-proposals' });${wait ? `\n\t\tawait page.waitForTimeout(${wait});` : ''}
	});
	await test.step('the widget list is shown', async () => {
		await lm.see({ css: '#list' }, { describe: 'widget list' });
	});
});`).join('\n')}`;

/** The product: one static page. tab = the Proposals tab's label, newId = the New button's id, confirm = a dialog before the card closes. */
const PAGE = ({ tab = 'Proposals', newId = 'new', confirm = false } = {}) => `<!doctype html><html><body style="font:16px sans-serif">
<div><span id="tab-proposals" style="padding:4px;border:1px solid #888">${tab}</span></div>
<button id="${newId}">New widget</button>
<div id="card" hidden><label for="name">Name</label> <input id="name"> <img id="close" alt="" width="16" height="16" style="background:#000"></div>
<div id="confirm" hidden>Close the card? <button id="yes">Close card</button></div>
<ul id="list" style="min-height:20px"></ul>
<script>
const $ = (id) => document.getElementById(id);
$('${newId}').onclick = () => { $('card').hidden = false; };
const closeCard = () => { $('card').hidden = true; $('confirm').hidden = true; const li = document.createElement('li'); li.textContent = $('name').value; $('list').append(li); };
$('close').onclick = () => { ${confirm ? "$('confirm').hidden = false;" : 'closeCard();'} };
$('yes').onclick = closeCard;
</script></body></html>`;

function workspace({ extra = 0, wait = 0, runMinutes = 30 } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'lm-watch-'));
	const folder = join(root, 'living-manual/products/fixture');
	for (const d of ['tests', 'scenarios', '../../../pages', '../../../docs/agents']) mkdirSync(join(folder, d), { recursive: true });
	writeFileSync(join(root, 'docs/agents/issue-tracker.md'), TRACKER);
	writeFileSync(join(root, 'docs/agents/triage-labels.md'), LABELS);
	writeFileSync(join(root, 'pages/widgets.html'), PAGE());
	writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({
		products: { fixture: {
			name: 'Fixture',
			environment: { baseUrl: pathToFileURL(join(root, 'pages')).href + '/', reset: 'echo reset >> env.log', verify: 'echo verify >> env.log', viewport: { width: 600, height: 300 } },
			context: { from: 'docs/agents/' },
			limits: { runMinutes, healMinutes: 2 },
		} },
	}));
	writeFileSync(join(folder, 'scenarios/widget.feature'), FEATURE + Array.from({ length: extra }, (_, i) => MORE(i + 2)).join(''));
	writeFileSync(join(folder, 'tests/widget.spec.ts'), SPEC(extra, wait));
	// The agents' seed (bin/lm-agent.mjs writes one with a path relative to the real kit when missing).
	writeFileSync(join(folder, 'tests/seed.spec.ts'), `import { test } from ${JSON.stringify(join(KIT, 'src/index.ts'))};\ntest('seed', { tag: '@seed' }, async ({ page }) => { await page.goto('widgets.html'); });\n`);
	return {
		root, folder,
		product: (opts) => writeFileSync(join(root, 'pages/widgets.html'), PAGE(opts)),
		spec: () => readFileSync(join(folder, 'tests/widget.spec.ts'), 'utf8'),
		report: () => readFileSync(join(folder, 'build/watch/report.md'), 'utf8'),
		page: () => readFileSync(join(folder, 'build/manual/widget-01-register-a-widget.md'), 'utf8'),
		site: () => /<article[\s\S]*<\/article>/.exec(readFileSync(join(folder, 'build/site/widget-01-register-a-widget.html'), 'utf8'))?.[0],
		issues: () => { const d = join(root, '.tracker/living-manual-fixture/issues'); return existsSync(d) ? readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')) : []; },
	};
}

/** A fake `claude` for the healer: applies the [from, to] edit to the spec, like a repair would. */
function fakeHealer(w, from, to, { add = {}, remove = [] } = {}) {
	const script = join(w.root, 'fake-claude.mjs');
	writeFileSync(script, `import { readFileSync, rmSync, writeFileSync } from 'node:fs';
const f = ${JSON.stringify(join(w.folder, 'tests/widget.spec.ts'))};
writeFileSync(f, readFileSync(f, 'utf8').replace(${JSON.stringify(from)}, ${JSON.stringify(to)}));
for (const [p, t] of Object.entries(${JSON.stringify(add)})) writeFileSync(${JSON.stringify(w.folder)} + '/' + p, t);
for (const p of ${JSON.stringify(remove)}) rmSync(${JSON.stringify(w.folder)} + '/' + p);
console.log('healed WIDGET-01: fake repair');\n`);
	const sh = join(w.root, 'fake-claude');
	writeFileSync(sh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
	chmodSync(sh, 0o755);
	return sh;
}

const env = { ...process.env, LM_CACHE_DIR: mkdtempSync(join(tmpdir(), 'lm-watch-cache-')) };
delete env.LM_RUN_LOCK;
const watch = (w, args = [], extraEnv = {}) => {
	const r = spawnSync(process.execPath, [bin('lm-watch.mjs'), 'fixture', ...args], { cwd: w.root, encoding: 'utf8', env: { ...env, LM_CLAUDE: '/bin/false', ...extraEnv } });
	return { status: r.status, out: r.stdout + r.stderr };
};
const lm = (w, cli, ...args) => spawnSync(process.execPath, [bin(cli), 'fixture', ...args], { cwd: w.root, encoding: 'utf8', env: { ...env, LM_WORKSPACE: w.root } });
const state = (w) => lm(w, 'lm-confirm.mjs', 'status', 'WIDGET-01').stdout;

test('watch runs every doc scenario and reports each as new, then unchanged on unchanged code', { timeout: 180_000 }, () => {
	const w = workspace({ extra: 1 });
	const first = watch(w);
	assert.equal(first.status, 0, first.out);
	assert.match(first.out, /^WIDGET-01: new/m);
	assert.match(first.out, /^WIDGET-02: new/m);
	assert.ok(existsSync(join(w.folder, 'build/manual/widget-01-register-a-widget.md')), 'a manual page from the run');
	const second = watch(w);
	assert.equal(second.status, 0, second.out);
	assert.match(second.out, /^WIDGET-01: unchanged/m);
	assert.match(second.out, /^WIDGET-02: unchanged/m);
	assert.match(w.report(), /## Unchanged[\s\S]*WIDGET-01/);
	assert.match(w.report(), /Not reached: none/);
	rmSync(w.root, { recursive: true });
});

// Review finding 14: each scenario starts from one reset and one verify (the run gate), not a
// reset by the watch, a verify by the gate and another reset and verify by the test fixture.
test('each scenario in a watch is reset once and verified once', { timeout: 180_000 }, () => {
	const w = workspace({ extra: 1 });
	const r = watch(w);
	assert.equal(r.status, 0, r.out);
	const log = readFileSync(join(w.root, 'env.log'), 'utf8').trim().split('\n');
	assert.deepEqual(log, ['reset', 'verify', 'reset', 'verify'], 'two scenarios: reset then verify, once each');
	rmSync(w.root, { recursive: true });
});

test('a renamed label flows into the page and its screenshot, and a confirmed scenario stays confirmed', { timeout: 180_000 }, () => {
	const w = workspace();
	assert.equal(watch(w).status, 0);
	assert.equal(lm(w, 'lm-confirm.mjs', 'confirm', 'WIDGET-01', '--by', 'Writer').status, 0);
	assert.equal(lm(w, 'lm-publish.mjs').status, 0);
	const shot = readFileSync(join(w.folder, 'build/manual/assets/WIDGET-01/01.png'));
	assert.match(w.page(), /Click \*\*Proposals\*\*/);

	w.product({ tab: 'Order proposals' });
	const r = watch(w);
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /^WIDGET-01: changed/m);
	assert.match(w.report(), /## Changed[\s\S]*WIDGET-01[\s\S]*Proposals → Order proposals/);
	assert.match(w.page(), /Click \*\*Order proposals\*\*/);
	assert.notDeepEqual(readFileSync(join(w.folder, 'build/manual/assets/WIDGET-01/01.png')), shot, 'a new screenshot');
	assert.match(state(w), /WIDGET-01: confirmed/);
	assert.match(w.site(), /Order proposals/, 'the published page follows');
	rmSync(w.root, { recursive: true });
});

test('a moved element is repaired by the healer: locator only, rerun green, reported healed; the writer must confirm again', { timeout: 180_000 }, () => {
	const w = workspace();
	assert.equal(watch(w).status, 0);
	assert.equal(lm(w, 'lm-confirm.mjs', 'confirm', 'WIDGET-01', '--by', 'Writer').status, 0);
	w.product({ newId: 'add' });
	const healer = fakeHealer(w, `lm.click({ css: '#new' })`, `lm.click({ css: '#add' })`);
	const r = watch(w, [], { LM_CLAUDE: healer });
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /^WIDGET-01: healed/m);
	assert.match(w.spec(), /css: '#add'/, 'the repair is kept');
	assert.match(w.report(), /## Healed[\s\S]*WIDGET-01[\s\S]*locator\/wait only/);
	assert.match(state(w), /WIDGET-01: broken \(confirmation lapsed: the action list changed/, 'a repair is never self-approved');
	rmSync(w.root, { recursive: true });
});

test('a repair that adds an action is rejected: spec restored, scenario broken, issue filed, published page unchanged', { timeout: 180_000 }, () => {
	const w = workspace();
	assert.equal(watch(w).status, 0);
	assert.equal(lm(w, 'lm-confirm.mjs', 'confirm', 'WIDGET-01', '--by', 'Writer').status, 0);
	assert.equal(lm(w, 'lm-publish.mjs').status, 0);
	const published = w.site();
	assert.ok(published);
	const before = w.spec();

	w.product({ confirm: true });
	const healer = fakeHealer(w, `{ describe: 'close button' });`, `{ describe: 'close button' });\n\t\tawait lm.click({ role: 'button', name: 'Close card' });`);
	const r = watch(w, [], { LM_CLAUDE: healer });
	assert.equal(r.status, 1, r.out);
	assert.match(r.out, /^WIDGET-01: broken/m);
	assert.match(r.out, /action added in step "I close the widget card": lm\.click/);
	assert.equal(w.spec(), before, 'the rejected repair is undone');
	assert.match(state(w), /WIDGET-01: broken/);
	const issues = w.issues().filter((t) => /\*\*Kind:\*\* broken-scenario/.test(t));
	assert.equal(issues.length, 1, 'one broken-scenario issue');
	assert.match(issues[0], /WIDGET-01/);
	assert.match(issues[0], /behaviour change/);
	assert.equal(w.site(), published, 'the published page is unchanged');
	assert.match(w.report(), /## Broken[\s\S]*WIDGET-01[\s\S]*\.tracker\/living-manual-fixture\/issues\//);
	rmSync(w.root, { recursive: true });
});

// Review finding 2: the guard reads the whole tests/ and scenarios/ trees, not only the files that
// were there before: a file the healer adds (any kind) is a behaviour change and is removed again.
test('a repair that adds a file under tests/ is rejected, and the added file is removed', { timeout: 180_000 }, () => {
	const w = workspace();
	assert.equal(watch(w).status, 0);
	const before = w.spec();
	w.product({ newId: 'add' });
	const healer = fakeHealer(w, `lm.click({ css: '#new' })`, `lm.click({ css: '#add' })`, {
		add: { 'tests/helpers.ts': 'export const extra = 1;\n', 'tests/notes.txt': 'scratch\n' },
	});
	const r = watch(w, [], { LM_CLAUDE: healer });
	assert.equal(r.status, 1, r.out);
	assert.match(r.out, /^WIDGET-01: broken: .*behaviour change.*tests\/helpers\.ts was added/m);
	assert.equal(w.spec(), before, 'the repair is undone');
	assert.equal(existsSync(join(w.folder, 'tests/helpers.ts')), false, 'the added file is removed');
	assert.equal(existsSync(join(w.folder, 'tests/notes.txt')), false, 'an added file of any kind is removed');
	rmSync(w.root, { recursive: true });
});

test('watch stops at the time limit, reports what it did not reach, and leaves those outputs as they were', { timeout: 180_000 }, () => {
	const w = workspace({ extra: 2 });
	assert.equal(watch(w).status, 0);
	const page = w.page();
	writeFileSync(join(w.folder, 'tests/widget.spec.ts'), SPEC(2, 8_000));
	const started = Date.now();
	const r = watch(w, ['--minutes', '0.05']);
	assert.equal(r.status, 4, r.out);
	assert.ok(Date.now() - started < 60_000, 'stopped near the limit, not after every scenario');
	assert.match(r.out, /time limit/);
	assert.match(w.report(), /Not reached[\s\S]*WIDGET-02[\s\S]*WIDGET-03/);
	assert.equal(w.page(), page, 'the page of a scenario stopped at the limit is kept');
	rmSync(w.root, { recursive: true });
});
