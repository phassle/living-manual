#!/usr/bin/env node
// Draft planning and the scenario rules (spec: Solution 3, Doc scenarios, Configuration; T1.14).
//
//   plan  — from the case inventory (facts/cases.json), picks the cases to draft this run: those
//           in the product's firstArea not yet covered by a doc scenario, in inventory order, at
//           most limits.scenariosPerRun. Gives each the next free ID. Every other case is reported
//           as not drafted, with the reason. Writes facts/draft-plan.json and facts/draft-report.md.
//           Once any planned scenario is drafted the plan is kept (printed again) until --new.
//   check — every doc scenario in scenarios/*.feature follows the rules: an ID, @draft or
//           @confirmed, a `Sources:` line, the intent note exactly when no human text is among the
//           sources, a first step naming role and start screen, intent-level steps (no "click",
//           "button", …: bin/lib/intent.mjs), a final Then. And no scenario beyond this run's plan
//           (planned cases plus the writer's drafts under fromWriter), so drafting stops at the limit.
//   from  — drafts from the writer's material: a manual (folder or URL), plain text, the writer's
//           Gherkin, or a Playwright codegen recording; corrections go to <feature>.corrections.json.
//
// usage: node living-manual/kit/bin/lm-draft.mjs plan <product> [--new]
//        node living-manual/kit/bin/lm-draft.mjs check <product> [--file <feature>]
//        node living-manual/kit/bin/lm-draft.mjs from <product> manual|text|gherkin|recording <source> [options] (bin/lib/draft-from.mjs)
// Exit 0 OK, 1 FAIL, 2 usage. Last line: `draft plan: …`, `draft PASS: …` or `draft FAIL: …`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFeature } from './lib/gherkin.mjs';
import { productConfig, productFolder, workspaceRoot } from './lib/workspace.mjs';
import { ADVICE, uiWords } from './lib/intent.mjs';
import { HUMAN_TYPES, NOTE, areaFeature, areaPrefix, docScenarios, readInventory, scenarioSources } from './lib/cases.mjs';

const [command, product] = process.argv.slice(2);
let root, section, folder;
try {
	if (!['plan', 'check', 'from'].includes(command) || !product) throw new Error('name a command and a product');
	root = workspaceRoot();
	section = productConfig(root, product);
	folder = productFolder(root, product);
} catch (e) {
	process.stderr.write(`lm-draft: ${e.message}\nusage: lm-draft.mjs plan|check|from <product> …\n`);
	process.exit(2);
}
const area = section.firstArea;
const limit = section.limits?.scenariosPerRun ?? 10;
const planFile = join(folder, 'facts/draft-plan.json');

if (command === 'from') {
	const { draftFrom } = await import('./lib/draft-from.mjs');
	process.exit(await draftFrom({ root, product, section, folder, planFile, args: process.argv.slice(4) }));
}

if (command === 'plan') {
	// This run's plan stays while its drafts are being written: planning again would count them as
	// existing and allow another full limit. --new starts the next run.
	if (existsSync(planFile) && !process.argv.includes('--new')) {
		const old = JSON.parse(readFileSync(planFile, 'utf8'));
		const ids = new Set(docScenarios(folder).map((s) => s.id));
		const done = old.toDraft.filter((d) => ids.has(d.id)).length;
		if (done > 0) {
			for (const d of old.toDraft) console.log(`${ids.has(d.id) ? 'drafted' : 'draft'} ${d.id} ${d.title} (${d.case})`);
			for (const n of old.notDrafted) console.log(`not drafted: ${n.title} (${n.case}): ${n.reason}`);
			console.log(`draft plan kept: ${done} of its ${old.toDraft.length} planned scenario(s) are drafted; plan --new starts the next run`);
			process.exit(0);
		}
	}
	let inventory;
	try { inventory = readInventory(folder); } catch (e) { console.log(`draft FAIL: ${e.message}`); process.exit(1); }
	const existing = docScenarios(folder).map((s) => s.id).filter(Boolean);
	const prefix = areaPrefix(area, section);
	let next = Math.max(0, ...existing.filter((id) => id.startsWith(`${prefix}-`)).map((id) => Number(id.split('-').pop())));
	const id2 = (n) => `${prefix}-${String(n).padStart(2, '0')}`;
	const toDraft = [], notDrafted = [];
	let covered = 0;
	for (const c of inventory.cases ?? []) {
		if (c.scenario) { covered++; continue; }
		if (c.area !== area) { notDrafted.push({ case: c.id, title: c.title, reason: `outside the first area (${area})` }); continue; }
		if (toDraft.length >= limit) { notDrafted.push({ case: c.id, title: c.title, reason: `limit of ${limit} scenarios per run reached` }); continue; }
		toDraft.push({ id: id2(++next), case: c.id, title: c.title, file: areaFeature(area), role: c.role, startScreen: c.startScreen,
			manual: c.manual ?? null, humanIntent: c.humanIntent ?? null, evidence: c.evidence ?? [] });
	}
	writeFileSync(planFile, JSON.stringify({ kind: 'living-manual/draft-plan', version: 1, product, area, limit, existing, toDraft, notDrafted }, null, '\t') + '\n');
	const over = notDrafted.filter((n) => n.reason.startsWith('limit')).length;
	const summary = `draft plan: ${toDraft.length} to draft (limit ${limit}), ${notDrafted.length} not drafted (${over} over the limit, ${notDrafted.length - over} outside the first area), ${covered} already covered`;
	const lines = [
		...toDraft.map((d) => `draft ${d.id} ${d.title} (${d.case}) into ${d.file}${d.manual ? ` as @manual (${d.manual})` : ''}`),
		...notDrafted.map((n) => `not drafted: ${n.title} (${n.case}): ${n.reason}`),
	];
	writeFileSync(join(folder, 'facts/draft-report.md'), `# Draft plan: ${product}, area ${area}\n\nWritten by lm-draft plan. Limit: ${limit} scenarios per run.\n\n## To draft\n\n${toDraft.map((d) => `- ${d.id} ${d.title} (\`${d.case}\`)\n`).join('') || '- none\n'}\n## Not drafted\n\n${notDrafted.map((n) => `- ${n.title} (\`${n.case}\`): ${n.reason}\n`).join('') || '- none\n'}\n${summary}\n`);
	for (const l of lines) console.log(l);
	console.log(summary);
	process.exit(0);
}

// check (--file <feature>: that file only, against the rules; no plan)
const fileArg = process.argv.includes('--file') ? process.argv[process.argv.indexOf('--file') + 1] : null;
const plan = !fileArg && existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : null;
const planned = new Set([...(plan?.toDraft ?? []), ...(plan?.fromWriter ?? [])].map((d) => d.id));
const before = new Set(plan?.existing ?? []);
const problems = [];
let thisRun = 0;
const scenarios = fileArg
	? parseFeature(readFileSync(resolve(root, fileArg), 'utf8')).scenarios.filter((s) => s.doc).map((s) => ({ ...s, file: fileArg }))
	: docScenarios(folder);
for (const s of scenarios) {
	const id = s.id ?? `${s.file}:${s.line}`;
	if (!s.id) problems.push(`${id}: no ID tag (@AREA-NN)`);
	if (!s.tags.includes('@draft') && !s.tags.includes('@confirmed')) problems.push(`${id}: tag it @draft (or @confirmed once the writer has confirmed it)`);
	const sources = scenarioSources(s);
	const note = s.description.includes(NOTE);
	if (!sources?.length) problems.push(`${id}: no "Sources:" line naming where the case came from`);
	else {
		const human = sources.find((x) => HUMAN_TYPES.includes(x.type));
		if (!human && !note) problems.push(`${id}: drafted from ${[...new Set(sources.map((x) => x.type))].sort().join(' and ')} only; add "${NOTE}"`);
		if (human && note) problems.push(`${id}: a human text (${human.type}) states the intent; remove the note`);
	}
	if (!/^I am an? .+ on the .+$/.test(s.steps[0]?.text ?? '')) problems.push(`${id}: the first step must name the role and the start screen ("I am a <role> on the <screen>")`);
	for (const step of s.steps) {
		const words = uiWords(step.text);
		if (words.length) problems.push(`${id}: step "${step.text}" is UI level (${words.join(', ')}); ${ADVICE}`);
	}
	// And/But continue the kind of the step before: "Then …, And …" ends on an assertion.
	const lastKind = s.steps.map((x) => x.keyword).filter((k) => !['And', 'But', '*'].includes(k)).at(-1);
	if (lastKind !== 'Then') problems.push(`${id}: the last step must be a Then that asserts the visible result`);
	if (plan && s.id && !before.has(s.id)) {
		if (planned.has(s.id)) thisRun++;
		else problems.push(`${s.id}: not in this run's draft plan (limit ${plan.limit}); it is not drafted`);
	}
}
for (const p of problems) console.log(`  ${p}`);
if (problems.length) {
	console.log(`draft FAIL: ${problems.length} problem(s) in ${scenarios.length} doc scenario(s)`);
	process.exit(1);
}
console.log(`draft PASS: ${scenarios.length} doc scenario(s)${fileArg ? ` in ${fileArg}` : ''} follow the rules${plan ? `; ${thisRun} drafted this run (limit ${plan.limit})` : ''}`);
