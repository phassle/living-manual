/*
 * Living Manual guide (spec: Guide). The one script a product loads with
 * one line:
 *
 *   <script>window.livingManualGuide = { role: "<the signed-in user's role>" }</script><script src="/lm-guide/lm-guide.js" defer></script>
 *
 * It adds a help button, a help panel and a highlight overlay. The user picks a task in the panel;
 * the guide then marks, one at a time, the element each recorded action used, and moves on when
 * the user has used it. When the user is on another screen than the task's start screen, it first
 * marks the way there. It never clicks, types, focuses or dispatches anything in the product:
 * it only listens (passive, capture phase) to the user's own trusted clicks and changes. An action
 * on an element that exists only because of the demo data is described in words and not marked.
 * When an element cannot be found, the panel says so.
 *
 * Reads: guide-index.json beside this script (lm-build-guide), the current screen from the route
 * (location.search, the index's routeKeys), the role from window.livingManualGuide.role.
 * Questions: the panel's question box posts exactly { question, screen, role } to the endpoint
 * beside this script (POST match, bin/lib/guide-match.mjs), with the page's own session cookie.
 * The screen is the start screen of a scenario whose route the user is on, else the route's
 * screen keys (index routeKeys; a record's id is never sent). The answer is one scenario ID, which
 * the guide starts, or none: then the panel says there is no tested answer and links the closest
 * manual page (the endpoint has counted the question for a batched issue).
 * Options on window.livingManualGuide: role, indexUrl, matchUrl, notFoundAfterMs (default 4000).
 * Everything the guide draws lives in one shadow root, so the product's styles do not reach it.
 */
(() => {
	if (window.__livingManualGuide) return;
	window.__livingManualGuide = true;

	const cfg = window.livingManualGuide || {};
	const here = (document.currentScript && document.currentScript.src) || location.href;
	const INDEX_URL = cfg.indexUrl || new URL('guide-index.json', here).href;
	const MATCH_URL = cfg.matchUrl || new URL('match', here).href;
	const NOT_FOUND_MS = cfg.notFoundAfterMs ?? 4000;

	// ---- Finding elements by the recorded locator chain --------------------------------------

	const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
	const ROLE = {
		button: 'button, input[type=button], input[type=submit], input[type=reset], [role=button]',
		link: 'a[href], [role=link]',
		textbox: 'input:not([type]), input[type=text], input[type=email], input[type=search], input[type=tel], input[type=url], input[type=number], textarea, [role=textbox]',
		checkbox: 'input[type=checkbox], [role=checkbox]',
		radio: 'input[type=radio], [role=radio]',
		combobox: 'select, [role=combobox]',
		tab: '[role=tab]',
		menuitem: '[role=menuitem]',
		option: 'option, [role=option]',
		heading: 'h1, h2, h3, h4, h5, h6, [role=heading]',
	};
	const textOf = (el) => norm(el.textContent);
	function accessibleName(el) {
		const aria = el.getAttribute('aria-label');
		if (aria) return norm(aria);
		const by = el.getAttribute('aria-labelledby');
		if (by) return norm(by.split(/\s+/).map((id) => textOf(document.getElementById(id) || document.createElement('i'))).join(' '));
		if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) return norm(el.value);
		if (el.labels && el.labels.length) return norm([...el.labels].map(textOf).join(' '));
		const t = textOf(el) || norm(el.getAttribute('alt')) || norm(el.getAttribute('title'));
		return t;
	}
	const matches = (value, want, exact, regex) => {
		if (regex) return new RegExp(regex.regex, regex.flags).test(value);
		return exact ? value === norm(want) : value.toLowerCase().includes(norm(want).toLowerCase());
	};
	const all = (scope, css) => [...scope.querySelectorAll(css)].filter((el) => el !== host);
	function step(scopes, seg) {
		if (seg.nth !== undefined) return scopes[seg.nth] ? [scopes[seg.nth]] : [];
		if (seg.last) return scopes.length ? [scopes[scopes.length - 1]] : [];
		// filter({ hasText }): the elements so far whose text contains it (case-insensitive, as Playwright).
		if (seg.hasText !== undefined || seg.hasTextRegex) return scopes.filter((el) => el !== document && matches(textOf(el), seg.hasText, false, seg.hasTextRegex));
		return scopes.flatMap((scope) => {
			if (seg.css) return all(scope, seg.css);
			if (seg.testId) return all(scope, `[data-testid="${CSS.escape(seg.testId)}"]`);
			if (seg.role) return all(scope, ROLE[seg.role] || `[role="${seg.role}"]`)
				.filter((el) => (seg.name === undefined && !seg.nameRegex) || matches(accessibleName(el), seg.name, seg.exact, seg.nameRegex));
			if (seg.label) return all(scope, 'label').filter((l) => matches(textOf(l), seg.label, seg.exact))
				.map((l) => l.control).filter(Boolean);
			if (seg.text !== undefined || seg.textRegex) {
				const hit = (el) => matches(textOf(el), seg.text, seg.exact, seg.textRegex);
				// The innermost elements whose text matches, as Playwright's getByText.
				return all(scope, '*').filter((el) => !/^(SCRIPT|STYLE|HEAD|TITLE)$/.test(el.tagName) && hit(el) && ![...el.children].some(hit));
			}
			return [];
		});
	}
	function visible(el) {
		if (!el.isConnected || !el.getClientRects().length) return false;
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0';
	}
	/** The first visible element the chain leads to, or null. */
	function find(chain) {
		if (!chain || !chain.length) return null;
		let scopes = [document];
		for (const seg of chain) {
			scopes = [...new Set(step(scopes, seg))];
			if (!scopes.length) return null;
		}
		return scopes.find(visible) || null;
	}

	// ---- Context: the screen from the route ---------------------------------------------------

	function routeNow(keys) {
		const params = new URLSearchParams(location.search);
		const out = {};
		for (const [k, v] of params) {
			if (!v) continue;
			const how = keys ? keys[k] : 'value';
			if (how === 'value') out[k] = v;
			else if (how === 'presence') out[k] = true;
		}
		return out;
	}
	function onStartScreen(sc) {
		const keys = state.index.routeKeys;
		const now = routeNow(keys);
		const names = keys ? Object.keys(keys) : Object.keys(sc.startRoute);
		return names.every((k) => now[k] === sc.startRoute[k]);
	}

	// ---- State --------------------------------------------------------------------------------

	const state = {
		index: null,
		error: null,
		open: false,
		scenario: null,
		i: 0,
		phase: 'trigger', // a select that is not data-specific: first its trigger, then its option
		lostSince: null,
		lost: false,
		done: false,
		question: '',
		asking: false,
		answer: null, // { none: true, question, page } after a question with no tested answer; { error } when the ask failed
	};
	const current = () => (state.scenario ? state.scenario.actions[state.i] : null);
	const label = (a) => (a.labelSource === 'author' ? a.label : norm(a.label).replace(/\s*:$/, ''));

	function begin(sc) {
		state.answer = null;
		state.scenario = sc;
		state.done = false;
		state.i = 0;
		if (onStartScreen(sc)) skipWay();
		enter();
	}
	function skipWay() {
		const first = state.scenario.actions.findIndex((a) => !a.wayToStart);
		if (first > state.i) state.i = first;
	}
	function enter() {
		state.phase = 'trigger';
		state.lostSince = null;
		state.lost = false;
		const a = current();
		if (!a) state.done = true;
		render();
		tick();
	}
	function advance(by = 1) {
		state.i = Math.min(state.i + by, state.scenario.actions.length);
		enter();
	}
	function stop() {
		state.scenario = null;
		state.done = false;
		render();
		tick();
	}

	// ---- The user's own actions move the guide on --------------------------------------------

	const inside = (el, target) => !!el && target instanceof Node && (el === target || el.contains(target));
	function containerOf(chain) {
		return chain && chain.length > 1 ? find(chain.slice(0, -1)) : null;
	}
	function onUser(e) {
		if (!e.isTrusted || !state.scenario || state.done) return;
		if (e.target === host) return; // the guide's own panel
		const a = current();
		if (!a || a.kind === 'verify') return;
		const el = find(a.locator.chain);
		const t = e.target;
		let used = false;
		if (a.kind === 'click' || a.kind === 'check') used = e.type === 'click' && inside(el, t);
		else if (a.kind === 'fill') used = e.type === 'change' && inside(el, t);
		else if (a.kind === 'select') {
			if (e.type === 'change' && inside(el, t)) used = true;
			else if (a.dataSpecific) used = e.type === 'click' && (inside(containerOf(a.option && a.option.chain), t) || inside(a.option && find(a.option.chain), t));
			else if (state.phase === 'trigger' && e.type === 'click' && inside(el, t)) {
				if (a.option) { state.phase = 'option'; render(); setTimeout(tick, 0); return; }
				used = true;
			} else if (state.phase === 'option' && e.type === 'click') used = inside(find(a.option.chain), t);
		}
		if (used) return void setTimeout(() => advance(1), 0);
		// The user went straight on to the next action (after typing, or after a step the guide does not mark).
		const next = state.scenario.actions[state.i + 1];
		if (e.type === 'click' && next && next.kind !== 'verify' && inside(find(next.locator.chain), t)) setTimeout(() => advance(2), 0);
	}
	for (const type of ['click', 'change']) document.addEventListener(type, onUser, { capture: true, passive: true });

	// ---- Drawing -------------------------------------------------------------------------------

	const host = document.createElement('div');
	host.id = 'living-manual-guide';
	const root = host.attachShadow({ mode: 'open' });
	root.innerHTML = `<style>
		:host { all: initial; }
		* { box-sizing: border-box; }
		.ui { font-family: Nunito, "Segoe UI", system-ui, sans-serif; font-size: 14px; color: #333; line-height: 1.4; }
		.help { position: fixed; left: 16px; bottom: 52px; z-index: 2147483646; display: inline-flex; align-items: center; gap: 8px;
			height: 40px; padding: 0 18px 0 8px; border: 0; border-radius: 20px; background: #fff; color: #184876; font: inherit; font-weight: 700;
			box-shadow: 0 4px 14px rgba(9, 30, 56, .35); cursor: pointer; }
		.help:hover { background: #eef4fb; }
		.help .q { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: #316ba2; color: #fff; font-weight: 800; }
		.panel { position: fixed; z-index: 2147483646; width: 360px; max-height: calc(100vh - 32px); display: flex; flex-direction: column;
			background: #fff; border-radius: 12px; box-shadow: 0 10px 32px rgba(9, 30, 56, .28), 0 0 0 1px rgba(24, 72, 118, .08); overflow: hidden; }
		.head { display: flex; align-items: center; gap: 10px; padding: 14px 14px 14px 18px; background: linear-gradient(135deg, #184876, #316ba2); color: #fff;
			cursor: move; touch-action: none; user-select: none; }
		.panel.dragging { box-shadow: 0 16px 40px rgba(9, 30, 56, .36), 0 0 0 1px rgba(24, 72, 118, .12); }
		.head h2 { margin: 0; font-size: 16px; font-weight: 700; flex: 1; }
		.head small { display: block; font-size: 12px; font-weight: 400; opacity: .8; }
		.icon { border: 0; background: transparent; color: #fff; width: 30px; height: 30px; border-radius: 50%; font-size: 18px; cursor: pointer; }
		.icon:hover { background: rgba(255, 255, 255, .15); }
		.body { padding: 16px 18px 18px; overflow: auto; }
		.ask { margin: 0 0 10px; font-weight: 700; color: #184876; }
		.tasks { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
		.task { width: 100%; display: flex; align-items: center; gap: 10px; text-align: left; padding: 11px 12px; border: 1px solid #d9e3ee; border-radius: 10px;
			background: #fff; font: inherit; color: #333; cursor: pointer; }
		.task:hover { border-color: #316ba2; background: #f4f8fc; }
		.task b { display: block; font-weight: 700; color: #1d2b3a; }
		.task span.meta { font-size: 12px; color: #6b7a8a; }
		.task .go { margin-left: auto; color: #316ba2; font-size: 18px; }
		.badge { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 9px; background: #fff4d6; color: #8a5a00; font-size: 11px; font-weight: 700; vertical-align: 1px; }
		.back { border: 0; background: transparent; color: #316ba2; font: inherit; font-weight: 700; padding: 0; cursor: pointer; margin-bottom: 10px; }
		.title { margin: 0 0 2px; font-size: 16px; font-weight: 800; color: #1d2b3a; }
		.progress { display: flex; align-items: center; gap: 10px; margin: 6px 0 14px; font-size: 12px; color: #6b7a8a; }
		.bar { flex: 1; height: 6px; border-radius: 3px; background: #e6edf5; overflow: hidden; }
		.bar i { display: block; height: 100%; background: #316ba2; border-radius: 3px; }
		.phase { margin: 0 0 6px; font-size: 12px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; color: #316ba2; }
		.now { padding: 12px 14px; border-radius: 10px; background: #f4f8fc; border-left: 4px solid #316ba2; }
		.now p { margin: 0; font-size: 15px; font-weight: 700; color: #1d2b3a; }
		.now .where { margin-top: 4px; font-size: 12px; font-weight: 400; color: #6b7a8a; }
		.note { margin-top: 10px; font-size: 13px; color: #4a5866; }
		.next { margin-top: 10px; border: 0; border-radius: 18px; padding: 8px 16px; background: #316ba2; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
		.next:hover { background: #184876; }
		.msg { margin-top: 12px; padding: 10px 12px; border-radius: 10px; font-size: 13px; }
		.msg.warn { background: #fff4e5; color: #7a4100; border: 1px solid #f3c98b; }
		.msg.ok { background: #e9f7ef; color: #1e6b3a; border: 1px solid #a9dcbc; font-weight: 700; }
		.steps { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 4px; font-size: 13px; }
		.steps li { display: flex; gap: 8px; color: #8a97a5; }
		.steps li.did { color: #6b7a8a; }
		.steps li.on { color: #1d2b3a; font-weight: 700; }
		.steps .n { flex: 0 0 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; background: #eef2f6; color: #6b7a8a; }
		.steps li.did .n { background: #d7ecdf; color: #1e6b3a; }
		.steps li.on .n { background: #316ba2; color: #fff; }
		.empty { color: #6b7a8a; }
		.askform { display: flex; gap: 8px; margin: 0 0 6px; }
		.askform input { flex: 1; min-width: 0; height: 36px; padding: 0 12px; border: 1px solid #c4d2e1; border-radius: 18px; font: inherit; color: #1d2b3a; background: #fff; }
		.askform input:focus { outline: 2px solid #316ba2; outline-offset: 1px; border-color: #316ba2; }
		.askform button { height: 36px; border: 0; border-radius: 18px; padding: 0 16px; background: #316ba2; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
		.askform button:disabled { opacity: .6; cursor: default; }
		.or { margin: 16px 0 8px; font-size: 12px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; color: #6b7a8a; }
		.msg a { color: #184876; font-weight: 700; }
		.mark { position: fixed; z-index: 2147483645; pointer-events: none; border: 3px solid #e4002b; border-radius: 8px;
			box-shadow: 0 0 0 4px rgba(228, 0, 43, .18), 0 0 0 100vmax rgba(9, 30, 56, .18); transition: all .15s ease-out; }
		.mark::after { content: ""; position: absolute; inset: -9px; border-radius: 12px; border: 2px solid rgba(228, 0, 43, .55); animation: pulse 1.4s ease-out infinite; }
		@keyframes pulse { from { opacity: 1; transform: scale(.96); } to { opacity: 0; transform: scale(1.08); } }
		.tip { position: fixed; z-index: 2147483646; pointer-events: none; max-width: 280px; padding: 8px 12px; border-radius: 8px; background: #184876; color: #fff;
			font-weight: 700; font-size: 13px; box-shadow: 0 4px 14px rgba(9, 30, 56, .3); }
		[hidden] { display: none !important; }
	</style>
	<div class="ui">
		<div class="mark" data-testid="lm-guide-highlight" hidden></div>
		<div class="tip" hidden aria-hidden="true"></div>
		<button class="help" type="button" data-testid="lm-guide-help" aria-haspopup="dialog"><span class="q">?</span>Help</button>
		<section class="panel" data-testid="lm-guide-panel" role="dialog" aria-label="Help" hidden>
			<div class="head" title="Drag to move. Double-click to let the guide place it."><h2>Help<small>Shown step by step in the product</small></h2><button class="icon" type="button" data-act="close" aria-label="Close help">×</button></div>
			<div class="body"></div>
		</section>
	</div>`;
	const $ = (s) => root.querySelector(s);
	const mark = $('.mark');
	const tip = $('.tip');
	const help = $('.help');
	const panel = $('.panel');
	const body = $('.body');

	// The user can drag the panel by its header. Where they put it is kept for this tab (and the
	// guide stops moving it out of the highlight's way); a double-click hands placement back.
	const MOVED_KEY = 'lm-guide-panel-position';
	let moved = null;
	try { moved = JSON.parse(sessionStorage.getItem(MOVED_KEY) || 'null'); } catch { moved = null; }
	const head = $('.head');
	head.addEventListener('pointerdown', (e) => {
		if (e.button !== 0 || e.target.closest('button')) return;
		const r = panel.getBoundingClientRect();
		const dx = e.clientX - r.left, dy = e.clientY - r.top;
		head.setPointerCapture(e.pointerId);
		panel.classList.add('dragging');
		const move = (ev) => { moved = { x: ev.clientX - dx, y: ev.clientY - dy }; placePanel(null); };
		const up = () => {
			head.removeEventListener('pointermove', move);
			head.removeEventListener('pointerup', up);
			head.removeEventListener('pointercancel', up);
			panel.classList.remove('dragging');
			try { if (moved) sessionStorage.setItem(MOVED_KEY, JSON.stringify(moved)); } catch { /* storage off: kept until reload */ }
		};
		head.addEventListener('pointermove', move);
		head.addEventListener('pointerup', up);
		head.addEventListener('pointercancel', up);
		e.preventDefault();
	});
	head.addEventListener('dblclick', (e) => {
		if (e.target.closest('button')) return;
		moved = null;
		try { sessionStorage.removeItem(MOVED_KEY); } catch { /* nothing kept */ }
		tick();
	});

	const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
	const forRole = (sc) => !cfg.role || !sc.role || sc.role === cfg.role;

	function render() {
		help.hidden = state.open;
		panel.hidden = !state.open;
		if (!state.open) return;
		if (state.error) { body.innerHTML = `<p class="msg warn" data-testid="lm-guide-message">${esc(state.error)}</p>`; return; }
		if (!state.index) { body.innerHTML = '<p class="empty">Loading…</p>'; return; }
		const sc = state.scenario;
		if (!sc) {
			const list = state.index.scenarios.filter(forRole);
			const ans = state.answer;
			const reply = state.asking ? '<p class="empty" data-testid="lm-guide-asking">Looking for a tested answer…</p>'
				: ans && ans.error ? `<p class="msg warn" data-testid="lm-guide-message">${esc(ans.error)}</p>`
				: ans && ans.none ? `<p class="msg warn" data-testid="lm-guide-message">There is no tested answer to “${esc(ans.question)}” yet, so the guide will not guess.${ans.page ? ` The closest page in the manual: <a data-testid="lm-guide-manual-link" href="${esc(ans.page.url)}" target="_blank" rel="noopener">${esc(ans.page.title)}</a>.` : ''} Your question has been passed on so the manual can cover it.</p>`
				: '';
			body.innerHTML = `<p class="ask">What do you want to do?</p>
				<form class="askform" data-act="ask"><input data-testid="lm-guide-question" name="q" type="text" maxlength="500" autocomplete="off" aria-label="Ask in your own words" placeholder="Ask in your own words" value="${esc(state.question)}"${state.asking ? ' disabled' : ''}><button type="submit" data-testid="lm-guide-ask"${state.asking ? ' disabled' : ''}>Ask</button></form>
				${reply}<p class="or">Or choose a task</p>${list.length ? `<ul class="tasks">${list.map((s, i) => `<li><button class="task" type="button" data-pick="${i}">
				<span><b>${esc(s.title)}${s.confirmed ? '' : '<span class="badge">Draft</span>'}</b><span class="meta">${esc(s.actions.filter((a) => !a.wayToStart).length)} steps · starts on the ${esc(s.startScreen)}</span></span>
				<span class="go" aria-hidden="true">›</span></button></li>`).join('')}</ul>` : '<p class="empty">There is no tested help for your role yet.</p>'}`;
			body._list = list;
			return;
		}
		const total = sc.actions.length;
		const a = current();
		const pct = Math.round((Math.min(state.i, total) / total) * 100);
		let now = '';
		if (state.done) {
			now = `<p class="msg ok" data-testid="lm-guide-message">Done. You have completed “${esc(sc.title)}”.</p>`;
		} else {
			const way = a.wayToStart ? `<p class="phase">First, go to the ${esc(sc.startScreen)}</p>` : `<p class="phase">Step ${state.i + 1} of ${total}</p>`;
			const opt = a.kind === 'select' && !a.dataSpecific && state.phase === 'option' ? ` Now choose “${esc(a.value)}”.` : '';
			const words = a.dataSpecific
				? `<p class="note">This one depends on your data, so the guide does not mark it. Do it yourself; the guide moves on when you have.</p><button class="next" type="button" data-testid="lm-guide-next" data-act="next">Done, next</button>`
				: '';
			const lost = state.lost
				? `<p class="msg warn" data-testid="lm-guide-message">The guide cannot find “${esc(label(a))}” on this screen. It has no tested answer for the screen as it is now.</p>`
				: '';
			now = `${way}<div class="now"><p data-testid="lm-guide-instruction">${esc(a.text)}${opt}</p>${a.screen ? `<p class="where">On: ${esc(a.screen)}</p>` : ''}</div>${words}${lost}`;
		}
		body.innerHTML = `<button class="back" type="button" data-act="back">‹ All tasks</button>
			<p class="title" data-testid="lm-guide-scenario" data-scenario="${esc(sc.id)}">${esc(sc.title)}${sc.confirmed ? '' : '<span class="badge">Draft</span>'}</p>
			<div class="progress"><div class="bar"><i style="width:${pct}%"></i></div>${Math.min(state.i, total)} of ${total} done</div>
			${now}
			<ol class="steps">${sc.actions.map((x, i) => `<li class="${i < state.i ? 'did' : i === state.i && !state.done ? 'on' : ''}"><span class="n">${i < state.i ? '✓' : i + 1}</span><span>${esc(x.text)}</span></li>`).join('')}</ol>`;
	}

	/** The screen the user is on, as the guide may say it: a known start screen, else the route's screen keys. */
	function screenNow() {
		const keys = state.index.routeKeys;
		const now = routeNow(keys);
		const names = keys ? Object.keys(keys) : Object.keys(now);
		const known = state.index.scenarios.find((s) => names.every((k) => now[k] === s.startRoute[k]));
		if (known) return known.startScreen;
		const parts = Object.entries(now).map(([k, v]) => (v === true ? k : `${k}=${v}`));
		return parts.length ? parts.join('&') : null;
	}

	async function ask(question) {
		state.question = question;
		state.answer = null;
		state.asking = true;
		render();
		try {
			const r = await fetch(MATCH_URL, {
				method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ question, screen: screenNow(), role: cfg.role ?? null }),
			});
			if (r.status === 401) throw new Error('Sign in to the product to ask the guide.');
			if (!r.ok) throw new Error('The guide could not answer just now. Choose a task below instead.');
			const out = await r.json();
			const sc = out.scenario && state.index.scenarios.filter(forRole).find((s) => s.id === out.scenario);
			state.asking = false;
			if (sc) { state.question = ''; begin(sc); return; }
			state.answer = { none: true, question, page: out.page || null };
		} catch (e) {
			state.asking = false;
			state.answer = { error: e.message };
		}
		render();
	}

	root.addEventListener('submit', (e) => {
		e.preventDefault();
		const q = (e.target.elements.q.value || '').trim();
		if (q && !state.asking) ask(q);
	});

	root.addEventListener('click', (e) => {
		const t = e.target.closest('button');
		if (!t) return;
		if (t === help) { state.open = true; load(); render(); return; }
		const act = t.dataset.act;
		if (act === 'close') { state.open = false; stop(); return; }
		if (act === 'back') { stop(); return; }
		if (act === 'next') { advance(1); return; }
		if (t.dataset.pick !== undefined) begin(body._list[Number(t.dataset.pick)]);
	});

	/** Puts the mark round the element, the tip beside it, and the panel where it covers neither. */
	function place(el) {
		if (!el) { mark.hidden = true; tip.hidden = true; placePanel(null); return; }
		const r = el.getBoundingClientRect();
		const pad = 4;
		Object.assign(mark.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
		mark.hidden = false;
		const a = current();
		tip.textContent = state.done ? 'Done' : a ? a.text : '';
		tip.hidden = false;
		const tw = tip.offsetWidth, th = tip.offsetHeight;
		// Beside a narrow element when there is room on its right, else below it, else above it.
		if (r.width < 400 && r.right + 16 + tw < innerWidth - 8) {
			tip.style.left = `${r.right + 16}px`;
			tip.style.top = `${Math.min(Math.max(8, r.top + r.height / 2 - th / 2), innerHeight - th - 8)}px`;
		} else {
			const below = r.bottom + 14 + th < innerHeight;
			tip.style.left = `${Math.min(Math.max(8, r.left), innerWidth - tw - 8)}px`;
			tip.style.top = `${below ? r.bottom + 14 : Math.max(8, r.top - th - 14)}px`;
		}
		// The panel keeps clear of both the mark and its tip.
		const t = tip.getBoundingClientRect();
		placePanel({ left: Math.min(r.left, t.left), top: Math.min(r.top, t.top), right: Math.max(r.right, t.right), bottom: Math.max(r.bottom, t.bottom) });
	}
	function placePanel(r) {
		if (panel.hidden) return;
		const w = panel.offsetWidth, h = panel.offsetHeight, m = 16;
		// Moved by the user: it stays there, kept inside the window.
		if (moved) {
			panel.style.left = `${Math.min(Math.max(0, moved.x), Math.max(0, innerWidth - w))}px`;
			panel.style.top = `${Math.min(Math.max(0, moved.y), Math.max(0, innerHeight - 48))}px`;
			return;
		}
		const spots = [[m, innerHeight - h - m], [innerWidth - w - m, innerHeight - h - m], [innerWidth - w - m, 72], [m, 72]];
		const clear = ([x, y]) => !r || x > r.right + 12 || x + w < r.left - 12 || y > r.bottom + 12 || y + h < r.top - 12;
		const [x, y] = spots.find(clear) || spots[0];
		panel.style.left = `${x}px`;
		panel.style.top = `${Math.max(m, y)}px`;
	}

	function tick() {
		const a = current();
		if (!state.scenario || (!a && !state.done)) { place(null); return; }
		if (state.done) {
			const last = state.scenario.actions[state.scenario.actions.length - 1];
			place(last && last.kind === 'verify' && !last.dataSpecific ? find(last.locator.chain) : null);
			return;
		}
		if (a.wayToStart && onStartScreen(state.scenario)) { skipWay(); enter(); return; }
		// Data-specific, or a locator the guide cannot follow: the step is said in words, nothing is marked.
		if (a.dataSpecific || a.highlightable === false) { place(null); return; }
		const chain = a.kind === 'select' && state.phase === 'option' ? a.option.chain : a.locator.chain;
		const el = find(chain);
		if (el) {
			if (state.lost) { state.lost = false; render(); }
			state.lostSince = null;
			if (a.kind === 'verify') { state.i = state.scenario.actions.length; state.done = true; render(); }
			place(el);
			return;
		}
		place(null);
		if (state.lostSince === null) state.lostSince = Date.now();
		else if (!state.lost && Date.now() - state.lostSince >= NOT_FOUND_MS) { state.lost = true; render(); placePanel(null); }
	}

	let loading = null;
	function load() {
		if (loading) return loading;
		loading = fetch(INDEX_URL, { credentials: 'same-origin' })
			.then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
			.then((index) => { state.index = index; })
			.catch((e) => { state.error = `The guide could not load its tested answers (${e.message}).`; })
			.then(render);
		return loading;
	}

	const mount = () => { document.body.appendChild(host); render(); setInterval(tick, 250); addEventListener('resize', tick, { passive: true }); addEventListener('scroll', tick, { passive: true, capture: true }); };
	if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
})();
