// Living Manual static site: search over window.LM_SEARCH (search-index.js), the header's
// as-you-type results, the search page, screenshot zoom and the small-screen menu. No dependencies.
(function () {
	'use strict';
	var INDEX = window.LM_SEARCH || [];
	var TYPE_GROUP = { how: 'Tasks', why: 'Concepts', reference: 'Reference' };

	function fold(s) { return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, ''); }
	// A light English stem, so "registering", "registered" and "registers" find "register".
	function stem(w) {
		if (w.length > 5) w = w.replace(/(ings|ing|ed|es)$/, '');
		if (w.length > 3) w = w.replace(/s$/, '');
		return w;
	}
	var STOP = { a: 1, an: 1, the: 1, i: 1, to: 1, of: 1, and: 1, or: 1, in: 1, on: 1, how: 1, do: 1, can: 1, my: 1, is: 1, for: 1, what: 1 };
	function words(s) { return fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean); }
	function terms(q) {
		var all = words(q), kept = all.filter(function (w) { return !STOP[w]; });
		return (kept.length ? kept : all).map(stem);
	}

	var prepared = INDEX.map(function (p) {
		return { page: p, title: words(p.title).map(stem), head: words(p.headings.join(' ')).map(stem), text: words(p.text).map(stem) };
	});
	function hits(list, t) { var n = 0; for (var i = 0; i < list.length; i++) if (list[i].indexOf(t) === 0) n++; return n; }

	function search(q, type) {
		var ts = terms(q);
		if (!ts.length) return [];
		var out = [];
		prepared.forEach(function (e) {
			if (type && type !== 'all' && e.page.type !== type) return;
			var score = 0;
			for (var i = 0; i < ts.length; i++) {
				var t = ts[i], s = hits(e.title, t) * 12 + hits(e.head, t) * 5 + Math.min(hits(e.text, t), 6);
				if (!s) return; // every word must match somewhere
				score += s;
			}
			if (e.page.type === 'how') score += 1;
			out.push({ page: e.page, score: score });
		});
		return out.sort(function (a, b) { return b.score - a.score; });
	}

	function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
	function highlight(text, q) {
		var ts = terms(q);
		var re = ts.length ? new RegExp('(^|[^\\p{L}\\p{N}])(' + ts.map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')([\\p{L}\\p{N}]*)', 'giu') : null;
		var safe = esc(text);
		return re ? safe.replace(re, '$1<mark>$2$3</mark>') : safe;
	}
	function snippet(p, q) {
		var text = p.text, low = fold(text), ts = terms(q), at = -1;
		for (var i = 0; i < ts.length && at < 0; i++) at = low.indexOf(ts[i]);
		if (at < 0) return highlight(text.slice(0, 150) + (text.length > 150 ? '…' : ''), q);
		var start = Math.max(0, at - 60), end = Math.min(text.length, at + 120);
		return highlight((start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : ''), q);
	}
	function badges(p) {
		return '<span class="badge type type-' + p.type + '">' + esc(p.typeLabel) + '</span>' +
			(p.verified ? '<span class="badge verified">Machine-verified</span>' : '<span class="badge unverified">Not machine-verified</span>') +
			(p.draft ? '<span class="badge draft">Draft</span>' : '');
	}

	// Header search: results as you type, arrows to move, Enter to open, "/" to focus.
	var form = document.querySelector('[data-search]');
	var input = document.querySelector('[data-search-input]');
	var pop = document.querySelector('[data-search-pop]');
	var sel = -1;
	function renderPop() {
		var q = input.value.trim();
		if (!q) { pop.hidden = true; return; }
		var rs = search(q).slice(0, 6);
		sel = -1;
		pop.innerHTML = (rs.length ? rs.map(function (r) {
			return '<a href="' + r.page.url + '"><div class="r-title"><span class="r-name">' + highlight(r.page.title, q) + '</span>' + badges(r.page).replace(/<span class="badge (verified|unverified)">[^<]*<\/span>/, '') + '</div><div class="r-snip">' + snippet(r.page, q) + '</div></a>';
		}).join('') : '<div class="r-none">No page matches “' + esc(q) + '”.</div>') +
			'<a class="r-all" href="search.html?q=' + encodeURIComponent(q) + '">See all results for “' + esc(q) + '” →</a>';
		pop.hidden = false;
	}
	if (input) {
		input.addEventListener('input', renderPop);
		input.addEventListener('focus', renderPop);
		input.addEventListener('keydown', function (e) {
			var links = pop.querySelectorAll('a');
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				sel = Math.max(0, Math.min(links.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
				links.forEach(function (l, i) { l.setAttribute('aria-selected', i === sel ? 'true' : 'false'); });
			} else if (e.key === 'Enter' && sel >= 0 && links[sel]) { e.preventDefault(); location.href = links[sel].getAttribute('href'); }
			else if (e.key === 'Escape') { pop.hidden = true; input.blur(); }
		});
		document.addEventListener('click', function (e) { if (!form.contains(e.target)) pop.hidden = true; });
		document.addEventListener('keydown', function (e) {
			if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); input.focus(); }
		});
	}

	// Search page.
	var list = document.querySelector('[data-results]');
	if (list) {
		var params = new URLSearchParams(location.search), q = params.get('q') || '', type = params.get('type') || 'all';
		var box = document.querySelector('[data-results-input]'), count = document.querySelector('[data-results-count]');
		box.value = q;
		if (input) input.value = q;
		var show = function () {
			var rs = search(q, type);
			count.textContent = q ? (rs.length ? rs.length + ' page' + (rs.length === 1 ? '' : 's') + ' for “' + q + '”' : 'No page matches “' + q + '”. Try fewer or other words.') : 'Type what you want to do or find.';
			list.innerHTML = rs.map(function (r) {
				var p = r.page;
				return '<li><a href="' + p.url + '"><div class="r-head"><span class="r-title">' + highlight(p.title, q) + '</span>' + badges(p) + '</div><div class="r-where">' + esc(p.feature) + ' · ' + TYPE_GROUP[p.type] + '</div><div class="r-snip">' + snippet(p, q) + '</div></a></li>';
			}).join('');
		};
		document.querySelectorAll('[data-chips] button').forEach(function (b) {
			b.setAttribute('aria-pressed', b.dataset.type === type ? 'true' : 'false');
			b.addEventListener('click', function () {
				type = b.dataset.type;
				document.querySelectorAll('[data-chips] button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
				show();
			});
		});
		show();
		if (!q) box.focus();
	}

	// Screenshot zoom.
	var lb = document.querySelector('[data-lightbox]');
	document.addEventListener('click', function (e) {
		var img = e.target.closest && e.target.closest('figure.shot img');
		if (img && lb) { lb.querySelector('img').src = img.src; lb.querySelector('img').alt = img.alt; lb.hidden = false; return; }
		if (lb && !lb.hidden && lb.contains(e.target)) lb.hidden = true;
	});
	document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && lb) lb.hidden = true; });

	// Small screens: the contents open from the menu button.
	var menu = document.querySelector('[data-menu]');
	if (menu) menu.addEventListener('click', function () { document.body.classList.toggle('menu-open'); });

	// Highlight the section in view in "On this page".
	var tocLinks = document.querySelectorAll('.toc a');
	if (tocLinks.length && 'IntersectionObserver' in window) {
		var obs = new IntersectionObserver(function (es) {
			es.forEach(function (en) {
				if (!en.isIntersecting) return;
				tocLinks.forEach(function (a) { a.classList.toggle('active', a.getAttribute('href') === '#' + en.target.id); });
			});
		}, { rootMargin: '-80px 0px -70% 0px' });
		document.querySelectorAll('.page-body h2[id]').forEach(function (h) { obs.observe(h); });
	}
})();
