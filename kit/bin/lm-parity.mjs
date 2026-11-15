#!/usr/bin/env node
// The parity check (spec: From scenario to test code). Every @doc scenario in the product's
// scenarios/*.feature has exactly one test in tests/*.spec.ts titled "<ID> <title>", and that
// test's test.step() titles are the scenario's step texts (without Given/When/Then), verbatim and
// in the same order. A scenario tagged @manual is never run and needs no test. A run counts only when parity holds, so lm-run.mjs calls this first.
//
// usage: node living-manual/kit/bin/lm-parity.mjs <product>
//        node living-manual/kit/bin/lm-parity.mjs --folder <product folder>
// Exit 0 PASS, 1 FAIL, 2 usage. Last line: `parity PASS: …` or `parity FAIL: …`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { folderFromArgs } from './lib/workspace.mjs';
import { parseFeature } from './lib/gherkin.mjs';
import { parseSpec } from './lib/spec.mjs';

let folder;
try { ({ folder } = folderFromArgs(process.argv.slice(2))); } catch (e) {
	process.stderr.write(`lm-parity: ${e.message}\nusage: lm-parity.mjs <product> | --folder <dir>\n`);
	process.exit(2);
}

const files = (dir, ext) => existsSync(join(folder, dir))
	? readdirSync(join(folder, dir)).filter((f) => f.endsWith(ext)).sort().map((f) => join(folder, dir, f)) : [];

const problems = [];
const scenarios = [];
let manualOnly = 0;
for (const f of files('scenarios', '.feature')) {
	for (const s of parseFeature(readFileSync(f, 'utf8')).scenarios.filter((s) => s.doc)) {
		if (s.tags.includes('@manual')) { manualOnly++; continue; } // never run (spec: Doc scenarios)
		if (!s.id) problems.push(`${relative(folder, f)}:${s.line} doc scenario "${s.title}" has no ID tag (@AREA-NN)`);
		else scenarios.push({ ...s, file: f });
	}
}

const ID_TITLE = /^([A-Z][A-Z0-9]*-\d+)\s+(.*)$/;
const tests = new Map();
for (const f of files('tests', '.spec.ts')) {
	for (const t of parseSpec(readFileSync(f, 'utf8'))) {
		const m = ID_TITLE.exec(t.title);
		if (!m) continue;
		if (tests.has(m[1])) problems.push(`${m[1]}: more than one test titled "${m[1]} …"`);
		tests.set(m[1], { ...t, id: m[1], name: m[2], file: f });
	}
}

let steps = 0;
for (const s of scenarios) {
	const t = tests.get(s.id);
	if (!t) { problems.push(`${s.id}: no test titled "${s.id} …" in tests/*.spec.ts`); continue; }
	if (t.name !== s.title) problems.push(`${s.id} title: feature says "${s.title}", test says "${t.name}"`);
	const n = Math.max(s.steps.length, t.steps.length);
	for (let i = 0; i < n; i++) {
		const want = s.steps[i]?.text, got = t.steps[i]?.title;
		if (want === got) { steps++; continue; }
		problems.push(`${s.id} step ${i + 1}: feature says ${want === undefined ? '(no step)' : `"${want}"`}, test says ${got === undefined ? '(no step)' : `"${got}"`}`);
		break;
	}
}
const ids = new Set(scenarios.map((s) => s.id));
for (const id of tests.keys()) if (!ids.has(id)) problems.push(`${id}: test has no doc scenario in scenarios/*.feature`);

for (const p of problems) console.log(`  ${p}`);
if (problems.length) {
	console.log(`parity FAIL: ${problems.length} problem(s) in ${scenarios.length} doc scenario(s)`);
	process.exit(1);
}
console.log(`parity PASS: ${scenarios.length} doc scenario(s), ${steps} step(s) match their tests${manualOnly ? `; ${manualOnly} @manual scenario(s) not run` : ''}`);
