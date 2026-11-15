// Setup (spec: Configuration, Packaging, Data safety). The lm-setup skill asks the installer eight
// questions; lm-setup.mjs is the deterministic part it drives: `detect` reads the workspace and
// says what it already knows and what to ask, `write` checks the answers and writes the product's
// section of living-manual.config.json. Tested on a fixture workspace (test/fixtures/
// setup-workspace: two repos, a spec, the Matt Pocock configuration) copied to a temp folder; we
// check what a person sees: the exit code, the message and the config file on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LM_SETUP = join(HERE, '../bin/lm-setup.mjs');
const FIXTURE = join(HERE, 'fixtures/setup-workspace');
const CONFIG = 'living-manual/living-manual.config.json';

function workspace() {
	const root = mkdtempSync(join(tmpdir(), 'lm-setup-'));
	cpSync(FIXTURE, root, { recursive: true });
	return root;
}

const setup = (root, args, input) =>
	spawnSync(process.execPath, [LM_SETUP, ...args], { cwd: root, encoding: 'utf8', input });

const detect = (root, product) => {
	const r = setup(root, ['detect', product]);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	return JSON.parse(r.stdout);
};

const write = (root, product, answers) => setup(root, ['write', product, '--answers', '-'], JSON.stringify(answers));

const question = (d, id) => d.questions.find((q) => q.id === id);

/** A full set of answers for the fixture's product "shop", as the skill would collect them. */
const shopAnswers = () => ({
	name: 'Shop',
	repos: ['shop-web', 'shop-api'],
	sources: [{ type: 'code', location: 'shop-web' }, { type: 'spec', location: 'docs/shop/spec.md' }],
	environment: {
		start: 'node living-manual/products/shop/env/env.mjs start',
		reset: 'node living-manual/products/shop/env/env.mjs reset',
		verify: 'node living-manual/products/shop/env/env.mjs verify',
		baseUrl: 'http://localhost:3000/',
		signIn: { kind: 'form', userEnv: 'LM_SHOP_USER', passwordEnv: 'LM_SHOP_PASSWORD' },
	},
	demoData: { origin: 'generated', file: 'living-manual/products/shop/demo-data/shop-demo.sql', database: 'lm_shop', customerCopy: false, kitOwnsDatabase: true },
	firstArea: 'Orders',
	people: { writer: 'Wendy', testReviewer: 'Per' },
	publish: { to: 'living-manual/products/shop/build/manual' },
});

test('detect asks the eight questions, each with three options, the first recommended', () => {
	const root = workspace();
	const d = detect(root, 'shop');
	assert.deepEqual(d.questions.map((q) => q.id),
		['repos', 'sources', 'commands', 'demoData', 'testUser', 'firstArea', 'people', 'publish']);
	for (const q of d.questions) {
		assert.equal(q.ask, true, `${q.id} should be asked in a fresh workspace`);
		assert.equal(q.options.length, 3, `${q.id} has three options`);
		assert.match(q.options[0].label, /\(Recommended\)$/, `${q.id}'s first option is the recommended one`);
		for (const o of q.options) assert.ok(o.answer !== undefined, `${q.id} option "${o.label}" carries its answer`);
	}
	rmSync(root, { recursive: true });
});

test('detect finds the repos and sources in the workspace and offers them', () => {
	const root = workspace();
	const d = detect(root, 'shop');
	assert.deepEqual(question(d, 'repos').options[0].answer.repos, ['shop-api', 'shop-web']);
	const sources = question(d, 'sources').options[0].answer.sources;
	assert.deepEqual(sources, [
		{ type: 'code', location: 'shop-api' },
		{ type: 'code', location: 'shop-web' },
		{ type: 'spec', location: 'docs/shop/spec.md' },
		{ type: 'manual', location: 'shop-web/user-manual' },
	]);
	assert.deepEqual(question(d, 'firstArea').options.slice(0, 2).map((o) => o.answer.firstArea), ['Orders', 'Customers']);
	rmSync(root, { recursive: true });
});

test('glossary, ADR and tracker locations come from the Matt Pocock configuration, never asked', () => {
	const root = workspace();
	const d = detect(root, 'shop');
	assert.equal(d.context.ok, true);
	assert.equal(d.context.glossary, 'GLOSSARY-MAP.md');
	assert.equal(d.context.adr, 'docs/<feature>/adr/');
	assert.equal(d.context.tracker, '.scratch/<feature-slug>/issues/');
	assert.ok(!d.questions.some((q) => /glossary|adr|tracker/i.test(q.id)));
	rmSync(root, { recursive: true });
});

test('without the Matt Pocock configuration, setup says to run setup-matt-pocock-skills first', () => {
	const root = workspace();
	rmSync(join(root, 'docs/agents/domain.md'));
	const d = detect(root, 'shop');
	assert.equal(d.context.ok, false);
	assert.deepEqual(d.context.missing, ['docs/agents/domain.md']);
	assert.match(d.context.message, /run setup-matt-pocock-skills first/);

	const w = write(root, 'shop', shopAnswers());
	assert.equal(w.status, 4, w.stdout + w.stderr);
	assert.match(w.stderr, /setup stopped: .*docs\/agents\/domain\.md.*run setup-matt-pocock-skills first/);
	assert.equal(existsSync(join(root, CONFIG)), false, 'nothing written');
	rmSync(root, { recursive: true });
});

test('write records the answers as the product section, with the context from the Matt Pocock configuration', () => {
	const root = workspace();
	const w = write(root, 'shop', shopAnswers());
	assert.equal(w.status, 0, w.stdout + w.stderr);
	assert.match(w.stdout, /setup OK: wrote product "shop" to living-manual\/living-manual\.config\.json/);
	const section = JSON.parse(readFileSync(join(root, CONFIG), 'utf8')).products.shop;
	assert.deepEqual(section.repos, ['shop-web', 'shop-api']);
	assert.equal(section.environment.reset, 'node living-manual/products/shop/env/env.mjs reset');
	assert.equal(section.demoData.kitOwnsDatabase, true);
	assert.equal(section.firstArea, 'Orders');
	assert.deepEqual(section.people, { writer: 'Wendy', testReviewer: 'Per' });
	assert.equal(section.publish.to, 'living-manual/products/shop/build/manual');
	assert.deepEqual(section.context, { glossary: 'GLOSSARY-MAP.md', adr: 'docs/<feature>/adr/', tracker: '.scratch/<feature-slug>/issues/', from: 'docs/agents/' });
	assert.ok(section.limits.scenariosPerRun > 0 && section.limits.runMinutes > 0, 'default limits written');
	rmSync(root, { recursive: true });
});

test('setup stops when the installer states the data is a copy of customer data', () => {
	const root = workspace();
	const a = shopAnswers();
	a.demoData.customerCopy = true;
	const w = write(root, 'shop', a);
	assert.equal(w.status, 3, w.stdout + w.stderr);
	assert.match(w.stderr, /setup stopped: the demo data is a copy of customer data/);
	assert.equal(existsSync(join(root, CONFIG)), false, 'nothing written');
	rmSync(root, { recursive: true });
});

test('setup stops when the installer does not confirm that the kit owns the database', () => {
	for (const owns of [false, undefined, 'not sure']) {
		const root = workspace();
		const a = shopAnswers();
		a.demoData.kitOwnsDatabase = owns;
		const w = write(root, 'shop', a);
		assert.equal(w.status, 3, `kitOwnsDatabase=${owns}: ${w.stdout}${w.stderr}`);
		assert.match(w.stderr, /setup stopped: .*kit owns the database "lm_shop"/);
		assert.equal(existsSync(join(root, CONFIG)), false, 'nothing written');
		rmSync(root, { recursive: true });
	}
});

test('the database-ownership confirmation is always asked, even when the config already records it', () => {
	const root = workspace();
	assert.equal(write(root, 'shop', shopAnswers()).status, 0);
	const d = detect(root, 'shop');
	const demo = question(d, 'demoData');
	assert.equal(demo.ask, true);
	assert.equal(demo.confirm.options.length, 3);
	assert.match(demo.confirm.question, /lm_shop/);
	rmSync(root, { recursive: true });
});

test('a secret typed as an answer is refused; secrets are written only as environment-variable names', () => {
	const root = workspace();
	const a = shopAnswers();
	a.environment.signIn = { kind: 'form', user: 'clerk', password: 'hunter2' };
	const w = write(root, 'shop', a);
	assert.equal(w.status, 2, w.stdout + w.stderr);
	assert.match(w.stderr, /environment\.signIn\.password: a secret goes in an environment variable; name it in environment\.signIn\.passwordEnv/);
	assert.doesNotMatch(w.stderr, /hunter2/, 'the secret is not echoed');
	assert.equal(existsSync(join(root, CONFIG)), false, 'nothing written');

	a.environment.signIn = { kind: 'form', userEnv: 'LM_SHOP_USER', passwordEnv: 'hunter2 ' };
	const bad = write(root, 'shop', a);
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /environment\.signIn\.passwordEnv: not an environment-variable name/);

	assert.equal(write(root, 'shop', shopAnswers()).status, 0);
	const text = readFileSync(join(root, CONFIG), 'utf8');
	assert.match(text, /"passwordEnv": "LM_SHOP_PASSWORD"/);
	rmSync(root, { recursive: true });
});

test('a second product adds a second section and leaves the first byte-identical', () => {
	const root = workspace();
	assert.equal(write(root, 'shop', shopAnswers()).status, 0);
	const before = readFileSync(join(root, CONFIG), 'utf8');
	// The installer may have hand-edited the first section since: setup must keep their bytes too.
	const edited = before.replace('"firstArea": "Orders"', '"firstArea":    "Orders"');
	writeFileSync(join(root, CONFIG), edited);
	const sectionText = (text, name) => {
		const start = text.indexOf(`"${name}": {`);
		return text.slice(start, text.indexOf('\n\t\t}', start) + 4);
	};

	const b = shopAnswers();
	b.name = 'Back office';
	b.repos = ['shop-api'];
	b.demoData.database = 'lm_backoffice';
	const w = write(root, 'backoffice', b);
	assert.equal(w.status, 0, w.stdout + w.stderr);

	const after = readFileSync(join(root, CONFIG), 'utf8');
	assert.equal(sectionText(after, 'shop'), sectionText(edited, 'shop'), 'first section byte-identical');
	assert.ok(after.startsWith(edited.slice(0, edited.indexOf(sectionText(edited, 'shop')) + sectionText(edited, 'shop').length)));
	const config = JSON.parse(after);
	assert.deepEqual(Object.keys(config.products), ['shop', 'backoffice']);
	assert.equal(config.products.backoffice.demoData.database, 'lm_backoffice');
	rmSync(root, { recursive: true });
});

test('re-running setup for a configured product asks only what the config does not answer, and keeps keys setup does not own', () => {
	const root = workspace();
	assert.equal(write(root, 'shop', shopAnswers()).status, 0);
	const config = JSON.parse(readFileSync(join(root, CONFIG), 'utf8'));
	config.products.shop.environment.local = { stateDir: '~/.cache/x' };
	delete config.products.shop.people;
	writeFileSync(join(root, CONFIG), JSON.stringify(config, null, '\t'));

	const d = detect(root, 'shop');
	assert.deepEqual(d.questions.filter((q) => q.ask).map((q) => q.id), ['demoData', 'people']);
	assert.deepEqual(question(d, 'repos').detected, { name: 'Shop', repos: ['shop-web', 'shop-api'] });

	const w = write(root, 'shop', { people: { writer: 'Wendy' }, demoData: { customerCopy: false, kitOwnsDatabase: true } });
	assert.equal(w.status, 0, w.stdout + w.stderr);
	const section = JSON.parse(readFileSync(join(root, CONFIG), 'utf8')).products.shop;
	assert.deepEqual(section.environment.local, { stateDir: '~/.cache/x' });
	assert.deepEqual(section.people, { writer: 'Wendy' });
	assert.equal(section.demoData.database, 'lm_shop');
	rmSync(root, { recursive: true });
});

test('write lists every missing answer instead of writing half a section', () => {
	const root = workspace();
	const a = shopAnswers();
	delete a.environment.verify;
	delete a.firstArea;
	const w = write(root, 'shop', a);
	assert.equal(w.status, 2);
	assert.match(w.stderr, /environment\.verify: missing/);
	assert.match(w.stderr, /firstArea: missing/);
	assert.equal(existsSync(join(root, CONFIG)), false);
	rmSync(root, { recursive: true });
});

test('the written section drives the kit: lm-env runs the reset command setup recorded', () => {
	const root = workspace();
	const a = shopAnswers();
	a.environment.reset = 'echo reset > reset.txt';
	assert.equal(write(root, 'shop', a).status, 0);
	mkdirSync(join(root, 'sub'));
	const r = spawnSync(process.execPath, [join(HERE, '../bin/lm-env.mjs'), 'shop', 'reset'], { cwd: join(root, 'sub'), encoding: 'utf8' });
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(readFileSync(join(root, 'reset.txt'), 'utf8'), 'reset\n');
	rmSync(root, { recursive: true });
});
