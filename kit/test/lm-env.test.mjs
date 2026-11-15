// The kit's environment contract (spec: Configuration, Data safety): start, reset and verify are
// the product's own commands, named in living-manual.config.json; a run starts only when verify
// passes. Tested against a small fixture product in a temporary workspace: what we check is what
// a person sees, the exit code, the message and whether the run's command left its mark on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LM_ENV = join(dirname(fileURLToPath(import.meta.url)), '../bin/lm-env.mjs');

/** A workspace whose product "fixture" verifies clean until a file named foreign.txt appears. */
function workspace() {
	const root = mkdtempSync(join(tmpdir(), 'lm-env-'));
	mkdirSync(join(root, 'living-manual'));
	writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({
		products: {
			fixture: {
				environment: {
					start: 'echo started > started.txt',
					reset: 'rm -f foreign.txt',
					verify: 'test ! -e foreign.txt || { echo "foreign record: foreign.txt"; exit 1; }'
				}
			}
		}
	}));
	return root;
}

const lmEnv = (root, ...args) => spawnSync(process.execPath, [LM_ENV, ...args], { cwd: root, encoding: 'utf8' });

test('a run starts when verify passes', () => {
	const root = workspace();
	const r = lmEnv(root, 'fixture', 'run', '--', 'touch ran.txt');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.ok(existsSync(join(root, 'ran.txt')));
	rmSync(root, { recursive: true });
});

test('with a foreign record, verify fails and the run refuses to start', () => {
	const root = workspace();
	writeFileSync(join(root, 'foreign.txt'), 'x');
	const verify = lmEnv(root, 'fixture', 'verify');
	assert.notEqual(verify.status, 0);
	assert.match(verify.stdout, /foreign record: foreign\.txt/);

	const run = lmEnv(root, 'fixture', 'run', '--', 'touch ran.txt');
	assert.notEqual(run.status, 0);
	assert.match(run.stderr, /run refused: verify failed for fixture/);
	assert.equal(existsSync(join(root, 'ran.txt')), false, 'the run command must not have run');
	rmSync(root, { recursive: true });
});

test('reset then verify passes again', () => {
	const root = workspace();
	writeFileSync(join(root, 'foreign.txt'), 'x');
	assert.equal(lmEnv(root, 'fixture', 'reset').status, 0);
	assert.equal(lmEnv(root, 'fixture', 'verify').status, 0);
	rmSync(root, { recursive: true });
});

test('start runs the configured start command from the workspace root', () => {
	const root = workspace();
	mkdirSync(join(root, 'sub'));
	const r = spawnSync(process.execPath, [LM_ENV, 'fixture', 'start'], { cwd: join(root, 'sub'), encoding: 'utf8' });
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.ok(existsSync(join(root, 'started.txt')));
	rmSync(root, { recursive: true });
});

test('an unknown product is named in the error', () => {
	const root = workspace();
	const r = lmEnv(root, 'nosuch', 'verify');
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /no product "nosuch" in .*living-manual\.config\.json/);
	rmSync(root, { recursive: true });
});

// Review finding 13: without a verify command nothing can prove the data is the demo data, so a
// run is refused (exit 3, a sentence), never started and never a crash.
test('a product without a verify command: the run is refused with exit 3 and nothing runs', () => {
	const root = mkdtempSync(join(tmpdir(), 'lm-env-'));
	mkdirSync(join(root, 'living-manual'));
	writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({ products: { fixture: { environment: { reset: 'true' } } } }));
	const r = lmEnv(root, 'fixture', 'run', '--', 'touch ran.txt');
	assert.equal(r.status, 3, r.stdout + r.stderr);
	assert.match(r.stderr, /run refused: .*no verify command/);
	assert.doesNotMatch(r.stderr, /TypeError|at .*lm-env\.mjs/);
	assert.equal(existsSync(join(root, 'ran.txt')), false);
	rmSync(root, { recursive: true });
});
