// lm-draft from <product> manual|text|gherkin|recording <source> [options]: drafts doc scenarios
// from the writer's material (spec: Starting material from the writer) into the area's .feature,
// and records every correction next to it in <feature>.corrections.json for the writer session.
//
// options: --role <role> --screen <screen>  what the material does not say (who, where it starts)
//          --title <title>                   a recording's scenario title (else from its file name)
//          --out <file.feature>              write somewhere else than scenarios/<area>.feature
//          --current <who/when>              a manual: who confirmed it is the live manual
// Drafts written into scenarios/ count against limits.scenariosPerRun with this run's plan
// (facts/draft-plan.json, listed under fromWriter). Exit 0 written, 1 written with open questions
// for the writer (or refused), 2 usage.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseFeature } from './gherkin.mjs';
import { areaFeature, areaPrefix, docScenarios } from './cases.mjs';
import { fromGherkin, fromProcedures, fromRecording, renderScenario } from './material.mjs';
import { findProcedures, readManualFolder, readManualUrl } from './procedures.mjs';

const KINDS = ['manual', 'text', 'gherkin', 'recording'];

function option(args, name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

export async function draftFrom({ root, product, section, folder, planFile, args }) {
	const [kind, source] = args;
	if (!KINDS.includes(kind) || !source) {
		process.stderr.write(`lm-draft from: name the kind of material (${KINDS.join(', ')}) and where it is\n`);
		return 2;
	}
	const area = section.firstArea;
	const limit = section.limits?.scenariosPerRun ?? 10;
	const out = option(args, '--out');
	const featureAbs = out ? resolve(root, out) : join(folder, areaFeature(area));
	const inFolder = featureAbs.startsWith(folder + sep);
	const featureRel = relative(inFolder ? folder : root, featureAbs);
	const correctionsAbs = featureAbs.replace(/\.feature$/, '') + '.corrections.json';
	const correctionsRel = relative(inFolder ? folder : root, correctionsAbs);
	const existingText = existsSync(featureAbs) ? readFileSync(featureAbs, 'utf8') : null;
	const docInherited = existingText === null || parseFeature(existingText).tags.includes('@doc');

	const prefix = areaPrefix(area, section);
	const taken = [...docScenarios(folder).map((s) => s.id), ...(existingText ? parseFeature(existingText).scenarios.map((s) => s.id) : [])]
		.filter((id) => id?.startsWith(`${prefix}-`)).map((id) => Number(id.split('-').pop()));
	let n = Math.max(0, ...taken);
	const nextId = () => `${prefix}-${String(++n).padStart(2, '0')}`;

	const opts = { role: option(args, '--role'), screen: option(args, '--screen'), title: option(args, '--title'), current: option(args, '--current'), nextId, docInherited };
	let drafts;
	try {
		const abs = /^https?:/.test(source) ? source : resolve(root, source);
		if (kind === 'gherkin') drafts = fromGherkin(readFileSync(abs, 'utf8'), { ...opts, source });
		else if (kind === 'recording') drafts = fromRecording(readFileSync(abs, 'utf8'), { ...opts, source });
		else if (kind === 'text') {
			const procs = findProcedures(readFileSync(abs, 'utf8'));
			drafts = fromProcedures(procs, { ...opts, refOf: (p) => `text ${source}#L${p.from}-L${p.to}` });
		} else {
			const pages = /^https?:/.test(source) ? await readManualUrl(source) : readManualFolder(abs, root);
			const found = pages.flatMap((page) => findProcedures(page.text).map((p) => ({ ...p, page: page.ref })));
			console.log(`manual: ${pages.length} page(s) read, ${found.length} procedure(s) found`);
			const extra = () => [opts.current
				? { rule: 'which manual is current', before: null, after: `confirmed as the manual in use: ${opts.current}` }
				: { rule: 'which manual is current', before: null, after: null, open: true, question: `confirm that ${source} is the manual in use before drafting from it (spec risk "Which manual is current"); then pass --current <who, when>` }];
			drafts = fromProcedures(found, { ...opts, extra, refOf: (p) => `manual ${p.page}#${p.anchor}` });
		}
	} catch (e) {
		console.log(`draft from ${kind} refused: ${e.message}`);
		return 1;
	}
	if (!drafts.length) { console.log(`draft from ${kind} refused: no scenario found in ${source}`); return 1; }

	if (featureAbs.startsWith(join(folder, 'scenarios') + sep)) {
		const ids = new Set(docScenarios(folder).map((s) => s.id));
		const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8'))
			: { kind: 'living-manual/draft-plan', version: 1, product, area, limit, existing: [...ids].filter(Boolean), toDraft: [], notDrafted: [] };
		const thisRun = plan.toDraft.filter((d) => ids.has(d.id)).length + (plan.fromWriter?.length ?? 0);
		if (thisRun + drafts.length > limit) {
			console.log(`draft from ${kind} refused: this run has ${thisRun} of its ${limit} scenario(s) drafted and the material gives ${drafts.length} more; lm-draft plan --new starts the next run`);
			return 1;
		}
		plan.fromWriter = [...(plan.fromWriter ?? []), ...drafts.map((d) => ({ id: d.id, title: d.title, source: d.sourceRef }))];
		mkdirSync(dirname(planFile), { recursive: true });
		writeFileSync(planFile, JSON.stringify(plan, null, '\t') + '\n');
	}

	const header = `# Doc scenarios for ${area} (Living Manual, Doc scenarios).\n@doc\nFeature: ${area}\n`;
	const text = (existingText ?? header).replace(/\s*$/, '\n') + drafts.map((d) => `\n${renderScenario(d)}\n`).join('');
	mkdirSync(dirname(featureAbs), { recursive: true });
	writeFileSync(featureAbs, text);

	const record = existsSync(correctionsAbs) ? JSON.parse(readFileSync(correctionsAbs, 'utf8')) : { kind: 'living-manual/corrections', version: 1, corrections: [] };
	const entries = drafts.flatMap((d) => d.corrections.map((c) => ({ scenario: d.id, title: d.title, source: `${kind} ${source}`, feature: featureRel, ...c })));
	record.corrections.push(...entries);
	writeFileSync(correctionsAbs, JSON.stringify(record, null, '\t') + '\n');

	const open = entries.filter((c) => c.open);
	for (const c of open) console.log(`open: ${c.scenario} ${c.question}`);
	console.log(`draft from ${kind}: ${drafts.length} draft scenario(s) written to ${featureRel} (${drafts.map((d) => d.id).join(', ')}); ${entries.length} correction(s) recorded in ${correctionsRel}${open.length ? `; ${open.length} open question(s) for the writer session` : ''}`);
	return open.length ? 1 : 0;
}
