// The healer's limits (spec: From scenario to test code, Healer): a repair may change locators and
// waits, and nothing else. This reads a spec's source as what it DOES, leaving out how it finds
// things and how long it waits, and compares two versions of it:
//
// - kept (a change here is a behaviour change): test and step titles, the order and kind of every
//   `lm.*` action, a filled value, the chosen option's name or text, what `lm.see` checks (its
//   text or name), other action options (describe, dataSpecific, commit, keys), every
//   `expect(…)` assertion that was there before (its matcher, `.not` and expected values: one
//   removed, inverted or changed is a behaviour change, even `toBeHidden()` with no value),
//   `page.goto` addresses, calls to the spec's own helper functions, `lm.screen` names, and
//   string constants;
// - left out (free to change): an action's target ({ testId, role, name, text, css }; for
//   lm.see and a select's option only testId, role and css), `within`/`optionWithin`, every
//   `timeout`, the subject of an `expect`, `page.waitFor…`, `.waitFor()`, and an ADDED positive
//   wait (`expect(…).toBeVisible/Hidden/Attached/Enabled/InViewport()` with no expected value
//   and no `.not`): waiting longer for something never weakens what the test checks.
//
// Plain JavaScript/TypeScript tokens are enough: specs are written in the kit's narrow style
// (src/index.ts). A construct the reader does not know is kept as text, so it counts.

const WAITS = new Set(['toBeVisible', 'toBeHidden', 'toBeAttached', 'toBeEnabled', 'toBeInViewport']);
const FREE_OPTIONS = new Set(['within', 'optionWithin', 'timeout']);

/** Tokens: { t: 'str'|'num'|'id'|'p', v (raw text) }, comments and whitespace dropped. */
export function tokenize(src) {
	const out = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) { i++; continue; }
		if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
		if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
		if (c === "'" || c === '"' || c === '`') {
			let j = i + 1;
			let depth = 0;
			for (; j < src.length; j++) {
				if (src[j] === '\\') { j++; continue; }
				if (c === '`' && src[j] === '$' && src[j + 1] === '{') { depth++; j++; continue; }
				if (c === '`' && depth && src[j] === '}') { depth--; continue; }
				if (src[j] === c && !depth) break;
			}
			out.push({ t: 'str', v: src.slice(i, j + 1) });
			i = j + 1;
			continue;
		}
		const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 200));
		if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
		const num = /^\d[\d_.eExXa-fA-F]*/.exec(src.slice(i, i + 50));
		if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
		const p = ['=>', '...', '?.', '===', '!==', '==', '!=', '&&', '||', '??'].find((x) => src.startsWith(x, i)) ?? c;
		out.push({ t: 'p', v: p });
		i += p.length;
	}
	return out;
}

const OPEN = { '(': ')', '[': ']', '{': '}' };
/** Index of the bracket closing the one at toks[i]. */
function closing(toks, i) {
	const stack = [];
	for (let j = i; j < toks.length; j++) {
		const v = toks[j].t === 'p' ? toks[j].v : null;
		if (v && OPEN[v]) stack.push(OPEN[v]);
		else if (v && v === stack.at(-1)) { stack.pop(); if (!stack.length) return j; }
	}
	return toks.length - 1;
}

/** The arguments of the call whose '(' is at toks[i]: arrays of tokens, split at top-level commas. */
function args(toks, i, end = closing(toks, i)) {
	const list = [];
	let cur = [];
	for (let j = i + 1; j < end; j++) {
		const v = toks[j];
		if (v.t === 'p' && OPEN[v.v]) { const e = closing(toks, j); cur.push(...toks.slice(j, e + 1)); j = e; continue; }
		if (v.t === 'p' && v.v === ',') { list.push(cur); cur = []; continue; }
		cur.push(v);
	}
	if (cur.length) list.push(cur);
	return list;
}

const text = (toks) => toks.map((t) => t.v).join(' ');

/** An object literal argument as Map(key → raw value), or null when the argument is not one. */
function object(arg) {
	if (!(arg.length && arg[0].v === '{' && closing(arg, 0) === arg.length - 1)) return null;
	const props = new Map();
	for (const p of args(arg, 0)) {
		if (!p.length) continue;
		const colon = p.findIndex((t) => t.v === ':');
		const key = (colon > 0 ? p[0].v : p[0].v).replace(/^['"]|['"]$/g, '');
		props.set(key, colon > 0 ? text(p.slice(colon + 1)) : key);
	}
	return props;
}

/** An object argument with only `keep` keys (sorted), or with `drop` keys left out. */
function only(arg, { keep, drop }) {
	const o = object(arg);
	if (!o) return keep ? '<target>' : text(arg);
	const entries = [...o].filter(([k]) => (keep ? keep.includes(k) : !drop.has(k))).sort(([a], [b]) => a.localeCompare(b));
	return entries.length ? `{${entries.map(([k, v]) => `${k}:${v}`).join(',')}}` : (keep ? '<target>' : '{}');
}

/** What an lm.* call does, its targets left out. */
function actionArgs(method, list) {
	const opts = (a) => only(a, { drop: FREE_OPTIONS });
	switch (method) {
		case 'click': case 'check': return [`<target>`, ...list.slice(1).map(opts)];
		case 'fill': return ['<target>', list[1] ? text(list[1]) : '', ...list.slice(2).map(opts)];
		case 'select': return ['<target>', list[1] ? only(list[1], { keep: ['name', 'text'] }) : '', ...list.slice(2).map(opts)];
		case 'see': return [list[0] ? only(list[0], { keep: ['name', 'text'] }) : '', ...list.slice(1).map(opts)];
		default: return list.map(text);
	}
}

/**
 * What a spec does: { titles: [test and step titles in order], scopes: [{ name, label, events }] }.
 * A scope is a test.step, a test's own body, or a helper function; an event is
 * { kind: action|assertion|navigation|call|screen|constant, name, detail }.
 */
export function behaviour(src) {
	const toks = tokenize(src);
	const helpers = new Set();
	for (let i = 0; i < toks.length; i++) {
		if (toks[i].v === 'function' && toks[i + 1]?.t === 'id') helpers.add(toks[i + 1].v);
		if (['const', 'let'].includes(toks[i].v) && toks[i + 1]?.t === 'id' && toks[i + 2]?.v === '=') {
			let j = i + 3;
			if (toks[j]?.v === 'async') j++;
			if (toks[j]?.v === '(') { const e = closing(toks, j); if (toks[e + 1]?.v === '=>' && toks[e + 2]?.v === '{') helpers.add(toks[i + 1].v); }
		}
	}
	const titles = [];
	const scopes = [{ name: '(top level)', label: 'the file', events: [], end: toks.length }];
	const stack = [scopes[0]];
	const scope = (i) => { while (stack.length > 1 && stack.at(-1).end < i) stack.pop(); return stack.at(-1); };
	const open = (name, label, end) => { const s = { name, label, events: [], end }; scopes.push(s); stack.push(s); };
	const prev = (i) => toks[i - 1]?.v;
	for (let i = 0; i < toks.length; i++) {
		const tk = toks[i];
		const here = scope(i);
		const emit = (kind, name, detail = '') => here.events.push({ kind, name, detail });
		if (tk.t !== 'id' || prev(i) === '.') continue;
		// test('<title>', …) and test.step('<title>', …)
		if (tk.v === 'test') {
			let j = i + 1;
			let step = false;
			if (toks[j]?.v === '.' && toks[j + 1]?.v === 'step') { step = true; j += 2; }
			if (toks[j]?.v === '(' && toks[j + 1]?.t === 'str') {
				const title = toks[j + 1].v;
				titles.push(`${step ? 'step' : 'test'} ${title}`);
				open(title, step ? `step ${title.replace(/^['"`]|['"`]$/g, '"')}` : `test ${title}`, closing(toks, j));
				i = j + 1;
				continue;
			}
		}
		// function name(…) { … }   const name = async (…) => { … }
		if (tk.v === 'function' && toks[i + 1]?.t === 'id') {
			const name = toks[i + 1].v;
			const p = i + 2;
			const body = closing(toks, p) + 1;
			if (toks[body]?.v === '{') { open(name, name, closing(toks, body)); i = body; continue; }
		}
		if (['const', 'let'].includes(tk.v) && toks[i + 1]?.t === 'id' && toks[i + 2]?.v === '=') {
			const name = toks[i + 1].v;
			if (helpers.has(name)) {
				let j = i + 3;
				if (toks[j]?.v === 'async') j++;
				const body = closing(toks, j) + 2;
				open(name, name, closing(toks, body));
				i = body;
				continue;
			}
			if (here === scopes[0] && toks[i + 3]?.t === 'str' && [';', undefined].includes(toks[i + 4]?.v)) { emit('constant', name, toks[i + 3].v); i += 3; continue; }
		}
		// lm.<method>(…)
		if (tk.v === 'lm' && toks[i + 1]?.v === '.' && toks[i + 2]?.t === 'id' && toks[i + 3]?.v === '(') {
			const method = toks[i + 2].v;
			const end = closing(toks, i + 3);
			const list = args(toks, i + 3, end);
			if (method === 'screen') emit('screen', 'lm.screen', list.map(text).join(', '));
			else emit('action', `lm.${method}`, actionArgs(method, list).join(' | '));
			i = end;
			continue;
		}
		// expect(subject)[.not].matcher(…)
		if (tk.v === 'expect' && toks[i + 1]?.v === '(') {
			let j = closing(toks, i + 1) + 1;
			const chain = [];
			while (toks[j]?.v === '.' && toks[j + 1]?.t === 'id') { chain.push(toks[j + 1].v); j += 2; }
			if (toks[j]?.v === '(' && chain.length) {
				const end = closing(toks, j);
				const list = args(toks, j, end).map((a) => only(a, { drop: FREE_OPTIONS }));
				const matcher = chain.at(-1);
				const expected = list.filter((a) => a !== '{}');
				const isWait = WAITS.has(matcher) && !chain.includes('not') && args(toks, j, end).every((a) => object(a));
				here.events.push({ kind: 'assertion', name: chain.join('.'), detail: expected.join(' | '), ...(isWait ? { wait: true } : {}) });
				i = end;
				continue;
			}
		}
		// page.goto(url)
		if (toks[i + 1]?.v === '.' && toks[i + 2]?.v === 'goto' && toks[i + 3]?.v === '(') {
			const end = closing(toks, i + 3);
			emit('navigation', 'goto', args(toks, i + 3, end).slice(0, 1).map(text).join(''));
			i = end;
			continue;
		}
		// a helper of this spec
		if (helpers.has(tk.v) && toks[i + 1]?.v === '(' && prev(i) !== 'function') {
			const end = closing(toks, i + 1);
			emit('call', tk.v);
			i = end;
		}
	}
	return { titles, scopes: scopes.map(({ end, ...s }) => s) };
}

const key = (e) => `${e.kind} ${e.name} ${e.detail}`;
const what = (e) => (e.kind === 'action' || e.kind === 'call' ? e.name : `${e.name}${e.detail ? ` ${e.detail}` : ''}`);
const noun = { action: 'action', assertion: 'assertion', navigation: 'navigation', call: 'helper call', screen: 'screen name', constant: 'constant' };

/** Longest common subsequence of two key lists, as [indexes in a, indexes in b]. */
function lcs(a, b) {
	const m = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) m[i][j] = a[i] === b[j] ? m[i + 1][j + 1] + 1 : Math.max(m[i + 1][j], m[i][j + 1]);
	const ia = new Set(), ib = new Set();
	for (let i = 0, j = 0; i < a.length && j < b.length;) {
		if (a[i] === b[j]) { ia.add(i++); ib.add(j++); } else if (m[i + 1][j] >= m[i][j + 1]) i++; else j++;
	}
	return [ia, ib];
}

/** The differences between two event lists of one scope, as sentences. */
function scopeChanges(label, a, b) {
	const ka = a.map(key), kb = b.map(key);
	if (ka.join('\n') === kb.join('\n')) return [];
	const where = label === 'the file' ? 'at the top of the file' : `in ${label}`;
	if (ka.length === kb.length && [...ka].sort().join('\n') === [...kb].sort().join('\n')) return [`actions reordered ${where}`];
	const [ia, ib] = lcs(ka, kb);
	const removed = a.filter((_, i) => !ia.has(i));
	// An added positive wait is free, unless it stands in for an assertion that went: every other
	// addition, and every removal, counts. A removed assertion paired with an added one is a change.
	const replaced = removed.some((r) => r.kind === 'assertion');
	const added = b.filter((x, i) => !ib.has(i) && !(x.wait && !replaced));
	if (!removed.length && !added.length) return [];
	const out = [];
	for (const r of removed) {
		const k = added.findIndex((x) => x.kind === r.kind && (x.name === r.name || r.kind === 'assertion'));
		if (k >= 0) { const [x] = added.splice(k, 1); out.push(`${noun[r.kind]} changed ${where}: ${what(r)} → ${what(x)}`); }
		else out.push(`${noun[r.kind]} removed ${where}: ${what(r)}`);
	}
	for (const x of added) out.push(`${noun[x.kind]} added ${where}: ${what(x)}`);
	return out;
}

/**
 * Compares a spec before and after a repair: { verdict: 'no change'|'locator/wait only'|
 * 'behaviour change', reasons: [sentences] }.
 */
export function classifyHeal(before, after) {
	if (before === after) return { verdict: 'no change', reasons: [] };
	const a = behaviour(before), b = behaviour(after);
	const reasons = [];
	if (a.titles.join('\n') !== b.titles.join('\n')) {
		const [ia, ib] = lcs(a.titles, b.titles);
		const gone = a.titles.filter((_, i) => !ia.has(i)), come = b.titles.filter((_, i) => !ib.has(i));
		reasons.push(`step title changed: ${gone.join(', ') || '(none)'} → ${come.join(', ') || '(none)'}`);
	} else {
		const names = (x) => x.scopes.map((s) => s.name).join('\n');
		if (names(a) !== names(b)) reasons.push('helper functions added or removed');
		else a.scopes.forEach((s, i) => reasons.push(...scopeChanges(s.label, s.events, b.scopes[i].events)));
	}
	return reasons.length ? { verdict: 'behaviour change', reasons } : { verdict: 'locator/wait only', reasons: [] };
}

/**
 * Compares a feature file before and after: the healer may only add a @broken tag (its stop
 * protocol). Returns sentences for anything else.
 */
export function featureChanges(before, after) {
	if (before === after) return [];
	const strip = (s) => s.split('\n').map((l) => l.replace(/\s@broken\b/g, '').replace(/^(\s*)@broken\s+/, '$1')).join('\n');
	return strip(before) === strip(after) ? [] : ['the feature file changed beyond a @broken tag'];
}
