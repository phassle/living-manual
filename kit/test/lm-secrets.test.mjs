// Secrets (spec: Configuration): the configuration names environment variables; a run reads them
// when it starts. A fixture product signs in with a cookie whose value lives in an environment
// variable: the test page sees that value when the variable is set, and the run refuses to start,
// naming the variable, when it is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');

function workspace() {
	const root = mkdtempSync(join(tmpdir(), 'lm-secrets-'));
	mkdirSync(join(root, 'living-manual/products/fixture/tests'), { recursive: true });
	writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({
		products: { fixture: { name: 'Fixture', environment: {
			signIn: { kind: 'cookie', cookie: 'session', valueEnv: 'LM_FIXTURE_SESSION', domain: 'localhost' },
		} } },
	}));
	writeFileSync(join(root, 'living-manual/products/fixture/tests/cookie.spec.ts'), `
import { test } from ${JSON.stringify(join(KIT, 'src/index.ts'))};
import { writeFileSync } from 'node:fs';
test('the sign-in cookie', async ({ context }) => {
	const c = (await context.cookies('http://localhost/')).find((x) => x.name === 'session');
	writeFileSync(${JSON.stringify(join(root, 'cookie.txt'))}, c?.value ?? '(none)');
});
`);
	return root;
}

const playwright = (root, env) => spawnSync(join(KIT, 'node_modules/.bin/playwright'), ['test', '--project=fixture'], {
	cwd: KIT, encoding: 'utf8', env: { ...process.env, LM_WORKSPACE: root, ...env },
});

test('the sign-in cookie value is read from the environment variable the config names', { timeout: 120_000 }, () => {
	const root = workspace();
	const run = playwright(root, { LM_FIXTURE_SESSION: 'from-the-environment' });
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.equal(readFileSync(join(root, 'cookie.txt'), 'utf8'), 'from-the-environment');
	assert.doesNotMatch(readFileSync(join(root, 'living-manual/living-manual.config.json'), 'utf8'), /from-the-environment/);
	rmSync(root, { recursive: true });
});

test('a run refuses to start when the named environment variable is not set', { timeout: 120_000 }, () => {
	const root = workspace();
	const env = { ...process.env, LM_WORKSPACE: root };
	delete env.LM_FIXTURE_SESSION;
	const run = spawnSync(join(KIT, 'node_modules/.bin/playwright'), ['test', '--project=fixture'], { cwd: KIT, encoding: 'utf8', env });
	assert.notEqual(run.status, 0);
	assert.match(run.stdout + run.stderr, /set environment variable LM_FIXTURE_SESSION \(named by products\.fixture\.environment\.signIn\.valueEnv\)/);
	rmSync(root, { recursive: true });
});
