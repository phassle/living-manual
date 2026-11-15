// A feature's prose file (spec: Manual generation, Writer story 27): the writer's concepts and
// business rules, in Markdown. Front matter (`key: value` lines between `---`) holds `feature` and
// `status` (draft | confirmed). Each `## Heading` starts a section a page in the page plan can name.
import { readFileSync } from 'node:fs';

/** Splits `---` front matter from a Markdown text. Values are JSON when they parse, else text. */
export function frontMatter(text) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!m) return { data: {}, body: text };
	const data = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([\w-]+):\s*(.*)$/.exec(line);
		if (!kv) continue;
		try { data[kv[1]] = JSON.parse(kv[2]); } catch { data[kv[1]] = kv[2]; }
	}
	return { data, body: text.slice(m[0].length) };
}

/** Reads a prose file: { data, title, sections: Map<heading, body> } (bodies trimmed, in file order). */
export function readProse(file) {
	const { data, body } = frontMatter(readFileSync(file, 'utf8'));
	const sections = new Map();
	let title = null, current = null, inFence = false;
	for (const line of body.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		const h1 = !inFence && /^#\s+(.*\S)\s*$/.exec(line);
		const h2 = !inFence && /^##\s+(.*\S)\s*$/.exec(line);
		if (h1 && title === null && !current) { title = h1[1]; continue; }
		if (h2) { current = h2[1]; sections.set(current, []); continue; }
		if (current) sections.get(current).push(line);
	}
	for (const [k, v] of sections) sections.set(k, v.join('\n').trim());
	return { data, title, sections };
}

/** Finds a section by heading, ignoring case and surrounding space. */
export function section(prose, heading) {
	const want = heading.trim().toLowerCase();
	for (const [k, v] of prose.sections) if (k.trim().toLowerCase() === want) return v;
	return null;
}
