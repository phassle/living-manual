#!/usr/bin/env node
// Writes the facts pack (spec: Facts pack) after a run: <product folder>/facts/pack.json,
// facts/pack.md, facts/step-records/<ID>.json and facts/screenshots/<ID>/ (the run's screenshots),
// all versioned. First it records every confirmed
// scenario the run found broken (its confirmation lapsed, or it no longer passes) in
// confirmation.json, so it stays broken until the writer confirms it again.
// The codebase glossaries come from the glossary map the product's config names
// (context.glossary, from the workspace root; default GLOSSARY-MAP.md); the documentation
// glossary is GLOSSARY.md in the product folder.
//
// usage: node living-manual/kit/bin/lm-facts.mjs <product>   (or --folder <product folder>)
// Exit 0 written, 2 usage. Last line: `facts: N scenario(s), M step record(s), … → <pack.json>`.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { folderFromArgs, workspaceRoot, CONFIG } from './lib/workspace.mjs';
import { buildPack, packMarkdown } from './lib/facts-pack.mjs';
import { recordBreaks, scenarioState } from './lib/confirmation.mjs';

let folder, product, root;
try { ({ folder, product, root } = folderFromArgs(process.argv.slice(2))); } catch (e) {
	process.stderr.write(`lm-facts: ${e.message}\nusage: lm-facts.mjs <product> | --folder <dir>\n`);
	process.exit(2);
}
if (!root) { try { root = workspaceRoot(folder); } catch { root = null; } }
let glossaryMap = null;
if (root) {
	const section = existsSync(join(root, CONFIG)) ? JSON.parse(readFileSync(join(root, CONFIG), 'utf8')).products?.[product ?? basename(folder)] : null;
	glossaryMap = join(root, section?.context?.glossary ?? 'GLOSSARY-MAP.md');
}

for (const id of recordBreaks(folder)) console.log(`${id}: ${scenarioState(folder, id).reason}; now broken until the writer confirms it again`);

const { pack, records } = buildPack(folder, { glossaryMap });
const dir = join(folder, 'facts');
mkdirSync(join(dir, 'step-records'), { recursive: true });
for (const r of records) writeFileSync(join(dir, 'step-records', `${r.scenario.id}.json`), `${JSON.stringify(r, null, '\t')}\n`);
// The screenshots travel with the pack (facts/screenshots/<ID>/<path the record names>), so the
// writer session and the preview work on a fresh checkout with no build folder (ticket 08).
for (const r of records) {
	const run = join(folder, 'build/runs', r.scenario.id);
	if (!existsSync(join(run, 'step-record.json'))) continue;
	const shots = join(dir, 'screenshots', r.scenario.id);
	rmSync(shots, { recursive: true, force: true });
	for (const a of r.steps.flatMap((st) => st.actions)) {
		if (!a.screenshot || !existsSync(join(run, a.screenshot))) continue;
		mkdirSync(dirname(join(shots, a.screenshot)), { recursive: true });
		copyFileSync(join(run, a.screenshot), join(shots, a.screenshot));
	}
}
writeFileSync(join(dir, 'pack.json'), `${JSON.stringify(pack, null, '\t')}\n`);
writeFileSync(join(dir, 'pack.md'), packMarkdown(pack));
const count = (n, what) => `${n} ${what}`;
console.log(`facts: ${count(pack.scenarios.length, 'scenario(s)')}, ${count(records.length, 'step record(s)')}, ${count(pack.mismatches.length, 'mismatch(es)')}, ${count(pack.unknownTerms.length, 'term(s) in neither glossary')}, ${count(pack.languageBound.length, 'language-bound action(s)')} → ${relative(process.cwd(), join(dir, 'pack.json')) || join(dir, 'pack.json')}`);
