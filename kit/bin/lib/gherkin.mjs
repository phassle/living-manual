// A small reader for the kit's doc scenarios: tags, scenario titles and step texts. It reads only
// what the kit needs (no examples tables or doc strings are interpreted; their lines are skipped).
const STEP = /^\s*(Given|When|Then|And|But|\*)\s+(.*\S)\s*$/;
const SCENARIO = /^\s*Scenario(?: Outline)?:\s*(.*\S)\s*$/;
const FEATURE = /^\s*Feature:\s*(.*\S)\s*$/;
export const ID_TAG = /^@([A-Z][A-Z0-9]*-\d+)$/;

/**
 * Parses a .feature text into { feature, tags, scenarios: [{ title, tags, id, doc, line, description, steps:
 * [{ keyword, text, line }] }] }. Feature-level tags are inherited by every scenario.
 */
export function parseFeature(text) {
	const out = { feature: null, tags: [], scenarios: [] };
	let pending = [];
	let current = null;
	let inDocString = false;
	text.split(/\r?\n/).forEach((raw, i) => {
		const line = raw.trim();
		if (line.startsWith('"""') || line.startsWith('```')) { inDocString = !inDocString; return; }
		if (inDocString || line === '' || line.startsWith('#') || line.startsWith('|')) return;
		if (line.startsWith('@')) { pending.push(...line.split(/\s+/).filter((t) => t.startsWith('@'))); return; }
		let m;
		if ((m = FEATURE.exec(line))) { out.feature = m[1]; out.tags = pending; pending = []; return; }
		if ((m = SCENARIO.exec(line))) {
			const tags = [...out.tags, ...pending];
			pending = [];
			const id = tags.map((t) => ID_TAG.exec(t)?.[1]).find(Boolean) ?? null;
			current = { title: m[1], tags, id, doc: tags.includes('@doc'), line: i + 1, description: [], steps: [] };
			out.scenarios.push(current);
			return;
		}
		if (current && (m = STEP.exec(line))) current.steps.push({ keyword: m[1], text: m[2], line: i + 1 });
		else if (current && !current.steps.length) current.description.push(line); // free text between Scenario: and the first step
	});
	return out;
}
