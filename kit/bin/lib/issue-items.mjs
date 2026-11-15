// What a run found that becomes an issue (spec: Issues), read from the product's facts pack
// (facts/pack.json, bin/lm-facts.mjs) and the guide's unanswered questions
// (build/guide/unanswered.jsonl, one JSON object per line: { question, screen?, role?, feature?, at? }).
// Grouped per kind and feature; a feature is the area of the case inventory whose scenarios live
// in a feature file (scenarios/<area>.feature), else the file's name in words.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { areaFeature } from './cases.mjs';

/** { run, productVersion, groups: [{ kind, feature, items: [{ key, text }] }] } for the product's latest run. */
export function afterRunItems(root, product) {
	const folder = join(root, 'living-manual/products', product);
	const packFile = join(folder, 'facts/pack.json');
	if (!existsSync(packFile)) throw new Error(`no facts pack at ${packFile}; run lm-facts first`);
	const pack = JSON.parse(readFileSync(packFile, 'utf8'));
	const scenarios = pack.scenarios ?? [];
	const cases = [...(pack.cases?.covered ?? []), ...(pack.cases?.notCovered ?? [])];

	const featureOfFile = (file) => featureOfFeatureFile(pack, file);
	const featureOf = (id) => featureOfFile(scenarios.find((s) => s.id === id)?.file);

	const groups = [];
	const add = (kind, feature, item) => {
		let g = groups.find((x) => x.kind === kind && x.feature === feature);
		if (!g) groups.push((g = { kind, feature, items: [] }));
		g.items.push(item);
	};

	for (const s of scenarios.filter((x) => x.status === 'broken')) {
		add('broken-scenario', featureOfFile(s.file), { key: `broken-scenario ${s.id}`, text: `${s.id} ${s.title}: ${s.reason} (${s.file})` });
	}
	for (const c of pack.cases?.notCovered ?? []) {
		add('missing-case', c.area, { key: `missing-case ${c.id}`, text: `${c.title} (case \`${c.id}\`${c.startScreen ? `, from the ${c.startScreen}` : ''}${c.role ? `, ${c.role}` : ''})` });
	}
	// Every action that found its element without a test ID: from the step records the pack names
	// (CSS as well as role-and-name or text), else from the pack's language-bound actions. An
	// element that exists only because of the demo data (a row in a list) is left out.
	const missing = [];
	const withRecord = new Set();
	for (const [id, rel] of Object.entries(pack.stepRecords ?? {})) {
		const file = join(folder, 'facts', rel);
		if (!existsSync(file)) continue;
		withRecord.add(id);
		JSON.parse(readFileSync(file, 'utf8')).steps?.forEach((st, si) => st.actions?.forEach((a, ai) => {
			if (a.missingTestId && !a.dataSpecific) missing.push({ scenario: id, step: si + 1, action: ai + 1, kind: a.kind, screen: a.screen ?? null, label: a.label ?? null, locator: a.locator?.expression ?? null, testIdTried: a.locator?.testIdTried ?? null });
		}));
	}
	for (const a of pack.languageBound ?? []) if (!withRecord.has(a.scenario)) missing.push(a);
	// One item per element: the same screen and locator in several scenarios is one missing test ID.
	const elements = new Map();
	for (const a of missing) {
		const key = `missing-test-id ${a.screen ?? ''} | ${a.locator ?? a.label}`;
		const e = elements.get(key) ?? { a, feature: featureOf(a.scenario), uses: [] };
		e.uses.push(`${a.scenario} step ${a.step}`);
		elements.set(key, e);
	}
	for (const [key, { a, feature, uses }] of elements) {
		const label = String(a.label ?? '').replace(/\s*:\s*$/, '');
		add('missing-test-ids', feature, { key, text: `**${label || '(no label)'}** (${a.kind}) on the ${a.screen ?? 'unnamed screen'}: found by \`${a.locator}\`${a.testIdTried ? `; test ID tried: \`${a.testIdTried}\`` : ''}; used by ${uses.join(', ')}` });
	}
	const questions = join(folder, 'build/guide/unanswered.jsonl');
	if (existsSync(questions)) {
		for (const line of readFileSync(questions, 'utf8').split('\n').filter((l) => l.trim())) {
			const q = JSON.parse(line);
			add('guide-questions', q.feature ?? 'Guide', { key: `guide-question ${String(q.question).trim().toLowerCase()} | ${q.screen ?? ''}`, text: `"${q.question}"${q.screen ? ` on the ${q.screen}` : ''}${q.role ? ` (${q.role})` : ''}` });
		}
	}
	return { run: pack.newestRunAt ?? pack.writtenAt ?? null, productVersion: pack.productVersion ?? null, groups };
}

/**
 * The feature a feature file belongs to, as issues name it: the case-inventory area that covers
 * one of its scenarios, else the area whose feature file it is, else the file's name in words.
 */
export function featureOfFeatureFile(pack, file) {
	const scenarios = pack.scenarios ?? [];
	const cases = [...(pack.cases?.covered ?? []), ...(pack.cases?.notCovered ?? [])];
	const covered = cases.find((c) => c.scenario && scenarios.find((s) => s.id === c.scenario)?.file === file);
	if (covered) return covered.area;
	const area = cases.find((c) => areaFeature(c.area) === file)?.area;
	if (area) return area;
	const words = basename(file ?? 'other', '.feature').replace(/-/g, ' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The feature of a scenario, read from the product folder's facts pack (null without a pack). */
export function featureOfScenario(folder, id) {
	const file = join(folder, 'facts/pack.json');
	if (!existsSync(file)) return null;
	const pack = JSON.parse(readFileSync(file, 'utf8'));
	const s = (pack.scenarios ?? []).find((x) => x.id === id);
	return s ? featureOfFeatureFile(pack, s.file) : null;
}
