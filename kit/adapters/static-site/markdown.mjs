// A small Markdown renderer for the manual's pages: headings (with ids), paragraphs, ordered and
// unordered lists (nested, loose or tight, with indented content such as a screenshot under a
// step), block quotes, tables, fenced code, rules, and inline strong, emphasis, code, links and
// images. Raw HTML in the source is escaped, never passed through.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const escapeHtml = esc;

export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
	.replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-') || 'section';

/**
 * A link or image address the page may carry: http, https, mailto, or one with no scheme (a
 * relative path, /path, ?query or #fragment). Anything else (javascript:, data:, vbscript:, an
 * address hiding a scheme behind control characters or entities) becomes '#'.
 */
export function safeUrl(u) {
	const s = String(u);
	// Browsers drop control characters and whitespace inside a scheme; an entity may spell one.
	if (/[\u0000-\u0020\u007f]|&#|&[a-z]+;/i.test(s)) return '#';
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
	if (!scheme) return /:/.test(s.split(/[/?#]/)[0]) ? '#' : s;
	return ['http', 'https', 'mailto'].includes(scheme[1].toLowerCase()) ? s : '#';
}

/** Inline Markdown to HTML. */
export function inline(text) {
	const codes = [];
	let s = String(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
	s = esc(s);
	const url = (u) => esc(safeUrl(u.replace(/&amp;/g, '&')));
	s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, src, title) =>
		`<img src="${url(src)}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy">`);
	s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `<a href="${url(href)}">${t}</a>`);
	s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>');
	s = s.replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>');
	return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}

/** Plain text of inline Markdown (for search and alt texts). */
export const plain = (text) => String(text).replace(/!\[([^\]]*)\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
	.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const indentOf = (l) => /^\s*/.exec(l)[0].length;

/**
 * Renders Markdown blocks. Returns { html, headings: [{ level, text, id }] }.
 * `ids` collects heading ids already used, so they stay unique on a page.
 */
export function render(md, ids = new Set()) {
	const headings = [];
	const html = blocks(String(md).replace(/\r\n?/g, '\n').split('\n'), headings, ids);
	return { html, headings };
}

function blocks(lines, headings, ids) {
	const out = [];
	let i = 0;
	const blank = (l) => /^\s*$/.test(l);
	while (i < lines.length) {
		const line = lines[i];
		if (blank(line)) { i++; continue; }
		let m;
		if ((m = /^\s*(```|~~~)\s*(\S*)/.exec(line))) {
			const fence = m[1], code = [];
			for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) code.push(lines[i]);
			i++;
			out.push(`<pre><code${m[2] ? ` class="language-${esc(m[2])}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
			continue;
		}
		if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
			const level = m[1].length;
			let id = slugify(plain(m[2]));
			for (let n = 2; ids.has(id); n++) id = `${slugify(plain(m[2]))}-${n}`;
			ids.add(id);
			headings.push({ level, text: plain(m[2]), id });
			out.push(`<h${level} id="${id}">${inline(m[2])}${level > 1 ? `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a>` : ''}</h${level}>`);
			i++;
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
		if (/^\s*>/.test(line)) {
			const quote = [];
			for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
			out.push(`<blockquote>${blocks(quote, headings, ids)}</blockquote>`);
			continue;
		}
		if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
			const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|')));
			const head = cells(line);
			const rows = [];
			for (i += 2; i < lines.length && lines[i].includes('|') && !blank(lines[i]); i++) rows.push(cells(lines[i]));
			out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
			continue;
		}
		if ((m = LIST.exec(line))) {
			const base = m[1].length;
			const ordered = /\d/.test(m[2]);
			const start = ordered ? parseInt(m[2], 10) : 1;
			const items = [];
			let loose = false;
			while (i < lines.length) {
				const lm = LIST.exec(lines[i]);
				if (!lm || lm[1].length !== base || /\d/.test(lm[2]) !== ordered) break;
				const contentIndent = lm[1].length + lm[2].length + 1;
				const body = [lm[3]];
				for (i++; i < lines.length; i++) {
					const l = lines[i];
					if (blank(l)) { body.push(''); continue; }
					if (indentOf(l) >= Math.min(contentIndent, base + 2)) { body.push(l.slice(Math.min(indentOf(l), contentIndent))); continue; }
					break;
				}
				while (body.length && body[body.length - 1] === '') { body.pop(); if (i < lines.length && LIST.exec(lines[i])) loose = true; }
				if (body.some((l, k) => l === '' && k < body.length - 1)) loose = true;
				items.push(body);
			}
			const lis = items.map((body) => {
				const hasBlock = body.length > 1;
				const content = hasBlock || loose ? blocks(body, headings, ids) : inline(body[0]);
				return `<li>${loose ? content : content.replace(/^<p>([\s\S]*?)<\/p>/, '$1')}</li>`;
			});
			const withShots = ordered && items.every((b) => b.some((l) => /^!\[/.test(l.trim())));
			const tag = ordered ? 'ol' : 'ul';
			out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}${withShots ? ' class="steps"' : ''}>${lis.join('')}</${tag}>`);
			continue;
		}
		const para = [];
		for (; i < lines.length && !blank(lines[i]) && !/^(#{1,6}\s|\s*>|\s*```|\s*~~~)/.test(lines[i]) && !(para.length && LIST.exec(lines[i])); i++) para.push(lines[i].trim());
		const text = para.join(' ');
		if (/^!\[[^\]]*\]\([^)]+\)$/.test(text)) out.push(`<figure class="shot">${inline(text)}</figure>`);
		else out.push(`<p>${inline(text)}</p>`);
	}
	return out.join('\n');
}
