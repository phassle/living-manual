// The case inventory (facts/cases.json, written by the planner) and the doc scenarios it is
// matched against (scenarios/*.feature). Shared by lm-collect and lm-draft.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFeature } from './gherkin.mjs';

/** Source types a person writes (a stated intent); `app` and `code` only show what the product does. */
export const HUMAN_TYPES = ['manual', 'spec', 'text', 'gherkin', 'recording'];
export const NOTE = 'Note: no human text stated the intent.';

export const inventoryFile = (folder) => join(folder, 'facts/cases.json');

export function readInventory(folder) {
	const file = inventoryFile(folder);
	if (!existsSync(file)) throw new Error(`no case inventory at ${file}; the planner writes it (lm-collect skill)`);
	return JSON.parse(readFileSync(file, 'utf8'));
}

/** Every doc scenario in the folder's scenarios/*.feature: { ...scenario, file (relative) }. */
export function docScenarios(folder) {
	const dir = join(folder, 'scenarios');
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith('.feature')).sort().flatMap((f) =>
		parseFeature(readFileSync(join(dir, f), 'utf8')).scenarios.filter((s) => s.doc).map((s) => ({ ...s, file: `scenarios/${f}` })));
}

/** The scenario's `Sources:` line as [{ type, location }], or null when it has none. */
export function scenarioSources(s) {
	const line = s.description.find((l) => l.startsWith('Sources:'));
	if (!line) return null;
	return line.slice(8).split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
		const [type, ...rest] = p.split(/\s+/);
		return { type, location: rest.join(' ') };
	});
}

/**
 * The ID prefix of an area's scenarios: the product's `idPrefixes[area]` when the config names one
 * ("Shipping and returns" → "SHIP"), else the area's letters: "Order" → "ORDER", "Work orders" → "WORKORDERS".
 */
export const areaPrefix = (area, section = null) => section?.idPrefixes?.[area] ?? area.toUpperCase().replace(/[^A-Z0-9]/g, '');
/** The area's feature file: "Order" → scenarios/order.feature. */
export const areaFeature = (area) => `scenarios/${area.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.feature`;
