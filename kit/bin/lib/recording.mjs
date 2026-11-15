// A Playwright codegen recording (`npx playwright codegen`, the .ts it writes) read as actions and
// turned into one intent-level draft scenario (spec: Starting material from the writer). Only the
// lines codegen writes are understood: `await page.<locator chain>.<action>(…);` and
// `await expect(page.<locator chain>).<matcher>(…);`. Anything else is reported, never guessed.
import { buttonIntent } from './intent.mjs';

/** Reads a JavaScript literal list: strings, numbers, booleans, regexes and flat { key: value } objects. */
function parseArgs(src) {
	let i = 0;
	const ws = () => { while (/\s/.test(src[i] ?? '')) i++; };
	const value = () => {
		ws();
		const c = src[i];
		if (c === "'" || c === '"' || c === '`') {
			let out = ''; i++;
			while (i < src.length && src[i] !== c) { if (src[i] === '\\') { i++; out += { n: '\n', t: '\t' }[src[i]] ?? src[i]; } else out += src[i]; i++; }
			i++;
			return out;
		}
		if (c === '/') { const m = /^\/((?:\\.|[^/])+)\/([a-z]*)/.exec(src.slice(i)); i += m[0].length; return new RegExp(m[1], m[2]); }
		if (c === '{') {
			i++; const obj = {};
			for (ws(); src[i] !== '}'; ws()) {
				const k = /^['"]?([\w$]+)['"]?\s*:/.exec(src.slice(i)); i += k[0].length;
				obj[k[1]] = value(); ws(); if (src[i] === ',') i++;
			}
			i++;
			return obj;
		}
		if (c === '[') { i++; const arr = []; for (ws(); src[i] !== ']'; ws()) { arr.push(value()); ws(); if (src[i] === ',') i++; } i++; return arr; }
		const m = /^[^,)}\]\s]+/.exec(src.slice(i)); i += m[0].length;
		return m[0] === 'true' ? true : m[0] === 'false' ? false : Number.isNaN(Number(m[0])) ? m[0] : Number(m[0]);
	};
	const out = [];
	for (ws(); i < src.length; ws()) { out.push(value()); ws(); if (src[i] === ',') i++; }
	return out;
}

/** `a(x).b(y)` → [{ name: 'a', args: [x] }, { name: 'b', args: [y] }], reading from `pos`; also returns where it stopped. */
function parseChain(src, pos = 0) {
	const calls = [];
	let i = pos;
	for (;;) {
		const m = /^\.?([\w$]+)\(/.exec(src.slice(i));
		if (!m) break;
		i += m[0].length;
		const start = i;
		let depth = 1, quote = null;
		for (; i < src.length && depth; i++) {
			const c = src[i];
			if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; }
			else if (c === "'" || c === '"' || c === '`') quote = c;
			else if (c === '(') depth++;
			else if (c === ')') depth--;
		}
		calls.push({ name: m[1], args: parseArgs(src.slice(start, i - 1)) });
	}
	return { calls, end: i };
}

const LOCATORS = new Set(['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'getByTitle', 'getByAltText', 'locator', 'filter', 'first', 'last', 'nth', 'frameLocator', 'contentFrame']);
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox']);
const str = (v) => (v instanceof RegExp ? v.source : v == null ? null : String(v));

/** What a locator chain points at: { role, name, field (a field's label), css, key (to compare chains) }. */
function target(calls, key) {
	const t = { role: null, name: null, field: null, css: null, testId: null, key };
	for (const c of calls) {
		const [a, b] = c.args;
		if (c.name === 'getByRole') { t.role = a; if (str(b?.name)) { t.name = str(b.name); if (FIELD_ROLES.has(a)) t.field = t.name; } }
		else if (c.name === 'getByLabel') { t.role = null; t.name = t.field = str(a); }
		else if (c.name === 'getByPlaceholder') { t.role = null; t.name = t.field = str(a); }
		else if (c.name === 'getByText' || c.name === 'getByTitle' || c.name === 'getByAltText') { t.role = null; t.name = str(a); }
		// A test ID is for code, not for people: it names nothing a step could say.
		else if (c.name === 'getByTestId') { t.role = null; t.testId = str(a); t.name = t.field = null; }
		else if (c.name === 'locator') { t.css = str(a); }
		else if (c.name === 'filter' && str(a?.hasText)) t.name ??= str(a.hasText);
	}
	return t;
}

/** The recording's lines as actions: { line, code, page|expect, target, action, args, not }. */
export function readRecording(text) {
	const actions = [];
	text.split(/\r?\n/).forEach((raw, idx) => {
		const code = raw.trim();
		let m;
		if ((m = /^await expect\((\w+)\./.exec(code))) {
			const { calls, end } = parseChain(code, m[0].length - 1);
			const rest = parseChain(code.slice(end).replace(/^\)/, ''), 0).calls;
			const not = rest[0]?.name === 'not';
			const matcher = rest[not ? 1 : 0];
			actions.push({ line: idx + 1, code, expect: true, target: target(calls.filter((c) => LOCATORS.has(c.name)), code.slice(m[0].length, end)), action: matcher?.name, args: matcher?.args ?? [], not });
		} else if ((m = /^await (\w+)\./.exec(code))) {
			const { calls } = parseChain(code, m[0].length - 1);
			const act = calls.at(-1);
			if (!act) return;
			const loc = calls.slice(0, -1);
			actions.push({ line: idx + 1, code, target: target(loc, JSON.stringify(loc)), action: act.name, args: act.args });
		} else if (/^(await |const |\w+\.(once|on)\()/.test(code)) actions.push({ line: idx + 1, code, action: null });
	});
	return actions;
}

const q = (s) => `"${s}"`;
const lc = (s) => s.replace(/:$/, '').trim().toLowerCase();

/** The step for one action: { kind, text } | { drop: reason } | { open: question }. */
function stepFor(a, next) {
	const t = a.target ?? {};
	const name = t.name;
	if (a.expect) {
		const v = str(a.args[0]);
		if (a.action === 'toBeVisible' && name) return { kind: 'Then', text: a.not ? `${q(name)} is no longer shown` : `${q(name)} is shown` };
		if ((a.action === 'toContainText' || a.action === 'toHaveText') && v) return { kind: 'Then', text: `${q(v)} is shown` };
		if (a.action === 'toHaveValue' && v && t.field) return { kind: 'Then', text: `the ${lc(t.field)} shows ${q(v)}` };
		if (a.action === 'toBeChecked' && name) return { kind: 'Then', text: `${q(name)} is ${a.not ? 'off' : 'on'}` };
		return { open: `line ${a.line}: cannot say what "${a.code}" shows; ask the writer what the user sees` };
	}
	switch (a.action) {
		case 'click': case 'dblclick': {
			if (next && next.target?.key === t.key && ['fill', 'press', 'selectOption', 'pressSequentially', 'type'].includes(next.action)) return { drop: 'the click into a field before typing is no step' };
			if (t.role === 'tab' && name) return { kind: 'When', text: `I open the ${name} tab` };
			if ((t.role === 'checkbox' || t.role === 'switch') && name) return { kind: 'When', text: `I turn on ${q(name)}` };
			if (['radio', 'option', 'menuitem', 'menuitemradio', 'menuitemcheckbox'].includes(t.role) && name) return { kind: 'When', text: `I choose ${q(name)}` };
			if (t.role === 'button' && name) { const text = buttonIntent(name); if (text) return { kind: 'When', text }; }
			if (name && t.role !== 'button') return { kind: 'When', text: `I open ${q(name)}` };
			return { open: `line ${a.line}: "${a.code}" names the element ${t.testId ? `only by its test ID (${t.testId})` : 'by no name a user sees'}; ask the writer what the user wants done` };
		}
		case 'fill': case 'pressSequentially': case 'type': {
			if (next && next.target?.key === t.key && ['fill', 'pressSequentially', 'type'].includes(next.action)) return { drop: 'only the last text typed into a field counts' };
			const v = str(a.args[0]);
			if (!t.field && t.testId) return { open: `line ${a.line}: "${a.code}" names the field only by its test ID (${t.testId}); ask the writer which field it is` };
			return { kind: 'When', text: t.field ? `I set the ${lc(t.field)} to ${q(v)}` : `I enter ${q(v)}` };
		}
		case 'press': return { drop: 'a key press is no step' };
		case 'hover': case 'focus': case 'blur': case 'scrollIntoViewIfNeeded': return { drop: `${a.action} is no step` };
		case 'selectOption': {
			const v0 = Array.isArray(a.args[0]) ? a.args[0][0] : a.args[0];
			const v = str(v0?.label ?? v0?.value ?? v0);
			return { kind: 'When', text: t.field ? `I choose the ${lc(t.field)} ${q(v)}` : `I choose ${q(v)}` };
		}
		case 'check': case 'uncheck': return name ? { kind: 'When', text: `I turn ${a.action === 'check' ? 'on' : 'off'} ${q(name)}` } : { open: `line ${a.line}: "${a.code}" names no option` };
		case 'setInputFiles': return { open: `line ${a.line}: choosing a file on the user's computer cannot run; ask the writer whether this task is @manual` };
		default: return { drop: 'not a step of the task' };
	}
}

/**
 * The draft scenario for a recording: { steps: [{ kind, text }], corrections, start }. `role` and
 * `screen` give the first step (codegen records neither); without them it is an open question.
 */
export function fromRecordingText(text, { role, screen, startStep }) {
	const actions = readRecording(text);
	const corrections = [];
	const steps = [];
	let started = false;
	for (let i = 0; i < actions.length; i++) {
		const a = actions[i];
		if (a.action === null) { corrections.push({ rule: 'intent level', line: a.line, before: a.code, after: null, reason: 'not a step of the task' }); continue; }
		if (!started && a.action === 'goto') {
			started = true;
			if (role && screen) {
				steps.push({ kind: 'Given', text: startStep(role, screen) });
				corrections.push({ rule: 'role and start screen in the first step', line: a.line, before: a.code, after: `Given ${startStep(role, screen)}` });
			} else corrections.push({ rule: 'role and start screen in the first step', line: a.line, before: a.code, after: null, open: true,
				question: `name the ${role ? 'start screen' : screen ? 'role' : 'role and the start screen'} (--role, --screen): the recording starts at ${a.args[0]}` });
			continue;
		}
		const s = stepFor(a, actions[i + 1]);
		if (s.drop) corrections.push({ rule: 'intent level', line: a.line, before: a.code, after: null, reason: s.drop });
		else if (s.open) corrections.push({ rule: 'intent level', line: a.line, before: a.code, after: null, open: true, question: s.open });
		else { steps.push(s); corrections.push({ rule: 'intent level', line: a.line, before: a.code, after: null, step: steps.length - 1 }); }
	}
	if (!steps.length || steps.at(-1).kind !== 'Then')
		corrections.push({ rule: 'final step asserts the visible result', before: null, after: null, open: true,
			question: 'the recording asserts nothing: record what the user sees at the end (the recorder\'s "Assert visibility" or "Assert text"), or add a final Then' });
	return { steps, corrections };
}
