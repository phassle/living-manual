// The guide's question endpoint (spec: Guide, Matching; Test 2 T2.4, T2.5, T2.7). The guide script
// posts { question, screen, role } to /lm-guide/match on the guide's own origin; the endpoint checks
// the signed-in session with the product's sign-in service, asks the model which tested scenario
// answers the question, and returns one scenario ID or none (with the closest manual page, the
// question counted for a batched issue). Tested over HTTP, as the browser calls it, against a
// fixture sign-in service and a stand-in model that records what it was sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuideServer } from '../bin/lib/guide-server.mjs';
import { createMatchHandler, sessionCheck } from '../bin/lib/guide-match.mjs';

const COOKIE = 'se_app_shop';
const INDEX = {
	kind: 'living-manual/guide-index', version: 1, routeKeys: null,
	scenarios: [
		{ id: 'SHOP-01', title: 'Put a product in the basket', role: 'customer', startScreen: 'product list', actions: [] },
		{ id: 'SHOP-02', title: 'Pay for the basket', role: 'customer', startScreen: 'basket', actions: [] },
	],
};
const PAGES = [
	{ slug: 'baskets', title: 'How baskets work', url: '/lm-manual/baskets.html' },
	{ slug: 'returns', title: 'Returning a product', url: '/lm-manual/returns.html' },
];

/**
 * A guide server with the match endpoint in front of a fixture sign-in service that knows one
 * token ("good"). model(prompt) answers as the test says and records every prompt.
 */
async function fixture(t, answer = () => ({ scenario: null, page: null })) {
	const signIn = createServer((req, res) => {
		const ok = req.headers.sessiontoken === 'good' && req.headers.appname === 'shop';
		res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
		res.end(JSON.stringify(ok ? { valid: true } : { valid: false }));
	});
	await new Promise((r) => signIn.listen(0, r));
	const guideDir = mkdtempSync(join(tmpdir(), 'lm-guide-match-'));
	writeFileSync(join(guideDir, 'lm-guide.js'), '/* the guide */');
	writeFileSync(join(guideDir, 'guide-index.json'), JSON.stringify(INDEX));
	const prompts = [];
	const model = async (prompt) => { prompts.push(prompt); return answer(prompt); };
	const unanswered = join(guideDir, 'unanswered.jsonl');
	const match = createMatchHandler({
		guideDir, model, pages: () => PAGES, unanswered,
		session: sessionCheck({ cookie: COOKIE, header: 'SessionToken', validate: `http://127.0.0.1:${signIn.address().port}/token/validate`, forward: { AppName: 'shop' } }),
	});
	const server = await startGuideServer({ port: 0, upstream: 'http://127.0.0.1:9', basePath: '/shop/', guideDir, config: { role: 'customer' }, match });
	t.after(() => { server.close(); signIn.close(); });
	const base = `http://127.0.0.1:${server.address().port}`;
	const ask = (body, { token = 'good', raw } = {}) => fetch(`${base}/lm-guide/match`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(token ? { cookie: `${COOKIE}=${token}` } : {}) },
		body: raw ?? JSON.stringify(body),
	});
	return { base, ask, prompts, unanswered };
}

const Q = { question: 'how do I buy the thing I put aside', screen: 'basket', role: 'customer' };

test('T2.7: a request without a signed-in session is rejected, and the model is never asked', async (t) => {
	const f = await fixture(t);
	const none = await f.ask(Q, { token: null });
	assert.equal(none.status, 401);
	const unknown = await f.ask(Q, { token: 'forged' });
	assert.equal(unknown.status, 401, 'a token the sign-in service refuses');
	assert.equal(f.prompts.length, 0);
});

test('T2.4: a body with any field besides question, screen and role is refused, and so is one missing a field', async (t) => {
	const f = await fixture(t);
	for (const body of [{ ...Q, url: 'http://shop/basket?id=905001' }, { ...Q, page: '<html>…</html>' }, { question: Q.question, screen: Q.screen }, [Q], 'text']) {
		const r = await f.ask(body);
		assert.equal(r.status, 400, JSON.stringify(body));
	}
	assert.equal((await f.ask(null, { raw: '{"question":' })).status, 400, 'not JSON');
	assert.equal(f.prompts.length, 0);
});

test('a question that a scenario answers returns that scenario; the model is sent only the question, screen, role and the titles', async (t) => {
	const f = await fixture(t, () => ({ scenario: 'SHOP-02', page: 'baskets' }));
	const r = await f.ask(Q);
	assert.equal(r.status, 200);
	assert.deepEqual(await r.json(), { scenario: 'SHOP-02' });
	assert.equal(f.prompts.length, 1);
	const sent = JSON.stringify(f.prompts[0]);
	for (const s of [Q.question, 'basket', 'customer', 'SHOP-01', 'Put a product in the basket', 'Pay for the basket', 'Returning a product']) assert.ok(sent.includes(s), s);
	assert.ok(!existsSync(f.unanswered), 'an answered question is not counted');
});

test('a scenario ID the model makes up is no answer', async (t) => {
	const f = await fixture(t, () => ({ scenario: 'SHOP-99', page: null }));
	assert.equal((await (await f.ask(Q)).json()).scenario, null);
});

test('T2.5: with no matching scenario the answer names the closest manual page and the question is counted', async (t) => {
	const f = await fixture(t, () => ({ scenario: null, page: 'returns' }));
	const r = await f.ask({ question: 'How do I send a sweater back?', screen: 'basket', role: 'customer' });
	assert.deepEqual(await r.json(), { scenario: null, page: { title: 'Returning a product', url: '/lm-manual/returns.html' } });
	const lines = readFileSync(f.unanswered, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
	assert.equal(lines.length, 1);
	assert.equal(lines[0].question, 'How do I send a sweater back?');
	assert.equal(lines[0].screen, 'basket');
	assert.equal(lines[0].role, 'customer');
});

// Review finding 7: only the sign-in service's own positive answer is a session. A redirect (to a
// sign-in page that answers 200 with HTML), an HTML 200, or JSON without a positive validity is not.
test('a redirect, an HTML page or a JSON body without a positive answer is not a signed-in session', async (t) => {
	const service = createServer((req, res) => {
		if (req.url.startsWith('/login')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><body>Sign in</body></html>'); }
		if (req.url.startsWith('/redirect')) { res.writeHead(302, { location: '/login' }); return res.end(); }
		if (req.url.startsWith('/html')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>ok</html>'); }
		if (req.url.startsWith('/empty')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
		if (req.url.startsWith('/user')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"userId":905001}'); }
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end('{"valid":true}');
	});
	await new Promise((r) => service.listen(0, r));
	t.after(() => service.close());
	const origin = `http://127.0.0.1:${service.address().port}`;
	const req = { headers: { cookie: `${COOKIE}=good` } };
	const signedIn = (path) => sessionCheck({ cookie: COOKIE, validate: `${origin}${path}` })(req);
	assert.equal(await signedIn('/redirect'), false, 'a redirect to the sign-in page');
	assert.equal(await signedIn('/html'), false, 'an HTML 200');
	assert.equal(await signedIn('/empty'), false, 'JSON that says nothing');
	assert.equal(await signedIn('/valid'), true, '{ valid: true }');
	assert.equal(await signedIn('/user'), true, 'a user id: the success shape some sign-in services send instead');
});
