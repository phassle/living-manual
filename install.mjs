#!/usr/bin/env node
// Installs the Living Manual pack into a workspace: kit/ becomes <workspace>/living-manual/kit and
// each skills/lm-<stage>/ becomes <workspace>/.claude/skills/lm-<stage>/, byte for byte. A file the
// installed copy has and the pack does not is removed, so the installed copy always equals the
// pack. The workspace's own files (living-manual/living-manual.config.json, living-manual/products/,
// its other skills) and the kit's node_modules are never touched.
//
// usage: node install.mjs <workspace>            install (or bring the installed copy back to the pack)
//        node install.mjs <workspace> --check    compare only; changes nothing
// Exit 0 OK, 1 the installed copy differs (--check), 2 refused.
// Last line: `install OK: …`, `install check OK: …`, `install check FAIL: …` or `install refused: …`.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACK = dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(['node_modules', 'test-results', '.playwright-mcp', '.DS_Store']);

/** Every file under dir, as paths relative to dir, generated folders left out. */
function list(dir, base = dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((name) => {
		if (SKIP.has(name)) return [];
		const p = join(dir, name);
		return statSync(p).isDirectory() ? list(p, base) : [relative(base, p)];
	});
}

/** The pack's parts and where each lands: [{ from, to }] (absolute folders). */
function parts(workspace) {
	const skills = readdirSync(join(PACK, 'skills')).filter((n) => n.startsWith('lm-') && statSync(join(PACK, 'skills', n)).isDirectory()).sort();
	return {
		skills,
		parts: [{ from: join(PACK, 'kit'), to: join(workspace, 'living-manual/kit') },
			...skills.map((s) => ({ from: join(PACK, 'skills', s), to: join(workspace, '.claude/skills', s) }))],
	};
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const target = args.find((a) => !a.startsWith('--'));
if (!target || !existsSync(target) || !statSync(target).isDirectory()) {
	console.log(`install refused: no workspace at ${target ? resolve(target) : '(give the workspace folder)'}`);
	process.exit(2);
}
const workspace = resolve(target);
const { skills, parts: all } = parts(workspace);
const rel = (p) => relative(workspace, p).split(sep).join('/');

if (check) {
	const lines = [];
	let count = 0;
	for (const { from, to } of all) {
		const want = list(from);
		const have = new Set(list(to));
		count += want.length;
		for (const f of want) {
			if (!have.has(f)) lines.push(`missing: ${rel(join(to, f))}`);
			else if (!readFileSync(join(from, f)).equals(readFileSync(join(to, f)))) lines.push(`differs: ${rel(join(to, f))}`);
			have.delete(f);
		}
		for (const f of have) lines.push(`only in the workspace: ${rel(join(to, f))}`);
	}
	for (const l of lines) console.log(l);
	if (lines.length) { console.log(`install check FAIL: ${lines.length} files differ from the pack`); process.exit(1); }
	console.log(`install check OK: ${workspace} equals the pack (${count} files)`);
	process.exit(0);
}

let kitFiles = 0;
for (const [i, { from, to }] of all.entries()) {
	const want = list(from);
	if (i === 0) kitFiles = want.length;
	for (const f of list(to)) if (!want.includes(f)) rmSync(join(to, f));
	for (const f of want) {
		mkdirSync(dirname(join(to, f)), { recursive: true });
		cpSync(join(from, f), join(to, f));
	}
}
console.log(`install OK: kit (${kitFiles} files) and ${skills.length} skills (${skills.join(', ')}) into ${workspace}; next: npm ci in living-manual/kit, then /lm-setup`);
