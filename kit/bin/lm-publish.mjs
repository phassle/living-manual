#!/usr/bin/env node
// Publishing (spec: Manual generation; Confirmation). Turns the Markdown manual lm-manual wrote
// into two sites through the product's publish adapter:
// - the site: only the pages isPublishable allows (bin/lib/publishable.mjs; drafts never), and
//   for a broken scenario (its confirmation lapsed, or its run fails) the page as it was last
//   published: every published scenario page is kept in <product folder>/build/published/<slug>/
//   (entry.json with the Markdown, assets/) and used while the scenario is broken;
// - the preview: every page, drafts marked, for the writer to judge.
// The adapter is per product (config publish.adapter, default "static-site"), a folder
// living-manual/kit/adapters/<name>/ whose build.mjs exports build(options); see that file.
//
// Paths from the product's config section (from the workspace root): publish.to (the Markdown
// manual), publish.site, publish.preview. Defaults, and with --folder: <product folder>/build/
// manual, build/site, build/preview.
//
// usage: node living-manual/kit/bin/lm-publish.mjs <product>
//        node living-manual/kit/bin/lm-publish.mjs --folder <product folder>
// Exit 0 built, 1 no manual to publish (run lm-manual first), 2 usage or unknown adapter.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { folderFromArgs, productConfig } from './lib/workspace.mjs';
import { isPublishable } from './lib/publishable.mjs';
import { scenarioState } from './lib/confirmation.mjs';

let folder, product, root;
try { ({ folder, product, root } = folderFromArgs(process.argv.slice(2))); } catch (e) {
	process.stderr.write(`lm-publish: ${e.message}\nusage: lm-publish.mjs <product> | --folder <dir>\n`);
	process.exit(2);
}
const publish = product ? productConfig(root, product).publish ?? {} : {};
const at = (key, fallback) => (publish[key] ? join(root, publish[key]) : join(folder, fallback));
const manualDir = at('to', 'build/manual');
const adapterName = publish.adapter ?? 'static-site';
const adapterFile = join(dirname(fileURLToPath(import.meta.url)), '../adapters', adapterName, 'build.mjs');
if (!/^[\w-]+$/.test(adapterName) || !existsSync(adapterFile)) {
	process.stderr.write(`lm-publish: no publish adapter "${adapterName}" (looked for ${adapterFile})\n`);
	process.exit(2);
}
const indexFile = join(manualDir, 'manual.json');
if (!existsSync(indexFile)) { console.log(`publish: no manual in ${relative(process.cwd(), manualDir) || manualDir}; run lm-manual first`); process.exit(1); }

const manual = JSON.parse(readFileSync(indexFile, 'utf8'));
const pages = manual.pages.map((p) => ({ ...p, draft: !isPublishable(folder, p), markdown: readFileSync(join(manualDir, `${p.slug}.md`), 'utf8') }));
const { build } = await import(pathToFileURL(adapterFile).href);

// The last published version of each scenario page.
const publishedDir = join(folder, 'build/published');
const lastPublished = (slug) => {
	const file = join(publishedDir, slug, 'entry.json');
	return existsSync(file) ? { ...JSON.parse(readFileSync(file, 'utf8')), assetsDir: join(publishedDir, slug, 'assets'), draft: false } : null;
};
const sitePages = [];
for (const p of pages) {
	if (!p.draft) { sitePages.push(p); continue; }
	if (!p.scenario) continue;
	const state = scenarioState(folder, p.scenario);
	const last = state.status === 'broken' ? lastPublished(p.slug) : null;
	if (state.status === 'draft') rmSync(join(publishedDir, p.slug), { recursive: true, force: true });
	if (last) {
		sitePages.push(last);
		console.log(`${p.scenario}: broken (${state.reason}); its last published page is kept`);
	}
}

// A broken scenario whose run no longer passes has no page in the manual at all (lm-manual writes
// none); its last published page stays on the site all the same, in its feature.
const planFile = join(folder, 'page-plan.json');
const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : { features: [] };
const siteFeatures = manual.features.map((f) => ({ ...f, pages: [...f.pages] }));
const inManual = new Set(pages.map((p) => p.slug));
for (const slug of existsSync(publishedDir) ? readdirSync(publishedDir).sort() : []) {
	if (inManual.has(slug)) continue;
	const last = lastPublished(slug);
	if (!last?.scenario) continue;
	const state = scenarioState(folder, last.scenario);
	if (state.status === 'draft') { rmSync(join(publishedDir, slug), { recursive: true, force: true }); continue; }
	if (state.status !== 'broken') continue;
	sitePages.push(last);
	let f = siteFeatures.find((x) => x.feature === last.feature);
	if (!f) siteFeatures.push((f = { feature: last.feature, title: last.featureTitle ?? last.feature, pages: [] }));
	// At its place in the page plan: after the nearest page before it that the manual has.
	const order = (plan.features ?? []).find((x) => x.feature === last.feature)?.pages?.map((x) => x.slug) ?? [];
	const before = order.slice(0, Math.max(0, order.indexOf(slug))).reverse().find((s) => f.pages.includes(s));
	if (!f.pages.includes(slug)) f.pages.splice(before ? f.pages.indexOf(before) + 1 : (order.includes(slug) ? 0 : f.pages.length), 0, slug);
	console.log(`${last.scenario}: broken (${state.reason}); its last published page is kept`);
}

for (const [mode, dir] of [['site', at('site', 'build/site')], ['preview', at('preview', 'build/preview')]]) {
	const shown = mode === 'site' ? sitePages : pages;
	const keep = new Set(shown.map((p) => p.slug));
	const features = (mode === 'site' ? siteFeatures : manual.features).map((f) => ({ ...f, pages: f.pages.filter((s) => keep.has(s)) }));
	await build({ mode, manualDir, outDir: dir, product: manual.product, searchExample: publish.searchExample, productVersion: manual.productVersion, features, pages: shown });
	const drafts = shown.filter((p) => p.draft).length;
	console.log(`${mode}: ${shown.length} page(s)${mode === 'preview' ? `, ${drafts} draft(s)` : ''} → ${relative(process.cwd(), join(dir, 'index.html')) || dir}`);
}

// Keep what was just published from a confirmed scenario, for when it breaks.
for (const p of sitePages.filter((x) => x.scenario && !x.assetsDir)) {
	const dir = join(publishedDir, p.slug);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const { draft, ...entry } = p;
	const featureTitle = manual.features.find((f) => f.feature === p.feature)?.title ?? p.feature;
	writeFileSync(join(dir, 'entry.json'), `${JSON.stringify({ ...entry, featureTitle, publishedAt: new Date().toISOString() }, null, '\t')}\n`);
	const assets = join(manualDir, 'assets', p.scenario);
	if (existsSync(assets)) cpSync(assets, join(dir, 'assets'), { recursive: true });
}
