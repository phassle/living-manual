// The writer's material turned into draft doc scenarios (spec: Starting material from the writer).
// Four inputs: Gherkin (checked against the scenario rules and corrected), plain text and manual
// pages (procedures: a heading, numbered steps, then what the user sees), and a Playwright codegen
// recording. Each gives drafts { title, sourceRef, tags, description, steps: [{ keyword, text }] }
// and the corrections made on the way: { rule, before, after, open? } (open: the writer must answer).
// Every step goes through intent.mjs, so the drafts are intent level whatever the input.
import { parseFeature, ID_TAG } from './gherkin.mjs';
import { buttonIntent, firstPerson, rewrite, uiWords } from './intent.mjs';
import { fromRecordingText } from './recording.mjs';
import { sentences } from './procedures.mjs';

const SUFFIX = /\s+(?:page|screen|view|window)$/i;
const ROLE_PATTERNS = [
	/^I am (?:logged|signed) in as an? (.+)$/i,
	/^(?:the )?user is (?:logged|signed) in as an? (.+)$/i,
	/^(?:the )?user is an? (.+)$/i,
	/^as an? (.+)$/i,
	/^I am an? ((?:(?!\bon the\b).)+)$/i,
];
const SCREEN_PATTERNS = [
	/^I am on the (.+)$/i,
	/^(?:the )?user is on the (.+)$/i,
	/^I (?:open|navigate to|go to|start on|start from|start at) the (.+)$/i,
	/^(?:the )?(.+?) is open$/i,
];
const first = (patterns, text) => { for (const p of patterns) { const m = p.exec(text); if (m) return m[1].trim(); } return null; };
export const startStep = (role, screen) => `I am ${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${role} on the ${screen}`;

/** Gives each step its keyword again: Given first, then When/Then, And where the kind repeats. */
function keywords(steps) {
	let prev = null;
	return steps.map((s, i) => {
		const kind = i === 0 ? 'Given' : s.kind;
		const keyword = kind === prev ? 'And' : kind;
		prev = kind;
		return { keyword, text: s.text };
	});
}

/** One scenario as .feature text (two-space indent under the Feature). */
export function renderScenario(d) {
	return [
		`  ${d.tags.join(' ')}`,
		`  Scenario: ${d.title}`,
		...d.description.map((l) => `    ${l}`),
		...d.steps.map((s) => `    ${s.keyword} ${s.text}`),
	].join('\n');
}

/**
 * Brings steps to intent level, one by one: { steps (kind, text), corrections }. A step that cannot
 * be brought there stays as it is, with an open correction for the writer session.
 */
function intentSteps(steps, label) {
	const out = [], corrections = [];
	for (const s of steps) {
		const words = uiWords(s.text);
		const third = /^(?:the )?user\b/i.test(s.text);
		if (!words.length && !third) { out.push(s); continue; }
		const r = rewrite(s.text);
		if (r?.drop) { corrections.push({ rule: 'intent level', before: label(s), after: null }); continue; }
		if (!r || (r.text === s.text && words.length)) {
			corrections.push({ rule: 'intent level', before: label(s), after: null, open: true, question: `step "${s.text}": cannot write it at intent level; ask the writer what the user wants done` });
			out.push(s);
			continue;
		}
		out.push({ ...s, text: r.text });
		if (r.text !== s.text) corrections.push({ rule: 'intent level', before: label(s), after: `${s.keyword} ${r.text}`, fix: s });
	}
	return { steps: out, corrections };
}

/**
 * The writer's Gherkin, checked against the scenario rules and corrected. `nextId()` gives the next
 * free ID; `role`/`screen` fill in what the first step does not say. Returns drafts, each with its
 * corrections in the order the rules are listed in the spec.
 */
export function fromGherkin(text, { source, role: defaultRole, screen: defaultScreen, nextId, docInherited }) {
	const parsed = parseFeature(text);
	return parsed.scenarios.map((sc) => {
		const corrections = [];
		const ref = `gherkin ${source}:${sc.line}`;
		let id = sc.id;
		if (!id) { id = nextId(); corrections.push({ rule: 'stable ID', before: null, after: `@${id}` }); }
		const kept = sc.tags.filter((t) => t !== '@doc' && t !== '@draft' && t !== '@confirmed' && !ID_TAG.test(t) && !parsed.tags.includes(t));
		if (!docInherited && !sc.tags.includes('@doc')) corrections.push({ rule: '@doc tag', before: null, after: '@doc' });
		if (!sc.tags.includes('@draft')) corrections.push({ rule: 'draft until the writer confirms', before: sc.tags.includes('@confirmed') ? '@confirmed' : null, after: '@draft' });
		const description = sc.description.filter((l) => !l.startsWith('Sources:'));
		const oldSources = sc.description.find((l) => l.startsWith('Sources:'));
		const sources = oldSources ? `${oldSources}; ${ref}` : `Sources: ${ref}`;
		corrections.push({ rule: 'source reference', before: oldSources ?? null, after: sources });

		// Effective kinds: And/But take the kind of the step before.
		let kind = 'Given';
		let steps = sc.steps.map((s) => { if (!['And', 'But', '*'].includes(s.keyword)) kind = s.keyword; return { kind, keyword: s.keyword, text: s.text }; });
		const label = (s) => `${s.keyword} ${s.text}`;

		// Role and start screen: from the leading Given steps, merged into one.
		const lead = [];
		for (const s of steps) { if (s.kind !== 'Given') break; lead.push(s); }
		let role = null, screen = null;
		const used = new Set();
		for (const s of lead) {
			const both = /^I am an? (.+?) on the (.+)$/i.exec(s.text);
			if (both) { role ??= both[1]; screen ??= both[2]; used.add(s); continue; }
			const r = first(ROLE_PATTERNS, s.text), sc2 = first(SCREEN_PATTERNS, s.text);
			if (r && !role) { role = r; used.add(s); } else if (sc2 && !screen) { screen = sc2; used.add(s); }
		}
		const notes = [];
		if (!role && defaultRole) { role = defaultRole; notes.push(`role from --role: ${defaultRole}`); }
		if (!screen && defaultScreen) { screen = defaultScreen; notes.push(`start screen from --screen: ${defaultScreen}`); }
		if (screen) screen = screen.replace(SUFFIX, '');
		const before = [...used].map(label).join(' / ');
		if (role && screen) {
			const start = startStep(role, screen);
			const unchanged = used.size === 1 && [...used][0].text === start && !notes.length;
			steps = [{ kind: 'Given', text: start }, ...steps.filter((s) => !used.has(s))];
			if (!unchanged) corrections.push({ rule: 'role and start screen in the first step', before: `${before || '(none)'}${notes.length ? ` (${notes.join('; ')})` : ''}`, after: `Given ${start}` });
		} else {
			corrections.push({ rule: 'role and start screen in the first step', before: before || null, after: null, open: true,
				question: `name the ${role ? 'start screen' : screen ? 'role' : 'role and the start screen'} ("I am a <role> on the <screen>")` });
		}

		const intent = intentSteps(steps.slice(1), label);
		corrections.push(...intent.corrections.map(({ fix, ...c }) => c));
		steps = [steps[0], ...intent.steps];

		const lastStep = steps.at(-1);
		if (steps.length > 1 && lastStep.kind !== 'Then') {
			const was = lastStep.keyword ? label(lastStep) : `${lastStep.kind} ${lastStep.text}`;
			if (!firstPerson(lastStep.text)) {
				lastStep.kind = 'Then';
				corrections.push({ rule: 'final step asserts the visible result', before: was, after: `Then ${lastStep.text}` });
			} else corrections.push({ rule: 'final step asserts the visible result', before: was, after: null, open: true, question: 'add a final Then that says what the user sees' });
		}
		return { id, title: sc.title, sourceRef: ref, tags: [`@${id}`, '@draft', ...kept, ...(!docInherited ? ['@doc'] : [])], description: [sources, ...description], steps: keywords(steps), corrections };
	});
}

/** A recording's title from its file name: "new-order.ts" → "New order". */
const titleOf = (file) => { const b = file.split(/[\\/]/).pop().replace(/\.(spec\.)?[jt]s$/, '').replace(/[-_]+/g, ' ').trim(); return b[0].toUpperCase() + b.slice(1); };

/** A Playwright codegen recording as one draft. */
export function fromRecording(text, { source, role, screen, title, nextId, docInherited }) {
	const id = nextId();
	const r = fromRecordingText(text, { role, screen, startStep });
	const steps = keywords(r.steps);
	// Each recorded line that became a step shows the step's final keyword.
	const corrections = r.corrections.map(({ step, ...c }) => (step === undefined ? c : { ...c, after: `${steps[step].keyword} ${steps[step].text}` }));
	for (const s of steps.slice(1)) {
		const w = uiWords(s.text);
		if (w.length) corrections.push({ rule: 'intent level', before: `${s.keyword} ${s.text}`, after: null, open: true, question: `step "${s.text}" is UI level (${w.join(', ')}); ask the writer what the user wants done` });
	}
	const ref = `recording ${source}`;
	return [{ id, title: title ?? titleOf(source), sourceRef: ref, tags: [`@${id}`, '@draft', ...(!docInherited ? ['@doc'] : [])], description: [`Sources: ${ref}`], steps, corrections }];
}

const ROLE_IN_TEXT = /\bas an? ([a-z][a-z -]*?)(?=\s+(?:you|I|can|may)\b|,|\.)/i;
const OPEN_SCREEN = /^I (?:open|go to|navigate to|start on|start from|start at|am on) the (.+)$/i;
const outcome = (s) => { const t = s.trim().replace(/[.!]$/, ''); return t[0].toLowerCase() + t.slice(1); };

/**
 * Procedures (procedures.mjs) as drafts. `refOf(proc)` gives the source reference ("text notes.txt#L1-L9",
 * "manual manual/cancel.html#cancel"); `extra(id)` gives corrections every draft carries (the manual's currency).
 */
export function fromProcedures(procs, { refOf, role: defaultRole, screen: defaultScreen, nextId, docInherited, extra = () => [] }) {
	return procs.map((p) => {
		const id = nextId();
		const corrections = [];
		const steps = [];
		const from = [];
		let role = ROLE_IN_TEXT.exec(p.intro)?.[1]?.trim() ?? null;
		if (role) from.push(sentences(p.intro).find((s) => ROLE_IN_TEXT.test(s)));
		let screen = null;
		const notes = [];
		p.items.forEach((item, k) => {
			const parts = sentences(item);
			parts.forEach((sentence, n) => {
				const fp = firstPerson(sentence);
				if (!fp) {
					// A sentence saying what happens: only the very last one, with no paragraph after the steps, is the result.
					if (!p.result && k === p.items.length - 1 && n === parts.length - 1) steps.push({ kind: 'Then', text: outcome(sentence) });
					return;
				}
				const open = OPEN_SCREEN.exec(fp);
				if (open && !steps.length && !screen) { screen = open[1].replace(/\s+(?:page|screen|view|window)$/i, ''); from.push(sentence); return; }
				const r = rewrite(sentence);
				if (r?.drop) { corrections.push({ rule: 'intent level', before: sentence, after: null }); return; }
				if (!r) {
					steps.push({ kind: 'When', text: fp });
					corrections.push({ rule: 'intent level', before: sentence, after: null, open: true, question: `step "${sentence}": cannot write it at intent level; ask the writer what the user wants done` });
					return;
				}
				steps.push({ kind: 'When', text: r.text, ...(uiWords(sentence).length ? { was: sentence } : {}) });
			});
		});
		if (p.result) steps.push({ kind: 'Then', text: outcome(sentences(p.result)[0]) });
		if (!role && defaultRole) { role = defaultRole; notes.push(`role from --role: ${defaultRole}`); }
		if (!screen && defaultScreen) { screen = defaultScreen; notes.push(`start screen from --screen: ${defaultScreen}`); }
		let all;
		if (role && screen) {
			all = keywords([{ kind: 'Given', text: startStep(role, screen) }, ...steps]);
			corrections.unshift({ rule: 'role and start screen in the first step', before: [...from, ...notes].join(' / ') || null, after: `Given ${all[0].text}` });
		} else {
			all = keywords([{ kind: 'Given', text: screen ? `I am on the ${screen}` : 'I am on the start screen' }, ...steps]);
			corrections.unshift({ rule: 'role and start screen in the first step', before: from.join(' / ') || null, after: null, open: true,
				question: `name the ${role ? 'start screen' : screen ? 'role' : 'role and the start screen'} (--role, --screen)` });
		}
		steps.forEach((s, i) => { if (s.was) corrections.push({ rule: 'intent level', before: s.was, after: `${all[i + 1].keyword} ${all[i + 1].text}` }); });
		if (steps.at(-1)?.kind !== 'Then') corrections.push({ rule: 'final step asserts the visible result', before: null, after: null, open: true, question: 'the procedure does not say what the user sees at the end; add a final Then' });
		corrections.push(...extra(id));
		const ref = refOf(p);
		return { id, title: p.title, sourceRef: ref, tags: [`@${id}`, '@draft', ...(!docInherited ? ['@doc'] : [])], description: [`Sources: ${ref}`], steps: all, corrections };
	});
}
