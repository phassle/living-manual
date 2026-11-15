// The kit's own publish adapter "static-site" (decision record: the product folder's decisions/
// 0003-static-site-generator.md). Turns the Markdown manual into plain HTML files that open from
// disk or any web server: no build tool, no runtime dependency, no network.
//
// Contract with lm-publish.mjs: build({ mode, manualDir, outDir, product, productVersion, searchExample,
// features: [{ feature, title, pages: [slug] }], pages: [manual.json entry + { draft, markdown }] }).
// mode is "site" or "preview"; in the preview a draft page carries a draft ribbon. A page may name
// `assetsDir`, the folder its screenshots come from (a kept, last published page); else they come
// from <manualDir>/assets/<scenario ID>. searchExample (config publish.searchExample) completes
// the home search's placeholder "What do you want to do? For example: …".
//
// Writes into outDir (emptied first):
//   index.html               home: search, every feature's pages by type, how to read a page
//   <slug>.html              one per page; the slug is the page plan's, so the URL is stable
//   <former slug>.html       a redirect for every slug in the plan entry's `formerly`
//   search.html              full search results (?q=)
//   search-index.js          window.LM_SEARCH = [{ url, title, type, feature, verified, headings, text }]
//   site.css, site.js        look and client-side search; assets/<ID>/NN.png screenshots
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml as esc, plain, render } from './markdown.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPE = { how: { label: 'Task', group: 'Tasks', blurb: 'Step by step, as run against the product' }, why: { label: 'Concept', group: 'Concepts', blurb: 'What things are and why they work as they do' }, reference: { label: 'Reference', group: 'Reference', blurb: 'Fields and options' } };
const ORDER = ['how', 'why', 'reference'];

/** Splits front matter off and drops the title line and the trust line under it (the site draws its own). */
function parsePage(md) {
	const fm = /^---\n[\s\S]*?\n---\n/.exec(md);
	let body = fm ? md.slice(fm[0].length) : md;
	let note = '';
	body = body.replace(/^\s*#\s+.*\n+((?:>.*\n?)+)?/, (_, quote) => {
		if (quote) note = quote.replace(/^>\s?/gm, '').replace(/\n/g, ' ').trim().replace(/^.*?\*\*(?:Not machine-verified|Machine-verified)\*\*:\s*/, '');
		return '';
	});
	return { body, note };
}

/** The words of a page body for search: no table headers, rules, images, markup or footer. */
function searchText(body) {
	const lines = body.split('\n');
	const keep = lines.filter((l, i) => !/^\s*\|?\s*:?-{3,}/.test(l) && !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '') && !/^\s*!\[/.test(l) && !/^\s*-{3,}\s*$/.test(l) && !/^Generated from /.test(l));
	return plain(keep.join('\n').replace(/^\s*#+\s*(.*)$/gm, '$1.').replace(/\|/g, ' ').replace(/^\s*\d+\.\s/gm, '').replace(/^\s*[-*]\s/gm, ''));
}

const productLine = (o) => `${o.product ?? ''} ${o.productVersion ?? '(version unknown)'}`.trim();

function badges(p, o) {
	const v = p.verification === 'machine-verified'
		? `<span class="badge verified" title="Every step was run against the product">Machine-verified</span>`
		: `<span class="badge unverified" title="Written by the writer; not run against the product">Not machine-verified</span>`;
	return `<span class="badge type type-${p.type}">${TYPE[p.type].label}</span>${v}<span class="badge version" title="Product version">${esc(productLine({ ...o, productVersion: p.productVersion ?? o.productVersion }))}</span>${p.draft ? '<span class="badge draft">Draft</span>' : ''}`;
}

function sidebar(o, current) {
	if (!o.features.length) return '<p class="nav-empty">No pages yet.</p>';
	const bySlug = new Map(o.pages.map((p) => [p.slug, p]));
	return o.features.map((f) => {
		const groups = ORDER.map((t) => {
			const ps = f.pages.map((s) => bySlug.get(s)).filter((p) => p?.type === t);
			if (!ps.length) return '';
			return `<div class="nav-group"><div class="nav-group-title">${TYPE[t].group}</div><ul>${ps.map((p) =>
				`<li><a href="${p.slug}.html"${p.slug === current ? ' aria-current="page"' : ''}><span class="dot ${p.verification === 'machine-verified' ? 'dot-ok' : 'dot-warn'}" aria-hidden="true"></span><span>${esc(p.title)}</span>${p.draft ? '<span class="nav-draft">Draft</span>' : ''}</a></li>`).join('')}</ul></div>`;
		}).join('');
		return `<section class="nav-feature"><div class="nav-feature-title">${esc(f.title)}</div>${groups}</section>`;
	}).join('');
}

const ICON_SEARCH = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M13 13l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_BOOK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 8h7M8.5 11.5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function layout(o, { title, current = null, main, toc = '', wide = false }) {
	const preview = o.mode === 'preview';
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(o.product ?? 'Manual')} manual${preview ? ' (preview)' : ''}</title>
<link rel="stylesheet" href="site.css">
<script src="search-index.js" defer></script>
<script src="site.js" defer></script>
</head>
<body class="${preview ? 'is-preview' : ''}">
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
	<button class="menu-btn" type="button" aria-label="Show the contents" data-menu>☰</button>
	<a class="brand" href="index.html"><span class="brand-mark">${ICON_BOOK}</span><span class="brand-name">${esc(o.product ?? '')} <span>Manual</span></span></a>
	${preview ? '<span class="preview-pill" title="The preview shows drafts too. Only confirmed pages are published.">Preview</span>' : ''}
	<form class="search" action="search.html" role="search" data-search>
		${ICON_SEARCH}
		<input type="search" name="q" placeholder="Search the manual" autocomplete="off" aria-label="Search the manual" data-search-input>
		<kbd>/</kbd>
		<div class="search-pop" data-search-pop hidden></div>
	</form>
	<span class="topbar-version">${esc(productLine(o))}</span>
</header>
<div class="shell${wide ? ' shell-wide' : ''}">
	<nav class="sidebar" aria-label="Contents" data-sidebar>${sidebar(o, current)}</nav>
	<main id="main" class="main">${main}</main>
	${toc ? `<aside class="toc" aria-label="On this page">${toc}</aside>` : ''}
</div>
<footer class="footer">Generated by Living Manual from tested scenarios and the writer's prose · ${esc(productLine(o))}${preview ? ' · <strong>Preview: drafts included, not for customers</strong>' : ''}</footer>
<div class="lightbox" data-lightbox hidden><img alt=""><button type="button" aria-label="Close">×</button></div>
</body>
</html>
`;
}

function trustNote(p, note) {
	if (p.verification === 'machine-verified') {
		const when = p.verifiedAt ?? (/run against .* on (\d{4}-\d{2}-\d{2})/.exec(note)?.[1]);
		return `<div class="trust trust-ok"><strong>Tested.</strong> Every step and screenshot on this page comes from a run against ${esc(note.match(/against (.*?) on /)?.[1] ?? 'the product')}${when ? ` on ${esc(String(when).slice(0, 10))}` : ''}. The button and field names are the ones the product showed.</div>`;
	}
	return `<div class="trust trust-warn"><strong>Not machine-verified.</strong> ${esc(note.charAt(0).toUpperCase() + note.slice(1))}</div>`;
}

function pageHtml(o, p, index) {
	const { body, note } = parsePage(p.markdown);
	const { html, headings } = render(body, new Set());
	const feature = o.features.find((f) => f.pages.includes(p.slug));
	const flat = o.features.flatMap((f) => f.pages);
	const i = flat.indexOf(p.slug);
	const bySlug = new Map(o.pages.map((x) => [x.slug, x]));
	const prev = bySlug.get(flat[i - 1]), next = bySlug.get(flat[i + 1]);
	const h2 = headings.filter((h) => h.level === 2);
	const toc = h2.length > 1 ? `<div class="toc-title">On this page</div><ul>${h2.map((h) => `<li><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ul>` : '';
	const main = `
${p.draft ? '<div class="draft-ribbon" role="note"><strong>Draft</strong> · shown in the preview only. It is published when the writer has confirmed it.</div>' : ''}
<article class="page page-${p.type}">
	<div class="crumbs"><a href="index.html">Home</a><span>/</span>${esc(feature?.title ?? '')}<span>/</span>${TYPE[p.type].group}</div>
	<h1>${esc(p.title)}</h1>
	<div class="badges">${badges(p, o)}</div>
	${trustNote(p, note)}
	<div class="page-body">${html}</div>
	<nav class="pager">${prev ? `<a class="prev" href="${prev.slug}.html"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="${next.slug}.html"><span>Next</span>${esc(next.title)}</a>` : ''}</nav>
</article>`;
	index.push({
		url: `${p.slug}.html`, title: p.title, type: p.type, typeLabel: TYPE[p.type].label, feature: feature?.title ?? '',
		verified: p.verification === 'machine-verified', draft: !!p.draft,
		headings: headings.map((h) => h.text),
		text: [searchText(body), ...(p.steps ?? []).map((t) => `${t}.`)].join(' ').replace(/\s+/g, ' ').trim(),
	});
	return layout(o, { title: p.title, current: p.slug, main, toc });
}

function homeHtml(o) {
	const bySlug = new Map(o.pages.map((p) => [p.slug, p]));
	const cards = o.features.map((f) => {
		const cols = ORDER.map((t) => {
			const ps = f.pages.map((s) => bySlug.get(s)).filter((p) => p?.type === t);
			if (!ps.length) return '';
			return `<div class="home-col"><h3><span class="badge type type-${t}">${TYPE[t].group}</span></h3><p class="muted">${TYPE[t].blurb}</p><ul>${ps.map((p) =>
				`<li><a href="${p.slug}.html"><span class="dot ${p.verification === 'machine-verified' ? 'dot-ok' : 'dot-warn'}" aria-hidden="true"></span>${esc(p.title)}</a>${p.draft ? ' <span class="nav-draft">Draft</span>' : ''}</li>`).join('')}</ul></div>`;
		}).join('');
		return `<section class="feature-card"><h2>${esc(f.title)}</h2><div class="home-cols">${cols}</div></section>`;
	}).join('');
	const counts = ORDER.map((t) => [t, o.pages.filter((p) => p.type === t).length]).filter(([, n]) => n);
	const main = `
<section class="hero">
	<p class="eyebrow">${esc(productLine(o))}${o.mode === 'preview' ? ' · preview with drafts' : ''}</p>
	<h1>${esc(o.product ?? '')} manual</h1>
	<p class="lead">How to do things in ${esc(o.product ?? 'the product')}, what the ideas behind them mean, and what every field is for. Task pages are tested against the product, so their steps and screenshots match what you see.</p>
	<form class="hero-search" action="search.html" role="search">${ICON_SEARCH}<input type="search" name="q" placeholder="What do you want to do?${o.searchExample ? ` For example: ${esc(o.searchExample)}` : ''}" aria-label="Search the manual" data-hero-search><button type="submit">Search</button></form>
	${counts.length ? `<p class="hero-stats">${counts.map(([t, n]) => `<span><strong>${n}</strong> ${n === 1 ? TYPE[t].label.toLowerCase() : TYPE[t].group.toLowerCase()}</span>`).join('')}</p>` : ''}
</section>
${o.pages.length ? cards : `<section class="empty"><h2>Nothing is published yet</h2><p>Pages appear here when the writer has confirmed them. The preview shows the drafts.</p></section>`}
<section class="legend">
	<h2>How far you can trust a page</h2>
	<div class="legend-grid">
		<div><span class="badge verified">Machine-verified</span><p>Every step was run against the product version named on the page. Button and field names are the product's own words, and each screenshot shows the element to use.</p></div>
		<div><span class="badge unverified">Not machine-verified</span><p>Written by the writer: concepts, business rules, and tasks that cannot be run automatically, such as printing or uploading a file.</p></div>
	</div>
</section>`;
	return layout(o, { title: 'Home', main, wide: true });
}

function searchHtml(o) {
	const main = `
<section class="search-page">
	<h1>Search</h1>
	<form class="hero-search" action="search.html" role="search">${ICON_SEARCH}<input type="search" name="q" aria-label="Search the manual" data-results-input><button type="submit">Search</button></form>
	<div class="chips" data-chips>${['all', ...ORDER].map((t) => `<button type="button" data-type="${t}"${t === 'all' ? ' aria-pressed="true"' : ''}>${t === 'all' ? 'All' : TYPE[t].group}</button>`).join('')}</div>
	<p class="muted" data-results-count></p>
	<ol class="results" data-results></ol>
</section>`;
	return layout(o, { title: 'Search', main, wide: true });
}

const redirectHtml = (to, title) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta http-equiv="refresh" content="0; url=${to}">
<link rel="canonical" href="${to}"></head>
<body><p>This page has moved to <a href="${to}">${esc(title)}</a>.</p></body></html>
`;

export async function build(o) {
	rmSync(o.outDir, { recursive: true, force: true });
	mkdirSync(o.outDir, { recursive: true });
	const index = [];
	for (const p of o.pages) {
		writeFileSync(join(o.outDir, `${p.slug}.html`), pageHtml(o, p, index));
		for (const old of p.formerly ?? []) if (!o.pages.some((x) => x.slug === old)) writeFileSync(join(o.outDir, `${old}.html`), redirectHtml(`${p.slug}.html`, p.title));
		const assets = p.assetsDir ?? join(o.manualDir, 'assets', p.scenario ?? '');
		if (p.verification === 'machine-verified' && p.scenario && existsSync(assets)) {
			cpSync(assets, join(o.outDir, 'assets', p.scenario), { recursive: true });
		}
	}
	writeFileSync(join(o.outDir, 'index.html'), homeHtml(o));
	writeFileSync(join(o.outDir, 'search.html'), searchHtml(o));
	writeFileSync(join(o.outDir, 'search-index.js'), `window.LM_SEARCH = ${JSON.stringify(index)};\n`);
	for (const f of ['site.css', 'site.js']) writeFileSync(join(o.outDir, f), readFileSync(join(HERE, f)));
}
