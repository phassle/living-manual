// The writer session (spec: Writer session, Decision records, Glossary): the bookkeeping behind the
// lm-writer-session skill. The skill asks; this module decides what to ask and writes down every
// answer the moment it is given. It reads only files: the facts pack (facts/pack.json and its step
// records), the doc scenarios, the prose files, the page plan, the decision records, the
// documentation glossary (GLOSSARY.md in the product folder) and the codebase glossaries the
// glossary map names. It never needs the product running, and it never writes a codebase glossary.
//
// The decision tree, per feature (a scenarios/<feature>.feature file):
//   reader → coverage → per case (scenarios without a human-stated intent first):
//   page type → boundaries → mismatches → terms → failures; then the page type of each prose section.
// Every question has a stable key (e.g. `page-type:ORDER-01`). A question whose key an active
// decision record names is skipped, and the summary names the record. A question whose fact the
// pack lacks (a failure question with no failures in the pack, a coverage question with no case
// inventory) is not asked: the fact is queued for the next run in facts/queue.json.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { docScenarios, NOTE } from './cases.mjs';
import { allRecords } from './facts.mjs';
import { readProse } from './prose.mjs';
import { glossaryTerms, glossariesInMap } from './facts-pack.mjs';
import { fileIssue } from './issues.mjs';
import { featureOfScenario } from './issue-items.mjs';

export const norm = (s) => String(s ?? '').toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();
export const slugify = (s) => norm(s).replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
/** A term as the glossary writes it: no trailing colon or ellipsis ("Extend..." is the term "Extend"). */
export const termName = (t) => String(t).replace(/\s*(:|\.\.\.|…)\s*$/, '').trim();
const termKey = (t) => `term:${slugify(termName(t))}`;
const today = () => new Date().toISOString().slice(0, 10);

// ---- Reading -------------------------------------------------------------------------------------

/** Active decision records: Map<question key, { number, file, title }>; plus the highest number. */
export function readDecisions(folder) {
	const dir = join(folder, 'decisions');
	const byKey = new Map();
	let highest = 0;
	if (!existsSync(dir)) return { byKey, highest };
	const files = readdirSync(dir).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort();
	// One number per record: with two records on one number the next number is ambiguous.
	const byNumber = Map.groupBy(files, (f) => f.slice(0, 4));
	const twice = [...byNumber].filter(([, fs]) => fs.length > 1);
	if (twice.length) throw new Error(`decision records share a number: ${twice.map(([n, fs]) => `${n} (${fs.join(', ')})`).join('; ')}; renumber one of them and update what refers to it`);
	for (const file of files) {
		highest = Math.max(highest, Number(file.slice(0, 4)));
		const text = readFileSync(join(dir, file), 'utf8');
		const key = /\*\*Question:\*\*\s*(\S+)/.exec(text)?.[1];
		const status = /\*\*Status:\*\*\s*([^·\n]+)/.exec(text)?.[1].trim() ?? '';
		// "accepted" is the older word for active.
		if (key && /^(active|accepted)\b/i.test(status)) byKey.set(key, { number: file.slice(0, 4), file: `decisions/${file}`, title: /^#\s+(.*)$/m.exec(text)?.[1] ?? file });
	}
	return { byKey, highest };
}

/** The writer corrections ticket 06 leaves beside a feature (scenarios/<feature>.corrections.json); [] when absent. */
export function readCorrections(folder, feature) {
	const file = join(folder, 'scenarios', `${feature}.corrections.json`);
	if (!existsSync(file)) return [];
	try {
		const data = JSON.parse(readFileSync(file, 'utf8'));
		const list = Array.isArray(data) ? data : data.corrections ?? [];
		return list.map((c) => ({
			scenario: c.scenario ?? c.id ?? null,
			// lm-draft from writes { rule, before, after, reason?, open?, question? } (after null: dropped, or open).
			text: typeof c === 'string' ? c : c.message ?? [c.rule && `${c.rule}:`, c.before && `"${c.before}"`, c.after ? `→ "${c.after}"` : c.before && !c.open ? '→ dropped' : null,
				c.reason && `(${c.reason})`, c.open && `open question: ${c.question}`].filter(Boolean).join(' '),
		}));
	} catch { return []; }
}

export const queueFile = (folder) => join(folder, 'facts/queue.json');
export function readQueue(folder) {
	const file = queueFile(folder);
	return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { items: [] };
}
function addToQueue(folder, item) {
	const q = readQueue(folder);
	if (q.items.some((i) => i.key === item.key)) return false;
	q.items.push({ ...item, queuedAt: new Date().toISOString() });
	mkdirSync(dirname(queueFile(folder)), { recursive: true });
	writeFileSync(queueFile(folder), `${JSON.stringify({
		_about: 'Facts the writer session needed and the facts pack lacked (kind "fact"), and scenario changes the writer asked for (kind "change"). The next run (lm-run, lm-collect, lm-draft) works through them; the session carries on without them. Written by living-manual/kit/bin/lm-writer-session.mjs.',
		items: q.items,
	}, null, '\t')}\n`);
	return true;
}

/** Everything the session reads. `glossaryMap` is the codebase glossary map file (or null). */
export function loadContext(folder, { glossaryMap = null, productName = null } = {}) {
	const packFile = join(folder, 'facts/pack.json');
	if (!existsSync(packFile)) throw new Error(`no facts pack at ${packFile}; a run writes it (lm-run, or lm-facts)`);
	const pack = JSON.parse(readFileSync(packFile, 'utf8'));
	const scenarios = docScenarios(folder);
	const records = new Map(allRecords(folder).map((r) => [r.scenario?.id, r]));
	const planFile = join(folder, 'page-plan.json');
	const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : { features: [] };
	const features = [...new Set(scenarios.map((s) => s.file))].map((file) => {
		const slug = basename(file, '.feature');
		const text = readFileSync(join(folder, file), 'utf8');
		const title = /^\s*Feature:\s*(.*\S)/m.exec(text)?.[1] ?? slug;
		const planned = plan.features.find((f) => f.feature === slug);
		const proseRel = planned?.prose ?? `prose/${slug}.md`;
		const prose = existsSync(join(folder, proseRel)) ? readProse(join(folder, proseRel)) : null;
		return { slug, file, title, proseRel, prose, scenarios: scenarios.filter((s) => s.file === file), corrections: readCorrections(folder, slug) };
	});
	const codebase = glossariesInMap(glossaryMap);
	const docGlossary = join(folder, 'GLOSSARY.md');
	return {
		folder, pack, scenarios, records, plan, features, codebase, docGlossary,
		productName: productName ?? pack.product ?? basename(folder),
		decisions: readDecisions(folder),
	};
}

// ---- The tree ------------------------------------------------------------------------------------

const firstScreen = (s, rec) => rec?.scenario?.startScreen ?? /\bon the (.+)$/i.exec(s.steps[0]?.text ?? '')?.[1] ?? 'first screen';
const casesOf = (ctx, f) => {
	if (!ctx.pack.cases) return null;
	const ids = new Set(f.scenarios.map((s) => s.id));
	// A case is the feature's when one of its scenarios covers it, or when its area names exactly
	// this feature ("Order" → order; not order-line, and a case with no area belongs to none).
	const mine = (c) => (c.scenario && ids.has(c.scenario)) || (!!String(c.area ?? '').trim() && slugify(c.area) === f.slug);
	return { covered: ctx.pack.cases.covered.filter(mine), notCovered: ctx.pack.cases.notCovered.filter(mine) };
};

/** A product value the run showed in the mismatched step, in its real spelling. */
function productValue(rec, m) {
	const step = rec?.steps?.[m.step - 1];
	const acts = step ? step.actions : [];
	const vals = [...acts.filter((a) => a.value).map((a) => a.value), ...acts.filter((a) => a.kind === 'verify').map((a) => a.label), ...acts.map((a) => a.label)];
	return vals.map((v) => String(v).replace(/\s*:\s*$/, '')).find((v) => v && norm(v) !== norm(m.quoted)) ?? null;
}

function mismatchQuestion(ctx, f, s, m) {
	const rec = ctx.records.get(s.id);
	const key = `mismatch:${s.id}:${m.kind}:${m.step ?? 0}${m.quoted ? `:${slugify(m.quoted)}` : ''}`;
	const bug = { label: `The scenario is right: ${ctx.productName} has a bug. File a bug issue and mark ${s.id} broken`, effect: { kind: 'bug' } };
	const unsure = { label: `Not sure yet: keep ${s.id} a draft and ask a developer before the next run`, effect: { kind: 'queue', queue: 'fact', need: `a developer's answer: ${m.message}` } };
	let fix;
	if (m.kind === 'quoted-value' && productValue(rec, m)) {
		const value = productValue(rec, m);
		fix = { label: `${ctx.productName} is right: change the scenario to say "${value}" instead of "${m.quoted}"`, effect: { kind: 'correct', step: m.step, from: `"${m.quoted}"`, to: `"${value}"` } };
	} else if (m.kind === 'step-text') {
		fix = { label: `${ctx.productName} is right: change step ${m.step} to "${m.product}"`, effect: { kind: 'correct', step: m.step, wholeStep: m.product } };
	} else {
		fix = { label: `${ctx.productName} is right: repair the scenario in the next run so it does what the product does`, effect: { kind: 'queue', queue: 'change', need: `repair ${s.id} to match the product: ${m.message}` } };
	}
	const options = m.kind === 'run-failed' ? [bug, fix, unsure] : [fix, bug, unsure];
	return {
		key, type: 'mismatch', feature: f.slug, scenario: s.id, scope: `feature (${f.slug})`,
		subject: `${s.id} mismatch`, mismatch: m,
		text: `In "${s.title}", your scenario and the product disagree. ${m.message}. Which is right?`,
		options,
	};
}

const READERS = (product) => ({
	daily: { label: `A daily user: someone who does this work every week in ${product}`, effect: { kind: 'plan-feature', field: 'reader', value: 'daily user' } },
	new: { label: `A new user: someone using ${product} for the first time`, effect: { kind: 'plan-feature', field: 'reader', value: 'new user' } },
	admin: { label: `An administrator: someone who sets ${product} up for others`, effect: { kind: 'plan-feature', field: 'reader', value: 'administrator' } },
});

const pageTypeOption = (type, id, slug, title) => ({
	how: { label: 'A how page: the steps to do the task, with screenshots', effect: { kind: 'plan-page', scenario: id, slug, title, type: 'how' } },
	why: { label: 'A why page: explain the idea and the rules, no steps', effect: { kind: 'plan-page', scenario: id, slug, title, type: 'why' } },
	reference: { label: 'A reference page: what each field on its screens means', effect: { kind: 'plan-page', scenario: id, slug, title, type: 'reference' } },
}[type]);

/**
 * Every question for the session, in tree order, each marked:
 * state 'ask' (on the frontier), 'skipped' (an active decision record answers it: `record`),
 * 'known' (a glossary already defines the term), 'needs-fact' (the pack lacks a fact: `need`),
 * or 'answered' (answered in this session).
 */
export function buildTree(ctx, state = { answers: [], extra: [] }) {
	const out = [];
	const answered = new Map(state.answers.map((a) => [a.key, a]));
	const glossaryKnown = new Set([...ctx.codebase.flatMap(glossaryTerms), ...glossaryTerms(ctx.docGlossary)].map((t) => termKey(t)));
	const push = (q) => {
		const rec = ctx.decisions.byKey.get(q.key);
		if (answered.has(q.key)) q.state = 'answered';
		else if (rec) Object.assign(q, { state: 'skipped', record: rec });
		else if (q.type === 'term' && glossaryKnown.has(q.key)) Object.assign(q, { state: 'known' });
		else if (q.need) q.state = 'needs-fact';
		else q.state = 'ask';
		out.push(q);
	};
	const termsSeen = new Set();
	// One question per term: "Extend..." (a label) and "Extend" (a screen) are the same term.
	const merged = new Map();
	for (const t of ctx.pack.unknownTerms) {
		const k = termKey(t.term);
		const m = merged.get(k) ?? { term: termName(t.term), kinds: [], scenarios: [] };
		for (const x of t.kinds) if (!m.kinds.includes(x)) m.kinds.push(x);
		for (const x of t.scenarios) if (!m.scenarios.includes(x)) m.scenarios.push(x);
		merged.set(k, m);
	}
	const unknownTerms = [...merged.values()];
	const product = ctx.productName;
	for (const f of ctx.features) {
		const roles = f.scenarios.map((s) => ctx.records.get(s.id)?.scenario?.role ?? '').join(' ');
		const R = READERS(product);
		push({ key: `reader:${f.slug}`, type: 'reader', feature: f.slug, scope: `feature (${f.slug})`, subject: `${f.title}: reader`,
			text: `Who will read the ${f.title} pages most? The runs did these tasks as: ${[...new Set(f.scenarios.map((s) => ctx.records.get(s.id)?.scenario?.role).filter(Boolean))].join(', ') || 'no role recorded'}.`,
			options: /admin/i.test(roles) ? [R.admin, R.daily, R.new] : [R.daily, R.new, R.admin] });

		const cases = casesOf(ctx, f);
		if (!cases) {
			push({ key: `coverage:${f.slug}`, type: 'coverage', feature: f.slug, scope: `feature (${f.slug})`, subject: `${f.title}: coverage`, text: `Which ${f.title} tasks deserve a page?`, options: [],
				need: { key: `fact:cases:${f.slug}`, need: `the case inventory for ${f.title} (facts/cases.json; lm-collect writes it)` } });
		} else if (cases.notCovered.length) {
			const others = cases.notCovered.map((c) => c.title);
			push({ key: `coverage:${f.slug}`, type: 'coverage', feature: f.slug, scope: `feature (${f.slug})`, subject: `${f.title}: coverage`,
				text: `${cases.covered.length + cases.notCovered.length} ${f.title} tasks are known. ${cases.covered.length} have a scenario now. These ${others.length} have none: ${others.join('; ')}. Which deserve a page?`,
				options: [
					{ label: `The ${cases.covered.length} with a scenario now; decide on the ${others.length} others in a later session`, effect: { kind: 'none' } },
					{ label: `All of them: draft scenarios for the ${others.length} others in the next run`, effect: { kind: 'queue', queue: 'change', need: `draft scenarios for: ${others.join('; ')}` } },
					{ label: `Only the ${cases.covered.length} with a scenario: the ${others.length} others never get a page`, effect: { kind: 'none' } },
				] });
		}

		const ordered = [...f.scenarios.filter((s) => s.description.includes(NOTE)), ...f.scenarios.filter((s) => !s.description.includes(NOTE))];
		for (const s of ordered) {
			const rec = ctx.records.get(s.id);
			const manual = s.tags.includes('@manual');
			const noted = s.description.includes(NOTE);
			const planned = ctx.plan.features.find((x) => x.feature === f.slug)?.pages.find((p) => p.scenario === s.id);
			const slug = planned?.slug ?? slugify(s.title);
			const current = planned?.type ?? 'how';
			const types = [current, ...['how', 'why', 'reference'].filter((t) => t !== current)];
			push({ key: `page-type:${s.id}`, type: 'page-type', feature: f.slug, scenario: s.id, scope: `feature (${f.slug})`, subject: `${s.id} page type`,
				text: `${noted ? 'Nobody wrote down why a user does this task; the scenario was drafted from the product alone. ' : ''}What kind of page should "${s.title}" get?${manual ? ' It cannot be run automatically, so its page comes from your prose and is marked not machine-verified.' : ''}`,
				options: types.map((t) => pageTypeOption(t, s.id, slug, s.title)) });

			const start = firstScreen(s, rec);
			const end = s.steps.at(-1)?.text ?? '';
			const opened = rec?.steps?.[0]?.actions?.[0]?.screen;
			push({ key: `boundaries:${s.id}`, type: 'boundaries', feature: f.slug, scenario: s.id, scope: `feature (${f.slug})`, subject: `${s.id} boundaries`,
				text: `Where does "${s.title}" start, and what does the user see when it is done?`,
				options: [
					{ label: `Starts on the ${start}; done when ${end}`, effect: { kind: 'none' } },
					{ label: `Start earlier: from ${opened && norm(opened) !== norm(start) ? `the ${opened}` : `where the user opens ${product}`}`, effect: { kind: 'queue', queue: 'change', need: `${s.id}: start the scenario earlier, from ${opened && norm(opened) !== norm(start) ? `the ${opened}` : `where the user opens ${product}`}` } },
					{ label: 'End later: also show where the result can be found afterwards', effect: { kind: 'queue', queue: 'change', need: `${s.id}: end the scenario later, showing where the result is found afterwards` } },
				] });

			for (const m of ctx.pack.mismatches.filter((x) => x.scenario === s.id)) push(mismatchQuestion(ctx, f, s, m));

			for (const t of unknownTerms.filter((x) => x.scenarios.includes(s.id))) {
				if (termsSeen.has(termKey(t.term))) continue;
				termsSeen.add(termKey(t.term));
				push(termQuestion(ctx, t.term, t.kinds, s, f));
			}

			const failures = (ctx.pack.failures ?? []).filter((x) => x.scenario === s.id);
			if (manual) continue;
			if (!failures.length) {
				push({ key: `failure:${s.id}`, type: 'failure', feature: f.slug, scenario: s.id, scope: `feature (${f.slug})`, subject: `${s.id} failures`, text: `Which warning or error is worth documenting on "${s.title}"?`, options: [],
					need: { key: `fact:failure:${s.id}`, need: `the warnings and errors "${s.title}" (${s.id}) can show, e.g. with a required field left empty` } });
			} else {
				const first = failures[0].message;
				push({ key: `failure:${s.id}`, type: 'failure', feature: f.slug, scenario: s.id, scope: `feature (${f.slug})`, subject: `${s.id} failures`,
					text: `The runs met ${failures.length} warning(s) or error(s) in "${s.title}": ${failures.map((x) => `"${x.message}"`).join('; ')}. Which are worth documenting?`,
					options: [
						{ label: `Document "${first}" on this page`, effect: { kind: 'none' } },
						{ label: failures.length > 1 ? `Document all ${failures.length} of them` : 'Document it on a separate troubleshooting page', effect: { kind: 'none' } },
						{ label: 'None: the page stays on the task that works', effect: { kind: 'none' } },
					] });
			}
		}

		if (f.prose) {
			const manualSections = new Set(f.scenarios.filter((s) => s.tags.includes('@manual')).map((s) => norm(ctx.plan.features.find((x) => x.feature === f.slug)?.pages.find((p) => p.scenario === s.id)?.section ?? s.title)));
			for (const heading of f.prose.sections.keys()) {
				if (manualSections.has(norm(heading))) continue;
				const planned = ctx.plan.features.find((x) => x.feature === f.slug)?.pages.find((p) => !p.scenario && norm(p.section) === norm(heading));
				const current = planned?.type ?? (/field/i.test(heading) ? 'reference' : 'why');
				const slug = planned?.slug ?? slugify(heading);
				const opt = {
					why: { label: 'A why page: explain the idea and the rules', effect: { kind: 'plan-section', section: heading, slug, type: 'why' } },
					reference: { label: 'A reference page: what each field means', effect: { kind: 'plan-section', section: heading, slug, type: 'reference' } },
					none: { label: 'No page of its own', effect: { kind: 'plan-section', section: heading, slug, type: null } },
				};
				push({ key: `page-type:${f.slug}#${slugify(heading)}`, type: 'page-type', feature: f.slug, scope: `feature (${f.slug})`, subject: `"${heading}" page type`,
					text: `Your prose file has a section "${heading}". What kind of page should it be?`,
					options: [opt[current], ...['why', 'reference', 'none'].filter((t) => t !== current).map((t) => opt[t])].slice(0, 3) });
			}
		}
	}
	for (const x of state.extra ?? []) push(x);
	return out;
}

function termQuestion(ctx, term, kinds, s, f) {
	const name = termName(term);
	const isScreen = kinds.includes('screen');
	const def = isScreen
		? `The screen ${ctx.productName} shows as "${name}"${s ? `, met in "${s.title}"` : ''}.`
		: `What ${ctx.productName} labels "${name}"${s ? ` in "${s.title}"` : ''}.`;
	const add = { label: `Add "${name}" to the manual's glossary: "${def}"`, effect: { kind: 'glossary', term: name, definition: def } };
	const plain = { label: `Leave "${name}" out of the glossary: the word explains itself`, effect: { kind: 'none' } };
	const never = { label: `Leave "${name}" out: the manual never needs to name it`, effect: { kind: 'none' } };
	return {
		key: termKey(name), type: 'term', feature: f?.slug ?? null, scenario: s?.id ?? null, scope: 'product', subject: `the term "${name}"`, term: name,
		text: `${ctx.productName} shows "${name}" (${kinds.join(', ')}), and neither glossary defines it. Should the manual's glossary define it? Free text: your own definition.`,
		options: isScreen ? [add, plain, never] : [plain, add, never],
	};
}

/** A term question for a word the writer used (the skill calls this when a word differs from a glossary). */
export function writerTermQuestion(ctx, word) {
	const k = norm(word);
	for (const file of [...ctx.codebase, ctx.docGlossary]) {
		if (!existsSync(file)) continue;
		const text = readFileSync(file, 'utf8');
		for (const m of text.matchAll(/^\*\*(.+?)\*\*:\s*\n([\s\S]*?)(?=^\*\*|^#|(?![\s\S]))/gm)) {
			const avoid = /_Avoid_:\s*(.*)/.exec(m[2])?.[1].split(',').map(norm) ?? [];
			if (norm(m[1]) === k) return { found: { term: m[1], file, avoid: false } };
			if (avoid.includes(k)) {
				const official = m[1];
				return {
					found: { term: official, file, avoid: true },
					question: {
						key: termKey(word), type: 'term', feature: null, scope: 'product', subject: `the word "${word}"`, term: word,
						text: `You wrote "${word}". The glossary ${relative(ctx.folder, file).startsWith('..') ? 'of the codebase' : 'of the manual'} says to say "${official}" instead. Which word should the manual use?`,
						options: [
							{ label: `"${official}", as the glossary says`, effect: { kind: 'none' } },
							{ label: `"${word}": add it to the manual's glossary, meaning the same as "${official}"`, effect: { kind: 'glossary', term: word, definition: `The manual's word for what the product calls ${official}.` } },
							{ label: `"${official}" in the text, with "${word}" in brackets the first time`, effect: { kind: 'none' } },
						],
					},
				};
			}
		}
	}
	return { found: null, question: termQuestion(ctx, word, ['writer'], null, null) };
}

// ---- Writing answers -----------------------------------------------------------------------------

function writeRecord(folder, decisions, q, answerText, why, writer) {
	const number = String(decisions.highest + 1).padStart(4, '0');
	decisions.highest += 1;
	const title = `${q.subject}: ${answerText.replace(/\s+/g, ' ').slice(0, 90)}`;
	const file = `decisions/${number}-${slugify(`${q.subject} ${answerText}`).slice(0, 50).replace(/-$/, '')}.md`;
	mkdirSync(join(folder, 'decisions'), { recursive: true });
	writeFileSync(join(folder, file), [
		`# ${number} ${title}`, '',
		`**Status:** active · **Scope:** ${q.scope} · **Question:** ${q.key} · **Decided:** ${today()} by ${writer} in the writer session`, '',
		`${q.text} Answer: ${answerText}. ${why}`, '',
	].join('\n'));
	decisions.byKey.set(q.key, { number, file, title });
	return { number, file };
}

function addGlossaryTerm(ctx, term, definition) {
	const file = ctx.docGlossary;
	if (!existsSync(file)) {
		writeFileSync(file, `# ${ctx.productName} manual\n\nTerms the manual uses that the codebase glossary does not define, settled by the writer in the writer session. The kit writes this file; the codebase glossary stays the developers'.\n\n## Language\n`);
	}
	const text = readFileSync(file, 'utf8');
	if (glossaryTerms(file).some((t) => norm(t) === norm(term))) return false;
	writeFileSync(file, `${text.replace(/\n*$/, '\n')}\n**${term}**:\n${definition.trim()}\n`);
	return true;
}

const pageLine = (p) => `{ ${Object.entries(p).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v).replace(/","/g, '", "')}`).join(', ')} }`;
function writePlan(folder, plan) {
	const about = plan._about ?? 'The manual\'s page plan (spec: Manual generation, Writer session). One entry per page, in reading order, per feature. Written by the writer session.';
	const features = plan.features.map((f) => {
		const { pages, ...rest } = f;
		const head = Object.entries(rest).map(([k, v]) => `\t\t\t${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n');
		return `\t\t{\n${head}\n\t\t\t"pages": [\n${pages.map((p) => `\t\t\t\t${pageLine(p)}`).join(',\n')}\n\t\t\t]\n\t\t}`;
	});
	writeFileSync(join(folder, 'page-plan.json'), `{\n\t"_about": ${JSON.stringify(about)},\n\t"features": [\n${features.join(',\n')}\n\t]\n}\n`);
}

function planFeature(ctx, slug) {
	let f = ctx.plan.features.find((x) => x.feature === slug);
	if (!f) {
		const feat = ctx.features.find((x) => x.slug === slug);
		f = { feature: slug, title: feat?.title ?? slug, prose: feat?.proseRel ?? `prose/${slug}.md`, pages: [] };
		ctx.plan.features.push(f);
	}
	return f;
}

/** Where a correction lands and what it changes it to; throws when the scenario no longer says what the run saw. */
function plannedCorrection(folder, ctx, q, effect) {
	const s = ctx.scenarios.find((x) => x.id === q.scenario);
	const step = s?.steps[effect.step - 1];
	if (!step) throw new Error(`${q.scenario} has no step ${effect.step} any more; nothing was changed (run lm-facts again)`);
	const file = join(folder, s.file);
	const lines = readFileSync(file, 'utf8').split('\n');
	const i = step.line - 1;
	const [from, to] = effect.wholeStep ? [step.text, effect.wholeStep] : [effect.from, effect.to];
	if (!lines[i]?.includes(from)) throw new Error(`${s.file}:${step.line} no longer says ${from}; nothing was changed (the scenario was edited after the run: run lm-facts again)`);
	// A function replacer: the product's value is written as it is ("$&" is not a pattern).
	return { s, step, file, lines, i, line: lines[i].replace(from, () => to) };
}

function correctScenario(folder, ctx, q, effect) {
	const { s, step, file, lines, i, line } = plannedCorrection(folder, ctx, q, effect);
	const before = lines[i];
	lines[i] = line;
	writeFileSync(file, lines.join('\n'));
	return `${s.file}:${step.line}: "${before.trim()}" → "${lines[i].trim()}"`;
}

function fileBug(ctx, q, tracker, recordFile, writer) {
	const m = q.mismatch;
	if (typeof tracker === 'object') {
		// The workspace's tracker: one product-bug issue per feature per run (bin/lib/issues.mjs).
		const feature = featureOfScenario(ctx.folder, q.scenario) ?? q.feature;
		const text = `${m.message}. ${writer} decided on ${today()} that the scenario is right and ${ctx.productName} is wrong (decision record \`${recordFile}\`); ${q.scenario} is marked broken until it is fixed and the writer confirms it again.`;
		const r = fileIssue('product-bug', feature, [{ key: `product-bug ${m.message}`, text }], { ...tracker, productName: ctx.productName });
		return r.file ? { file: r.file, existing: false } : { file: r.listedIn, existing: true };
	}
	mkdirSync(tracker, { recursive: true });
	for (const f of readdirSync(tracker).filter((x) => x.endsWith('.md'))) {
		const t = readFileSync(join(tracker, f), 'utf8');
		const status = /\*\*Status:\*\*\s*(\S+)/.exec(t)?.[1] ?? '';
		if (!/resolved|wontfix/.test(status) && t.includes(m.message)) return { file: join(tracker, f), existing: true };
	}
	const n = Math.max(0, ...readdirSync(tracker).map((x) => Number(/^(\d+)-/.exec(x)?.[1] ?? 0))) + 1;
	const file = join(tracker, `${String(n).padStart(2, '0')}-bug-${slugify(`${q.scenario} ${m.quoted ?? m.kind}`)}.md`);
	writeFileSync(file, [
		`# ${ctx.productName} bug: ${q.scenario} does not do what the scenario says`, '',
		'**Status:** needs-triage', '',
		'**Labels:** living-manual, needs-triage', '',
		`**Kind:** product bug from a mismatch · **Feature:** ${q.feature}`, '',
		`In the writer session on ${today()}, ${writer} decided that the scenario text is right and ${ctx.productName} is wrong (decision record \`${recordFile}\`). The scenario ${q.scenario} is marked broken until this is fixed and the writer confirms it again.`, '',
		'## Items', '',
		`- ${m.message}`, '',
	].join('\n'));
	return { file, existing: false };
}

/**
 * Applies the writer's answer to question `q`: `choice` (1–3) or free `text`. Writes the decision
 * record, glossary term, page plan, scenario correction, queue item or bug issue at once.
 * Returns { lines (what was written, for the CLI), record, effect, answerText, broken? }.
 */
export function applyAnswer(ctx, q, { choice = null, text = null, writer, tracker }) {
	const folder = ctx.folder;
	const opt = choice ? q.options[choice - 1] : null;
	if (choice && !opt) throw new Error(`question ${q.key} has ${q.options.length} options; choose 1–${q.options.length} or give --text`);
	const answerText = opt ? opt.label : text;
	const why = opt ? (choice === 1 ? 'The kit recommended this answer from the facts pack; the writer chose it.' : 'The writer chose this over the kit\'s recommendation.') : `In the writer's words: "${text}".`;
	const lines = [];
	const out = { lines, answerText, effect: opt?.effect ?? { kind: 'free-text' } };
	let effect = opt?.effect;
	// Free text still does what the question is about where the text can say it.
	if (!opt) {
		if (q.type === 'term') effect = { kind: 'glossary', term: q.term, definition: text };
		else if (q.type === 'page-type') {
			const t = ['how', 'why', 'reference'].find((x) => new RegExp(`\\b${x}\\b`, 'i').test(text));
			const base = q.options[0].effect;
			if (t) effect = { ...base, type: t };
		} else if (q.type === 'mismatch' || q.type === 'boundaries') effect = { kind: 'queue', queue: q.type === 'mismatch' ? 'fact' : 'change', need: `${q.scenario}: ${text}` };
	}
	// A correction that would change nothing is refused before anything is written.
	if (effect?.kind === 'correct') plannedCorrection(folder, ctx, q, effect);
	const needRecord = !(effect?.kind === 'glossary');
	if (effect?.kind === 'glossary') {
		const added = addGlossaryTerm(ctx, effect.term, effect.definition);
		lines.push(added ? `glossary: **${effect.term}** added to ${relative(process.cwd(), ctx.docGlossary)}` : `glossary: **${effect.term}** is already in ${relative(process.cwd(), ctx.docGlossary)}`);
		out.term = effect.term;
	}
	if (needRecord) {
		const r = writeRecord(folder, ctx.decisions, q, answerText, why, writer);
		out.record = r;
		lines.push(`decision: ${r.file}`);
	}
	if (effect?.kind === 'plan-feature') {
		planFeature(ctx, q.feature)[effect.field] = effect.value;
		writePlan(folder, ctx.plan);
		lines.push(`page plan: ${q.feature} ${effect.field} = ${effect.value}`);
	}
	if (effect?.kind === 'plan-page') {
		const pf = planFeature(ctx, q.feature);
		const at = pf.pages.findIndex((p) => p.scenario === effect.scenario);
		const page = { slug: effect.slug, type: effect.type, scenario: effect.scenario };
		const old = at >= 0 ? pf.pages[at] : {};
		if (effect.type !== 'how' || old.section) page.section = old.section ?? effect.title;
		for (const k of ['screens', 'formerly']) if (old[k]) page[k] = old[k];
		if (at >= 0) pf.pages[at] = page; else pf.pages.push(page);
		writePlan(folder, ctx.plan);
		lines.push(`page plan: ${effect.slug} is a ${effect.type} page`);
		if (effect.type !== 'how') addToQueue(folder, { key: `change:prose:${effect.scenario}`, kind: 'change', feature: q.feature, scenario: effect.scenario, need: `a prose section "${page.section}" in ${pf.prose} for the ${effect.type} page` });
	}
	if (effect?.kind === 'plan-section') {
		const pf = planFeature(ctx, q.feature);
		const at = pf.pages.findIndex((p) => !p.scenario && norm(p.section) === norm(effect.section));
		if (effect.type === null) { if (at >= 0) pf.pages.splice(at, 1); lines.push(`page plan: "${effect.section}" has no page`); }
		else {
			const page = { ...(at >= 0 ? pf.pages[at] : { slug: effect.slug }), type: effect.type, section: effect.section };
			if (at >= 0) pf.pages[at] = page; else pf.pages.push(page);
			lines.push(`page plan: ${page.slug} is a ${effect.type} page`);
		}
		writePlan(folder, ctx.plan);
	}
	if (effect?.kind === 'queue') {
		const key = `${effect.queue}:${q.key}`;
		addToQueue(folder, { key, kind: effect.queue, feature: q.feature, scenario: q.scenario ?? null, need: effect.need, decision: out.record?.file });
		lines.push(`queued for the next run (${effect.queue}): ${effect.need}`);
		out.queued = key;
	}
	if (effect?.kind === 'correct') {
		const c = correctScenario(folder, ctx, q, effect);
		lines.push(`scenario corrected: ${c}`);
		out.correction = c;
	}
	if (effect?.kind === 'bug') {
		const bug = fileBug(ctx, q, tracker, out.record.file, writer);
		lines.push(bug.existing ? `bug issue: already open in ${relative(process.cwd(), bug.file)}` : `bug issue: ${relative(process.cwd(), bug.file)}`);
		out.bug = bug.file;
		out.broken = { id: q.scenario, reason: `the writer filed a mismatch as a bug: ${relative(folder, bug.file).startsWith('..') ? bug.file : relative(folder, bug.file)}` };
	}
	return out;
}

/** The queue items that wait on a scenario change (such a scenario is not confirmed until the next run). */
export const pendingChanges = (folder) => readQueue(folder).items.filter((i) => i.kind === 'change' && i.scenario);

export { addToQueue };

/** Appends one answered question to the session transcript. */
export function logTranscript(file, q, answer, out) {
	mkdirSync(dirname(file), { recursive: true });
	const lines = [
		`### ${q.key} (${q.type})`, '',
		`**Question:** ${q.text}`, '',
		...q.options.map((o, i) => `${i + 1}. ${o.label}${i === 0 ? ' **(recommended)**' : ''}`),
		'4. Free text', '',
		`**Answer:** ${answer.choice ? `option ${answer.choice}: ${q.options[answer.choice - 1].label}` : `free text: "${answer.text}"`}`, '',
		...out.lines.map((l) => `- ${l}`), '',
	];
	appendFileSync(file, `${lines.join('\n')}\n`);
}
