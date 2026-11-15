// A temporary workspace with one product, "fixture", whose pages are static files and whose spec
// the test writes; and a Playwright run of it through the kit's own project (LM_WORKSPACE).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT = `import { test, expect } from ${JSON.stringify(join(KIT, 'src/index.ts'))};\nimport { writeFileSync, existsSync } from 'node:fs';\n`;

/** A workspace with product "fixture": its config (environment merged in), pages and one spec. */
export function workspace({ environment = {}, pages = {}, spec }) {
	const root = mkdtempSync(join(tmpdir(), 'lm-repeat-'));
	const folder = join(root, 'living-manual/products/fixture');
	mkdirSync(join(folder, 'tests'), { recursive: true });
	mkdirSync(join(root, 'pages'));
	for (const [name, html] of Object.entries(pages)) writeFileSync(join(root, 'pages', name), html);
	writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({
		products: { fixture: { name: 'Fixture', environment: { baseUrl: pathToFileURL(join(root, 'pages')).href + '/', ...environment } } },
	}));
	writeFileSync(join(folder, 'tests/fixture.spec.ts'), IMPORT + spec(root));
	return { root, runs: join(folder, 'build/runs') };
}

export function playwright(root) {
	return spawnSync(join(KIT, 'node_modules/.bin/playwright'), ['test', '--project=fixture'], {
		cwd: KIT, encoding: 'utf8', env: { ...process.env, LM_WORKSPACE: root },
	});
}


/** The same run without blocking this process, so a server in the test can answer the page. */
export function playwrightAsync(root) {
	return new Promise((done) => {
		const child = spawn(join(KIT, 'node_modules/.bin/playwright'), ['test', '--project=fixture'], { cwd: KIT, env: { ...process.env, LM_WORKSPACE: root } });
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (out += d));
		child.on('exit', (status) => done({ status, out }));
	});
}
