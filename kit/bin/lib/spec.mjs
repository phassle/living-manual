// Reads a generated Playwright spec as text: each test's title and its test.step() titles, in
// source order. Titles must be plain string literals (a template literal with ${} is refused),
// so the binding between scenario and test can be checked without running anything.

/** Reads the string literal starting at src[i]; returns { value, end } or null. */
function literal(src, i) {
	const q = src[i];
	if (q !== "'" && q !== '"' && q !== '`') return null;
	let value = '';
	for (let j = i + 1; j < src.length; j++) {
		const c = src[j];
		if (c === '\\') {
			const n = src[++j];
			value += n === 'n' ? '\n' : n === 't' ? '\t' : n;
			continue;
		}
		if (q === '`' && c === '$' && src[j + 1] === '{') return { value: null, end: j };
		if (c === q) return { value, end: j + 1 };
		value += c;
	}
	return null;
}

const CALL = /(?<![\w.$])test(\.step|\.only|\.skip|\.fixme|\.fail)?\s*\(\s*/g;

/** Returns [{ title, line, steps: [{ title, line }] }] for the tests in a spec's source. */
export function parseSpec(src) {
	const tests = [];
	const lineOf = (i) => src.slice(0, i).split('\n').length;
	for (const m of src.matchAll(CALL)) {
		const lit = literal(src, m.index + m[0].length);
		if (!lit) continue;
		const title = lit.value ?? '<template literal with ${}>';
		if (m[1] === '.step') tests.at(-1)?.steps.push({ title, line: lineOf(m.index) });
		else tests.push({ title, line: lineOf(m.index), steps: [] });
	}
	return tests;
}
