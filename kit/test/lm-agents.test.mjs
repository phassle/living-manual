// Playwright's planner, generator and healer agents for Claude, with the kit's changes kept as a
// patch (spec: Packaging, From scenario to test code). Playwright rewrites the agent files on
// every `init-agents`, so the patch must apply again after a re-init. Tested on a scratch copy of
// the kit: what lands in its .claude/agents and .mcp.json must equal the kit's own patched files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['.claude/agents/playwright-test-planner.md', '.claude/agents/playwright-test-generator.md',
	'.claude/agents/playwright-test-healer.md', '.mcp.json'];

function scratchKit() {
	const dir = mkdtempSync(join(tmpdir(), 'lm-agents-'));
	cpSync(join(KIT, 'package.json'), join(dir, 'package.json'));
	cpSync(join(KIT, 'agents'), join(dir, 'agents'), { recursive: true });
	symlinkSync(join(KIT, 'node_modules'), join(dir, 'node_modules'));
	return dir;
}
const agents = (kit, ...args) => spawnSync(process.execPath, [join(KIT, 'bin/lm-agents.mjs'), ...args, '--kit', kit], { encoding: 'utf8' });

test('init writes the stock agents and applies the kit patch; a re-init (an upgrade) gives the same files', () => {
	const kit = scratchKit();
	for (let round = 1; round <= 2; round++) {
		const r = agents(kit, 'init');
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /agents OK: initialised Playwright \S+ agents for Claude and applied agents\/kit\.patch/);
		for (const f of FILES) assert.equal(readFileSync(join(kit, f), 'utf8'), readFileSync(join(KIT, f), 'utf8'), `${f} (round ${round})`);
	}
	assert.equal(existsSync(join(kit, 'specs')), false, 'the stock plan folder is not left behind');
	rmSync(kit, { recursive: true });
});

test('apply on patched files changes nothing and says so', () => {
	const kit = scratchKit();
	assert.equal(agents(kit, 'init').status, 0);
	const r = agents(kit, 'apply');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /agents OK: agents\/kit\.patch is already applied/);
	for (const f of FILES) assert.equal(readFileSync(join(kit, f), 'utf8'), readFileSync(join(KIT, f), 'utf8'), f);
	rmSync(kit, { recursive: true });
});

test('a patch that no longer fits the stock agents stops with what to do, and leaves the files as they were', () => {
	const kit = scratchKit();
	assert.equal(agents(kit, 'init').status, 0);
	const planner = join(kit, '.claude/agents/playwright-test-planner.md');
	// An upgraded Playwright whose planner text the patch does not know.
	spawnSync(join(kit, 'node_modules/.bin/playwright'), ['init-agents', '--loop=claude'], { cwd: kit, encoding: 'utf8' });
	writeFileSync(planner, readFileSync(planner, 'utf8').replace(/You are an expert web test planner[^\n]*/, 'You plan tests (new wording).'));
	const before = readFileSync(planner, 'utf8');
	const r = agents(kit, 'apply');
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /agents FAIL: agents\/kit\.patch does not apply .*make-patch/);
	assert.equal(readFileSync(planner, 'utf8'), before);
	rmSync(kit, { recursive: true });
});
