#!/usr/bin/env node
// Manual generation (spec: Manual generation). Emits the manual as Markdown pages and assets; a
// publish adapter (lm-publish.mjs) turns them into a site.
//
// Every page has one type, set in the product's page plan (<product folder>/page-plan.json, written
// by the writer session; its `_about` and .claude/skills/lm-generate-manual describe its shape):
// - how, from a scenario's step record (<product folder>/build/runs/<ID>/step-record.json):
//   numbered actions worded with the recorded labels, the action's marked screenshot under each,
//   grouped by screen. Machine-verified. A record whose run did not pass gets no page. A step
//   record the plan does not name still gets a how page (slug "<id>-<title>").
// - how, for a scenario tagged @manual: written from the prose section the plan names (default: the
//   section titled like the scenario). Never run, so marked not machine-verified.
// - why: a section of the feature's prose file. Not machine-verified.
// - reference: a prose section plus, per screen the plan names, a table of the fields the runs
//   used there (from the facts, bin/lib/facts.mjs), each with the writer's description of it.
// Every page states its product version and whether it is machine-verified (front matter
// `productVersion`, `verification`, and a line under the title).
//
// Output (publish.to from the product's config; default, and with --folder: build/manual):
// <slug>.md per page, assets/<ID>/NN.png, and manual.json listing every page in plan order.
// A how page is regenerated only when its sources differ (spec: Repeatable runs): its front matter
// holds `sources:`, a fingerprint of the step record without clock readings and of every
// screenshot's bytes (bin/lib/record.mjs); a page whose fingerprint matches is kept as it is.
// Pages and asset folders that are no longer in the manual are removed.
//
// usage: node living-manual/kit/bin/lm-manual.mjs <product> [--id <ID>]
//        node living-manual/kit/bin/lm-manual.mjs --folder <product folder> [--id <ID>]
// --id limits which how pages are rebuilt; the other pages and manual.json are always rebuilt.
// Exit 0 when every page the plan and the step records ask for was written, 1 when one was not, 2 usage.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { folderFromArgs, productConfig } from './lib/workspace.mjs';
import { sourceFingerprint } from './lib/record.mjs';
import { parseFeature } from './lib/gherkin.mjs';
import { readProse, section } from './lib/prose.mjs';
import { loadFacts } from './lib/facts.mjs';

let folder, rest, product, root;
try { ({ folder, rest, product, root } = folderFromArgs(process.argv.slice(2))); } catch (e) {
	process.stderr.write(`lm-manual: ${e.message}\nusage: lm-manual.mjs <product> | --folder <dir> [--id <ID>]\n`);
	process.exit(2);
}
const only = rest.includes('--id') ? rest[rest.indexOf('--id') + 1] : null;

const runs = join(folder, 'build/runs');
// Where setup recorded the publish location (publish.to, from the workspace root); else build/manual.
const publishTo = product ? productConfig(root, product).publish?.to : null;
const out = publishTo ? join(root, publishTo) : join(folder, 'build/manual');

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
/** A label as the reader sees it in a sentence: no trailing colon. */
const name = (label) => String(label ?? '').replace(/\s*:\s*$/, '');
const bold = (s) => `**${s}**`;
const problems = [];

// ---- What the manual is made from -------------------------------------------------------------

const facts = loadFacts(folder);
const productName = facts.product ?? (product ? productConfig(root, product).name : null) ?? 'the product';
const versionText = (v) => `${productName} ${v ?? '(version unknown)'}`;

/** Every doc scenario by ID, with the feature it belongs to (the .feature file's name). */
const scenarios = new Map();
const featureTitles = new Map();
const scenarioDir = join(folder, 'scenarios');
for (const f of existsSync(scenarioDir) ? readdirSync(scenarioDir).filter((f) => f.endsWith('.feature')).sort() : []) {
	const parsed = parseFeature(readFileSync(join(scenarioDir, f), 'utf8'));
	const feature = basename(f, '.feature');
	featureTitles.set(feature, parsed.feature ?? feature);
	for (const s of parsed.scenarios) if (s.id) scenarios.set(s.id, { ...s, feature, manual: s.tags.includes('@manual') });
}

const planFile = join(folder, 'page-plan.json');
const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : { features: [] };

// The step records the facts know (the runs', else the pack's) whose screenshots are on disk: in
// the run's folder, or in the facts pack's screenshots (a machine without runs, e.g. the writer's).
const records = new Map();
for (const rec of facts.records) {
	const id = rec.scenario?.id;
	if (existsSync(join(runs, id, 'step-record.json')) || existsSync(join(folder, 'facts/screenshots', id))) records.set(id, rec);
}

// ---- How pages from step records --------------------------------------------------------------

/** One action as a sentence, worded with the recorded label. */
function sentence(a) {
	const what = a.labelSource === 'author' ? `the ${a.label}` : bold(name(a.label));
	const example = (v) => `(in this example ${bold(v)})`;
	switch (a.kind) {
		case 'click': return a.labelVisible === false ? `Click ${what} (the marked icon).` : `Click ${what}.`;
		case 'check': return `Tick ${what}.`;
		case 'fill': return `In ${what}, type "${a.value}".`;
		case 'select': return a.dataSpecific ? `In ${what}, choose the one you need ${example(a.value)}.` : `In ${what}, choose ${bold(a.value)}.`;
		case 'verify': return a.dataSpecific ? `Check that the result is shown ${example(name(a.label))}.` : `Check that ${what} is shown.`;
		default: return `${a.kind} ${what}.`;
	}
}

/** True when the page on disk was built from these very sources (and its pictures are there). */
function unchanged(file, id, sources) {
	return existsSync(file) && existsSync(join(out, 'assets', id)) && readFileSync(file, 'utf8').includes(`\nsources: ${sources}\n`);
}

function howPage(entry, rec, runDir, sources) {
	const { scenario: sc, run } = rec;
	const assets = join(out, 'assets', sc.id);
	rmSync(assets, { recursive: true, force: true });
	mkdirSync(assets, { recursive: true });
	const date = run.endedAt.slice(0, 10);
	const product = versionText(rec.productVersion);
	const lines = [
		'---',
		`id: ${sc.id}`,
		`slug: ${entry.slug}`,
		'type: how',
		`title: ${JSON.stringify(sc.title)}`,
		`feature: ${JSON.stringify(entry.feature)}`,
		`scenario: ${sc.id}`,
		`product: ${JSON.stringify(rec.product)}`,
		`productVersion: ${JSON.stringify(rec.productVersion)}`,
		'verification: machine-verified',
		`verifiedAt: ${run.endedAt}`,
		`sources: ${sources}`,
		'---',
		'',
		`# ${sc.title}`,
		'',
		`> ${product} · **Machine-verified**: every step on this page was run against ${product} on ${date}.`,
		'',
	];
	const who = [sc.role && `**Who:** ${sc.role}`, sc.startScreen && `**Starts on:** ${sc.startScreen}`].filter(Boolean).join(' · ');
	if (who) lines.push(who, '');
	let screen;
	let n = 0;
	for (const step of rec.steps) {
		for (const a of step.actions) {
			n++;
			if (a.screen !== screen) {
				screen = a.screen;
				if (screen) lines.push(`## ${screen}`, '');
			}
			const file = `${String(n).padStart(2, '0')}.png`;
			copyFileSync(join(runDir, a.screenshot), join(assets, file));
			const text = sentence(a);
			lines.push(`${n}. ${text}`, '', `   ![${n}. ${text.replace(/\*\*/g, '').replace(/[[\]]/g, '')}](assets/${sc.id}/${file})`, '');
		}
	}
	lines.push('---', '', `Generated from the step record of ${sc.id}, run ${run.startedAt}.`, '');
	writeFileSync(join(out, `${entry.slug}.md`), lines.join('\n'));
	return n;
}

// ---- Pages from prose -------------------------------------------------------------------------

const proseCache = new Map();
function prose(file) {
	if (!proseCache.has(file)) proseCache.set(file, existsSync(join(folder, file)) ? readProse(join(folder, file)) : null);
	return proseCache.get(file);
}

/** Moves the headings of a prose section one level up: its ### become the page's ##. */
const lift = (body) => body.replace(/^###(#*)\s/gm, '##$1 ');

const KIND_WORDS = { fill: 'Type it', select: 'Choose from a list', check: 'Tick it' };

/** The facts table of a reference page: fields the runs used on each screen, with the writer's words. */
function referenceBody(body, screens) {
	// "- **Label**: description" items in the prose describe fields; everything else is kept as it is.
	const described = new Map();
	const keep = [];
	for (const line of body.split('\n')) {
		const m = /^\s*[-*]\s+\*\*(.+?)\*\*\s*[:–—-]\s*(.*)$/.exec(line);
		if (m) described.set(m[1].trim().toLowerCase(), { label: m[1].trim(), text: m[2].trim(), used: false });
		else keep.push(line);
	}
	const lines = [keep.join('\n').trim(), ''];
	const runIds = new Set();
	for (const screen of screens) {
		const fields = facts.fieldsOn(screen);
		lines.push(`## ${screen}`, '');
		if (!fields.length) { lines.push('No run has used a field on this screen yet.', ''); continue; }
		lines.push('| Field | How you fill it in | What it means |', '|---|---|---|');
		for (const f of fields) {
			runIds.add(f.scenario);
			const d = described.get(f.label.toLowerCase());
			if (d) d.used = true;
			const cell = (s) => s.replace(/\|/g, '\\|');
			lines.push(`| **${cell(f.label)}** | ${KIND_WORDS[f.kind] ?? f.kind} | ${cell(d?.text ?? '_Not described yet._')} |`);
		}
		lines.push('');
	}
	const unseen = [...described.values()].filter((d) => !d.used);
	if (unseen.length) {
		lines.push('## Also described', '', 'The writer describes these fields; no run has used them yet, so their names are not checked against the product.', '');
		for (const d of unseen) lines.push(`- **${d.label}**: ${d.text}`);
		lines.push('');
	}
	return { body: lines.join('\n').trim(), runIds: [...runIds] };
}

function prosePage(entry, title, body, banner, extra = {}) {
	const lines = [
		'---',
		...(entry.scenario ? [`id: ${entry.scenario}`] : []),
		`slug: ${entry.slug}`,
		`type: ${entry.type}`,
		`title: ${JSON.stringify(title)}`,
		`feature: ${JSON.stringify(entry.feature)}`,
		...(entry.scenario ? [`scenario: ${entry.scenario}`] : []),
		`prose: ${JSON.stringify(entry.prose)}`,
		`product: ${JSON.stringify(productName)}`,
		`productVersion: ${JSON.stringify(facts.productVersion)}`,
		'verification: not-machine-verified',
		...Object.entries(extra).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
		'---',
		'',
		`# ${title}`,
		'',
		`> ${versionText(facts.productVersion)} · **Not machine-verified**: ${banner}`,
		'',
		lift(body),
		'',
	];
	writeFileSync(join(out, `${entry.slug}.md`), lines.join('\n'));
}

// ---- Build ------------------------------------------------------------------------------------

mkdirSync(out, { recursive: true });
const pages = [];
const planned = new Set();
let written = 0, kept = 0, refused = 0, fromProse = 0;

function buildHow(entry) {
	const rec = records.get(entry.scenario);
	if (!rec) { console.log(`  ${entry.scenario}: no step record; no page`); return; }
	// The run's folder; on a machine without runs (the writer's), the screenshots the facts pack carries.
	const runDir = existsSync(join(runs, entry.scenario, 'step-record.json')) ? join(runs, entry.scenario) : join(folder, 'facts/screenshots', entry.scenario);
	if (rec.run?.status !== 'passed') { console.log(`  ${entry.scenario}: run ${rec.run?.status ?? 'unknown'}; no page written`); refused++; return; }
	const file = join(out, `${entry.slug}.md`);
	const meta = { slug: entry.slug, type: 'how', title: rec.scenario.title, feature: entry.feature, scenario: entry.scenario, verification: 'machine-verified', productVersion: rec.productVersion, verifiedAt: rec.run.endedAt, steps: rec.steps.map((s) => s.text) };
	if (only && entry.scenario !== only) { if (existsSync(file)) pages.push(meta); return; }
	const sources = sourceFingerprint(runDir, rec);
	if (unchanged(file, entry.scenario, sources)) { console.log(`  ${entry.scenario}: unchanged (same step record and screenshots); page kept`); kept++; pages.push(meta); return; }
	const n = howPage(entry, rec, runDir, sources);
	console.log(`  ${entry.scenario}: ${relative(process.cwd(), file)} (${n} actions)`);
	written++;
	pages.push(meta);
}

function buildFromProse(entry) {
	const p = entry.prose && prose(entry.prose);
	if (!p) { problems.push(`${entry.slug}: prose file ${entry.prose ?? '(none named)'} not found`); return; }
	const sc = entry.scenario && scenarios.get(entry.scenario);
	const heading = entry.section ?? sc?.title;
	const body = heading && section(p, heading);
	if (body === null || body === undefined) { problems.push(`${entry.slug}: no section "${heading}" in ${entry.prose}`); return; }
	const meta = { slug: entry.slug, type: entry.type, feature: entry.feature, prose: entry.prose, verification: 'not-machine-verified', productVersion: facts.productVersion };
	if (entry.type === 'how') {
		const banner = 'this task cannot be run automatically, so no step on this page was run against the product. The writer wrote it.';
		prosePage(entry, sc.title, body, banner);
		pages.push({ ...meta, title: sc.title, scenario: entry.scenario, steps: sc.steps.map((s) => s.text) });
	} else if (entry.type === 'reference') {
		const ref = referenceBody(body, entry.screens ?? []);
		const banner = ref.runIds.length
			? `the descriptions are the writer's. The field names in the tables are the ones the product showed in the run of ${ref.runIds.join(', ')}.`
			: "the writer wrote this page; no run has used these fields yet.";
		prosePage(entry, heading, ref.body, banner, ref.runIds.length ? { fieldsFrom: ref.runIds } : {});
		pages.push({ ...meta, title: heading });
	} else {
		prosePage(entry, heading, body, 'the writer wrote this page to explain a concept; it describes no steps to run.');
		pages.push({ ...meta, title: heading });
	}
	fromProse++;
}

const features = [];
for (const f of plan.features ?? []) {
	const feature = { feature: f.feature, title: f.title ?? featureTitles.get(f.feature) ?? f.feature, pages: [] };
	features.push(feature);
	for (const p of f.pages ?? []) {
		if (!['how', 'why', 'reference'].includes(p.type)) { problems.push(`${p.slug ?? '(no slug)'}: type must be how, why or reference, not ${JSON.stringify(p.type)}`); continue; }
		const sc = p.scenario && scenarios.get(p.scenario);
		if (p.scenario && !sc) { problems.push(`${p.slug}: scenario ${p.scenario} is not in scenarios/*.feature`); continue; }
		if (p.scenario && p.type !== 'how') { problems.push(`${p.slug}: a scenario's page is a how page, not ${p.type}`); continue; }
		const entry = { ...p, slug: p.slug ?? slug(`${p.scenario}-${sc?.title ?? p.section}`), feature: f.feature, prose: p.prose ?? f.prose };
		if (p.scenario) planned.add(p.scenario);
		const before = pages.length;
		if (p.scenario && !sc.manual) buildHow(entry); else buildFromProse(entry);
		if (pages.length > before) { pages[pages.length - 1].formerly = p.formerly ?? []; feature.pages.push(entry.slug); }
	}
}
// A step record the plan does not name still gets a how page (its type is not yet decided).
for (const [id, rec] of records) {
	if (planned.has(id)) continue;
	const featureName = scenarios.get(id)?.feature ?? 'other';
	let feature = features.find((f) => f.feature === featureName);
	if (!feature) features.push((feature = { feature: featureName, title: featureTitles.get(featureName) ?? 'Other tasks', pages: [] }));
	const before = pages.length;
	buildHow({ scenario: id, slug: `${slug(id)}-${slug(rec.scenario.title)}`, feature: featureName });
	if (pages.length > before) { pages[pages.length - 1].formerly = []; pages[pages.length - 1].unplanned = true; feature.pages.push(pages[pages.length - 1].slug); }
}

// Remove what is no longer in the manual.
const keep = new Set(pages.map((p) => `${p.slug}.md`));
for (const f of readdirSync(out)) if (f.endsWith('.md') && !keep.has(f)) rmSync(join(out, f));
const keepAssets = new Set(pages.filter((p) => p.verification === 'machine-verified').map((p) => p.scenario));
if (existsSync(join(out, 'assets'))) for (const d of readdirSync(join(out, 'assets'))) if (!keepAssets.has(d)) rmSync(join(out, 'assets', d), { recursive: true, force: true });

writeFileSync(join(out, 'manual.json'), JSON.stringify({
	kind: 'living-manual/manual', version: 1, product: productName, productVersion: facts.productVersion,
	features: features.filter((f) => f.pages.length), pages,
}, null, '\t') + '\n');

for (const p of problems) console.log(`  ${p}`);
console.log(`manual: ${written} how page(s) written to ${relative(process.cwd(), out) || out}${kept ? `, ${kept} unchanged` : ''}${refused ? `, ${refused} refused` : ''}; ${fromProse} page(s) from prose${problems.length ? `; ${problems.length} problem(s)` : ''}`);
process.exit(refused || problems.length ? 1 : 0);
