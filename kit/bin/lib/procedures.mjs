// Procedures in a writer's plain text or manual pages (spec: Starting material from the writer).
// A procedure is a heading, numbered steps ("1. Open the order list."), and the sentence after them
// that says what the user then sees. Manual pages (HTML or Markdown, from a folder or a URL) are
// first brought to the same plain lines. Each procedure keeps where it came from: lines L<a>-L<b>
// of a text file, or the page and heading anchor of a manual page.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ITEM = /^\s*\d+[.)]\s+(.*\S)\s*$/;
const MD_HEADING = /^\s*#{1,6}\s+(.*?)\s*(?:\{#([\w-]+)\})?\s*$/;
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Splits text into sentences, keeping quoted text whole. */
export const sentences = (text) => text.split(/(?<=[.!?])\s+(?=[A-Z"])/).map((s) => s.trim()).filter(Boolean);

/**
 * The procedures in plain lines: [{ title, anchor, from, to (1-based lines), intro (text before the
 * steps), items (one string per numbered step), result (the paragraph after the steps, or null) }].
 */
export function findProcedures(text) {
	const lines = text.split(/\r?\n/);
	const blank = (i) => i < 0 || i >= lines.length || !lines[i].trim();
	const headings = [];
	lines.forEach((l, i) => {
		const md = MD_HEADING.exec(l);
		if (md && l.trim().startsWith('#')) headings.push({ i, title: md[1], anchor: md[2] ?? slug(md[1]) });
		// A plain-text heading: a short line on its own, no full stop, not a numbered step.
		else if (l.trim() && blank(i - 1) && blank(i + 1) && !ITEM.test(l) && !/[.:;,!?]$/.test(l.trim()) && l.trim().length <= 80) headings.push({ i, title: l.trim(), anchor: slug(l.trim()) });
	});
	const out = [];
	headings.forEach((h, k) => {
		const end = k + 1 < headings.length ? headings[k + 1].i : lines.length;
		const body = lines.slice(h.i + 1, end);
		const first = body.findIndex((l) => ITEM.test(l));
		if (first < 0) return;
		const items = [];
		let j = first;
		for (; j < body.length; j++) {
			const m = ITEM.exec(body[j]);
			if (m) items.push(m[1]);
			else if (body[j].trim() && items.length && /^\s+/.test(body[j])) items[items.length - 1] += ` ${body[j].trim()}`;
			else if (body[j].trim()) break;
			else if (!ITEM.test(body[j + 1] ?? '')) { j++; break; }
		}
		while (j < body.length && !body[j].trim()) j++;
		const resultLines = [];
		for (; j < body.length && body[j].trim() && !ITEM.test(body[j]); j++) resultLines.push(body[j].trim());
		const lastLine = h.i + 1 + (resultLines.length ? j : first + items.length);
		const intro = body.slice(0, first).map((l) => l.trim()).filter(Boolean).join(' ');
		out.push({ title: h.title, anchor: h.anchor, from: h.i + 1, to: lastLine, intro, items, result: resultLines.length ? resultLines.join(' ') : null });
	});
	return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);

/** An HTML page as plain lines: headings as "## Title {#id}", ordered-list items as "1. …", one paragraph a line. */
export function htmlToLines(html) {
	let s = html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
	s = s.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi, (_, n, attrs, inner) => {
		const id = /\bid=["']([^"']+)["']/.exec(attrs)?.[1];
		return `\n\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}${id ? ` {#${id}}` : ''}\n\n`;
	});
	s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => `\n\n${inner.split(/<li\b[^>]*>/i).slice(1).map((li, k) => `${k + 1}. ${li.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`).join('\n')}\n\n`);
	s = s.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/(p|div|ul|li|table|tr|section|article)>|<br\s*\/?>/gi, '\n\n').replace(/<(p|div|ul|table|tr|section|article)\b[^>]*>/gi, '\n\n');
	s = s.replace(/<[^>]+>/g, '');
	return decode(s).split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const PAGE = /\.(html?|md|markdown|txt)$/i;
const linesOf = (name, text) => (/\.html?$/i.test(name) || /<\/(p|h\d|li|body)>/i.test(text) ? htmlToLines(text) : text);

/** A manual folder's pages: [{ ref (path from the workspace root), text (plain lines) }], in path order. */
export function readManualFolder(abs, root) {
	const files = [];
	const walk = (d) => { for (const f of readdirSync(d).sort()) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (PAGE.test(f)) files.push(p); } };
	walk(abs);
	return files.map((p) => ({ ref: relative(root, p), text: linesOf(p, readFileSync(p, 'utf8')) }));
}

/** A manual at a URL: that page and the pages on the same site it links to (one level, at most 50). */
export async function readManualUrl(url) {
	const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.text(); };
	const start = await get(url);
	const base = new URL(url);
	const links = [...start.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)(?:#[^"']*)?["']/gi)].map((m) => new URL(m[1], base))
		.filter((u) => u.origin === base.origin && PAGE.test(u.pathname)).map((u) => u.href);
	const pages = [{ ref: url, text: linesOf(url, start) }];
	for (const u of [...new Set(links)].filter((u) => u !== url).slice(0, 50)) pages.push({ ref: u, text: linesOf(u, await get(u)) });
	return pages;
}
