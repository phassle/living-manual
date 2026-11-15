// The publish adapter (spec: Manual generation; Confirmation): the Markdown manual becomes a site
// with search and stable page URLs. Only publishable pages reach the site; every page, drafts
// marked, reaches the preview. Tested on a fixture product: lm-manual, then lm-publish, then we
// read the HTML and the search index on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bin, manualProduct, PLAN, PROSE, FEATURE, RECORD } from './manual-fixture.mjs';

const run = (cli, folder) => spawnSync(process.execPath, [bin(cli), '--folder', folder], { encoding: 'utf8' });
function built(opts) {
	const p = manualProduct(opts);
	const m = run('lm-manual.mjs', p.folder);
	assert.equal(m.status, 0, m.stdout + m.stderr);
	const r = run('lm-publish.mjs', p.folder);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const html = (where, slug) => readFileSync(join(p.folder, 'build', where, `${slug}.html`), 'utf8');
	return { ...p, r, html, has: (where, file) => existsSync(join(p.folder, 'build', where, file)) };
}

test('only publishable pages reach the site; the preview has every page, drafts marked', () => {
	const b = built({ confirmed: ['WIDGET-01'] });
	assert.ok(b.has('site', 'register-a-widget.html'), 'confirmed scenario');
	assert.ok(b.has('site', 'what-a-widget-is.html'), 'confirmed prose');
	assert.ok(!b.has('site', 'print-a-widget-label.html'), 'WIDGET-09 is a draft');
	assert.doesNotMatch(b.html('site', 'index'), /print-a-widget-label/);
	assert.doesNotMatch(readFileSync(join(b.folder, 'build/site/search-index.js'), 'utf8'), /Print a widget label/);
	assert.ok(b.has('preview', 'print-a-widget-label.html'));
	assert.match(b.html('preview', 'print-a-widget-label'), /Draft/);
	assert.doesNotMatch(b.html('preview', 'register-a-widget'), /class="draft-ribbon"/);
	assert.match(b.r.stdout, /site: 3 page\(s\)/);
	assert.match(b.r.stdout, /preview: 4 page\(s\), 1 draft/);
	rmSync(b.root, { recursive: true });
});

test('nothing confirmed: the site has no pages, and says so', () => {
	const b = built({ prose: PROSE.replace('status: confirmed', 'status: draft') });
	for (const p of PLAN.features[0].pages) assert.ok(!b.has('site', `${p.slug}.html`), p.slug);
	assert.match(b.html('site', 'index'), /Nothing is published yet/);
	rmSync(b.root, { recursive: true });
});

test('a page lives at its plan slug, and a former slug redirects to it', () => {
	const plan = structuredClone(PLAN);
	plan.features[0].pages[0].formerly = ['about-widgets'];
	const b = built({ plan, confirmed: ['WIDGET-01'] });
	const page = b.html('site', 'what-a-widget-is');
	assert.match(page, /<h1[^>]*>What a widget is<\/h1>/);
	const redirect = b.html('site', 'about-widgets');
	assert.match(redirect, /<meta http-equiv="refresh" content="0; url=what-a-widget-is\.html">/);
	rmSync(b.root, { recursive: true });
});

test('a how page shows its steps and screenshots, its version and that it is machine-verified', () => {
	const b = built({ confirmed: ['WIDGET-01'] });
	const page = b.html('site', 'register-a-widget');
	assert.match(page, /<ol[^>]*>[\s\S]*Click <strong>New widget<\/strong>\./);
	assert.match(page, /<img[^>]+src="assets\/WIDGET-01\/01\.png"/);
	assert.ok(b.has('site', 'assets/WIDGET-01/01.png'));
	assert.match(page, /class="badge verified"[^>]*>[^<]*Machine-verified/);
	assert.match(page, /Fixture 9\.9\.9/);
	const why = b.html('site', 'what-a-widget-is');
	assert.match(why, /class="badge unverified"[^>]*>[^<]*Not machine-verified/);
	assert.match(why, /Fixture 9\.9\.9/);
	rmSync(b.root, { recursive: true });
});

test('the search index holds each published page with its title, type and words', () => {
	const b = built({ confirmed: ['WIDGET-01'] });
	const js = readFileSync(join(b.folder, 'build/site/search-index.js'), 'utf8');
	const index = JSON.parse(js.slice(js.indexOf('=') + 1).replace(/;\s*$/, ''));
	const how = index.find((p) => p.url === 'register-a-widget.html');
	assert.equal(how.title, 'Register a new widget');
	assert.equal(how.type, 'how');
	assert.match(how.text, /I start a new widget/, 'the scenario\'s step texts are searchable');
	assert.match(index.find((p) => p.url === 'what-a-widget-is.html').text, /keeps gears in place/);
	assert.ok(b.has('site', 'search.html'));
	rmSync(b.root, { recursive: true });
});

test('run by product name, the site and preview go where the config says', () => {
	const config = { name: 'Fixture', publish: { to: 'out/manual', site: 'out/site', preview: 'out/preview', adapter: 'static-site' } };
	const p = manualProduct({ config, confirmed: ['WIDGET-01'] });
	const opts = { cwd: p.root, encoding: 'utf8' };
	assert.equal(spawnSync(process.execPath, [bin('lm-manual.mjs'), 'fixture'], opts).status, 0);
	const r = spawnSync(process.execPath, [bin('lm-publish.mjs'), 'fixture'], opts);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.ok(existsSync(join(p.root, 'out/site/register-a-widget.html')));
	assert.ok(existsSync(join(p.root, 'out/preview/print-a-widget-label.html')));
	writeFileSync(join(p.root, 'living-manual/living-manual.config.json'), JSON.stringify({ products: { fixture: { ...config, publish: { ...config.publish, adapter: 'nope' } } } }));
	const bad = spawnSync(process.execPath, [bin('lm-publish.mjs'), 'fixture'], opts);
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /no publish adapter "nope"/);
	rmSync(p.root, { recursive: true });
});

test('the home page\'s search example comes from the config (publish.searchExample); without one there is none', () => {
	const config = { name: 'Fixture', publish: { to: 'out/manual', site: 'out/site', preview: 'out/preview', searchExample: 'register a widget' } };
	const p = manualProduct({ config, confirmed: ['WIDGET-01'] });
	const opts = { cwd: p.root, encoding: 'utf8' };
	assert.equal(spawnSync(process.execPath, [bin('lm-manual.mjs'), 'fixture'], opts).status, 0);
	assert.equal(spawnSync(process.execPath, [bin('lm-publish.mjs'), 'fixture'], opts).status, 0);
	assert.match(readFileSync(join(p.root, 'out/site/index.html'), 'utf8'), /placeholder="What do you want to do\? For example: register a widget"/);
	rmSync(p.root, { recursive: true });
	const b = built({ confirmed: ['WIDGET-01'] });
	assert.match(b.html('site', 'index'), /placeholder="What do you want to do\?"/);
	rmSync(b.root, { recursive: true });
});

test('a lapsed scenario keeps its last published page; the preview shows the new one as a draft', () => {
	const b = built({ confirmed: ['WIDGET-01'] });
	assert.match(b.html('site', 'register-a-widget'), /Click <strong>New widget<\/strong>/);
	// The scenario text changes (the confirmation lapses) and the product renames the button.
	writeFileSync(join(b.folder, 'scenarios/widget.feature'), FEATURE.replace('When I start a new widget', 'When I add a widget'));
	const record = structuredClone(RECORD);
	record.steps[0].actions[0].label = 'Add widget';
	writeFileSync(join(b.folder, 'build/runs/WIDGET-01/step-record.json'), JSON.stringify(record));
	assert.equal(run('lm-manual.mjs', b.folder).status, 0);
	const r = run('lm-publish.mjs', b.folder);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const site = b.html('site', 'register-a-widget');
	assert.match(site, /Click <strong>New widget<\/strong>/, 'the last published page, unchanged');
	assert.doesNotMatch(site, /Add widget|draft-ribbon/);
	assert.ok(b.has('site', 'assets/WIDGET-01/01.png'), 'with its screenshots');
	assert.match(b.html('site', 'index'), /register-a-widget/);
	const preview = b.html('preview', 'register-a-widget');
	assert.match(preview, /Click <strong>Add widget<\/strong>/);
	assert.match(preview, /class="draft-ribbon"/);
	assert.match(r.stdout, /WIDGET-01: broken .*; its last published page is kept/);

	// Confirmed again: the new page is published.
	const c = spawnSync(process.execPath, [bin('lm-confirm.mjs'), '--folder', b.folder, 'confirm', 'WIDGET-01', '--by', 'Wendy'], { encoding: 'utf8' });
	assert.equal(c.status, 0, c.stdout + c.stderr);
	assert.equal(run('lm-publish.mjs', b.folder).status, 0);
	assert.match(b.html('site', 'register-a-widget'), /Click <strong>Add widget<\/strong>/);
	rmSync(b.root, { recursive: true });
});

test('a lapsed scenario that was never published stays out of the site', () => {
	const p = manualProduct({ confirmed: ['WIDGET-01'] });
	writeFileSync(join(p.folder, 'scenarios/widget.feature'), FEATURE.replace('When I start a new widget', 'When I add a widget'));
	assert.equal(run('lm-manual.mjs', p.folder).status, 0);
	assert.equal(run('lm-publish.mjs', p.folder).status, 0);
	assert.ok(!existsSync(join(p.folder, 'build/site/register-a-widget.html')));
	assert.ok(existsSync(join(p.folder, 'build/preview/register-a-widget.html')));
	rmSync(p.root, { recursive: true });
});

test('a confirmed scenario whose run now fails keeps its last published page', () => {
	const b = built({ confirmed: ['WIDGET-01'] });
	// The page itself; the site's top bar names the product version the site was built for.
	const article = (html) => /<article[\s\S]*<\/article>/.exec(html)?.[0];
	const before = article(b.html('site', 'register-a-widget'));
	assert.ok(before);
	// The product changed its flow: the run fails, so lm-manual writes no page for it (exit 1).
	const record = structuredClone(RECORD);
	record.run.status = 'failed';
	writeFileSync(join(b.folder, 'build/runs/WIDGET-01/step-record.json'), JSON.stringify(record));
	assert.equal(run('lm-manual.mjs', b.folder).status, 1);
	const r = run('lm-publish.mjs', b.folder);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(article(b.html('site', 'register-a-widget')), before, 'the last published page, unchanged');
	assert.ok(b.has('site', 'assets/WIDGET-01/01.png'), 'with its screenshots');
	assert.match(b.html('site', 'index'), /register-a-widget/);
	assert.match(r.stdout, /WIDGET-01: broken .*; its last published page is kept/);
	rmSync(b.root, { recursive: true });
});

// Review finding 6: only http, https, mailto, relative and #fragment links reach the page; any
// other scheme (javascript:, a doubled javascript:javascript:, data:, vbscript:) is neutralised.
test('a link or image with a script or data scheme is neutralised on the published page', () => {
	const links = [
		'[a](javascript:javascript:alert(1))', '[b](JavaScript:alert(2))', '[c](data:text/html;base64,PHNjcmlwdD4=)',
		'[d](vbscript:msgbox)', '![e](javascript:alert(3))', '[f](java&#09;script:alert(4))',
		'[ok1](https://example.com/x)', '[ok2](mailto:help@example.com)', '[ok3](other-page.html#part)', '[ok4](#fields)',
	].join(' ');
	const prose = PROSE.replace('Widgets wear out after ten years.', `Widgets wear out after ten years. ${links}`);
	const b = built({ prose, confirmed: ['WIDGET-01'] });
	const page = b.html('site', 'what-a-widget-is');
	const urls = [...page.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
	for (const u of urls) assert.doesNotMatch(u, /^\s*(javascript|data|vbscript):/i, `unsafe url on the page: ${u}`);
	assert.doesNotMatch(page, /href="[^"]*script:/i);
	for (const ok of ['https://example.com/x', 'mailto:help@example.com', 'other-page.html#part', '#fields']) assert.ok(urls.includes(ok), `kept: ${ok}`);
	rmSync(b.root, { recursive: true });
});
