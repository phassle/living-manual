// The guide index (spec: Guide): what the guide script needs from the step records, per scenario
// its ID, title, role, start screen (and the route that shows it), and every action's step text,
// wording, locator, label and data-specific flag. Built by bin/lm-build-guide.mjs.
import { scenarioConfirmed } from './publishable.mjs';

/**
 * Whether a scenario is confirmed, so the guide may use it. The guide asks only this; it answers
 * with the manual's own split (bin/lib/publishable.mjs scenarioConfirmed), so the guide index and
 * the published manual hold the same scenarios: confirmed and not lapsed (bin/lib/confirmation.mjs).
 */
export function confirmation(folder) {
	return (id) => scenarioConfirmed(folder, id);
}

const STRING = /^'((?:[^'\\]|\\.)*)'/;
const unq = (s) => s.replace(/\\(.)/g, '$1');

/** Reads one argument list `( … )` of a Playwright locator call: strings, regexes, { key: value } objects. */
function readArgs(src) {
	const args = [];
	let s = src.trimStart();
	if (!s.startsWith('(')) throw new Error(`expected ( in ${src}`);
	s = s.slice(1).trimStart();
	const value = () => {
		let m;
		if ((m = STRING.exec(s))) { s = s.slice(m[0].length).trimStart(); return unq(m[1]); }
		if ((m = /^\/((?:[^/\\]|\\.)+)\/([a-z]*)/.exec(s))) { s = s.slice(m[0].length).trimStart(); return { regex: m[1], flags: m[2] }; }
		if ((m = /^(true|false|-?\d+(?:\.\d+)?)/.exec(s))) { s = s.slice(m[0].length).trimStart(); return JSON.parse(m[1]); }
		if (s.startsWith('{')) {
			s = s.slice(1).trimStart();
			const obj = {};
			while (!s.startsWith('}')) {
				const k = /^(\w+)\s*:\s*/.exec(s);
				if (!k) throw new Error(`cannot read object at ${s}`);
				s = s.slice(k[0].length);
				obj[k[1]] = value();
				if (s.startsWith(',')) s = s.slice(1).trimStart();
			}
			s = s.slice(1).trimStart();
			return obj;
		}
		if (/^[A-Za-z_]\w*\s*\(/.test(s)) { const r = parseChain(s, src); s = r.rest.trimStart(); return { chain: r.chain }; }
		throw new Error(`cannot read argument at ${s}`);
	};
	while (!s.startsWith(')')) {
		args.push(value());
		if (s.startsWith(',')) s = s.slice(1).trimStart();
	}
	return { args, rest: s.slice(1) };
}

/**
 * A recorded Playwright locator expression as a chain the guide script follows in the page:
 * `locator('#list').getByText('Blue', { exact: true })` → [{ css: '#list' }, { text: 'Blue', exact: true }].
 * Also `filter({ hasText })` and a nested `locator(<locator>)` (a `within` scope is a prefix of the
 * same kind). Throws on anything else (and(), or(), filter({ has }) …): the caller then marks the
 * action as not highlightable.
 */
export function locatorChain(expression) {
	const { chain, rest } = parseChain(expression.trim(), expression);
	if (rest.trim()) throw new Error(`cannot read locator ${expression} at ${rest}`);
	return chain;
}

/** Reads calls `.name(…)` from the start of s until the end of an argument; { chain, rest }. */
function parseChain(s, expression) {
	const chain = [];
	s = s.trimStart();
	while (s && !/^[),}]/.test(s)) {
		const m = /^\.?(\w+)/.exec(s);
		if (!m) throw new Error(`cannot read locator ${expression}`);
		const { args, rest } = readArgs(s.slice(m[0].length));
		s = rest.trimStart();
		const [a, opts = {}] = args;
		const name = (n) => (typeof n === 'string' ? { name: n, exact: opts.exact ?? true } : { nameRegex: n });
		switch (m[1]) {
			case 'locator':
				if (typeof a === 'string') chain.push({ css: a });
				else if (a?.chain) chain.push(...a.chain);
				else throw new Error(`the guide cannot follow this locator() in ${expression}`);
				break;
			case 'getByTestId': chain.push({ testId: a }); break;
			case 'getByRole': chain.push({ role: a, ...(opts.name !== undefined ? name(opts.name) : {}) }); break;
			case 'getByText': chain.push(typeof a === 'string' ? { text: a, exact: !!opts.exact } : { textRegex: a }); break;
			case 'getByLabel': chain.push({ label: a, exact: !!opts.exact }); break;
			case 'filter': {
				const keys = a && typeof a === 'object' ? Object.keys(a) : [];
				if (keys.length !== 1 || keys[0] !== 'hasText' || a.hasText?.chain) throw new Error(`the guide cannot follow filter(${keys.join(', ')}) in ${expression}`);
				chain.push(typeof a.hasText === 'string' ? { hasText: a.hasText } : { hasTextRegex: a.hasText });
				break;
			}
			case 'first': break;
			case 'nth': chain.push({ nth: a }); break;
			case 'last': chain.push({ last: true }); break;
			default: throw new Error(`the guide cannot follow ${m[1]}() in ${expression}`);
		}
	}
	return { chain, rest: s };
}

/** The chain, or null when the guide cannot follow the locator (the action is then said in words only). */
const chainOrNull = (expression) => { try { return locatorChain(expression); } catch { return null; } };

const name = (label) => label.replace(/\s*:\s*$/, '');
const q = (s) => `“${s}”`;

/** One action as the guide says it to the user (plain text; the manual's wording without Markdown). */
export function wording(a) {
	const what = a.labelSource === 'author' ? `the ${a.label}` : q(name(a.label));
	const example = (v) => `(in this example ${q(v)})`;
	switch (a.kind) {
		case 'click': return a.labelVisible === false ? `Click ${what} (the marked icon).` : `Click ${what}.`;
		case 'check': return `Tick ${what}.`;
		case 'fill': return `In ${what}, type ${q(a.value)}.`;
		case 'select': return a.dataSpecific ? `In ${what}, choose the one you need ${example(a.value)}.` : `In ${what}, choose ${q(a.value)}.`;
		case 'verify': return a.dataSpecific ? `Check that the result is shown ${example(name(a.label))}.` : `Check that ${what} is shown.`;
		default: return `${a.kind} ${what}.`;
	}
}

/**
 * The route values that name a screen, from a page address. `keys` maps a query key to "value"
 * (compare the value) or "presence" (compare only whether it is set: an open record's id is
 * demo data). Without keys, every non-empty query value counts.
 */
export function routeOf(url, keys) {
	const params = new URL(url).searchParams;
	const out = {};
	for (const [k, v] of params) {
		if (!v) continue;
		const how = keys ? keys[k] : 'value';
		if (how === 'value') out[k] = v;
		else if (how === 'presence') out[k] = true;
	}
	return out;
}

/** One scenario's index entry from its step record. */
export function indexEntry(rec, confirmed, routeKeys) {
	const [first, ...rest] = rec.steps;
	const way = first?.actions ?? [];
	const at = way.at(-1) ?? rest.flatMap((s) => s.actions)[0];
	const actions = rec.steps.flatMap((step, i) => step.actions.map((a) => {
		const chain = chainOrNull(a.locator.expression);
		const optionChain = a.option ? chainOrNull(a.option.expression) : undefined;
		return {
		n: a.n,
		step: step.text,
		wayToStart: i === 0,
		kind: a.kind,
		text: wording(a),
		screen: a.screen,
		label: a.label,
		labelSource: a.labelSource,
		labelVisible: a.labelVisible !== false,
		...(a.value !== undefined ? { value: a.value } : {}),
		dataSpecific: !!a.dataSpecific,
		locator: { strategy: a.locator.strategy, expression: a.locator.expression, chain },
		...(a.option ? { option: { expression: a.option.expression, chain: optionChain } } : {}),
		// false: the guide cannot find the element from the recorded locator; it says the step in words.
		highlightable: chain !== null && optionChain !== null,
		};
	}));
	return {
		id: rec.scenario.id,
		title: rec.scenario.title,
		role: rec.scenario.role,
		startScreen: rec.scenario.startScreen,
		startRoute: at?.url ? routeOf(at.url, routeKeys) : {},
		confirmed,
		productVersion: rec.productVersion ?? null,
		actions,
	};
}
