// The run lock (one live demo environment, several people or agents running against it): a run
// holds <cache>/<product>/run.lock for its whole length, and a second run waits for it rather than
// failing. Tested through bin/lm-lock.mjs with LM_CACHE_DIR pointed at a temporary folder: we
// check the order the commands' marks land on disk and what the waiting run says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LM_LOCK = join(dirname(fileURLToPath(import.meta.url)), '../bin/lm-lock.mjs');

function sandbox() {
	const dir = mkdtempSync(join(tmpdir(), 'lm-lock-'));
	return { dir, env: { ...process.env, LM_CACHE_DIR: join(dir, 'cache'), LM_RUN_LOCK: '' } };
}

function run(s, ...args) {
	const child = spawn(process.execPath, [LM_LOCK, ...args], { cwd: s.dir, env: s.env });
	let out = '';
	child.stdout.on('data', (d) => (out += d));
	child.stderr.on('data', (d) => (out += d));
	return new Promise((done) => child.on('exit', (code) => done({ code, out })));
}

const until = async (cond, ms = 10_000) => {
	for (const end = Date.now() + ms; !cond(); ) {
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((r) => setTimeout(r, 50));
	}
};

test('a second run waits for the first to release the lock', async () => {
	const s = sandbox();
	const first = run(s, 'fixture', '--', 'sleep 1.5; echo first >> order.txt');
	await until(() => existsSync(join(s.dir, 'cache/fixture/run.lock')));
	const second = run(s, 'fixture', '--', 'echo second >> order.txt');
	const [a, b] = await Promise.all([first, second]);
	assert.equal(a.code, 0, a.out);
	assert.equal(b.code, 0, b.out);
	assert.equal(readFileSync(join(s.dir, 'order.txt'), 'utf8'), 'first\nsecond\n');
	assert.match(b.out, /waiting for the run lock .*held by pid \d+/);
	assert.equal(existsSync(join(s.dir, 'cache/fixture/run.lock')), false, 'released after the run');
	rmSync(s.dir, { recursive: true });
});

test('a lock left by a process that is gone is taken over', async () => {
	const s = sandbox();
	const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
	mkdirSync(join(s.dir, 'cache/fixture'), { recursive: true });
	writeFileSync(join(s.dir, 'cache/fixture/run.lock'), JSON.stringify({ pid: Number(dead), command: 'crashed run' }));
	const r = await run(s, 'fixture', '--', 'touch ran.txt');
	assert.equal(r.code, 0, r.out);
	assert.ok(existsSync(join(s.dir, 'ran.txt')));
	assert.match(r.out, /stale run lock/);
	rmSync(s.dir, { recursive: true });
});

test('a command run under the lock can itself take the lock without waiting for itself', async () => {
	const s = sandbox();
	const inner = `${JSON.stringify(process.execPath)} ${JSON.stringify(LM_LOCK)} fixture -- touch inner.txt`;
	const r = await run(s, 'fixture', '--', inner);
	assert.equal(r.code, 0, r.out);
	assert.ok(existsSync(join(s.dir, 'inner.txt')));
	rmSync(s.dir, { recursive: true });
});

test('the command\'s exit code is passed on', async () => {
	const s = sandbox();
	const r = await run(s, 'fixture', '--', 'exit 7');
	assert.equal(r.code, 7);
	rmSync(s.dir, { recursive: true });
});

// Review finding 4: several runs that find the same stale lock at the same moment must not all
// take it over. Each run waits for a common start instant, takes the lock, holds it for a while
// and writes when it held it; no two holding intervals may overlap.
test('runs that find the same stale lock at once: exactly one holds it at a time', { timeout: 60_000 }, async () => {
	const s = sandbox();
	const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
	mkdirSync(join(s.dir, 'cache/fixture'), { recursive: true });
	writeFileSync(join(s.dir, 'cache/fixture/run.lock'), JSON.stringify({ pid: Number(dead), command: 'crashed run' }));
	const LOCK_LIB = join(dirname(fileURLToPath(import.meta.url)), '../bin/lib/lock.mjs');
	const at = Date.now() + 1500;
	const holder = `import { takeRunLock } from ${JSON.stringify(LOCK_LIB)};
import { appendFileSync } from 'node:fs';
while (Date.now() < ${at}) { /* everyone starts together */ }
takeRunLock('fixture', 'racer', () => {});
const from = Date.now();
await new Promise((r) => setTimeout(r, 300));
appendFileSync(${JSON.stringify(join(s.dir, 'held.txt'))}, JSON.stringify({ pid: process.pid, from, to: Date.now() }) + '\\n');`;
	const script = join(s.dir, 'racer.mjs');
	writeFileSync(script, holder);
	const N = 16;
	const runs = Array.from({ length: N }, () => new Promise((done) => {
		const c = spawn(process.execPath, [script], { env: s.env });
		let out = '';
		c.stderr.on('data', (d) => (out += d));
		c.on('exit', (code) => done({ code, out }));
	}));
	for (const r of await Promise.all(runs)) assert.equal(r.code, 0, r.out);
	const held = readFileSync(join(s.dir, 'held.txt'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).sort((a, b) => a.from - b.from);
	assert.equal(held.length, N, 'every run got the lock in the end');
	for (let i = 1; i < held.length; i++) assert.ok(held[i].from >= held[i - 1].to, `pid ${held[i].pid} took the lock while pid ${held[i - 1].pid} held it`);
	rmSync(s.dir, { recursive: true });
});
