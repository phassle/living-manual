// The guide's demonstration origin (spec: Guide; decision record 0002 of the first product). A small proxy in
// front of the running product: every request goes to the upstream unchanged, except that a page
// (text/html) under the product's base path gets the one line that loads the guide script, just
// before </head>; a product script that names the upstream origin names this one instead; and
// /lm-guide/* is served from the built guide folder (script and index). The product's files are
// never edited, and the product's own origin stays as it was, so doc runs and their screenshots
// never see the guide.
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { MATCH_PATH } from './guide-match.mjs';

export const GUIDE_PREFIX = '/lm-guide/';
export const MANUAL_PREFIX = '/lm-manual/';
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const MANUAL_TYPES = { ...TYPES, '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

/** The one line the product adds to load the guide: its configuration object and the script. */
export const guideLine = (config) =>
	`<script>window.livingManualGuide = ${JSON.stringify(config)}</script><script src="${GUIDE_PREFIX}lm-guide.js" defer></script>`;

/**
 * Starts the proxy. { port, upstream (origin URL), basePath (e.g. "/shop/"), guideDir,
 * config (the configuration object: role, …), match (optional: the question endpoint's handler,
 * bin/lib/guide-match.mjs createMatchHandler, served at POST /lm-guide/match), manualDir
 * (optional: the built manual, served at /lm-manual/ so the guide can link its pages) }.
 * Resolves to the listening http.Server.
 */
export function startGuideServer({ port, upstream, basePath, guideDir, config, match = null, manualDir = null }) {
	const up = new URL(upstream);
	const line = guideLine(config);

	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://x');
		if (url.pathname === MATCH_PATH) {
			if (!match) { res.writeHead(404); return res.end(); }
			return void match(req, res).catch((e) => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); res.end(`lm-guide match: ${e.message}`); });
		}
		if (manualDir && url.pathname.startsWith(MANUAL_PREFIX)) {
			let decoded;
			// A malformed escape (%E0) is the client's mistake: 400, and the server keeps serving.
			try { decoded = decodeURIComponent(url.pathname.slice(MANUAL_PREFIX.length)); } catch { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('bad address'); }
			const name = normalize(decoded || 'index.html');
			const file = join(manualDir, name);
			const type = MANUAL_TYPES[name.slice(name.lastIndexOf('.'))];
			if (name.startsWith('..') || name.includes('/../') || !type || !existsSync(file)) { res.writeHead(404); return res.end(); }
			res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
			return res.end(readFileSync(file));
		}
		if (url.pathname.startsWith(GUIDE_PREFIX)) {
			const name = normalize(url.pathname.slice(GUIDE_PREFIX.length));
			const file = join(guideDir, name);
			const type = TYPES[name.slice(name.lastIndexOf('.'))];
			if (name.includes('..') || name.includes('/') || !type || !existsSync(file)) { res.writeHead(404); return res.end(); }
			res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
			return res.end(readFileSync(file));
		}
		const headers = { ...req.headers };
		const page = url.pathname.startsWith(basePath) || `${url.pathname}/` === basePath;
		if (page) delete headers['accept-encoding']; // a page is rewritten, so ask for it uncompressed
		const proxied = httpRequest({ hostname: up.hostname, port: up.port, method: req.method, path: req.url, headers }, (r) => {
			const type = r.headers['content-type'] ?? '';
			const isHtml = page && /^text\/html/.test(type);
			const isScript = page && /javascript/.test(type);
			if (!isHtml && !isScript) { res.writeHead(r.statusCode ?? 502, r.headers); return r.pipe(res); }
			const chunks = [];
			r.on('data', (c) => chunks.push(c));
			r.on('end', () => {
				// A product script that names the product's own origin (an API base URL) is pointed at
				// this origin, so the browser never calls across origins from the guide's port.
				const self = `http://${req.headers.host}`;
				let html = Buffer.concat(chunks).toString('utf8').replaceAll(up.origin, self);
				if (isHtml) html = html.includes('</head>') ? html.replace('</head>', `${line}\n</head>`) : `${line}\n${html}`;
				const out = { ...r.headers };
				delete out['content-length'];
				delete out['content-encoding'];
				res.writeHead(r.statusCode ?? 200, out);
				res.end(html);
			});
		});
		proxied.on('error', (e) => {
			if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
			res.end(`lm-guide-serve: upstream ${upstream} unavailable: ${e.message}`);
		});
		req.pipe(proxied);
	});

	// WebSockets (the product's live channels, Vite's reload) pass straight through.
	server.on('upgrade', (req, socket, head) => {
		const conn = netConnect(Number(up.port), up.hostname, () => {
			conn.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(',') : v}`).join('\r\n')}\r\n\r\n`);
			if (head?.length) conn.write(head);
			conn.pipe(socket); socket.pipe(conn);
		});
		conn.on('error', () => socket.destroy());
		socket.on('error', () => conn.destroy());
	});

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, () => resolve(server));
	});
}
