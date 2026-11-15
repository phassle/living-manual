// The guide's question endpoint (spec: Guide, Matching; decisions in the product folder). The guide
// script posts exactly { question, screen, role } to POST /lm-guide/match on the guide's origin.
// The endpoint:
//   1. rejects a request without a signed-in session: the session token from the product's
//      sign-in cookie (or token header) is checked with the product's sign-in service, the way the
//      product's own backend checks it (401 when there is no token or the service refuses it);
//   2. rejects any body that is not exactly those three fields (400);
//   3. asks the model which tested scenario answers the question, given only the question, the
//      screen, the role, the scenario titles (and start screens) and the manual's page titles;
//   4. answers { scenario: "<ID>" } or { scenario: null, page: { title, url } }; with no scenario
//      the question is appended to the unanswered file, which lm-issues after-run files as one
//      batched issue (kind guide-questions).
// The model is a function (prompt) => Promise<{ scenario, page }> (bin/lib/guide-model.mjs), so the
// model key lives only in this process.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MATCH_PATH = '/lm-guide/match';
export const FIELDS = ['question', 'screen', 'role'];
const MAX_BODY = 4096;
const MAX_QUESTION = 500;

/**
 * The session check: (req) => Promise<boolean>. { cookie (the sign-in cookie's name), header (a
 * token header the product also accepts, e.g. SessionToken), validate (the sign-in service's
 * validate URL), forward (extra headers the service needs, e.g. { AppName }) }. The token goes to
 * the service in `header` (default X-Session-Token); only HTTP 200 (redirects not followed) with a JSON
 * body that says so ({ valid: true }, or a userId) counts as signed in.
 */
export function sessionCheck({ cookie, header = 'X-Session-Token', validate, forward = {} }) {
	return async (req) => {
		const token = tokenOf(req, cookie, header);
		if (!token) return false;
		try {
			// A redirect (to a sign-in page) is a refusal, not something to follow.
			const r = await fetch(validate, { headers: { ...forward, [header]: token, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
			if (r.status !== 200) return false;
			const body = await r.json().catch(() => null);
			return signedIn(body);
		} catch {
			return false;
		}
	};
}

/**
 * The service's positive answer: a JSON object that says { valid: true }, or carries a
 * user id (the success shape some sign-in services send instead), and never { valid: false }.
 */
const signedIn = (body) => !!body && typeof body === 'object' && !Array.isArray(body) && body.valid !== false
	&& (body.valid === true || (body.userId !== undefined && body.userId !== null));

function tokenOf(req, cookie, header) {
	const h = req.headers[header.toLowerCase()];
	if (h) return String(h);
	const c = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(`${cookie}=`));
	return c ? decodeURIComponent(c.slice(cookie.length + 1)) : '';
}

/** Exactly { question, screen, role }: question a non-empty string, screen and role strings or null. */
export function readRequest(body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('the body must be a JSON object');
	const extra = Object.keys(body).filter((k) => !FIELDS.includes(k));
	if (extra.length) throw new Error(`only ${FIELDS.join(', ')} may be sent; not ${extra.join(', ')}`);
	const missing = FIELDS.filter((k) => !(k in body));
	if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
	const { question, screen, role } = body;
	if (typeof question !== 'string' || !question.trim()) throw new Error('question must be a non-empty string');
	if (question.length > MAX_QUESTION) throw new Error(`question longer than ${MAX_QUESTION} characters`);
	for (const [k, v] of [['screen', screen], ['role', role]]) if (v !== null && typeof v !== 'string') throw new Error(`${k} must be a string or null`);
	return { question: question.trim(), screen, role };
}

/**
 * What the model is sent: a system text, the user text and the JSON schema of the answer. Nothing
 * but the question, the screen, the role, the scenarios (ID, title, start screen) and the pages
 * (slug, title) goes in.
 */
export function matchPrompt({ question, screen, role }, scenarios, pages) {
	const system = [
		'You match a user\'s question to one tested how-to scenario of a software product.',
		'Pick a scenario only when doing that scenario is what the user asks how to do. When none of them is, answer null: never pick the nearest one as a guess.',
		'Also pick the manual page that comes closest to the question, or null when none is near.',
		'Answer with the JSON object only.',
	].join(' ');
	const user = [
		`Question: ${question}`,
		`The user is on the screen: ${screen ?? 'unknown'}`,
		`The user's role: ${role ?? 'unknown'}`,
		'',
		'Scenarios (ID: title, starts on screen):',
		...scenarios.map((s) => `- ${s.id}: ${s.title} (starts on the ${s.startScreen})`),
		'',
		'Manual pages (slug: title):',
		...pages.map((p) => `- ${p.slug}: ${p.title}`),
	].join('\n');
	const schema = {
		type: 'object',
		properties: {
			scenario: { anyOf: [{ type: 'string', enum: scenarios.map((s) => s.id) }, { type: 'null' }] },
			page: { anyOf: [{ type: 'string', enum: pages.map((p) => p.slug) }, { type: 'null' }] },
		},
		required: ['scenario', 'page'],
		additionalProperties: false,
	};
	return { system, user, schema };
}

const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/**
 * The endpoint as a request handler for the guide server. { guideDir (guide-index.json is read
 * from here on every request, so a rebuilt index is used at once), model, session, pages ()
 * => [{ slug, title, url }] (the manual pages the user can open), unanswered (file the unanswered
 * questions are appended to), manualHome (the page linked when the model names none; optional),
 * log (optional line logger) }.
 */
export function createMatchHandler({ guideDir, model, session, pages = () => [], unanswered, manualHome = null, log = () => {} }) {
	return async (req, res) => {
		if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
		if (!(await session(req))) return send(res, 401, { error: 'sign in first' });
		let q;
		try {
			if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new Error('send application/json');
			q = readRequest(JSON.parse(await readBody(req)));
		} catch (e) {
			return send(res, 400, { error: e.message });
		}
		const index = JSON.parse(readFileSync(join(guideDir, 'guide-index.json'), 'utf8'));
		const scenarios = index.scenarios.filter((s) => !q.role || !s.role || s.role === q.role);
		const manual = pages();
		let answer;
		try {
			answer = await model(matchPrompt(q, scenarios, manual));
		} catch (e) {
			log(`match: the model failed: ${e.message}`);
			return send(res, 502, { error: 'the guide could not reach its model' });
		}
		const hit = scenarios.find((s) => s.id === answer?.scenario);
		if (hit) { log(`match: "${q.question}" → ${hit.id}`); return send(res, 200, { scenario: hit.id }); }
		const near = manual.find((p) => p.slug === answer?.page);
		const page = near ? { title: near.title, url: near.url } : manualHome;
		mkdirSync(dirname(unanswered), { recursive: true });
		appendFileSync(unanswered, `${JSON.stringify({ question: q.question, screen: q.screen, role: q.role, at: new Date().toISOString() })}\n`);
		log(`match: "${q.question}" → no tested answer (closest page ${page?.url ?? 'none'}); counted in ${unanswered}`);
		return send(res, 200, { scenario: null, page });
	};
}

/**
 * The manual pages the user can open: the manual's pages (manual.json, written by lm-manual) whose
 * HTML file is in the served manual folder, at `${urlBase}<slug>.html`.
 */
export function manualPages(manualJson, servedDir, urlBase) {
	if (!existsSync(manualJson)) return [];
	const m = JSON.parse(readFileSync(manualJson, 'utf8'));
	return (m.pages ?? []).filter((p) => existsSync(join(servedDir, `${p.slug}.html`)))
		.map((p) => ({ slug: p.slug, title: p.title, url: `${urlBase}${p.slug}.html` }));
}
