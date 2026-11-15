// The guide's demonstration origin (decisions/0002 in the first product's folder): the product's own
// pages, unchanged on disk, served through the kit with the one line that loads the guide script
// added. Tested over HTTP against a fixture upstream: what a browser would receive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuideServer } from '../bin/lib/guide-server.mjs';

const PAGE = '<!doctype html><html><head><title>Shop</title></head><body><p>Shop</p></body></html>';

async function fixture(t) {
	const upstream = createServer((req, res) => {
		if (req.url.startsWith('/shop/api')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
		if (req.url.startsWith('/shop/config.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(`export const api = '${upstreamOrigin}/api';`); }
		if (req.url.startsWith('/login')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><head></head><body>login</body></html>'); }
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(PAGE) });
		res.end(PAGE);
	});
	await new Promise((r) => upstream.listen(0, r));
	const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
	const guideDir = mkdtempSync(join(tmpdir(), 'lm-guide-dir-'));
	writeFileSync(join(guideDir, 'lm-guide.js'), '/* the guide */');
	writeFileSync(join(guideDir, 'guide-index.json'), '{"scenarios":[]}');
	const manualDir = mkdtempSync(join(tmpdir(), 'lm-guide-manual-'));
	writeFileSync(join(manualDir, 'index.html'), '<h1>Manual</h1>');
	const server = await startGuideServer({
		port: 0, upstream: upstreamOrigin, basePath: '/shop/', guideDir, config: { role: 'shop keeper' }, manualDir,
	});
	t.after(() => { server.close(); upstream.close(); });
	return `http://127.0.0.1:${server.address().port}`;
}

test('the product page arrives with the one line that loads the guide', async (t) => {
	const base = await fixture(t);
	const html = await (await fetch(`${base}/shop/?view=list`)).text();
	const lines = html.split('\n').filter((l) => l.includes('lm-guide'));
	assert.equal(lines.length, 1, html);
	assert.match(lines[0], /<script>window\.livingManualGuide = \{"role":"shop keeper"\}<\/script><script src="\/lm-guide\/lm-guide\.js" defer><\/script>/);
	assert.ok(html.indexOf('lm-guide') < html.indexOf('</head>'), 'loaded from the head');
	assert.match(html, /<p>Shop<\/p>/);
});

test('pages outside the product and everything that is not a page pass through untouched', async (t) => {
	const base = await fixture(t);
	assert.doesNotMatch(await (await fetch(`${base}/login/`)).text(), /lm-guide/);
	assert.equal(await (await fetch(`${base}/shop/api/x`)).text(), '{"ok":true}');
});

test('the guide script and its index are served by the kit', async (t) => {
	const base = await fixture(t);
	const js = await fetch(`${base}/lm-guide/lm-guide.js`);
	assert.equal(js.status, 200);
	assert.match(js.headers.get('content-type'), /javascript/);
	assert.equal(await js.text(), '/* the guide */');
	assert.deepEqual(await (await fetch(`${base}/lm-guide/guide-index.json`)).json(), { scenarios: [] });
	assert.equal((await fetch(`${base}/lm-guide/missing.js`)).status, 404);
});

test('the product scripts call back to the guide origin, not to the product origin', async (t) => {
	// A product that names its own origin in a script (an API base URL) would otherwise call across
	// origins from the guide's port, and the browser would block it.
	const base = await fixture(t);
	assert.equal(await (await fetch(`${base}/shop/config.js`)).text(), `export const api = '${base}/api';`);
});

// Review finding 3: a malformed percent-escape in a manual path is the client's mistake (400), and
// the server goes on serving.
test('a malformed escape in a manual address is answered 400 and the server keeps serving', { timeout: 20_000 }, async (t) => {
	const base = await fixture(t);
	const bad = await fetch(`${base}/lm-manual/%E0%A4%A`, { signal: AbortSignal.timeout(5000) });
	assert.equal(bad.status, 400);
	const again = await fetch(`${base}/lm-manual/%E0`, { signal: AbortSignal.timeout(5000) });
	assert.equal(again.status, 400);
	const manual = await fetch(`${base}/lm-manual/index.html`);
	assert.equal(manual.status, 200);
	assert.match(await manual.text(), /Manual/);
	assert.match(await (await fetch(`${base}/shop/`)).text(), /<p>Shop<\/p>/);
});
