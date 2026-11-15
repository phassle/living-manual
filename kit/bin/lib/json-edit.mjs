// Edits a JSON file in place without touching the bytes of anything that did not change, so a
// second product's section leaves the first one byte-identical, hand edits included. `format`
// writes new values in the configuration's own style: tabs, short flat objects and arrays of
// plain values on one line.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPlain = (v) => v === null || typeof v !== 'object';
const flat = (v) => isPlain(v) || (Array.isArray(v) && v.every(isPlain));

export const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Formats a value whose key sits at indentation `indent`. */
export function format(v, indent = '') {
	if (isPlain(v)) return JSON.stringify(v);
	const inner = indent + '\t';
	if (Array.isArray(v)) {
		if (v.length === 0) return '[]';
		if (v.every(isPlain)) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
		return `[\n${v.map((x) => inner + format(x, inner)).join(',\n')}\n${indent}]`;
	}
	const entries = Object.entries(v);
	if (entries.length === 0) return '{}';
	if (entries.length <= 3 && entries.every(([, x]) => flat(x)))
		return `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${format(x)}`).join(', ')} }`;
	return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${format(x, inner)}`).join(',\n')}\n${indent}}`;
}

/** Parses JSON text into a tree of positions: objects carry `keys`, a Map of key → { keyStart, node }. */
export function locate(text) {
	JSON.parse(text); // a clear error for a broken file, before positions are needed
	let i = 0;
	const ws = () => { while (/\s/.test(text[i] ?? '')) i++; };
	const str = () => { const s = i++; while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1; i++; return JSON.parse(text.slice(s, i)); };
	const value = () => {
		ws();
		const start = i;
		if (text[i] === '{') {
			i++; const keys = new Map(); ws();
			if (text[i] === '}') { i++; return { type: 'object', start, end: i, keys }; }
			for (;;) {
				ws(); const keyStart = i; const key = str(); ws(); i++; // ':'
				keys.set(key, { keyStart, node: value() }); ws();
				if (text[i++] === '}') return { type: 'object', start, end: i, keys };
			}
		}
		if (text[i] === '[') {
			i++; const items = []; ws();
			if (text[i] === ']') { i++; return { type: 'array', start, end: i, items }; }
			for (;;) { items.push(value()); ws(); if (text[i++] === ']') return { type: 'array', start, end: i, items }; }
		}
		if (text[i] === '"') { str(); return { type: 'string', start, end: i }; }
		i += /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i))[0].length;
		return { type: 'literal', start, end: i };
	};
	return value();
}

const lineIndent = (text, pos) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', pos - 1) + 1))[0];

/**
 * The edits that turn `node` (holding `oldVal`) into `newVal`: unchanged keys keep their bytes,
 * a changed object is patched key by key when it is laid out over several lines and no key was
 * dropped, anything else is rewritten whole, new keys go after the last one.
 */
function patch(text, node, oldVal, newVal, indent, edits) {
	const recurse = node.type === 'object' && isObject(oldVal) && isObject(newVal) && node.keys.size > 0
		&& text.slice(node.start, node.end).includes('\n')
		&& Object.keys(oldVal).every((k) => k in newVal);
	if (!recurse) { edits.push({ start: node.start, end: node.end, text: format(newVal, indent) }); return; }
	const keyIndent = lineIndent(text, [...node.keys.values()][0].keyStart);
	let last = null;
	for (const [k, entry] of node.keys) {
		last = entry;
		if (!deepEqual(oldVal[k], newVal[k])) patch(text, entry.node, oldVal[k], newVal[k], keyIndent, edits);
	}
	const added = Object.keys(newVal).filter((k) => !node.keys.has(k));
	if (added.length) edits.push({
		start: last.node.end, end: last.node.end,
		text: added.map((k) => `,\n${keyIndent}${JSON.stringify(k)}: ${format(newVal[k], keyIndent)}`).join(''),
	});
}

/** Sets `obj[path[0]][path[1]]… = value` in the JSON text; missing parents are created. */
export function setPath(text, path, value) {
	const old = JSON.parse(text);
	const next = structuredClone(old);
	let o = next;
	for (const k of path.slice(0, -1)) o = (isObject(o[k]) ? o[k] : (o[k] = {}));
	o[path.at(-1)] = value;
	const edits = [];
	patch(text, locate(text), old, next, '', edits);
	return applyEdits(text, edits);
}

function applyEdits(text, edits) {
	for (const e of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
	return text;
}
