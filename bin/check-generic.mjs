#!/usr/bin/env node
// The genericity check: nothing in the pack names a product it was used on. The words it hunts
// come from the workspace, so the pack carries no list of them:
//   - every product section of <workspace>/living-manual/living-manual.config.json: the product's
//     id and name, repos, first area, people, database names, cookie, header and query-key names,
//     and every port (keys ending in "port", and the port of every URL);
//   - the ID prefixes of the product's scenarios (@ABC-01 in products/<id>/scenarios/*.feature);
//   - products/<id>/private-terms.txt: one word or phrase per line (# comments), for the product's
//     words the config cannot name (its company, its other modules, its demo data's names).
// A word matches at a word start, case-insensitively (a plural is still a hit); a number, or a word
// of four letters or fewer, matches only whole and as written.
// generic-allow.txt in the pack lists the deliberate exceptions, one `<file>: <word>` per line
// (# comments), e.g. the author's name in the README. Only that word, only in that file.
//
// usage: node bin/check-generic.mjs [<pack dir>] --workspace <workspace dir>
// Exit 0 clean, 1 product words found (one line each: <file>:<line>: <word>), 2 refused.
// Last line: `generic OK: …`, `generic FAIL: …` or `generic refused: …`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['node_modules', '.git', 'test-results', '.playwright-mcp', 'generic-allow.txt']);

/** The product words of one workspace: [{ term, product }]. */
export function productWords(workspace) {
	const configFile = join(workspace, 'living-manual/living-manual.config.json');
	const config = JSON.parse(readFileSync(configFile, 'utf8'));
	const words = new Map();
	const add = (term, product) => {
		const t = String(term ?? '').trim();
		if (t.length >= 3 && !words.has(t.toLowerCase())) words.set(t.toLowerCase(), { term: t, product });
	};
	for (const [id, section] of Object.entries(config.products ?? {})) {
		add(id, id);
		add(section.name, id);
		for (const r of section.repos ?? []) add(r, id);
		add(section.firstArea, id);
		for (const p of Object.values(section.people ?? {})) add(p, id);
		const dd = section.demoData ?? {};
		add(dd.database, id);
		add(dd.structureFrom, id);
		for (const d of dd.forbiddenDatabases ?? []) add(d, id);
		walk(section, (key, value) => {
			if (/port$/i.test(key) && Number.isInteger(value)) add(String(value), id);
			if (typeof value === 'string' && /^https?:\/\//.test(value)) {
				try { const u = new URL(value); if (u.port) add(u.port, id); } catch { /* not a URL */ }
			}
			if ((key === 'cookie' || key === 'header') && typeof value === 'string') add(value, id);
		});
		const session = section.guide?.session ?? {};
		for (const [k, v] of Object.entries(session.forward ?? {})) { add(k, id); add(v, id); }
		for (const k of Object.keys(section.guide?.routeKeys ?? {})) add(k, id);
		const folder = join(workspace, 'living-manual/products', id);
		const scenarios = join(folder, 'scenarios');
		if (existsSync(scenarios)) {
			for (const f of readdirSync(scenarios).filter((n) => n.endsWith('.feature'))) {
				for (const m of readFileSync(join(scenarios, f), 'utf8').matchAll(/@([A-Z][A-Z0-9]*)-\d+/g)) add(m[1], id);
			}
		}
		const priv = join(folder, 'private-terms.txt');
		if (existsSync(priv)) {
			for (const line of readFileSync(priv, 'utf8').split(/\r?\n/)) if (line.trim() && !line.trim().startsWith('#')) add(line, id);
		}
	}
	return [...words.values()];
}

function walk(node, visit, key = '') {
	if (Array.isArray(node)) node.forEach((v) => walk(v, visit, key));
	else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { visit(k, v); walk(v, visit, k); }
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A matcher for one word: whole and exact when numeric or short, else at a word start, any case. */
function matcher(term) {
	const whole = /^\d+$/.test(term) || term.length <= 4;
	return new RegExp(`(?<![A-Za-z0-9_])${escape(term)}${whole ? '(?![A-Za-z0-9_])' : ''}`, whole ? 'g' : 'gi');
}

function* files(dir) {
	for (const name of readdirSync(dir)) {
		if (SKIP.has(name)) continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) yield* files(p);
		else yield p;
	}
}

/** Every product word in the pack: [{ file, line, word }]. */
export function findLeaks(pack, words) {
	const matchers = words.map((w) => matcher(w.term));
	const hits = [];
	let count = 0;
	for (const file of files(pack)) {
		const buf = readFileSync(file);
		if (buf.includes(0)) continue; // binary
		count++;
		buf.toString('utf8').split('\n').forEach((text, i) => {
			const seen = new Set();
			for (const re of matchers) {
				for (const m of text.matchAll(re)) {
					const key = m[0].toLowerCase();
					if (!seen.has(key)) { seen.add(key); hits.push({ file: relative(pack, file), line: i + 1, word: m[0] }); }
				}
			}
		});
	}
	return { hits, count };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const w = args.indexOf('--workspace');
	const workspace = w >= 0 ? resolve(args.splice(w, 2)[1] ?? '') : null;
	const pack = resolve(args[0] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
	if (!workspace || !existsSync(join(workspace, 'living-manual/living-manual.config.json'))) {
		console.log(`generic refused: no living-manual/living-manual.config.json in ${workspace ?? '(give --workspace <dir>)'}`);
		process.exit(2);
	}
	const words = productWords(workspace);
	const products = new Set(words.map((x) => x.product)).size;
	const allowFile = join(pack, 'generic-allow.txt');
	const allowed = new Set(existsSync(allowFile) ? readFileSync(allowFile, 'utf8').split('\n')
		.map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map((l) => l.toLowerCase()) : []);
	const found = findLeaks(pack, words);
	const hits = found.hits.filter((h) => !allowed.has(`${h.file}: ${h.word}`.toLowerCase()));
	const { count } = found;
	for (const h of hits) console.log(`${h.file}:${h.line}: ${h.word}`);
	if (hits.length) {
		console.log(`generic FAIL: ${hits.length} product words in ${new Set(hits.map((h) => h.file)).size} files`);
		process.exit(1);
	}
	console.log(`generic OK: ${count} files, no product words (${words.length} words from ${products} product${products === 1 ? '' : 's'})`);
}
