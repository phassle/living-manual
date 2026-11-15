#!/usr/bin/env node
// Guide build (spec: Guide). Reads every step record (the facts pack's, overlaid by build/runs/<ID>/;
// bin/lib/facts.mjs allRecords) and
// writes <product folder>/build/guide/guide-index.json (per scenario: ID, title, role, start
// screen and its route, and each action's step text, wording, locator chain, label and
// data-specific flag) and build/guide/lm-guide.js, the one script the product loads with the
// line this command prints. Only confirmed scenarios whose run passed go in (bin/lib/guide-index.mjs
// `confirmation`); --include-drafts adds drafts, marked confirmed: false, for a demonstration.
// The route keys that name a screen come from the product's config, guide.routeKeys.
//
// usage: node living-manual/kit/bin/lm-build-guide.mjs <product> [--include-drafts]
//        node living-manual/kit/bin/lm-build-guide.mjs --folder <product folder> [--include-drafts]
// Exit 0 written (also with no scenario in it), 2 usage or unreadable record.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { folderFromArgs, productConfig } from './lib/workspace.mjs';
import { allRecords } from './lib/facts.mjs';
import { confirmation, indexEntry } from './lib/guide-index.mjs';
import { scenarioState } from './lib/confirmation.mjs';

export const SCRIPT_PATH = '/lm-guide/lm-guide.js';
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../guide/lm-guide.js');

let folder, rest, product, root;
try { ({ folder, rest, product, root } = folderFromArgs(process.argv.slice(2))); } catch (e) {
	process.stderr.write(`lm-build-guide: ${e.message}\nusage: lm-build-guide.mjs <product> | --folder <dir> [--include-drafts]\n`);
	process.exit(2);
}
const includeDrafts = rest.includes('--include-drafts');
const routeKeys = product ? productConfig(root, product).guide?.routeKeys : undefined;

let records;
try { records = allRecords(folder); } catch (e) { process.stderr.write(`lm-build-guide: cannot read the step records: ${e.message}\n`); process.exit(2); }
const isConfirmed = confirmation(folder);
const scenarios = [];
for (const rec of records) {
	const id = rec.scenario?.id;
	if (rec.run?.status !== 'passed') { console.log(`${id}: run ${rec.run?.status ?? 'unknown'}, left out`); continue; }
	const confirmed = isConfirmed(id);
	if (!confirmed && !includeDrafts) { const st = scenarioState(folder, id); console.log(`${id}: ${st.status} (${st.reason}), left out (--include-drafts adds it)`); continue; }
	try { scenarios.push(indexEntry(rec, confirmed, routeKeys)); } catch (e) { process.stderr.write(`lm-build-guide: ${id}: ${e.message}\n`); process.exit(2); }
	console.log(`${id}: ${confirmed ? 'confirmed' : 'draft (included on request)'}, ${scenarios.at(-1).actions.length} actions`);
}

const out = join(folder, 'build/guide');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'guide-index.json'), `${JSON.stringify({
	kind: 'living-manual/guide-index',
	version: 1,
	routeKeys: routeKeys ?? null,
	scenarios,
}, null, '\t')}\n`);
copyFileSync(SCRIPT, join(out, 'lm-guide.js'));
console.log(`guide: ${scenarios.length} scenario(s) in ${relative(process.cwd(), out) || out}/guide-index.json`);
console.log(`load it with one line (the product fills in the signed-in user's role): <script>window.livingManualGuide = { role: "<role>" }</script><script src="${SCRIPT_PATH}" defer></script>`);
