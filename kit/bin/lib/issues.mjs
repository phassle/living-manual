// Batched issues (spec: Issues). Files what the kit found into the tracker the workspace already
// uses, read from the files setup-matt-pocock-skills wrote (config context.from, default
// docs/agents/): issue-tracker.md names the tracker and where an issue file goes,
// triage-labels.md how this workspace spells needs-triage. Each issue carries the kit's label
// `living-manual` and that needs-triage label. One issue per kind per feature per run, listing its
// items; an item already listed in an open issue is filed again in none.
//
// Only a local-markdown tracker is supported; any other refuses with a message naming it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { productConfig, workspaceRoot } from './workspace.mjs';

export const LABEL = 'living-manual';

/** The kinds of issue the kit files: kind → title words and what the team is asked to do. */
export const KINDS = {
	'broken-scenario': { title: 'Broken scenarios', ask: 'These doc scenarios no longer do what the product does. A person decides whether the change is intended; the writer then confirms the scenario again or the product is fixed.' },
	'missing-case': { title: 'Missing cases', ask: 'These cases from the case inventory have no doc scenario yet, so the manual does not cover them.' },
	'missing-test-ids': { title: 'Missing test IDs', ask: 'The doc scenarios found these elements by their visible text or by CSS, not by a test ID, so they break when the wording or the language changes. Add a test ID to each element (the one listed as tried is picked up with no change to the scenarios).' },
	'product-bug': { title: 'Product bugs', ask: 'The writer decided the documentation is right and the product is wrong in each of these. The scenario is marked broken until the product is fixed.' },
	'guide-questions': { title: 'Unanswered guide questions', ask: 'Users asked the guide these questions and it had no tested answer. Each is a gap in the manual.' },
};

const CLOSED = ['wontfix', 'resolved', 'closed', 'done'];
const backticked = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
export const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The tracker for a product: { dir, status, labels, comments } read from the workspace's
 * tracker files. `dir` is the folder issue files go in; `status` the status line's prefix;
 * `labels` [kit label, needs-triage spelled as this workspace spells it].
 */
export function tracker(root, product) {
	const section = productConfig(root, product);
	const from = join(root, section.context?.from ?? 'docs/agents/');
	const trackerFile = join(from, 'issue-tracker.md');
	if (!existsSync(trackerFile)) throw new Error(`no issue tracker configuration at ${trackerFile}: run setup-matt-pocock-skills, then lm-setup`);
	const text = readFileSync(trackerFile, 'utf8');
	const kind = /^#\s*Issue tracker:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? 'unknown';
	if (!/local markdown/i.test(kind)) throw new Error(`the workspace's issue tracker is "${kind}"; the kit files issues only into a local-markdown tracker so far`);
	const ticks = backticked(text);
	const pattern = ticks.find((t) => /<feature-slug>/.test(t) && /\/issues\//.test(t)) ?? section.context?.tracker;
	if (!pattern) throw new Error(`${trackerFile} names no issue folder (a path with <feature-slug> and /issues/)`);
	const slug = section.issues?.featureSlug ?? `living-manual-${product}`;
	const dir = join(root, pattern.slice(0, pattern.indexOf('/issues/') + 8).replace('<feature-slug>', slug));
	const status = ticks.find((t) => /^\*\*Status:\*\*$/.test(t)) ?? '**Status:**';
	const comments = ticks.find((t) => /^##\s+Comments$/.test(t)) ?? '## Comments';
	const labelsFile = join(from, 'triage-labels.md');
	let needsTriage = 'needs-triage';
	if (existsSync(labelsFile)) {
		const row = readFileSync(labelsFile, 'utf8').split('\n').find((l) => /^\|\s*`?needs-triage`?\s*\|/.test(l));
		const cell = row?.split('|')[2]?.trim().replace(/`/g, '');
		if (cell) needsTriage = cell;
	}
	return { dir, status, comments, labels: [LABEL, needsTriage] };
}

const ITEM = /<!-- lm-item: (.+?) -->/g;
const field = (text, name) => new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.*)$`, 'm').exec(text)?.[1]?.trim() ?? null;

/** The kit's open issues in the tracker folder: { file, kind, feature, run, keys }. */
export function openIssues(t) {
	if (!existsSync(t.dir)) return [];
	return readdirSync(t.dir).filter((f) => f.endsWith('.md')).sort().flatMap((file) => {
		const text = readFileSync(join(t.dir, file), 'utf8');
		const labels = (field(text, 'Labels') ?? '').split(',').map((s) => s.trim());
		const status = (field(text, 'Status') ?? '').toLowerCase();
		if (!labels.includes(LABEL) || CLOSED.includes(status)) return [];
		return [{ file, kind: field(text, 'Kind'), feature: field(text, 'Feature'), run: field(text, 'Run'), keys: [...text.matchAll(ITEM)].map((m) => m[1]) }];
	});
}

const asItem = (i) => (typeof i === 'string' ? { key: i, text: i } : { key: String(i.key ?? i.text), text: String(i.text ?? i.key) });
const itemLine = (i) => `- ${i.text} <!-- lm-item: ${i.key.replace(/-->/g, '- ->')} -->`;

/**
 * Files `items` (strings, or { key, text }) of one kind for one feature into the product's
 * tracker. An item whose key an open kit issue already lists is skipped. Items of the same kind
 * and feature from the same run are added to that run's issue; otherwise a new issue file is
 * written. Returns { file (null when nothing new), filed, skipped, listedIn (the open issue that
 * already lists the first skipped item), added (true when joined to this run's issue) }.
 *
 * opts: { product (required), root (workspace root; default: found upwards from cwd),
 *         run (the run the items come from; default: the facts pack's newest run, else now),
 *         productName, productVersion }
 */
export function fileIssue(kind, feature, items, opts = {}) {
	if (!KINDS[kind]) throw new Error(`unknown issue kind "${kind}" (one of ${Object.keys(KINDS).join(', ')})`);
	const { product } = opts;
	if (!product) throw new Error('fileIssue needs opts.product');
	const root = opts.root ?? workspaceRoot();
	const t = tracker(root, product);
	const run = opts.run ?? defaultRun(root, product);
	const open = openIssues(t);
	const listed = new Set(open.flatMap((i) => i.keys));
	const seen = new Set();
	const filed = [];
	const skipped = [];
	for (const item of items.map(asItem)) {
		if (listed.has(item.key) || seen.has(item.key)) { skipped.push(item); continue; }
		seen.add(item.key);
		filed.push(item);
	}
	const holder = skipped.length ? open.find((i) => i.keys.includes(skipped[0].key)) : null;
	const listedIn = holder ? join(t.dir, holder.file) : null;
	if (!filed.length) return { file: null, filed, skipped, listedIn };
	mkdirSync(t.dir, { recursive: true });
	const same = open.find((i) => i.kind === kind && i.feature === feature && i.run === run);
	if (same) {
		const path = join(t.dir, same.file);
		const text = readFileSync(path, 'utf8');
		const at = text.indexOf(`\n${t.comments}`);
		const lines = filed.map(itemLine).join('\n');
		writeFileSync(path, at < 0 ? `${text.trimEnd()}\n${lines}\n` : `${text.slice(0, at).trimEnd()}\n${lines}\n${text.slice(at)}`);
		return { file: path, filed, skipped, listedIn, added: true };
	}
	const numbers = readdirSync(t.dir).map((f) => /^(\d+)-/.exec(f)?.[1]).filter(Boolean).map(Number);
	const nn = String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(2, '0');
	const name = `${nn}-${slugify(`${kind} ${feature}`)}.md`;
	const section = productConfig(root, product);
	const body = [
		`# ${KINDS[kind].title}: ${feature}`,
		'',
		`${t.status} ${t.labels[1]}`,
		`**Labels:** ${t.labels.join(', ')}`,
		`**Kind:** ${kind}`,
		`**Feature:** ${feature}`,
		`**Product:** ${opts.productName ?? section.name ?? product}${opts.productVersion ? ` ${opts.productVersion}` : ''}`,
		`**Run:** ${run}`,
		'',
		`Filed by the Living Manual kit (living-manual/kit/bin/lm-issues.mjs). ${KINDS[kind].ask}`,
		'',
		'## Items',
		'',
		...filed.map(itemLine),
		'',
		t.comments,
		'',
	].join('\n');
	writeFileSync(join(t.dir, name), body);
	return { file: join(t.dir, name), filed, skipped, listedIn, added: false };
}

/** The run the product's latest facts pack comes from, else now. */
export function defaultRun(root, product) {
	const pack = join(root, 'living-manual/products', product, 'facts/pack.json');
	if (existsSync(pack)) {
		const p = JSON.parse(readFileSync(pack, 'utf8'));
		if (p.newestRunAt) return p.newestRunAt;
	}
	return new Date().toISOString();
}
