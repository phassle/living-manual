// Narration for a scenario's video (spec: Video): one spoken sentence per unit, written from the
// step texts and the recorded labels of a step record. Units: two intro sentences (title, role),
// one per action (spoken just before that action happens), one outro. `text` is the caption;
// `speech` is what the voice reads: no quotes, dashes or parenthesised hints such as "(×)".

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** A label as a reader says it: no trailing colon. */
const name = (label) => clean(label).replace(/\s*:\s*$/, '');
const unquote = (s) => clean(s).replace(/["“”]/g, '');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** What the voice reads for a caption. */
export function speech(text) {
	return clean(text
		.replace(/\s*\([^)]*\)/g, '')
		.replace(/["“”]/g, '')
		.replace(/\s+[–—]\s+/g, ', ')
		.replace(/\s+([,.])/g, '$1'));
}

/** The action as an instruction, lower-case first: "click New widget", "in Name, type Blue". */
function instruction(a) {
	const label = name(a.label);
	switch (a.kind) {
		case 'click':
			if (a.labelSource === 'author') return `click the ${label}`;
			return a.labelVisible === false ? `click the ${label} button` : `click ${label}`;
		case 'check': return `tick ${label}`;
		case 'fill': return `in ${label}, type ${clean(a.value)}`;
		case 'select': return a.dataSpecific ? `in ${label}, choose the one you need: here, ${clean(a.value)}` : `in ${label}, choose ${clean(a.value)}`;
		case 'verify': return `check that ${label} is shown`;
		default: return `${a.kind} ${label}`;
	}
}

/** The purpose a first-person step names ("I start a new order" → "start a new order"), or null. */
function purpose(stepText) {
	const m = /^I\s+(.*)$/.exec(unquote(stepText));
	if (!m || /^(am|'m|have|can|see)\b/i.test(m[1])) return null;
	return m[1];
}

/** True when the step text already names the value the action enters or picks. */
const saysIt = (stepText, a) => !!a.value && unquote(stepText).toLowerCase().includes(clean(a.value).toLowerCase());

/**
 * The narration for a step record. Each unit: { id, kind: intro|action|outro, step?, action?, text, speech }.
 * step/action are the indexes into record.steps[step].actions[action] the sentence comes before.
 */
export function narrate(record) {
	const units = [];
	const add = (u) => units.push({ ...u, text: u.text, speech: speech(u.text) });
	const { title, role } = record.scenario;
	add({ id: 'intro-1', kind: 'intro', text: sentence(clean(title)) });
	if (role) add({ id: 'intro-2', kind: 'intro', text: `Here's how, as a ${clean(role)}.` });
	const last = record.steps.length - 1;
	let first = true;
	// The result's sentence is said once, before the last step's first check; its other checks are plain.
	let resultSaid = false;
	record.steps.forEach((step, s) => {
		step.actions.forEach((a, i) => {
			let text;
			const what = instruction(a);
			if (a.kind === 'verify' && s === last && !resultSaid) { text = `And there it is: ${lowerFirst(unquote(step.text))}`; resultSaid = true; }
			else if (first) text = `First, ${a.screen ? `in the ${a.screen.toLowerCase()}, ` : ''}${what}`;
			else if (i === 0 && purpose(step.text) && !saysIt(step.text, a)) text = `To ${purpose(step.text)}, ${what}`;
			else if (i === 0 && s === last) text = `Then ${what}`;
			else text = cap(what);
			first = false;
			add({ id: `s${s}a${i}`, kind: 'action', step: s, action: i, label: a.label, text: sentence(cap(text)) });
		});
	});
	add({ id: 'outro', kind: 'outro', text: `That's how you ${lowerFirst(clean(title))}.` });
	return units;
}
