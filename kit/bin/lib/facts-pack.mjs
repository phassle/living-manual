// The facts pack (spec: Facts pack): everything a run found out, so the writer session can decide
// without a running product. Built by bin/lm-facts.mjs from the step records (bin/lib/facts.mjs),
// the doc scenarios, the case inventory (facts/cases.json), both glossaries and the confirmations.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { allRecords } from './facts.mjs';
import { docScenarios } from './cases.mjs';
import { allStates } from './confirmation.mjs';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();
const termName = (label) => String(label ?? '').replace(/\s*:\s*$/, '').trim();

/** The terms a glossary file defines: its `**Term**:` lines. */
export function glossaryTerms(file) {
	if (!file || !existsSync(file)) return [];
	return [...readFileSync(file, 'utf8').matchAll(/^\*\*(.+?)\*\*:/gm)].map((m) => m[1].trim());
}

/** The glossary files a glossary map names (every path ending in GLOSSARY.md), relative to the map's folder. */
export function glossariesInMap(mapFile) {
	if (!mapFile || !existsSync(mapFile)) return [];
	const text = readFileSync(mapFile, 'utf8');
	const paths = new Set([...text.matchAll(/([\w./-]*GLOSSARY\.md)/g)].map((m) => m[1]).filter((p) => !p.endsWith('GLOSSARY-MAP.md')));
	return [...paths].map((p) => join(dirname(mapFile), p));
}

/** A term is known when a glossary names it, ignoring case and a plural s. */
function knownIn(terms) {
	const set = new Set(terms.map(norm).flatMap((t) => [t, t.replace(/s$/, ''), `${t}s`]));
	return (term) => set.has(norm(term));
}

/** Mismatches between the writer's scenario and its step record. */
export function mismatches(scenario, record) {
	const out = [];
	const id = scenario.id;
	if (record.run?.status !== 'passed') {
		out.push({ scenario: id, kind: 'run-failed', message: `${id}: the run ${record.run?.status ?? 'did not finish'}: the product did not do what the scenario says${record.run?.error ? `: ${String(record.run.error).split('\n')[0]}` : ''}` });
	}
	const ran = record.steps ?? [];
	if (ran.length !== scenario.steps.length) {
		out.push({ scenario: id, kind: 'step-count', writer: scenario.steps.length, product: ran.length, message: `${id}: the scenario has ${scenario.steps.length} step(s), the run ${ran.length}` });
	}
	scenario.steps.forEach((step, i) => {
		const r = ran[i];
		if (r && norm(r.text) !== norm(step.text)) {
			out.push({ scenario: id, kind: 'step-text', step: i + 1, writer: step.text, product: r.text, message: `${id} step ${i + 1}: the scenario says "${step.text}", the run did "${r.text}"` });
		}
		const seen = (r ? r.actions : ran.flatMap((s) => s.actions)).flatMap((a) => [a.label, a.value]).filter(Boolean).map(norm);
		for (const [, quoted] of step.text.matchAll(/"([^"]+)"/g)) {
			if (!seen.some((v) => v.includes(norm(quoted)) || (v && norm(quoted).includes(v) && v.length > 2))) {
				out.push({ scenario: id, kind: 'quoted-value', step: i + 1, quoted, product: seen, message: `${id} step ${i + 1}: the scenario names "${quoted}", which is not a label or value the product showed in that step` });
			}
		}
	});
	return out;
}

/**
 * Builds the pack. `glossaryMap` is the codebase glossary map file (or null). Returns
 * { pack, records }: pack.stepRecords maps IDs to facts/step-records/<ID>.json, and records are
 * the records to write there.
 */
export function buildPack(folder, { glossaryMap = null, at = new Date().toISOString() } = {}) {
	const records = allRecords(folder);
	const byId = new Map(records.map((r) => [r.scenario?.id, r]));
	const scenarios = docScenarios(folder).filter((s) => s.id);
	const states = new Map(allStates(folder).map((s) => [s.id, s]));
	const passed = records.filter((r) => r.run?.status === 'passed');
	const newest = [...passed].sort((a, b) => String(b.run.endedAt).localeCompare(String(a.run.endedAt)))[0];

	let cases = null;
	const inventory = join(folder, 'facts/cases.json');
	if (existsSync(inventory)) {
		const all = JSON.parse(readFileSync(inventory, 'utf8')).cases ?? [];
		const pick = (c) => ({ id: c.id, area: c.area, title: c.title, role: c.role, startScreen: c.startScreen, ...(c.scenario ? { scenario: c.scenario } : {}), ...(c.manual ? { manual: c.manual } : {}) });
		cases = { total: all.length, covered: all.filter((c) => c.scenario).map(pick), notCovered: all.filter((c) => !c.scenario).map(pick) };
	}

	const codebase = glossariesInMap(glossaryMap);
	const known = knownIn([...codebase.flatMap(glossaryTerms), ...glossaryTerms(join(folder, 'GLOSSARY.md'))]);
	const terms = new Map();
	const addTerm = (term, kind, id) => {
		const t = termName(term);
		if (t.length < 3 || !/[a-z]/i.test(t) || known(t)) return;
		const key = norm(t);
		const entry = terms.get(key) ?? { term: t, kinds: [], scenarios: [] };
		if (!entry.kinds.includes(kind)) entry.kinds.push(kind);
		if (!entry.scenarios.includes(id)) entry.scenarios.push(id);
		terms.set(key, entry);
	};
	const languageBound = [];
	for (const r of records) {
		const id = r.scenario?.id;
		r.steps.forEach((st, si) => st.actions.forEach((a, ai) => {
			if (a.screen) addTerm(a.screen, 'screen', id);
			if (a.kind !== 'verify' && !a.dataSpecific && a.labelSource !== 'author') addTerm(a.label, 'label', id);
			if (a.languageBound) languageBound.push({ scenario: id, step: si + 1, action: ai + 1, kind: a.kind, screen: a.screen ?? null, label: a.label ?? null, locator: a.locator?.expression ?? null, testIdTried: a.locator?.testIdTried ?? null });
		}));
	}

	const pack = {
		_about: 'The facts pack (spec: Facts pack), written by living-manual/kit/bin/lm-facts.mjs after every run. The writer session reads this and nothing else from the product. Do not edit; rerun lm-facts.',
		kind: 'living-manual/facts-pack',
		version: 1,
		writtenAt: at,
		product: newest?.product ?? records[0]?.product ?? null,
		productVersion: newest?.productVersion ?? null,
		newestRunAt: newest?.run.endedAt ?? null,
		scenarios: scenarios.map((s) => {
			const manual = s.tags.includes('@manual');
			const st = states.get(s.id);
			return { id: s.id, title: s.title, file: s.file, run: manual ? 'manual' : byId.get(s.id)?.run?.status ?? 'not run', status: st.status, reason: st.reason, confirmedBy: st.by, confirmedAt: st.at, fingerprint: st.current };
		}),
		stepRecords: Object.fromEntries(records.map((r) => [r.scenario.id, `step-records/${r.scenario.id}.json`])),
		cases,
		mismatches: scenarios.filter((s) => byId.has(s.id) && !s.tags.includes('@manual')).flatMap((s) => mismatches(s, byId.get(s.id))),
		unknownTerms: [...terms.values()],
		glossaries: { codebase: codebase.map(String), documentation: 'GLOSSARY.md' },
		languageBound,
	};
	return { pack, records };
}

/** The pack as Markdown for a person: facts/pack.md. */
export function packMarkdown(pack) {
	const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
	const lines = [`# Facts pack: ${pack.product ?? ''}`, '', `Written ${pack.writtenAt} by lm-facts from the latest runs (newest ${pack.newestRunAt ?? 'none'}, product version ${pack.productVersion ?? 'unknown'}). Generated; do not edit.`, ''];
	lines.push('## Scenarios', '', '| Scenario | Title | Run | Status |', '|---|---|---|---|');
	for (const s of pack.scenarios) lines.push(`| ${s.id} | ${cell(s.title)} | ${s.run} | ${s.status}: ${cell(s.reason)} |`);
	lines.push('', '## Case inventory', '');
	if (!pack.cases) lines.push('No case inventory yet (facts/cases.json; the lm-collect skill writes it).');
	else {
		lines.push(`${pack.cases.total} case(s): ${pack.cases.covered.length} covered by a doc scenario, ${pack.cases.notCovered.length} not yet covered.`, '', '| Case | Area | Doc scenario |', '|---|---|---|');
		for (const c of pack.cases.covered) lines.push(`| ${cell(c.title)} | ${cell(c.area)} | ${c.scenario} |`);
		for (const c of pack.cases.notCovered) lines.push(`| ${cell(c.title)} | ${cell(c.area)} | not yet covered${c.manual ? ` (@manual: ${cell(c.manual)})` : ''} |`);
	}
	lines.push('', '## Mismatches between the scenario text and what the product did', '');
	lines.push(...(pack.mismatches.length ? pack.mismatches.map((m) => `- ${m.message}`) : ['None.']));
	lines.push('', '## Terms in neither glossary', '', 'Screen names and labels the runs met that neither the codebase glossaries nor the documentation glossary (GLOSSARY.md in the product folder) defines.', '');
	lines.push(...(pack.unknownTerms.length ? pack.unknownTerms.map((t) => `- **${t.term}** (${t.kinds.join(', ')}; ${t.scenarios.join(', ')})`) : ['None.']));
	lines.push('', '## Language-bound actions', '', 'Actions found by role and name or text rather than a test ID: they break when the product\'s language or wording changes.', '');
	if (!pack.languageBound.length) lines.push('None.');
	else {
		lines.push('| Scenario | Step | Action | Label | Locator | Test ID tried |', '|---|---|---|---|---|---|');
		for (const a of pack.languageBound) lines.push(`| ${a.scenario} | ${a.step} | ${a.action} ${a.kind} | ${cell(a.label)} | \`${cell(a.locator)}\` | ${cell(a.testIdTried ?? '')} |`);
	}
	return `${lines.join('\n')}\n`;
}
