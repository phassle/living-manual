#!/usr/bin/env node
// Confirmation (spec: Confirmation): shows and records the writer's confirmation of doc scenarios.
// The writer session (lm-writer-session) calls `confirm` when the writer has confirmed; nobody
// else does. Model and storage: bin/lib/confirmation.mjs (product folder's confirmation.json).
//
// usage: node living-manual/kit/bin/lm-confirm.mjs <product> status [<ID>…] [--json]
//        node living-manual/kit/bin/lm-confirm.mjs <product> confirm <ID>… --by <writer> [--at <ISO time>]
//        node living-manual/kit/bin/lm-confirm.mjs <product> draft <ID>… [--reason <text>]
//        node living-manual/kit/bin/lm-confirm.mjs <product> broken <ID>… --reason <text>
//          (a mismatch the writer filed as a bug; the last published page stays published)
//        (or --folder <product folder> instead of <product>)
// Output: one line per scenario, `<ID>: draft|confirmed|broken (<reason>)`; --json prints
// [{ id, status, reason, by, at, current: { text, actions, fingerprint } }].
// Exit 0 done, 1 a scenario could not be confirmed (unknown ID, no passing run), 2 usage.
import { folderFromArgs } from './lib/workspace.mjs';
import { allStates, confirm, markBroken, unconfirm } from './lib/confirmation.mjs';

const USAGE = 'usage: lm-confirm.mjs <product> | --folder <dir>  status [<ID>…] [--json] | confirm <ID>… --by <writer> [--at <time>] | draft <ID>… [--reason <text>] | broken <ID>… --reason <text>';
function usage(msg) { process.stderr.write(`lm-confirm: ${msg}\n${USAGE}\n`); process.exit(2); }

let folder, rest;
try { ({ folder, rest } = folderFromArgs(process.argv.slice(2))); } catch (e) { usage(e.message); }
const take = (flag) => {
	const i = rest.indexOf(flag);
	if (i < 0) return undefined;
	const v = rest[i + 1];
	if (!v || v.startsWith('--')) usage(`${flag} needs a value`);
	rest.splice(i, 2);
	return v;
};
const json = rest.includes('--json');
rest = rest.filter((a) => a !== '--json');
const by = take('--by');
const at = take('--at');
const reason = take('--reason');
const [command, ...ids] = rest;

if (command === 'status') {
	const states = allStates(folder).filter((s) => !ids.length || ids.includes(s.id));
	if (json) console.log(JSON.stringify(states, null, '\t'));
	else for (const s of states) console.log(`${s.id}: ${s.status} (${s.reason})`);
	process.exit(0);
}
if (command === 'confirm') {
	if (!by) usage('confirm needs --by <writer>: only the writer confirms, and the confirmation records who');
	if (!ids.length) usage('name the scenario ID(s) to confirm');
	let failed = 0;
	for (const id of ids) {
		const r = confirm(folder, id, by, at);
		console.log(r.message);
		if (!r.ok) failed++;
	}
	process.exit(failed ? 1 : 0);
}
if (command === 'draft') {
	if (!ids.length) usage('name the scenario ID(s) to take back to draft');
	for (const id of ids) console.log(unconfirm(folder, id, reason).message);
	process.exit(0);
}
if (command === 'broken') {
	if (!reason) usage('broken needs --reason <text>: say why, e.g. the bug issue it waits for');
	if (!ids.length) usage('name the scenario ID(s) to mark broken');
	let failed = 0;
	for (const id of ids) {
		const r = markBroken(folder, id, reason);
		console.log(r.message);
		if (!r.ok) failed++;
	}
	process.exit(failed ? 1 : 0);
}
usage(command ? `unknown command "${command}"` : 'name a command');
