#!/usr/bin/env node
// Watch (spec: Watch; From scenario to test code, Healer; Confirmation). After the product
// changed, reruns every doc scenario, one at a time, under the product's run lock:
//
// 1. parity check (a run counts only when it holds);
// 2. per scenario, in feature-file order, while time is left: the run gate (lm-env run --fresh:
//    reset, verify, then Playwright for that one scenario, which skips its own reset). When it fails and healing is on, the kit's healer
//    agent (bin/lm-agent.mjs healer) gets the failure; then the guard (bin/lib/heal-guard.mjs)
//    reads what it changed in the product's tests/ and scenarios/ (every file; one added or
//    deleted is a behaviour change, and undoing a repair removes the files it added):
//    - no change: the healer stopped → broken;
//    - locators and waits only: the scenario runs again; green → healed, else broken (repair undone);
//    - anything else (an action added, removed or reordered, an assertion or value changed, a step
//      title changed): the repair is undone (files restored) → broken.
//    A broken scenario is marked broken in confirmation.json with the reason (lm-confirm status
//    shows it), so it needs the writer again; lm-issues after-run files it as a broken-scenario
//    issue; lm-publish keeps its last published page.
// 3. the outputs, from the new step records: lm-compare, lm-facts (a confirmed scenario whose
//    action list changed — a heal — lapses; a renamed label alone keeps it), lm-issues after-run,
//    lm-manual (only pages whose step record or screenshots changed are rewritten), lm-publish,
//    the guide index (lm-build-guide) when anything changed, and a scenario's video (lm-video)
//    when it changed, already has a video, and is still eligible (confirmed).
// 4. the report: build/watch/report.md and report.json, one line per scenario on stdout:
//    new | unchanged | changed | healed | broken | not reached.
//
// The time limit (config limits.runMinutes, or --minutes) is hard: a scenario or a healer still
// running at the limit is stopped (its files restored, its run before the watch put back so its
// outputs stay as they were), and it and every scenario after it are reported as not reached. The healer gets at most limits.healMinutes (default 15) per scenario.
//
// usage: node living-manual/kit/bin/lm-watch.mjs <product> [--minutes <n>] [--no-heal]
// Exit 0 every scenario ran and none is broken, 1 a scenario is broken (or parity failed),
// 4 the time limit stopped the watch before every scenario ran (and none is broken).
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productConfig, productFolder, workspaceRoot } from './lib/workspace.mjs';
import { takeRunLock } from './lib/lock.mjs';
import { docScenarios } from './lib/cases.mjs';
import { differences, readRecord, screenshots, sourceFingerprint, stableRecord } from './lib/record.mjs';
import { classifyHeal, featureChanges } from './lib/heal-guard.mjs';
import { allStates, markBroken } from './lib/confirmation.mjs';
import { videoEligible } from './lib/eligible.mjs';
import { tracker } from './lib/issues.mjs';

const argv = process.argv.slice(2);
const product = argv[0];
if (!product || product.startsWith('-')) { process.stderr.write('usage: lm-watch.mjs <product> [--minutes <n>] [--no-heal]\n'); process.exit(2); }
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const root = workspaceRoot();
const section = productConfig(root, product);
const folder = productFolder(root, product);
const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = (f) => join(KIT, 'bin', f);
const limitMinutes = Number(opt('--minutes') ?? section.limits?.runMinutes ?? 60);
const healMinutes = Number(section.limits?.healMinutes ?? 15);
const heal = !argv.includes('--no-heal');

takeRunLock(product, `lm-watch ${argv.join(' ')}`);
process.env.LM_WORKSPACE = root;
const startedAt = new Date();
const deadline = startedAt.getTime() + limitMinutes * 60_000;
const left = () => deadline - Date.now();

const build = join(folder, 'build');
const watchDir = join(build, 'watch');
rmSync(watchDir, { recursive: true, force: true });
mkdirSync(join(watchDir, 'logs'), { recursive: true });
const rel = (p) => relative(root, p);
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const say = (line) => console.log(line);

// ---- Child processes: own process group, so the limit stops Playwright and the healer too ----

let current = null;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (current) try { process.kill(-current.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(130); });

/** Runs node <args> from the workspace root; resolves { code, out, timedOut }. Output goes to log. */
function run(args, { log, ms = left() } = {}) {
	return new Promise((done) => {
		if (ms <= 0) { done({ code: null, out: '', timedOut: true }); return; }
		const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
		current = child;
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (out += d));
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
			setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref();
		}, ms);
		child.on('close', (code) => {
			clearTimeout(timer);
			current = null;
			if (log) writeFileSync(log, out, { flag: 'a' });
			done({ code, out, timedOut });
		});
	});
}
const node = (...args) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: process.env });

// ---- 1. Parity ---------------------------------------------------------------------------------

const parity = node(bin('lm-parity.mjs'), product);
if (parity.status !== 0) {
	process.stdout.write(parity.stdout + parity.stderr);
	say('watch refused: parity failed; no scenario was run');
	process.exit(1);
}

// ---- 2. The scenarios --------------------------------------------------------------------------

const scenarios = docScenarios(folder).filter((s) => s.id && !s.tags.includes('@manual'));
const runDir = (id) => join(build, 'runs', id);

/** The scenario's step record before the watch, with the folder its screenshots are in. */
function baseline(id) {
	const saved = join(watchDir, 'baseline', id);
	if (existsSync(join(runDir(id), 'step-record.json'))) {
		cpSync(runDir(id), saved, { recursive: true });
		return { dir: saved, rec: readRecord(saved), from: 'run' };
	}
	const packRec = join(folder, 'facts/step-records', `${id}.json`);
	const packShots = join(folder, 'facts/screenshots', id);
	if (existsSync(packRec) && existsSync(packShots)) return { dir: packShots, rec: JSON.parse(readFileSync(packRec, 'utf8')), from: 'facts pack' };
	return null;
}

const fingerprint = (b) => { try { return sourceFingerprint(b.dir, b.rec); } catch { return null; } };
const unquote = (line) => line.replace(/: "((?:[^"\\]|\\.)*)" → "((?:[^"\\]|\\.)*)"$/, ': $1 → $2');

/** What differs between the baseline and the new run: record fields and screenshots. */
function whatChanged(base, now) {
	const lines = differences(stableRecord(base.rec), stableRecord(now.rec)).map(unquote);
	for (const shot of screenshots(now.rec)) {
		const a = join(base.dir, shot), b = join(now.dir, shot);
		if (!existsSync(a)) lines.push(`${shot}: new screenshot`);
		else if (!readFileSync(a).equals(readFileSync(b))) lines.push(`${shot}: screenshot changed`);
	}
	return lines;
}

/** One scenario through the gate. */
async function runScenario(id, log) {
	// One reset and one verify: the gate resets (--fresh) and verifies, and the scenario's own
	// reset is skipped for it.
	const playwright = `cd ${q(KIT)} && node_modules/.bin/playwright test --project=${q(product)} --grep-invert @seed --grep ${q(`${id}\\b`)} --reporter=line`;
	const r = await run([bin('lm-env.mjs'), product, 'run', '--fresh', '--', playwright], { log });
	let rec = null;
	try { rec = readRecord(runDir(id)); } catch { /* none */ }
	const passed = r.code === 0 && rec?.run?.status === 'passed';
	// Playwright colours its messages; the report and the issue get plain text.
	const plain = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');
	const error = plain(rec?.run?.error ?? (r.code === 3 ? 'verify refused the run' : r.out.split('\n').find((l) => /Error|failed/.test(l))?.trim() ?? `exit ${r.code}`));
	return { passed, timedOut: r.timedOut, error, rec };
}

/** Every file under the product's tests/ and scenarios/, path → contents (bytes). */
function snapshot() {
	const files = new Map();
	for (const d of ['tests', 'scenarios']) {
		const dir = join(folder, d);
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir, { recursive: true })) {
			const p = join(dir, String(f));
			if (statSync(p).isFile()) files.set(p, readFileSync(p));
		}
	}
	return files;
}
/** Puts tests/ and scenarios/ back as they were: changed and deleted files rewritten, added ones removed. */
function restore(snap) {
	for (const [p, bytes] of snap) if (!existsSync(p) || !readFileSync(p).equals(bytes)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, bytes); }
	for (const p of snapshot().keys()) if (!snap.has(p)) rmSync(p, { force: true });
}

/** The guard over everything the healer changed: { verdict, reasons, files }. */
function guard(before) {
	const after = snapshot();
	const reasons = [];
	const files = [];
	let locator = false;
	// A file the healer added (a helper, a second spec, anything) is not a locator or wait repair.
	for (const p of after.keys()) if (!before.has(p)) { reasons.push(`${rel(p)} was added`); files.push(rel(p)); }
	for (const [p, bytes] of before) {
		const now = after.get(p);
		if (now === undefined) { reasons.push(`${rel(p)} was deleted`); files.push(rel(p)); continue; }
		if (now.equals(bytes)) continue;
		files.push(rel(p));
		if (p.endsWith('.feature')) { reasons.push(...featureChanges(bytes.toString('utf8'), now.toString('utf8')).map((r) => `${rel(p)}: ${r}`)); continue; }
		if (!/\.(ts|js|mjs)$/.test(p)) { reasons.push(`${rel(p)} was changed`); continue; }
		const c = classifyHeal(bytes.toString('utf8'), now.toString('utf8'));
		if (c.verdict === 'behaviour change') reasons.push(...c.reasons);
		else if (c.verdict === 'locator/wait only') locator = true;
	}
	if (reasons.length) return { verdict: 'behaviour change', reasons, files };
	return { verdict: locator ? 'locator/wait only' : 'no change', reasons: [], files };
}

/** A scenario the limit stopped keeps the run it had before the watch, so its outputs stay as they were. */
function keepBaseline(id, base) {
	if (base?.from !== 'run') return;
	rmSync(runDir(id), { recursive: true, force: true });
	cpSync(base.dir, runDir(id), { recursive: true });
}

const results = [];
let stoppedAt = null;
for (const s of scenarios) {
	const id = s.id;
	if (left() <= 0) { results.push({ id, title: s.title, status: 'not reached' }); continue; }
	const log = join(watchDir, 'logs', `${id}.log`);
	const base = baseline(id);
	let r = await runScenario(id, log);
	const result = { id, title: s.title, file: s.file };
	if (r.timedOut) { keepBaseline(id, base); stoppedAt ??= id; results.push({ ...result, status: 'not reached', note: 'stopped at the time limit while it ran' }); continue; }
	if (!r.passed && heal) {
		const before = snapshot();
		const prompt = `lm-watch: the doc scenario ${id} ("${s.title}", ${s.file}) failed in a watch run: ${r.error}. Repair locators and waits only. You were started by lm-watch: do not edit the feature file and do not file an issue; if the repair would be a behaviour change, change nothing and end with "broken ${id}: <what changed>". lm-watch checks your change with bin/lm-heal-guard.mjs, marks the scenario broken and files the issue.`;
		const healLog = join(watchDir, 'logs', `${id}.healer.log`);
		const h = await run([bin('lm-agent.mjs'), product, 'healer', '--log', rel(healLog), '--', prompt], { log, ms: Math.min(left(), healMinutes * 60_000) });
		const said = existsSync(healLog) ? readFileSync(healLog, 'utf8').trim().split('\n').filter((l) => new RegExp(`^(healed|broken) ${id}\\b`).test(l.trim())).pop()?.trim() : null;
		const g = guard(before);
		result.healer = { exit: h.code, said: said ?? null, guard: g.verdict, reasons: g.reasons, files: g.files, log: rel(healLog) };
		if (h.timedOut) {
			restore(before);
			keepBaseline(id, base);
			stoppedAt ??= id;
			results.push({ ...result, status: 'not reached', note: 'the healer was stopped at the time limit; its changes were undone' });
			continue;
		}
		if (g.verdict === 'locator/wait only') {
			const healed = await runScenario(id, log);
			// The run before the watch is the one to compare with, not the failed attempt.
			if (base?.from === 'run') { rmSync(join(build, 'previous', id), { recursive: true, force: true }); cpSync(base.dir, join(build, 'previous', id), { recursive: true }); }
			if (healed.timedOut) { restore(before); keepBaseline(id, base); stoppedAt ??= id; results.push({ ...result, status: 'not reached', note: 'stopped at the time limit while the repaired scenario ran; the repair was undone' }); continue; }
			if (healed.passed) r = { ...healed, healed: true };
			else { restore(before); result.reason = `the healer's locator/wait repair did not make it pass (${healed.error}); the repair was undone`; }
		} else if (g.verdict === 'behaviour change') {
			restore(before);
			result.reason = `the healer's repair was a behaviour change, rejected and undone: ${g.reasons.join('; ')}`;
		} else {
			restore(before);
			result.reason = `the healer made no repair${said ? ` (${said})` : ''}; the run failed: ${r.error}`;
		}
	} else if (!r.passed) result.reason = `the run failed: ${r.error} (healing is off)`;

	if (!r.passed) { results.push({ ...result, status: 'broken', error: r.error }); continue; }
	const now = { dir: runDir(id), rec: r.rec };
	const changes = base ? whatChanged(base, now) : [];
	const same = base && fingerprint(base) === fingerprint(now);
	const status = r.healed ? 'healed' : !base ? 'new' : same ? 'unchanged' : 'changed';
	results.push({ ...result, status, changes, baselineFrom: base?.from ?? null });
}

// A broken scenario needs the writer again: recorded with its reason before the facts pack.
const at = new Date().toISOString();
for (const x of results.filter((r) => r.status === 'broken')) markBroken(folder, x.id, `watch ${at.slice(0, 10)}: ${x.reason}`, at);

// ---- 3. The outputs ----------------------------------------------------------------------------

const outputs = [];
const step = (label, ...args) => {
	const r = node(...args);
	writeFileSync(join(watchDir, 'logs', 'outputs.log'), `$ ${label}\n${r.stdout}${r.stderr}\n`, { flag: 'a' });
	return r;
};
const ran = results.filter((r) => r.status !== 'not reached');
if (ran.length) step('lm-compare', bin('lm-compare.mjs'), product);
const facts = step('lm-facts', bin('lm-facts.mjs'), product);
if (facts.status === 0) step('lm-issues after-run', bin('lm-issues.mjs'), product, 'after-run');

const manualDir = section.publish?.to ? join(root, section.publish.to) : join(build, 'manual');
const pagesNow = () => new Map(existsSync(manualDir) ? readdirSync(manualDir).filter((f) => f.endsWith('.md')).map((f) => [f, readFileSync(join(manualDir, f), 'utf8')]) : []);
const pagesBefore = pagesNow();
step('lm-manual', bin('lm-manual.mjs'), product);
const pagesAfter = pagesNow();
for (const [f, text] of pagesAfter) if (pagesBefore.get(f) !== text) outputs.push({ kind: 'manual page', what: rel(join(manualDir, f)), how: pagesBefore.has(f) ? 'regenerated' : 'new' });
for (const f of pagesBefore.keys()) if (!pagesAfter.has(f)) outputs.push({ kind: 'manual page', what: rel(join(manualDir, f)), how: 'no longer in the manual (its run did not pass); the site keeps its last published version' });
const published = step('lm-publish', bin('lm-publish.mjs'), product);
if (published.status === 0) outputs.push({ kind: 'site and preview', what: [section.publish?.site, section.publish?.preview].filter(Boolean).join(', ') || rel(join(build, 'site')), how: 'rebuilt' });
const moved = results.filter((r) => ['changed', 'healed', 'broken', 'new'].includes(r.status));
if (moved.length) {
	const g = step('lm-build-guide', bin('lm-build-guide.mjs'), product);
	outputs.push({ kind: 'guide index', what: rel(join(build, 'guide/guide-index.json')), how: g.status === 0 ? 'rebuilt' : `not rebuilt (lm-build-guide exit ${g.status})` });
}
for (const x of results.filter((r) => ['changed', 'healed'].includes(r.status))) {
	if (!existsSync(join(build, 'videos', `${x.id}.mp4`))) continue;
	const e = videoEligible(readRecord(runDir(x.id)), folder);
	if (!e.eligible) { outputs.push({ kind: 'video', what: `${x.id}`, how: `kept, not regenerated: ${e.reason}` }); continue; }
	const v = step(`lm-video ${x.id}`, bin('lm-video.mjs'), product, '--id', x.id);
	outputs.push({ kind: 'video', what: rel(join(build, 'videos', `${x.id}.mp4`)), how: v.status === 0 ? 'regenerated' : `failed (lm-video exit ${v.status}; see ${rel(join(watchDir, 'logs/outputs.log'))})` });
}

// ---- 4. The report -----------------------------------------------------------------------------

const states = new Map(allStates(folder).map((s) => [s.id, s]));
/** The open issue in the workspace's tracker (lm-issues) that lists the scenario as broken. */
const issueOf = (id) => {
	let dir;
	try { dir = tracker(root, product).dir; } catch { return null; }
	if (!existsSync(dir)) return null;
	return readdirSync(dir).filter((f) => f.endsWith('.md') && readFileSync(join(dir, f), 'utf8').includes(`<!-- lm-item: broken-scenario ${id} -->`)).map((f) => rel(join(dir, f))).sort().pop() ?? null;
};
for (const x of results) {
	x.confirmation = states.get(x.id) ? `${states.get(x.id).status} (${states.get(x.id).reason})` : null;
	if (x.status === 'broken') x.issue = issueOf(x.id);
}
const endedAt = new Date();
const notReached = results.filter((r) => r.status === 'not reached');
const report = {
	kind: 'living-manual/watch-report', version: 1, product, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(),
	limitMinutes, heal, stoppedAtLimit: notReached.length > 0, scenarios: results, outputs,
};
writeFileSync(join(watchDir, 'report.json'), `${JSON.stringify(report, null, '\t')}\n`);

const group = (status, title, line) => {
	const xs = results.filter((r) => r.status === status);
	return [`## ${title}`, '', ...(xs.length ? xs.flatMap(line) : ['None.']), ''];
};
const minutes = ((endedAt - startedAt) / 60_000).toFixed(1);
const md = [
	`# Watch: ${section.name ?? product}`,
	'',
	`${startedAt.toISOString()} → ${endedAt.toISOString()} (${minutes} min of ${limitMinutes}); healing ${heal ? 'on' : 'off'}; ${results.length} doc scenario(s).`,
	'',
	`Changed: ${results.filter((r) => r.status === 'changed').length} · healed: ${results.filter((r) => r.status === 'healed').length} · broken: ${results.filter((r) => r.status === 'broken').length} · unchanged: ${results.filter((r) => r.status === 'unchanged').length} · new: ${results.filter((r) => r.status === 'new').length}`,
	'',
	notReached.length ? `**Not reached** (time limit ${limitMinutes} min): ${notReached.map((r) => `${r.id}${r.note ? ` (${r.note})` : ''}`).join(', ')}` : 'Not reached: none',
	'',
	...group('changed', 'Changed', (r) => [`- **${r.id}** ${r.title} · confirmation: ${r.confirmation}`, ...r.changes.slice(0, 20).map((c) => `  - ${c}`), ...(r.changes.length > 20 ? [`  - … ${r.changes.length - 20} more`] : [])]),
	...group('healed', 'Healed', (r) => [`- **${r.id}** ${r.title}: the healer's repair was locator/wait only (${r.healer.files.join(', ')}); green on the rerun · confirmation: ${r.confirmation}`, ...(r.healer.said ? [`  - healer: ${r.healer.said}`] : []), ...r.changes.slice(0, 20).map((c) => `  - ${c}`)]),
	...group('broken', 'Broken', (r) => [`- **${r.id}** ${r.title}: ${r.reason}`, `  - issue: ${r.issue ?? '(none filed; see lm-issues in the outputs log)'}`, `  - confirmation: ${r.confirmation}`, ...(r.healer ? [`  - healer log: ${r.healer.log}`] : [])]),
	...group('unchanged', 'Unchanged', (r) => [`- ${r.id} ${r.title}`]),
	...group('new', 'New (no earlier run to compare with)', (r) => [`- ${r.id} ${r.title}`]),
	'## Outputs',
	'',
	...(outputs.length ? outputs.map((o) => `- ${o.kind}: ${o.what}: ${o.how}`) : ['Nothing regenerated.']),
	'',
	`Logs: ${rel(join(watchDir, 'logs'))}/ · comparison: ${rel(join(build, 'compare.md'))}`,
	'',
].join('\n');
writeFileSync(join(watchDir, 'report.md'), md);

for (const r of results) say(`${r.id}: ${r.status}${r.reason ? `: ${r.reason}` : r.note ? ` (${r.note})` : ''}${r.issue ? ` · issue ${r.issue}` : ''}`);
for (const o of outputs) say(`output ${o.kind}: ${o.what}: ${o.how}`);
if (notReached.length) say(`watch stopped at the time limit (${limitMinutes} min): not reached ${notReached.map((r) => r.id).join(', ')}`);
say(`watch: ${results.length} scenario(s) in ${minutes} min; report ${rel(join(watchDir, 'report.md'))}`);
process.exit(results.some((r) => r.status === 'broken') ? 1 : notReached.length ? 4 : 0);
