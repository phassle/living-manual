#!/usr/bin/env node
// Files batched issues into the workspace's tracker (spec: Issues; bin/lib/issues.mjs).
//
// usage:
//   node living-manual/kit/bin/lm-issues.mjs <product> file <kind> <feature> --items <json|-> [--run <id>]
//       items: a JSON array of strings or { key, text }; `-` reads it from stdin
//   node living-manual/kit/bin/lm-issues.mjs <product> after-run
//       from the facts pack: broken scenarios, missing cases, missing test IDs (language-bound
//       actions), and unanswered guide questions (build/guide/unanswered.jsonl); lm-run calls it
// kinds: broken-scenario, missing-case, missing-test-ids, product-bug, guide-questions
// One line per issue: `issues: filed <file> (N item(s))`, `issues: added N item(s) to <file>`,
// `issues: <kind> <feature>: nothing new (N already in an open issue)`.
// Exit 0 done, 2 usage, 1 the tracker refused (message names why).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileIssue } from './lib/issues.mjs';
import { afterRunItems } from './lib/issue-items.mjs';
import { workspaceRoot } from './lib/workspace.mjs';

const [product, command, ...rest] = process.argv.slice(2);
const usage = () => { process.stderr.write('usage: lm-issues.mjs <product> file <kind> <feature> --items <json|-> [--run <id>] | <product> after-run\n'); process.exit(2); };
if (!product || product.startsWith('-') || !command) usage();
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };

function report(kind, feature, r) {
	if (!r.file) console.log(`issues: ${kind} ${feature}: nothing new (${r.skipped.length} already in an open issue)`);
	else if (r.added) console.log(`issues: added ${r.filed.length} item(s) to ${basename(r.file)}${r.skipped.length ? ` (${r.skipped.length} already in an open issue)` : ''}`);
	else console.log(`issues: filed ${basename(r.file)} (${r.filed.length} item(s))${r.skipped.length ? ` (${r.skipped.length} already in an open issue)` : ''}`);
}

try {
	const root = workspaceRoot();
	if (command === 'file') {
		const run = opt('--run');
		const raw = opt('--items');
		const [kind, feature] = rest;
		if (!kind || !feature || raw === undefined) usage();
		const items = JSON.parse(raw === '-' ? readFileSync(0, 'utf8') : raw);
		report(kind, feature, fileIssue(kind, feature, items, { product, root, run }));
	} else if (command === 'after-run') {
		const { run, productVersion, groups } = afterRunItems(root, product);
		if (!groups.length) console.log('issues: nothing to file');
		for (const g of groups) report(g.kind, g.feature, fileIssue(g.kind, g.feature, g.items, { product, root, run, productVersion }));
	} else usage();
} catch (e) {
	console.log(`issues refused: ${e.message}`);
	process.exit(1);
}
