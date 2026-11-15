#!/usr/bin/env node
// Compares each scenario's run with the run before it (spec: Repeatable runs; T1.3). The kit keeps
// the previous run of a scenario in build/previous/<ID> when a new one starts in build/runs/<ID>.
// Per scenario: every screenshot byte-identical (else: pixel-identical with different bytes, or
// how many pixels differ), and the step record the same once its clock readings and page
// addresses are left out (else: the fields that differ; changed addresses are listed apart). On unchanged code two runs are identical, so a difference means
// the product (or the scenario) changed. Writes build/compare.md and prints one line per scenario.
//
// usage: node living-manual/kit/bin/lm-compare.mjs <product> [--id <ID>]
//        node living-manual/kit/bin/lm-compare.mjs --folder <product folder> [--id <ID>]
// Exit 0 when nothing differs (a scenario with no earlier run is not a difference), 1 when
// something does, 2 usage.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { folderFromArgs } from './lib/workspace.mjs';
import { readPng } from './lib/png.mjs';
import { addresses, differences, readRecord, screenshots, stableRecord } from './lib/record.mjs';

let folder, rest;
try { ({ folder, rest } = folderFromArgs(process.argv.slice(2))); } catch (e) {
	process.stderr.write(`lm-compare: ${e.message}\nusage: lm-compare.mjs <product> | --folder <dir> [--id <ID>]\n`);
	process.exit(2);
}
const only = rest.includes('--id') ? rest[rest.indexOf('--id') + 1] : null;
const build = join(folder, 'build');
const runs = join(build, 'runs');
const ids = (existsSync(runs) ? readdirSync(runs) : []).filter((id) => existsSync(join(runs, id, 'step-record.json')) && (!only || id === only)).sort();
if (!ids.length) { console.log(`compare: no step record${only ? ` for ${only}` : ''} in ${runs}`); process.exit(1); }

/** One screenshot, earlier run against this one. */
function compareShot(before, after) {
	if (!existsSync(before)) return 'new (no earlier screenshot)';
	if (!existsSync(after)) return 'missing in this run';
	const a = readFileSync(before), b = readFileSync(after);
	if (a.equals(b)) return 'byte-identical';
	const pa = readPng(a), pb = readPng(b);
	if (pa.width !== pb.width || pa.height !== pb.height) return `different: size ${pa.width}×${pa.height} → ${pb.width}×${pb.height}`;
	let n = 0;
	for (let i = 0; i < pa.rgb.length; i += 3) if (pa.rgb[i] !== pb.rgb[i] || pa.rgb[i + 1] !== pb.rgb[i + 1] || pa.rgb[i + 2] !== pb.rgb[i + 2]) n++;
	return n ? `different: ${n} pixels differ` : 'pixel-identical (bytes differ)';
}

const lines = ['# Run comparison', '', `Each scenario's run in \`build/runs/<ID>\` against its previous run in \`build/previous/<ID>\`. Step records are compared without their clock readings (startedAt, endedAt, startMs, endMs) and page addresses (url: they hold ids the server assigns).`, '', '| Scenario | Screenshot | Result |', '|---|---|---|'];
const notes = [];
let differing = 0;
for (const id of ids) {
	const now = join(runs, id), prev = join(build, 'previous', id);
	if (!existsSync(join(prev, 'step-record.json'))) {
		console.log(`  ${id}: no earlier run to compare with`);
		lines.push(`| ${id} | – | no earlier run |`);
		continue;
	}
	const a = readRecord(prev), b = readRecord(now);
	const shots = [...new Set([...screenshots(a), ...screenshots(b)])];
	const results = shots.map((s) => [s, compareShot(join(prev, s), join(now, s))]);
	for (const [s, r] of results) lines.push(`| ${id} | ${s} | ${r} |`);
	const diff = differences(stableRecord(a), stableRecord(b));
	const moved = differences(addresses(a), addresses(b));
	const same = results.filter(([, r]) => r === 'byte-identical').length;
	const identical = same === results.length && !diff.length;
	if (!identical) differing++;
	notes.push(`## ${id}`, '', `Earlier run ${a.run?.startedAt}, this run ${b.run?.startedAt}.`, '',
		diff.length ? `Step record differs:\n\n${diff.map((d) => `- ${d}`).join('\n')}` : 'Step record: same.', '',
		...(moved.length ? [`Not compared (page addresses hold server-assigned ids):\n\n${moved.map((d) => `- ${d}`).join('\n')}`, ''] : []));
	console.log(`  ${id}: ${identical ? 'identical' : 'differs'} (${same} of ${results.length} screenshots byte-identical, step record ${diff.length ? `differs in ${diff.length} field(s)` : 'same'})`);
}
writeFileSync(join(build, 'compare.md'), [...lines, '', ...notes].join('\n'));
console.log(`compare: ${differing ? `${differing} scenario(s) differ from their earlier run` : 'no differences'}; report ${relative(process.cwd(), join(build, 'compare.md')) || join(build, 'compare.md')}`);
process.exit(differing ? 1 : 0);
