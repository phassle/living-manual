#!/usr/bin/env node
// The writer session's bookkeeping (spec: Writer session; skill .claude/skills/lm-writer-session).
// The skill puts each question to the writer; this CLI picks the question, writes every answer
// down at once, and on the writer's confirmation confirms the scenarios covered through
// lm-confirm. It reads files only (the facts pack, scenarios, prose, page plan, decision records,
// both glossaries) and never starts or calls the product.
//
// usage: node living-manual/kit/bin/lm-writer-session.mjs <product> <command> …   (or --folder <dir>)
//   start [--writer <name>] [--feature <slug>] [--no-preview]
//                         new session: builds the preview from the pack, queues facts the pack
//                         lacks, prints how many questions there are and which records answer others
//   next [--json]         the next question: text, three options (1 recommended), free text allowed,
//                         the preview page and screenshots to show; "no more questions" when done
//   answer <key> (--choice 1|2|3 | --text "<free text>")   writes the answer down at once
//   show <ID>             the scenario's text, for when the writer asks for it
//   term "<word>"         checks a word the writer used against both glossaries; adds a term
//                         question when the word is one a glossary says to avoid, or unknown
//   summary               what this session decided, wrote, queued, filed; the questions skipped
//                         and the decision record that answered each; the scenarios to confirm
//   confirm --by <writer> only after the writer confirmed the summary: confirms every scenario
//                         covered through lm-confirm (not one that is broken or waits on a change)
// Session state and the transcript: <product folder>/build/session/ (state.json, transcript.md).
// Exit 0 done, 1 refused (unknown question, open questions at confirm, a scenario not confirmed), 2 usage.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { folderFromArgs, workspaceRoot, CONFIG } from './lib/workspace.mjs';
import { addToQueue, applyAnswer, buildTree, loadContext, logTranscript, pendingChanges, readQueue, writerTermQuestion } from './lib/writer-session.mjs';
import { allStates, markBroken } from './lib/confirmation.mjs';
import { tracker as trackerOf } from './lib/issues.mjs';

const BIN = dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: lm-writer-session.mjs <product> | --folder <dir>  start [--writer <name>] [--feature <slug>] [--no-preview] | next [--json] | answer <key> (--choice N | --text "…") | show <ID> | term "<word>" | summary | confirm --by <writer>';
function usage(msg) { process.stderr.write(`lm-writer-session: ${msg}\n${USAGE}\n`); process.exit(2); }

const argv = process.argv.slice(2);
let folder, product, root, rest;
try { ({ folder, product, root, rest } = folderFromArgs(argv)); } catch (e) { usage(e.message); }
const target = argv.includes('--folder') ? ['--folder', folder] : [product];
if (!root) { try { root = workspaceRoot(folder); } catch { root = null; } }
const config = root && existsSync(join(root, CONFIG)) ? JSON.parse(readFileSync(join(root, CONFIG), 'utf8')).products?.[product ?? basename(folder)] ?? null : null;
const fromRoot = (p) => (root ? join(root, p) : null);
const glossaryMap = root ? fromRoot(config?.context?.glossary ?? 'GLOSSARY-MAP.md') : null;
// Bug issues go to the workspace's tracker through the kit's batched issues (bin/lib/issues.mjs,
// ticket 10) when the workspace names one; else to issues/ in the product folder.
let tracker = join(folder, 'issues');
if (root && config) { try { trackerOf(root, product ?? basename(folder)); tracker = { product: product ?? basename(folder), root }; } catch { /* no tracker configured */ } }
const manualDir = config?.publish?.to && root ? fromRoot(config.publish.to) : join(folder, 'build/manual');
const previewDir = config?.publish?.preview && root ? fromRoot(config.publish.preview) : join(folder, 'build/preview');

const take = (flag) => {
	const i = rest.indexOf(flag);
	if (i < 0) return undefined;
	const v = rest[i + 1];
	if (v === undefined) usage(`${flag} needs a value`);
	rest.splice(i, 2);
	return v;
};
const flag = (f) => { const i = rest.indexOf(f); if (i < 0) return false; rest.splice(i, 1); return true; };

const sessionDir = join(folder, 'build/session');
const stateFile = join(sessionDir, 'state.json');
const transcript = join(sessionDir, 'transcript.md');
const readState = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null);
const saveState = (s) => { mkdirSync(sessionDir, { recursive: true }); writeFileSync(stateFile, `${JSON.stringify(s, null, '\t')}\n`); };
const rel = (p) => relative(process.cwd(), p) || p;

let ctx;
try { ctx = loadContext(folder, { glossaryMap, productName: config?.name ?? null }); } catch (e) { console.log(`session: ${e.message}`); process.exit(1); }
const inSession = (s, q) => !s?.features?.length || !q.feature || s.features.includes(q.feature);
const tree = (s) => buildTree(ctx, s ?? { answers: [], extra: [] }).filter((q) => inSession(s, q));

/** The preview page and screenshots for a question about a scenario or feature. */
function showing(q) {
	const pf = ctx.plan.features.find((f) => f.feature === q.feature);
	const page = q.scenario ? pf?.pages.find((p) => p.scenario === q.scenario) : pf?.pages[0];
	const html = page && join(previewDir, `${page.slug}.html`);
	const shotsDir = q.scenario && join(manualDir, 'assets', q.scenario);
	const corrections = (ctx.features.find((f) => f.slug === q.feature)?.corrections ?? []).filter((c) => !c.scenario || c.scenario === q.scenario);
	return {
		previewPage: html && existsSync(html) ? rel(html) : null,
		previewIndex: existsSync(join(previewDir, 'index.html')) ? rel(join(previewDir, 'index.html')) : null,
		screenshots: shotsDir && existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => f.endsWith('.png')).sort().map((f) => rel(join(shotsDir, f))) : [],
		scenarioText: q.scenario ? `on request: lm-writer-session … show ${q.scenario}` : null,
		corrections: corrections.map((c) => c.text),
	};
}

const [command, ...args] = rest;

if (command === 'start') {
	const writer = take('--writer') ?? config?.people?.writer ?? 'the writer';
	const feature = take('--feature');
	const noPreview = flag('--no-preview');
	const state = { writer, startedAt: new Date().toISOString(), features: feature ? [feature] : [], answers: [], extra: [], skipped: [], queued: [], bugs: [], corrections: [], terms: [], broken: [] };
	if (!noPreview) {
		for (const cli of ['lm-manual.mjs', 'lm-publish.mjs']) {
			const r = spawnSync(process.execPath, [join(BIN, cli), ...target], { encoding: 'utf8' });
			const last = `${r.stdout}${r.stderr}`.trim().split('\n').at(-1);
			console.log(`preview: ${cli.replace('.mjs', '')}: ${last}`);
		}
	}
	const all = tree(state);
	for (const q of all.filter((x) => x.state === 'needs-fact')) {
		if (addToQueue(folder, { key: q.need.key, kind: 'fact', feature: q.feature, scenario: q.scenario ?? null, need: q.need.need })) state.queued.push(q.need.key);
	}
	saveState(state);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(transcript, `# Writer session: ${ctx.productName}\n\nStarted ${state.startedAt} with ${writer}. Facts pack written ${ctx.pack.writtenAt} (product version ${ctx.pack.productVersion ?? 'unknown'}).\n\n`);
	for (const f of ctx.features.filter((x) => inSession(state, { feature: x.slug }))) for (const c of f.corrections) console.log(`correction (${f.slug}${c.scenario ? `, ${c.scenario}` : ''}): ${c.text}`);
	for (const q of all.filter((x) => x.state === 'skipped')) console.log(`skipped ${q.key}: answered by ${q.record.file}`);
	for (const q of all.filter((x) => x.state === 'needs-fact')) console.log(`queued for the next run: ${q.need.need}`);
	if (existsSync(join(previewDir, 'index.html'))) console.log(`preview: open ${rel(join(previewDir, 'index.html'))}`);
	const count = (st) => all.filter((x) => x.state === st).length;
	console.log(`session: ${count('ask')} question(s) to ask, ${count('skipped')} answered by decision records, ${count('known')} term(s) already in a glossary, ${count('needs-fact')} waiting for a fact (queued) — writer ${writer}`);
	process.exit(0);
}

const state = readState();
if (!state && command !== 'show' && command !== 'term') { console.log('session: no session started; run `start` first'); process.exit(1); }

if (command === 'next') {
	const json = flag('--json');
	const open = tree(state).filter((q) => q.state === 'ask');
	const q = open[0];
	if (json) {
		console.log(JSON.stringify(q ? { question: { key: q.key, type: q.type, feature: q.feature, scenario: q.scenario ?? null, text: q.text, options: q.options.map((o) => o.label), recommended: 1, freeText: true }, remaining: open.length, show: showing(q) } : { question: null, remaining: 0 }, null, '\t'));
		process.exit(0);
	}
	if (!q) { console.log('no more questions: run `summary`, show it to the writer, and ask them to confirm'); process.exit(0); }
	const sh = showing(q);
	console.log(`question ${q.key} (${q.type}; ${open.length} left)`);
	console.log(q.text);
	q.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}${i === 0 ? '  (recommended)' : ''}`));
	console.log('  or free text');
	if (sh.previewPage) console.log(`preview page: ${sh.previewPage}`);
	for (const s of sh.screenshots) console.log(`screenshot: ${s}`);
	for (const c of sh.corrections) console.log(`correction made to the writer's scenario: ${c}`);
	if (sh.scenarioText) console.log(`scenario text: ${sh.scenarioText}`);
	process.exit(0);
}

if (command === 'answer') {
	const choice = take('--choice');
	const text = take('--text');
	const [key] = args.filter((a) => !a.startsWith('--'));
	if (!key) usage('name the question key');
	if (!choice === !text) usage('give exactly one of --choice 1|2|3 or --text "<free text>"');
	const q = tree(state).find((x) => x.key === key);
	if (!q) { console.log(`session: no question ${key}`); process.exit(1); }
	if (q.state !== 'ask') { console.log(`session: ${key} is not open (${q.state}${q.record ? `: ${q.record.file}` : ''})`); process.exit(1); }
	let out;
	try { out = applyAnswer(ctx, q, { choice: choice ? Number(choice) : null, text, writer: state.writer, tracker }); } catch (e) { console.log(`session: ${e.message}`); process.exit(1); }
	if (out.broken) {
		const r = markBroken(folder, out.broken.id, out.broken.reason);
		out.lines.push(r.message);
		state.broken.push(out.broken.id);
	}
	state.answers.push({ key, type: q.type, scenario: q.scenario ?? null, feature: q.feature, question: q.text, options: q.options.map((o) => o.label), answer: choice ? { choice: Number(choice) } : { text }, answerText: out.answerText, record: out.record?.file ?? null });
	if (out.queued) state.queued.push(out.queued);
	if (out.bug) state.bugs.push(rel(out.bug));
	if (out.correction) state.corrections.push(out.correction);
	if (out.term) state.terms.push(out.term);
	saveState(state);
	logTranscript(transcript, q, choice ? { choice: Number(choice) } : { text }, out);
	for (const l of out.lines) console.log(l);
	process.exit(0);
}

if (command === 'show') {
	const id = args[0];
	const s = ctx.scenarios.find((x) => x.id === id);
	if (!s) { console.log(`session: no scenario ${id}`); process.exit(1); }
	const lines = readFileSync(join(folder, s.file), 'utf8').split('\n');
	let from = s.line - 1;
	while (from > 0 && lines[from - 1].trim().startsWith('@')) from--;
	console.log(lines.slice(from, s.steps.at(-1).line).join('\n'));
	process.exit(0);
}

if (command === 'term') {
	const word = args.join(' ').trim();
	if (!word) usage('name the word');
	const r = writerTermQuestion(ctx, word);
	if (r.found && !r.found.avoid) { console.log(`term: "${r.found.term}" is defined in ${rel(r.found.file)}; nothing to ask`); process.exit(0); }
	if (r.found?.avoid) console.log(`term: ${rel(r.found.file)} says to say "${r.found.term}" instead of "${word}"`);
	else console.log(`term: "${word}" is in neither glossary`);
	if (state && !state.extra.some((x) => x.key === r.question.key)) {
		state.extra.push(r.question);
		saveState(state);
		console.log(`term: question ${r.question.key} added; it comes next`);
	}
	process.exit(0);
}

if (command === 'summary') {
	const all = tree(state);
	const lines = [`# Writer session summary: ${ctx.productName}`, '', `Writer: ${state.writer}. Started ${state.startedAt}.`, ''];
	lines.push(`## Decided in this session (${state.answers.length})`, '');
	for (const a of state.answers) lines.push(`- ${a.key}: ${a.answerText}${a.record ? ` (${a.record})` : ''}`);
	lines.push('', `## Skipped: an earlier decision answers them (${all.filter((q) => q.state === 'skipped').length})`, '', 'If one of these no longer holds, mark its record superseded and the question comes back.', '');
	for (const q of all.filter((x) => x.state === 'skipped')) lines.push(`- ${q.key}: answered by ${q.record.number} (${q.record.file}): ${q.record.title}`);
	if (state.terms.length) lines.push('', '## Terms added to the manual\'s glossary', '', ...state.terms.map((t) => `- ${t}`));
	if (state.corrections.length) lines.push('', '## Scenarios corrected', '', ...state.corrections.map((c) => `- ${c}`));
	if (state.bugs.length) lines.push('', '## Bug issues filed (scenario marked broken)', '', ...state.bugs.map((b) => `- ${b}`));
	const queue = readQueue(folder).items.filter((i) => inSession(state, i));
	lines.push('', `## Waiting for the next run (${queue.length})`, '', ...queue.map((i) => `- ${i.kind}: ${i.need}`));
	const open = all.filter((q) => q.state === 'ask');
	if (open.length) lines.push('', `## Still open (${open.length})`, '', ...open.map((q) => `- ${q.key}`));
	const { confirmable, held } = coverage();
	lines.push('', '## On your confirmation', '', confirmable.length ? `These scenarios become confirmed: ${confirmable.join(', ')}.` : 'No scenario can be confirmed.', ...held.map((h) => `- ${h.id} stays ${h.why}`));
	console.log(lines.join('\n'));
	process.exit(0);
}

/** The scenarios this session covers, split into those a confirmation confirms and those it holds back. */
function coverage() {
	const pending = new Set(pendingChanges(folder).map((i) => i.scenario));
	const states = new Map(allStates(folder).map((s) => [s.id, s]));
	const confirmable = [], held = [];
	for (const f of ctx.features.filter((x) => inSession(state, { feature: x.slug }))) {
		for (const s of f.scenarios) {
			const st = states.get(s.id);
			if (st?.status === 'broken') held.push({ id: s.id, why: `broken: ${st.reason}` });
			else if (pending.has(s.id)) held.push({ id: s.id, why: 'a draft: it waits for a scenario change in the next run' });
			else confirmable.push(s.id);
		}
	}
	return { confirmable, held };
}

if (command === 'confirm') {
	const by = take('--by');
	if (!by) usage('confirm needs --by <writer>: only the writer confirms');
	const open = tree(state).filter((q) => q.state === 'ask');
	if (open.length) { console.log(`session: ${open.length} question(s) still open (${open.map((q) => q.key).join(', ')}); ask them before confirming`); process.exit(1); }
	const { confirmable, held } = coverage();
	for (const h of held) console.log(`${h.id}: not confirmed; it stays ${h.why}`);
	if (!confirmable.length) { console.log('session: nothing to confirm'); process.exit(1); }
	const r = spawnSync(process.execPath, [join(BIN, 'lm-confirm.mjs'), ...target, 'confirm', ...confirmable, '--by', by], { encoding: 'utf8' });
	process.stdout.write(r.stdout + r.stderr);
	state.confirmedBy = by;
	state.confirmedAt = new Date().toISOString();
	saveState(state);
	writeFileSync(transcript, `${readFileSync(transcript, 'utf8')}## Confirmation\n\n${by} confirmed the summary at ${state.confirmedAt}.\n\n${r.stdout}\n`);
	process.exit(r.status === 0 ? 0 : 1);
}

usage(command ? `unknown command "${command}"` : 'name a command');
