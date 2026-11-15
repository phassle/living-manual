// The installer (ticket 16): the pack's kit lands in <workspace>/living-manual/kit and each stage's
// skill in <workspace>/.claude/skills/lm-<stage>, byte for byte; the workspace's own files (its
// configuration, its product folders, its other skills) are never touched. --check says whether a
// workspace's installed copy still equals the pack. Tested on a fixture pack and workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), '../install.mjs');

function put(root, files) {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'lm-install-'));
	const pack = join(root, 'pack');
	const ws = join(root, 'ws');
	put(pack, {
		'kit/package.json': '{"name":"kit"}\n',
		'kit/bin/lm-run.mjs': '// run\n',
		'kit/.claude/agents/planner.md': 'planner\n',
		'kit/node_modules/x/index.js': 'dependency\n',
		'skills/lm-run/SKILL.md': '---\nname: lm-run\n---\nRun.\n',
		'skills/lm-setup/SKILL.md': '---\nname: lm-setup\n---\nSet up.\n',
		'README.md': 'pack readme\n',
	});
	put(ws, {
		'living-manual/living-manual.config.json': '{"products":{}}\n',
		'living-manual/products/shop/scenarios/a.feature': 'Feature: A\n',
		'.claude/skills/other/SKILL.md': 'someone else\n',
	});
	writeFileSync(join(pack, 'install.mjs'), readFileSync(INSTALL)); // the installer installs the pack it sits in
	return { pack, ws };
}
const install = ({ pack, ws }, ...args) => spawnSync(process.execPath, [join(pack, 'install.mjs'), ws, ...args], { encoding: 'utf8' });

test('install copies the kit and every skill, and leaves the workspace\'s own files as they were', () => {
	const f = fixture();
	const r = install(f);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(readFileSync(join(f.ws, 'living-manual/kit/bin/lm-run.mjs'), 'utf8'), '// run\n');
	assert.equal(readFileSync(join(f.ws, 'living-manual/kit/.claude/agents/planner.md'), 'utf8'), 'planner\n');
	assert.equal(readFileSync(join(f.ws, '.claude/skills/lm-run/SKILL.md'), 'utf8'), '---\nname: lm-run\n---\nRun.\n');
	assert.ok(existsSync(join(f.ws, '.claude/skills/lm-setup/SKILL.md')));
	assert.equal(existsSync(join(f.ws, 'living-manual/kit/node_modules')), false, 'dependencies come from npm ci, not the pack');
	assert.equal(readFileSync(join(f.ws, 'living-manual/living-manual.config.json'), 'utf8'), '{"products":{}}\n');
	assert.equal(readFileSync(join(f.ws, '.claude/skills/other/SKILL.md'), 'utf8'), 'someone else\n');
	assert.ok(existsSync(join(f.ws, 'living-manual/products/shop/scenarios/a.feature')));
	assert.match(r.stdout.trim().split('\n').pop(), /^install OK: kit \(3 files\) and 2 skills \(lm-run, lm-setup\) into \S+; next: npm ci in living-manual\/kit, then \/lm-setup$/);
});

test('a re-install brings an edited or stale installed copy back to the pack, and keeps the kit\'s node_modules', () => {
	const f = fixture();
	install(f);
	put(f.ws, {
		'living-manual/kit/bin/lm-run.mjs': '// edited in the workspace\n',
		'living-manual/kit/bin/lm-gone.mjs': '// a file the pack no longer has\n',
		'living-manual/kit/node_modules/y/index.js': 'installed dependency\n',
	});
	const r = install(f);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(readFileSync(join(f.ws, 'living-manual/kit/bin/lm-run.mjs'), 'utf8'), '// run\n');
	assert.equal(existsSync(join(f.ws, 'living-manual/kit/bin/lm-gone.mjs')), false);
	assert.ok(existsSync(join(f.ws, 'living-manual/kit/node_modules/y/index.js')));
});

test('--check passes on an installed copy equal to the pack, and names every file that differs', () => {
	const f = fixture();
	install(f);
	const ok = install(f, '--check');
	assert.equal(ok.status, 0, ok.stdout + ok.stderr);
	assert.match(ok.stdout.trim().split('\n').pop(), /^install check OK: \S+ equals the pack \(5 files\)$/);
	put(f.ws, {
		'living-manual/kit/bin/lm-run.mjs': '// edited\n',
		'living-manual/kit/bin/extra.mjs': '// only in the workspace\n',
		'living-manual/kit/node_modules/z/index.js': 'ignored\n',
	});
	spawnSync('rm', [join(f.ws, '.claude/skills/lm-setup/SKILL.md')]);
	const bad = install(f, '--check');
	assert.equal(bad.status, 1, bad.stdout + bad.stderr);
	assert.match(bad.stdout, /^differs: living-manual\/kit\/bin\/lm-run\.mjs$/m);
	assert.match(bad.stdout, /^only in the workspace: living-manual\/kit\/bin\/extra\.mjs$/m);
	assert.match(bad.stdout, /^missing: \.claude\/skills\/lm-setup\/SKILL\.md$/m);
	assert.doesNotMatch(bad.stdout, /node_modules/);
	assert.match(bad.stdout.trim().split('\n').pop(), /^install check FAIL: 3 files differ from the pack$/);
	assert.equal(readFileSync(join(f.ws, 'living-manual/kit/bin/lm-run.mjs'), 'utf8'), '// edited\n', '--check changes nothing');
});

test('a workspace that does not exist is refused (exit 2) and nothing is written', () => {
	const f = fixture();
	const r = install({ pack: f.pack, ws: join(f.ws, 'missing') });
	assert.equal(r.status, 2);
	assert.match(r.stdout + r.stderr, /install refused: no workspace at /);
	assert.equal(existsSync(join(f.ws, 'missing')), false);
});
