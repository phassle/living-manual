#!/usr/bin/env node
// The healer's limits (spec: From scenario to test code, Healer): compares a spec before and after
// a repair and says whether it changed only locators and waits (bin/lib/heal-guard.mjs lists
// what counts as which). lm-watch runs it on every repair; the healer may run it on its own.
//
// usage: node living-manual/kit/bin/lm-heal-guard.mjs <spec before> <spec after> [--json]
// Prints `guard: no change`, `guard: locator/wait only`, or `guard: behaviour change` followed by
// one `- <reason>` line per change. Exit 0 no change or locator/wait only, 1 behaviour change, 2 usage.
import { existsSync, readFileSync } from 'node:fs';
import { classifyHeal } from './lib/heal-guard.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const [before, after] = argv.filter((a) => a !== '--json');
if (!before || !after || !existsSync(before) || !existsSync(after)) {
	process.stderr.write('usage: lm-heal-guard.mjs <spec before> <spec after> [--json]\n');
	process.exit(2);
}
const r = classifyHeal(readFileSync(before, 'utf8'), readFileSync(after, 'utf8'));
if (json) console.log(JSON.stringify(r, null, '\t'));
else console.log([`guard: ${r.verdict}`, ...r.reasons.map((x) => `- ${x}`)].join('\n'));
process.exit(r.verdict === 'behaviour change' ? 1 : 0);
