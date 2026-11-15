// The pointer drawn into a video run (spec: Video: "A pointer is drawn into the recording").
// Headless Chromium draws no mouse pointer, so a viewer could not follow the clicks. Adapted from
// the workspace's demo recorder (e2e/demo-next/cursor.ts): an arrow that follows mousemove, a
// ripple on mousedown, plus a soft ring round the element the narration is about. It lives in a
// closed shadow root with pointer-events: none, so it never catches a click, never changes what
// elementFromPoint returns, and the kit's animations-off style (which targets the document) does
// not stop its motion. Controlled through window.__lmPointer: speed(ms) sets how long the arrow
// takes to follow a move; ring(box | null) shows or hides the ring.
// Listeners are on the window, capture phase, so they see every move before the page does.
export const POINTER_SCRIPT = `(() => {
	// Installed again whenever the document lost it (document.open, as page.setContent does, drops
	// the element and the window's listeners); every call through window.__lmPointer checks.
	let api = null, host = null, pending = [];
	window.__lmPointer = new Proxy({}, { get: (_, k) => (...a) => { if (document.documentElement && !(host && host.isConnected)) install(); return api ? api[k](...a) : pending.push([k, a]); } });
	const install = () => {
		host = document.createElement('lm-pointer');
		host.setAttribute('aria-hidden', 'true');
		host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
		const root = host.attachShadow({ mode: 'closed' });
		root.innerHTML = '<style>'
			+ '.p{position:fixed;left:0;top:0;width:30px;height:30px;transform:translate(-100px,-100px);transition:transform 60ms linear;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));}'
			+ '.r{position:fixed;left:0;top:0;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;border:3px solid #ff8a00;background:rgba(255,138,0,.28);pointer-events:none;animation:k 700ms ease-out forwards;}'
			+ '@keyframes k{from{transform:scale(.3);opacity:1}to{transform:scale(1.7);opacity:0}}'
			+ '.h{position:fixed;border:3px solid rgba(255,138,0,.95);border-radius:10px;box-shadow:0 0 0 6px rgba(255,138,0,.22);pointer-events:none;opacity:0;transition:opacity 250ms ease;}'
			+ '</style><div class="h"></div><svg class="p" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8 16.5 L11.5 24 L15 22.5 L11.6 15 L18 15 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
		const p = root.querySelector('.p');
		const h = root.querySelector('.h');
		const move = (x, y) => { p.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 2) + 'px)'; };
		try { const last = JSON.parse(sessionStorage.getItem('__lmPointer') || 'null'); if (last) { p.style.transition = 'none'; move(last[0], last[1]); requestAnimationFrame(() => { p.style.transition = ''; }); } } catch {}
		addEventListener('mousemove', (e) => { move(e.clientX, e.clientY); try { sessionStorage.setItem('__lmPointer', JSON.stringify([e.clientX, e.clientY])); } catch {} }, true);
		addEventListener('mousedown', (e) => {
			move(e.clientX, e.clientY);
			const r = document.createElement('div');
			r.className = 'r';
			r.style.left = e.clientX + 'px';
			r.style.top = e.clientY + 'px';
			root.appendChild(r);
			setTimeout(() => r.remove(), 750);
		}, true);
		document.documentElement.appendChild(host);
		api = {
			speed: (ms) => { p.style.transition = 'transform ' + ms + 'ms linear'; },
			ring: (b) => {
				if (!b) { h.style.opacity = '0'; return; }
				Object.assign(h.style, { left: (b.x - 7) + 'px', top: (b.y - 7) + 'px', width: (b.width + 14) + 'px', height: (b.height + 14) + 'px', opacity: '1' });
			},
		};
		for (const [k, a] of pending) api[k](...a);
		pending = [];
	};
	if (document.documentElement) install(); else document.addEventListener('DOMContentLoaded', install);
})();`;
