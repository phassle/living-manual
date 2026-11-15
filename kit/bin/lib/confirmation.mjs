// Confirmation (spec: Confirmation). Every doc scenario is draft, confirmed or broken:
// - draft: nobody has confirmed it (or the writer took the confirmation back);
// - confirmed: the writer confirmed it, and its fingerprint still matches;
// - broken: it was confirmed, and then its scenario text or its action list changed (the
//   confirmation lapsed), or a run found that it no longer passes. It needs the writer again; its
//   last published page stays published (lm-publish).
// The fingerprint is a sha256 over the scenario text (title and steps, not tags or the
// Sources/Note lines) and the action list of its latest step record: per step, each action's kind
// and locator (strategy and expression), never its label, so a renamed label keeps the
// confirmation. A @manual scenario has no run; its action list is empty.
//
// Stored in the product folder's confirmation.json (versioned):
// { kind, version, scenarios: { <ID>: { status, by, at, fingerprint, text, actions, reason?, brokenAt? } } }
// `text` and `actions` are the two halves' own hashes, so a lapse can say which half changed.
// This is the ONE model the manual (publishable.mjs), the guide (guide-index.mjs) and the video
// (eligible.mjs) ask.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { docScenarios } from './cases.mjs';
import { loadFacts } from './facts.mjs';

export const confirmationFile = (folder) => join(folder, 'confirmation.json');
const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** The scenario text the writer confirms: title and steps (keyword and text). */
export const scenarioText = (s) => ({ title: s.title, steps: s.steps.map((st) => `${st.keyword} ${st.text}`) });

/** The action list of a step record: per step, [kind, locator strategy, locator expression]. */
export const actionList = (record) => (record?.steps ?? []).map((st) => st.actions.map((a) => [a.kind, a.locator?.strategy ?? null, a.locator?.expression ?? null]));

/** { text, actions, fingerprint } hashes for a scenario and its latest step record (null for none). */
export function fingerprintOf(scenario, record) {
	const text = sha(scenarioText(scenario));
	const actions = sha(actionList(record));
	return { text, actions, fingerprint: sha({ text, actions }) };
}

export function readConfirmations(folder) {
	const file = confirmationFile(folder);
	if (!existsSync(file)) return { kind: 'living-manual/confirmation', version: 1, scenarios: {} };
	return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeConfirmations(folder, data) {
	const sorted = Object.fromEntries(Object.entries(data.scenarios).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
	writeFileSync(confirmationFile(folder), `${JSON.stringify({
		_about: 'The writer\'s confirmations (spec: Confirmation), written by living-manual/kit/bin/lm-confirm.mjs and lm-facts.mjs. Only the writer confirms; never edit by hand.',
		kind: 'living-manual/confirmation', version: 1, scenarios: sorted,
	}, null, '\t')}\n`);
}

/** What the kit knows of each doc scenario now: Map<ID, { scenario, record, manual }>. */
export function currentScenarios(folder) {
	const records = new Map(loadFacts(folder).records.map((r) => [r.scenario?.id, r]));
	return new Map(docScenarios(folder).filter((s) => s.id).map((s) => [s.id, { scenario: s, record: records.get(s.id) ?? null, manual: s.tags.includes('@manual') }]));
}

/**
 * The state of one scenario: { id, status: draft|confirmed|broken, reason, by?, at?, current }.
 * `current` is the fingerprint now ({ text, actions, fingerprint }), null for an unknown ID.
 * Pass `known` (from currentScenarios) when asking about many scenarios.
 */
export function scenarioState(folder, id, known = currentScenarios(folder), stored = readConfirmations(folder)) {
	const now = known.get(id);
	const rec = stored.scenarios[id];
	const current = now ? fingerprintOf(now.scenario, now.manual ? null : now.record) : null;
	const base = { id, by: rec?.by ?? null, at: rec?.at ?? null, current };
	if (!rec || rec.status === 'draft') return { ...base, status: 'draft', reason: rec?.reason ?? 'not confirmed by the writer' };
	if (rec.status === 'broken') return { ...base, status: 'broken', reason: rec.reason };
	if (!now) return { ...base, status: 'broken', reason: 'the scenario is no longer in scenarios/*.feature' };
	const changed = [];
	if (current.text !== rec.text) changed.push('the scenario text changed');
	if (current.actions !== rec.actions) changed.push('the action list changed');
	if (changed.length) return { ...base, status: 'broken', reason: `confirmation lapsed: ${changed.join(' and ')} since ${rec.by} confirmed it` };
	if (!now.manual && now.record?.run?.status !== 'passed') return { ...base, status: 'broken', reason: `its last run did not pass (${now.record?.run?.status ?? 'no run'})` };
	return { ...base, status: 'confirmed', reason: `confirmed by ${rec.by} at ${rec.at}` };
}

/** Every doc scenario's state, in file order. */
export function allStates(folder) {
	const known = currentScenarios(folder);
	const stored = readConfirmations(folder);
	return [...known.keys()].map((id) => scenarioState(folder, id, known, stored));
}

/** Records the writer's confirmation. Returns { ok, message }. */
export function confirm(folder, id, by, at = new Date().toISOString()) {
	const now = currentScenarios(folder).get(id);
	if (!now) return { ok: false, message: `${id}: no doc scenario with this ID in scenarios/*.feature` };
	if (!now.manual && !now.record) return { ok: false, message: `${id}: not confirmed: it has no step record yet; run it first (lm-run)` };
	if (!now.manual && now.record.run?.status !== 'passed') return { ok: false, message: `${id}: not confirmed: its last run did not pass (${now.record.run?.status ?? 'no status'}); a scenario is confirmed only when it runs` };
	const data = readConfirmations(folder);
	data.scenarios[id] = { status: 'confirmed', by, at, ...fingerprintOf(now.scenario, now.manual ? null : now.record) };
	writeConfirmations(folder, data);
	return { ok: true, message: `${id}: confirmed by ${by} at ${at}` };
}

/** Takes a confirmation back: the scenario is a draft again. */
export function unconfirm(folder, id, reason = 'taken back to draft') {
	const data = readConfirmations(folder);
	if (!data.scenarios[id]) return { ok: true, message: `${id}: draft (was not confirmed)` };
	data.scenarios[id] = { status: 'draft', reason, previous: { by: data.scenarios[id].by, at: data.scenarios[id].at } };
	writeConfirmations(folder, data);
	return { ok: true, message: `${id}: draft (${reason})` };
}

/** Marks a scenario broken on purpose (the writer session filed a mismatch as a bug). */
export function markBroken(folder, id, reason, at = new Date().toISOString()) {
	if (!currentScenarios(folder).has(id)) return { ok: false, message: `${id}: no doc scenario with this ID in scenarios/*.feature` };
	const data = readConfirmations(folder);
	data.scenarios[id] = { ...(data.scenarios[id] ?? {}), status: 'broken', reason, brokenAt: at };
	writeConfirmations(folder, data);
	return { ok: true, message: `${id}: broken (${reason})` };
}

/**
 * Stores "broken" for every confirmed scenario whose confirmation no longer holds (a lapse, or a
 * run that did not pass), so it stays broken until the writer confirms it again: a repair, or a
 * text changed back, is never approved by the kit itself. Returns the IDs it marked.
 */
export function recordBreaks(folder, at = new Date().toISOString()) {
	const data = readConfirmations(folder);
	const known = currentScenarios(folder);
	const marked = [];
	for (const [id, rec] of Object.entries(data.scenarios)) {
		if (rec.status !== 'confirmed') continue;
		const state = scenarioState(folder, id, known, data);
		if (state.status !== 'broken') continue;
		data.scenarios[id] = { ...rec, status: 'broken', reason: state.reason, brokenAt: at };
		marked.push(id);
	}
	if (marked.length) writeConfirmations(folder, data);
	return marked;
}
