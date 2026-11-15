#!/usr/bin/env node
// Setup's deterministic half (spec: Configuration, Packaging, Data safety). The lm-setup skill
// asks the installer; this script reads the workspace and writes the answers.
//
// usage: node living-manual/kit/bin/lm-setup.mjs detect <product>
//          JSON: the Matt Pocock context, and the eight questions, each either answered already
//          (ask: false, detected: <answer>) or to ask (three options, the first recommended).
//        node living-manual/kit/bin/lm-setup.mjs write <product> --answers <file.json | ->
//          Checks the answers and writes the product's section of living-manual.config.json;
//          every other byte of the file stays as it was.
//        node living-manual/kit/bin/lm-setup.mjs check <product>
//          The first touch of the live environment: start, reset and verify, under the product's run
//          lock (bin/lib/lock.mjs), so it waits for a run in progress. Exit 1 when a command fails.
// Run from the workspace root. Exit: 0 written, 2 invalid answers, 3 setup stopped for data
// safety, 4 the Matt Pocock configuration is missing.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { CONFIG } from './lib/workspace.mjs';
import { takeRunLock } from './lib/lock.mjs';
import { format, setPath, deepEqual } from './lib/json-edit.mjs';

const AGENTS = 'docs/agents/';
const AGENT_FILES = ['issue-tracker.md', 'triage-labels.md', 'domain.md'].map((f) => AGENTS + f);
const SOURCE_TYPES = ['manual', 'code', 'spec', 'app'];
const DEFAULT_LIMITS = { scenariosPerRun: 10, runMinutes: 60 };
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_KEY = /(password|passwd|pwd|secret|token|api[-_]?key|credential)s?$/i;

const fail = (message, code) => { process.stderr.write(message + '\n'); process.exit(code); };
const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
const title = (id) => id.split(/[-_]/).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const envPrefix = (product) => 'LM_' + product.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

// ---------------------------------------------------------------- reading the workspace

function readConfig(root) {
	const file = join(root, CONFIG);
	return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

const backticked = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

/** Glossary, ADR and tracker locations, read from what setup-matt-pocock-skills wrote. */
function context(root) {
	const missing = AGENT_FILES.filter((f) => !existsSync(join(root, f)));
	if (missing.length) return {
		ok: false, missing,
		message: `The glossary, ADR and tracker configuration is missing (${missing.join(', ')}): run setup-matt-pocock-skills first, then run setup again.`,
	};
	const read = (f) => readFileSync(join(root, AGENTS + f), 'utf8');
	const domain = backticked(read('domain.md'));
	const glossaries = domain.filter((t) => /GLOSSARY(-MAP)?\.md$/.test(t));
	const trackerText = read('issue-tracker.md');
	const issues = backticked(trackerText).find((t) => t.includes('/issues/'));
	return {
		ok: true,
		glossary: glossaries.find((t) => t.includes('-MAP')) ?? glossaries[0] ?? null,
		adr: domain.find((t) => /adr\/$/i.test(t)) ?? null,
		tracker: issues ? issues.slice(0, issues.indexOf('/issues/') + 8) : (/^#\s*Issue tracker:\s*(.+)$/m.exec(trackerText)?.[1] ?? null),
		from: AGENTS,
	};
}

const REPO_MARKERS = ['.git', 'package.json', 'pom.xml', 'build.gradle', 'go.mod', 'Cargo.toml', 'pyproject.toml'];
const SKIP_FOLDERS = new Set(['living-manual', 'docs', 'node_modules']);

const dirs = (d) => { try { return readdirSync(d).filter((n) => !n.startsWith('.') && statSync(join(d, n)).isDirectory()).sort(); } catch { return []; } };
const files = (d) => { try { return readdirSync(d).filter((n) => statSync(join(d, n)).isFile()).sort(); } catch { return []; } };

/** Top-level folders that look like a repo: a build file, a .git, or a .sln/.csproj. */
const repoCandidates = (root) => dirs(root).filter((n) => !SKIP_FOLDERS.has(n)
	&& (REPO_MARKERS.some((m) => existsSync(join(root, n, m))) || files(join(root, n)).some((f) => /\.(sln|csproj)$/.test(f))));

/** Markdown files under docs/ (three levels) whose path names the product. */
function specCandidates(root, product, name) {
	const out = [];
	const walk = (d, depth) => {
		for (const f of files(join(root, d))) if (/(^|[./-])spec\.md$/i.test(f)) out.push(`${d}/${f}`);
		if (depth < 3) for (const s of dirs(join(root, d))) walk(`${d}/${s}`, depth + 1);
	};
	walk('docs', 1);
	const words = [product, name].filter(Boolean).map((w) => w.toLowerCase().replace(/\s+/g, '-'));
	return out.filter((p) => words.some((w) => p.toLowerCase().includes(w)));
}

/** Folders or PDFs that look like an existing user manual, in the repos and docs/. */
function manualCandidates(root, repos) {
	const out = [];
	for (const d of [...repos, 'docs']) {
		for (const n of [...dirs(join(root, d)), ...files(join(root, d)).filter((f) => f.endsWith('.pdf'))])
			if (/manual|user-?guide|handbook|help/i.test(n) && !/living-manual/i.test(n)) out.push(`${d}/${n}`);
	}
	return out;
}

const featureNames = (folder) => files(folder).filter((f) => f.endsWith('.feature'))
	.map((f) => /^\s*Feature:\s*(.+)$/m.exec(readFileSync(join(folder, f), 'utf8'))?.[1].trim()).filter(Boolean);
const headings = (root, file) => [...readFileSync(join(root, file), 'utf8').matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());

function gitUser(root) {
	const r = spawnSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8' });
	return r.status === 0 ? r.stdout.trim() : '';
}

// ---------------------------------------------------------------- the eight questions

/** Three options, the first recommended; duplicates dropped, gaps filled with "say it in your own words". */
function options(list) {
	const seen = new Set();
	const out = [];
	for (const o of list) {
		const key = JSON.stringify(o.answer);
		if (o.answer == null || seen.has(key)) continue;
		seen.add(key);
		out.push(o);
	}
	while (out.length < 3) out.push({ label: 'Something else: answer in your own words', answer: null });
	return out.slice(0, 3).map((o, i) => ({ ...o, label: i === 0 ? `${o.label} (Recommended)` : o.label }));
}

function questions(root, product, section) {
	const s = section ?? {};
	const name = s.name ?? title(product);
	const all = repoCandidates(root);
	const matching = all.filter((n) => n.toLowerCase().includes(product.toLowerCase()));
	const repos = s.repos ?? (matching.length ? matching : all);
	const kit = `living-manual/products/${product}`;
	const db = s.demoData?.database ?? `lm_${product.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
	const P = envPrefix(product);

	const specs = specCandidates(root, product, name);
	const manuals = manualCandidates(root, repos);
	const code = repos.map((r) => ({ type: 'code', location: r }));
	const app = s.environment?.baseUrl ? [{ type: 'app', location: s.environment.baseUrl }] : [];
	const docs = [...specs.map((l) => ({ type: 'spec', location: l })), ...manuals.map((l) => ({ type: 'manual', location: l }))];

	const baseUrl = s.environment?.baseUrl ?? 'http://localhost:3000/';
	const commands = (label, f) => ({ label, answer: { environment: { start: f('start'), reset: f('reset'), verify: f('verify'), stop: f('stop'), baseUrl } } });
	const envScript = `${kit}/env/env.mjs`;
	const npmDir = [...repos, '.'].find((d) => {
		try { const sc = JSON.parse(readFileSync(join(root, d, 'package.json'), 'utf8')).scripts ?? {}; return 'lm:start' in sc && 'lm:reset' in sc && 'lm:verify' in sc; } catch { return false; }
	});

	const demoFiles = files(join(root, kit, 'demo-data')).filter((f) => f.endsWith('.sql')).map((f) => `${kit}/demo-data/${f}`);
	const provided = demoFiles[0] ?? s.demoData?.file;
	const providedOpt = provided && { label: `Provided file: ${provided} (synthetic, no personal data)`, answer: { demoData: { origin: 'provided', file: provided, database: db, customerCopy: false } } };
	const generatedOpt = { label: `Let AI create the demo data, saved as ${kit}/demo-data/${product}-demo.sql`, answer: { demoData: { origin: 'generated', file: `${kit}/demo-data/${product}-demo.sql`, database: db, customerCopy: false } } };

	const areas = [...featureNames(join(root, kit, 'scenarios')), ...specs.flatMap((f) => headings(root, f))];
	const who = gitUser(root);

	const q = [
		{
			id: 'repos', path: ['repos'], detected: s.repos && { name, repos: s.repos },
			question: `Which repos make up ${name}?`,
			options: options([
				{ label: repos.join(', '), answer: { name, repos } },
				{ label: `Every repo in the workspace: ${all.join(', ')}`, answer: { name, repos: all } },
				...all.map((r) => ({ label: `Only ${r}`, answer: { name, repos: [r] } })),
			]),
		},
		{
			id: 'sources', path: ['sources'], detected: s.sources && { sources: s.sources },
			question: `Where should the kit start from? Sources are code, specs, an existing manual, or the running app.`,
			options: options([
				{ label: [...code, ...docs, ...app].map((x) => `${x.type} ${x.location}`).join(', '), answer: { sources: [...code, ...docs, ...app] } },
				{ label: `Code only: ${repos.join(', ')}`, answer: { sources: code } },
				{ label: `Code and the running app at ${baseUrl}`, answer: { sources: [...code, { type: 'app', location: baseUrl }] } },
			]),
		},
		{
			id: 'commands', path: ['environment.start', 'environment.reset', 'environment.verify', 'environment.baseUrl'],
			detected: s.environment?.start && s.environment?.reset && s.environment?.verify && s.environment?.baseUrl
				&& { environment: { start: s.environment.start, reset: s.environment.reset, verify: s.environment.verify, stop: s.environment.stop, baseUrl } },
			question: `Which commands start ${name} with demo data, reset it to the demo data, and verify that the database holds only demo data? (Base URL ${baseUrl}; say so if it differs.)`,
			options: options([
				...(existsSync(join(root, envScript)) ? [commands(`The kit's env script: node ${envScript} start|reset|verify|stop`, (a) => `node ${envScript} ${a}`)] : []),
				...(npmDir ? [commands(`npm scripts in ${npmDir}: lm:start, lm:reset, lm:verify`, (a) => `npm --prefix ${npmDir} run lm:${a}`)] : []),
				commands(`A kit env script, to write at ${envScript}`, (a) => `node ${envScript} ${a}`),
				commands(`Make targets: make lm-start, lm-reset, lm-verify`, (a) => `make lm-${a}`),
				commands(`npm scripts at the workspace root: lm:start, lm:reset, lm:verify`, (a) => `npm run lm:${a}`),
			]),
		},
		{
			id: 'demoData', path: ['demoData.origin', 'demoData.file', 'demoData.database'],
			detected: s.demoData?.origin && { demoData: { origin: s.demoData.origin, file: s.demoData.file, database: db, customerCopy: s.demoData.customerCopy } },
			question: `Where does the demo data come from? It must hold no personal data.`,
			options: options([
				...(providedOpt ? [providedOpt] : []),
				generatedOpt,
				{ label: 'A copy of customer data (setup stops: the kit only runs on synthetic data)', answer: { demoData: { customerCopy: true } } },
			]),
			confirm: {
				question: `May the kit overwrite database "${db}" before every run? Only answer yes when nothing and nobody else uses it.`,
				options: [
					{ label: `Yes, the kit owns "${db}" and may overwrite it (Recommended)`, answer: { demoData: { kitOwnsDatabase: true } } },
					{ label: 'No, someone else uses it (setup stops)', answer: { demoData: { kitOwnsDatabase: false } } },
					{ label: 'Not sure (setup stops)', answer: { demoData: { kitOwnsDatabase: false } } },
				],
			},
		},
		{
			id: 'testUser', path: ['environment.signIn'], detected: s.environment?.signIn && { environment: { signIn: s.environment.signIn } },
			question: `How does the test user sign in? Secrets stay in environment variables; give only their names.`,
			options: options([
				{ label: `A sign-in form; user name and password from ${P}_USER and ${P}_PASSWORD`, answer: { environment: { signIn: { kind: 'form', userEnv: `${P}_USER`, passwordEnv: `${P}_PASSWORD` } } } },
				{ label: `A session cookie whose value is in ${P}_SESSION`, answer: { environment: { signIn: { kind: 'cookie', cookie: 'session', valueEnv: `${P}_SESSION`, domain: new URL(baseUrl).hostname } } } },
				{ label: 'No sign-in: the app is open', answer: { environment: { signIn: { kind: 'none' } } } },
			]),
		},
		{
			id: 'firstArea', path: ['firstArea'], detected: s.firstArea && { firstArea: s.firstArea },
			question: `Which area of ${name} should the kit document first?`,
			options: options(areas.map((a) => ({ label: a, answer: { firstArea: a } }))),
		},
		{
			id: 'people', path: ['people'], detected: s.people && { people: s.people },
			question: 'Who is the writer, and who reviews the tests (optional)?',
			options: options([
				...(who ? [{ label: `${who} writes; no test reviewer`, answer: { people: { writer: who } } },
					{ label: `${who} writes and reviews the tests`, answer: { people: { writer: who, testReviewer: who } } }] : []),
			]),
		},
		{
			id: 'publish', path: ['publish'], detected: s.publish && { publish: s.publish },
			question: 'Where should the manual be built to?',
			options: options([
				{ label: `${kit}/build/manual (build output, not versioned)`, answer: { publish: { to: `${kit}/build/manual` } } },
				{ label: `docs/${product}-manual (versioned with the workspace)`, answer: { publish: { to: `docs/${product}-manual` } } },
				{ label: `${kit}/site (a folder to host as a static site)`, answer: { publish: { to: `${kit}/site` } } },
			]),
		},
	];
	return q.map(({ path, detected, ...rest }) => ({
		...rest,
		ask: !detected || rest.id === 'demoData', // the ownership confirmation is asked every time
		...(detected ? { detected } : {}),
	}));
}

// ---------------------------------------------------------------- write

/** The paths an answer may set. Each replaces what is there; everything else in the section is kept. */
const OWNED = ['name', 'repos', 'sources', 'environment.start', 'environment.reset', 'environment.verify', 'environment.stop',
	'environment.baseUrl', 'environment.signIn', 'demoData.origin', 'demoData.file', 'demoData.database', 'demoData.customerCopy',
	'demoData.kitOwnsDatabase', 'firstArea', 'people', 'publish', 'limits'];
const REQUIRED = ['name', 'repos', 'sources', 'environment.start', 'environment.reset', 'environment.verify', 'environment.baseUrl',
	'environment.signIn', 'demoData.origin', 'demoData.file', 'demoData.database', 'firstArea', 'people.writer', 'publish.to'];

function leaves(o, prefix = '') {
	return Object.entries(o).flatMap(([k, v]) => {
		const p = prefix + k;
		return OWNED.includes(p) || v === null || typeof v !== 'object' || Array.isArray(v) ? [p] : leaves(v, p + '.');
	});
}

function setIn(o, path, v) {
	const ks = path.split('.');
	let t = o;
	for (const k of ks.slice(0, -1)) t = t[k] && typeof t[k] === 'object' ? t[k] : (t[k] = {});
	t[ks.at(-1)] = v;
}

/** Every string under a secret-sounding key is a typed secret; every *Env value must be a variable name. */
function secretErrors(o, prefix = '') {
	if (!o || typeof o !== 'object') return [];
	return Object.entries(o).flatMap(([k, v]) => {
		const p = prefix + k;
		if (k.endsWith('Env')) return typeof v === 'string' && ENV_NAME.test(v) ? [] : [`${p}: not an environment-variable name (use letters, digits and _, e.g. LM_PASSWORD)`];
		if (SECRET_KEY.test(k) && typeof v === 'string') return [`${p}: a secret goes in an environment variable; name it in ${p}Env`];
		return secretErrors(v, p + '.');
	});
}

function check(section) {
	const errors = REQUIRED.filter((p) => {
		const v = get(section, p);
		return v == null || v === '' || (Array.isArray(v) && v.length === 0);
	}).map((p) => `${p}: missing`);
	for (const [i, src] of (Array.isArray(section.sources) ? section.sources : []).entries())
		if (!SOURCE_TYPES.includes(src?.type) || !src?.location) errors.push(`sources[${i}]: needs a type (${SOURCE_TYPES.join(', ')}) and a location`);
	if (section.demoData?.origin && !['provided', 'generated'].includes(section.demoData.origin)) errors.push('demoData.origin: "provided" or "generated"');
	if (section.environment?.signIn && !section.environment.signIn.kind) errors.push('environment.signIn.kind: missing');
	return [...errors, ...secretErrors(section)];
}

function write(root, product, answers) {
	const ctx = context(root);
	if (!ctx.ok) fail(`setup stopped: ${ctx.message}`, 4);

	const unknown = leaves(answers).filter((p) => !OWNED.includes(p));
	if (unknown.length) fail(`setup refused the answers:\n${unknown.map((p) => `  ${p}: not a setup answer`).join('\n')}`, 2);

	const config = readConfig(root) ?? { products: {} };
	const old = config.products?.[product];
	const section = structuredClone(old ?? {});
	for (const p of OWNED) { const v = get(answers, p); if (v !== undefined) setIn(section, p, v); }
	section.context = { glossary: ctx.glossary, adr: ctx.adr, tracker: ctx.tracker, from: ctx.from };
	section.limits ??= DEFAULT_LIMITS;

	// Data safety comes first: these stop setup whatever else the answers hold.
	const demo = section.demoData ?? {};
	if (demo.customerCopy === true) fail('setup stopped: the demo data is a copy of customer data. The kit runs only on synthetic demo data; provide a synthetic file or let AI create one, then run setup again.', 3);
	if (demo.customerCopy !== false) fail('setup stopped: the installer has not stated that the demo data is not a copy of customer data.', 3);
	if (get(answers, 'demoData.kitOwnsDatabase') !== true)
		fail(`setup stopped: the installer did not confirm that the kit owns the database "${demo.database ?? '(none named)'}" and may overwrite it. Give the kit a database of its own, then run setup again.`, 3);
	if ((demo.forbiddenDatabases ?? []).includes(demo.database)) fail(`setup stopped: "${demo.database}" is listed in demoData.forbiddenDatabases.`, 3);

	const errors = check(section);
	if (errors.length) fail(`setup refused the answers:\n${errors.map((e) => `  ${e}`).join('\n')}`, 2);

	const file = join(root, CONFIG);
	if (!existsSync(file)) {
		mkdirSync(join(root, 'living-manual'), { recursive: true });
		writeFileSync(file, format({
			_about: 'Living Manual workspace configuration (Living Manual kit, Configuration). One section per product. Secrets appear only as environment-variable names. Commands run from the workspace root.',
			products: { [product]: section },
		}) + '\n');
	} else if (!deepEqual(old, section)) {
		writeFileSync(file, setPath(readFileSync(file, 'utf8'), ['products', product], section));
	}
	console.log(`setup OK: wrote product "${product}" to ${relative(root, file)}${old ? ' (updated)' : ''}`);
}

// ---------------------------------------------------------------- main

const [cmd, product, ...rest] = process.argv.slice(2);
const usage = 'usage: lm-setup.mjs detect <product> | write <product> --answers <file.json|-> | check <product>';
if (!['detect', 'write', 'check'].includes(cmd) || !product) fail(usage, 2);
if (!/^[a-z][a-z0-9-]*$/.test(product)) fail(`product id "${product}": lower-case letters, digits and -, starting with a letter`, 2);
const root = process.cwd();

if (cmd === 'detect') {
	const config = readConfig(root);
	const section = config?.products?.[product];
	console.log(JSON.stringify({
		workspace: root,
		product,
		configured: Boolean(section),
		otherProducts: Object.keys(config?.products ?? {}).filter((p) => p !== product),
		context: context(root),
		questions: questions(root, product, section),
	}, null, '\t'));
} else if (cmd === 'check') {
	const env = readConfig(root)?.products?.[product]?.environment;
	if (!env) fail(`setup check FAIL: no product "${product}" in ${CONFIG}; run setup's write first`, 2);
	takeRunLock(product, `lm-setup check ${product}`);
	for (const step of ['start', 'reset', 'verify']) {
		if (!env[step]) { console.log(`setup check FAIL: no ${step} command in the configuration`); process.exit(1); }
		const r = spawnSync(env[step], { cwd: root, shell: '/bin/sh', stdio: 'inherit' });
		if (r.status !== 0) { console.log(`setup check FAIL: ${step} failed (exit ${r.status}): ${env[step]}`); process.exit(1); }
	}
	console.log(`setup check PASS: ${product} started, reset and verified under the run lock`);
} else {
	const i = rest.indexOf('--answers');
	if (i < 0 || !rest[i + 1]) fail(usage, 2);
	const src = rest[i + 1] === '-' ? readFileSync(0, 'utf8') : readFileSync(rest[i + 1], 'utf8');
	let answers;
	try { answers = JSON.parse(src); } catch (e) { fail(`setup refused the answers: not JSON (${e.message})`, 2); }
	write(root, product, answers);
}
