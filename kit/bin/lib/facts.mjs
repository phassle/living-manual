// What the kit knows about the product from runs (spec: Facts pack). The ONE place the manual,
// the confirmation model and the writer session read product facts from.
//
// The step records are the facts pack's (<product folder>/facts/step-records/<ID>.json, versioned,
// written by lm-facts after every run), overlaid by the latest runs' own records
// (<product folder>/build/runs/<ID>/step-record.json) where those exist: right after a run they
// are the same, and between a run and its lm-facts the run's record is the newer one. Without a
// build folder (a fresh checkout, the writer's machine) the pack alone answers.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The step records the latest runs left in build/runs: Map<ID, record>. */
export function runRecords(folder) {
	const runs = join(folder, 'build/runs');
	if (!existsSync(runs)) return new Map();
	return new Map(readdirSync(runs).sort()
		.filter((d) => existsSync(join(runs, d, 'step-record.json')))
		.map((d) => JSON.parse(readFileSync(join(runs, d, 'step-record.json'), 'utf8')))
		.map((r) => [r.scenario?.id, r]));
}

/** The step records in the facts pack: Map<ID, record>. */
export function packRecords(folder) {
	const file = join(folder, 'facts/pack.json');
	if (!existsSync(file)) return new Map();
	const pack = JSON.parse(readFileSync(file, 'utf8'));
	return new Map(Object.entries(pack.stepRecords ?? {})
		.filter(([, rel]) => existsSync(join(folder, 'facts', rel)))
		.map(([id, rel]) => [id, JSON.parse(readFileSync(join(folder, 'facts', rel), 'utf8'))]));
}

/** Every known step record, the pack's overlaid by the runs', sorted by scenario ID. */
export function allRecords(folder) {
	const merged = new Map([...packRecords(folder), ...runRecords(folder)]);
	return [...merged.keys()].sort().map((id) => merged.get(id));
}

const FIELD_KINDS = new Set(['fill', 'select', 'check']);
const name = (label) => String(label ?? '').replace(/\s*:\s*$/, '').trim();

/**
 * The facts for a product folder: { records, product, productVersion, fieldsOn(screen) }.
 * productVersion is the version of the newest run (null when there is none).
 * fieldsOn(screen) lists the fields the runs used on that screen, first use first:
 * [{ label, kind, value, dataSpecific, scenario, verifiedAt }].
 */
export function loadFacts(folder) {
	const records = allRecords(folder);
	const passed = records.filter((r) => r.run?.status === 'passed');
	const newest = [...passed].sort((a, b) => String(b.run.endedAt).localeCompare(String(a.run.endedAt)))[0];
	return {
		records,
		product: newest?.product ?? records.find((r) => r.product)?.product ?? null,
		productVersion: newest?.productVersion ?? null,
		newestRunAt: newest?.run.endedAt ?? null,
		fieldsOn(screen) {
			const seen = new Map();
			for (const r of passed) for (const s of r.steps) for (const a of s.actions) {
				if (!FIELD_KINDS.has(a.kind) || a.labelSource === 'author') continue;
				if (String(a.screen).toLowerCase() !== screen.toLowerCase()) continue;
				const label = name(a.label);
				if (label && !seen.has(label.toLowerCase())) {
					seen.set(label.toLowerCase(), { label, kind: a.kind, value: a.value ?? null, dataSpecific: !!a.dataSpecific, scenario: r.scenario.id, verifiedAt: r.run.endedAt });
				}
			}
			return [...seen.values()];
		},
	};
}
