// A video run's timeline (written by src/index.ts in video mode, <videos>/<ID>/timeline.json):
// events { type: narration|action, start, end } in ms from the start of the recording. From it
// come the sync check (T1.12) and the captions.

const s = (ms) => (ms / 1000).toFixed(2);

/**
 * T1.12: every narration sentence ends before the next action starts. The next action of a
 * sentence is the first action that starts at or after the sentence starts. Returns
 * { ok, lines } where lines[0] is the verdict and the rest one row per sentence.
 */
export function syncCheck(timeline, clips = {}) {
	const id = timeline.scenario?.id ?? '?';
	const said = timeline.events.filter((e) => e.type === 'narration').sort((a, b) => a.start - b.start);
	const actions = timeline.events.filter((e) => e.type === 'action').sort((a, b) => a.start - b.start);
	const rows = [];
	let bad = 0;
	// A sentence the run waited on for much longer than its clip lasts: the run stalled (the
	// machine slept, say) and the film would hold a long silence there.
	const stalled = said.filter((n) => clips[n.unit] && n.end - n.start > clips[n.unit] * 1000 + 1000);
	for (const n of stalled) rows.push(`  STALLED  ${s(n.start)}–${s(n.end)} s  "${n.text}"  ${s(n.end - n.start)} s for a ${clips[n.unit].toFixed(2)} s clip`);
	let smallest = Infinity;
	for (const n of said) {
		const next = actions.find((a) => a.start >= n.start);
		const what = next ? `${next.kind} ${next.label}` : null;
		if (!next) { rows.push(`  ok       ${s(n.start)}–${s(n.end)} s  "${n.text}"  (no action after it)`); continue; }
		const gap = next.start - n.end;
		if (gap < 0) {
			bad++;
			rows.push(`  OVERLAP  ${s(n.start)}–${s(n.end)} s  "${n.text}"  still playing ${s(-gap)} s into ${what} (starts ${s(next.start)} s)`);
		} else {
			smallest = Math.min(smallest, gap);
			rows.push(`  ok       ${s(n.start)}–${s(n.end)} s  "${n.text}"  ends ${s(gap)} s before ${what} (starts ${s(next.start)} s)`);
		}
	}
	const verdict = stalled.length
		? `FAIL T1.12 ${id}: ${stalled.length} sentence(s) lasted longer than their clip (the run stalled; record again)`
		: bad
		? `FAIL T1.12 ${id}: ${bad} sentence(s) still playing when the next action starts`
		: `PASS T1.12 ${id}: every narration sentence ends before the next action starts (${said.length} sentences, ${actions.length} actions; smallest gap ${Number.isFinite(smallest) ? s(smallest) : '–'} s)`;
	return { ok: !bad && !stalled.length && said.length > 0, lines: [verdict, ...rows] };
}

const stamp = (ms) => {
	const t = Math.max(0, Math.round(ms));
	const p = (n, w = 2) => String(n).padStart(w, '0');
	return `${p(Math.floor(t / 3_600_000))}:${p(Math.floor(t / 60_000) % 60)}:${p(Math.floor(t / 1000) % 60)}.${p(t % 1000, 3)}`;
};

/** WebVTT captions: one cue per narration sentence, shifted by leadIn ms (a title card before the recording). */
export function webvtt(timeline, leadIn = 0) {
	const cues = timeline.events.filter((e) => e.type === 'narration').sort((a, b) => a.start - b.start);
	return ['WEBVTT', '', ...cues.flatMap((c, i) => [String(i + 1), `${stamp(c.start + leadIn)} --> ${stamp(c.end + leadIn)}`, c.text, ''])].join('\n');
}
