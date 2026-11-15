// Intent level (spec: Doc scenarios: "I save the order", never "I click the Save button"; story 31).
// uiWords(step) finds the words that tie a step to the screen's widgets; rewrite(sentence) turns a
// UI-level or imperative sentence into an intent-level step when it can, else returns null. Shared
// by lm-draft check (the lint) and lm-draft from (Gherkin, text, manuals, click recordings).
// Text in double quotes is data (a name, a value) and is never read as a UI word.

const VERBS = [
	['double-click', /\bdouble[- ]click(s|ed|ing)?\b/],
	['right-click', /\bright[- ]click(s|ed|ing)?\b/],
	['click', /(?<![-\w])click(s|ed|ing)?\b/],
	['tap', /\btap(s|ped|ping)?\b/],
	['press', /\bpress(es|ed|ing)?\b/],
	['hover', /\bhover(s|ed|ing)?\b/],
	['scroll', /\bscroll(s|ed|ing)?\b/],
	['drag', /\bdrag(s|ged|ging)?\b/],
	['type into', /\btyp(e|es|ed|ing)\b(?:\s+\S+)*?\s+in(to)?\b/],
];
const NOUNS = [
	['button', /\bbuttons?\b/],
	['checkbox', /\bcheck[- ]?box(es)?\b/],
	['dropdown', /\bdrop[- ]?downs?\b/],
	['combobox', /\bcombo[- ]?box(es)?\b/],
	['radio button', /\bradio\b/],
	['text box', /\btext[- ]?box(es)?\b/],
	['field', /\bfields?\b/],
	['icon', /\bicons?\b/],
	['link', /\b(hyper)?links?\b(?!\s+(the|a|an)\b)/],
	['scrollbar', /\bscroll ?bars?\b/],
];
const unquoted = (s) => s.replace(/"[^"]*"/g, '""');

/** The UI words in a step, as names ("click", "button"); empty when the step is intent level. */
export function uiWords(step) {
	const s = unquoted(step).toLowerCase();
	const found = [];
	for (const [name, re] of VERBS) if (re.test(s) && !(name === 'click' && found.some((f) => f.endsWith('click')))) found.push(name);
	for (const [name, re] of NOUNS) if (re.test(s) && !(name === 'button' && found.includes('radio button'))) found.push(name);
	return found;
}

export const ADVICE = 'write what the user wants done, e.g. "I save the order"';

const LABEL = String.raw`(?:"([^"]+)"|(.+?))`;
const lc = (s) => s.replace(/:$/, '').trim().toLowerCase();
const pick = (m, i) => m[i] ?? m[i + 1];
/** The value as it was written: quoted when the writer quoted it ("A-100"), else as words (the order number). */
const val = (m, i) => (m[i] !== undefined ? `"${m[i]}"` : m[i + 1]);
const NO_THE = new Set(['a', 'an', 'the', 'all', 'to', 'from', 'in', 'on', 'with', 'and', 'or', 'my', 'this', 'that', 'it', 'up', 'out', 'off', 'down', 'back']);

/** Verbs a button's label starts with ("Save", "Create new order", "Extend..."). */
const UI_VERBS = new Set(('accept add apply approve archive assign attach book calculate cancel change check choose clear close confirm copy create delete ' +
	'deselect discard download duplicate edit email end export extend filter find finish generate hide import invite link load lock log mark merge move ' +
	'next open pay pause preview print publish refresh register reject reload remove rename renew reopen replace report request reset restore resume ' +
	'retry return revert run save search select send set share show sign sort start stop submit terminate undo unlock update upload validate verify view').split(' '));

/** What pressing a button with this label is for: "Save" → "I save", "Cancel order" → "I cancel the order". */
export function buttonIntent(label) {
	const name = label.replace(/(\.\.\.|…)$/, '').trim();
	const low = name.toLowerCase();
	if (['ok', 'yes', 'confirm', 'done', 'apply'].includes(low)) return 'I confirm';
	if (['cancel', 'no'].includes(low)) return 'I cancel';
	if (['close', 'x', '×'].includes(low)) return 'I close the dialog';
	if (!/[a-z]/.test(low)) return null;
	const words = low.split(/\s+/);
	if (words[0] === 'new' && words.length >= 2) return `I start a new ${words.slice(1).join(' ')}`;
	// A label that does not start with a verb names a thing ("Termination of customer"): the user opens it.
	if (!UI_VERBS.has(words[0])) return `I open "${name}"`;
	if (words[1] === 'new') words.splice(1, 0, 'a');
	else if (words.length >= 2 && !NO_THE.has(words[1])) words.splice(1, 0, 'the');
	return `I ${words.join(' ')}`;
}

/** Base form of a third-person verb: "types" → "type", "presses" → "press", "copies" → "copy". */
const base = (v) => /ies$/.test(v) ? v.slice(0, -3) + 'y' : /(ss|sh|ch|x|o)es$/.test(v) ? v.slice(0, -2) : /s$/.test(v) && !/ss$/.test(v) ? v.slice(0, -1) : v;

/**
 * The sentence in the first person, or null when it describes an outcome rather than something the
 * user does: "the user types …" → "I type …", "Click Save." → "I click Save", "I save" → itself.
 */
export function firstPerson(sentence) {
	const s = sentence.trim().replace(/[.!]$/, '').trim();
	let m;
	if (/^I\b/.test(s)) return s;
	if ((m = /^(?:the )?user (\S+)(.*)$/i.exec(s))) return `I ${base(m[1].toLowerCase())}${m[2]}`;
	if ((m = /^you (\S+)(.*)$/i.exec(s))) return `I ${m[1].toLowerCase()}${m[2]}`;
	if (/^(the|a|an|this|that|these|it|its|your|there|now|then|when|if|after|before)\b/i.test(s)) return null;
	if (/^[A-Z][a-z]+\b/.test(s) && !/^[A-Z][a-z]*[^s]s\b|^[A-Z][a-z]+ed\b/.test(s)) return `I ${s[0].toLowerCase()}${s.slice(1)}`;
	return null;
}

/**
 * An intent-level step for a first-person (or third-person, or imperative) sentence that names the
 * UI. Returns { text } with the new step text, { drop: true } for a step that is no intent at all (a
 * key press, a hover, a scroll), or null when it cannot tell what the user wants done.
 */
export function rewrite(sentence) {
	let t = firstPerson(sentence);
	if (!t) return null;
	// "… and press Enter" only confirms what the sentence already did.
	t = t.replace(/,? and (?:then )?press (?:the )?(?:enter|return|tab)(?: key)?$/i, '');
	const res = rules(t);
	if (!res && !uiWords(t).length) return { text: t };
	if (!res || res.drop) return res;
	return uiWords(res.text).length ? null : res;
}

function rules(t) {
	let m;
	const L = LABEL;
	const re = (src) => new RegExp(`^${src}$`, 'i');
	if (re(String.raw`I (?:press|hit) (?:the )?(?:enter|return|tab|escape|esc)(?: key)?`).test(t)) return { drop: true };
	if (re(String.raw`I (?:hover|scroll|move the mouse)\b.*`).test(t)) return { drop: true };
	if ((m = re(String.raw`I (?:type|enter|fill in|write|input|key in) ${L} (?:in|into) (?:the )?${L}(?: field| box| text ?box| input)?`).exec(t)))
		return { text: `I set the ${lc(pick(m, 3))} to ${val(m, 1)}` };
	if ((m = re(String.raw`I fill (?:in )?(?:the )?${L}(?: field| box| text ?box)? with ${L}`).exec(t)))
		return { text: `I set the ${lc(pick(m, 1))} to ${val(m, 3)}` };
	if ((m = re(String.raw`I (?:select|choose|pick) ${L} (?:in|from) (?:the )?${L}(?: drop-?down| list| menu| combo ?box| field)?`).exec(t)))
		return { text: `I choose the ${lc(pick(m, 3))} ${val(m, 1)}` };
	if ((m = re(String.raw`I (check|tick|select|uncheck|untick|clear) (?:the )?${L} check ?box`).exec(t)))
		return { text: `I turn ${/^(un|clear)/i.test(m[1]) ? 'off' : 'on'} ${pick(m, 2)}` };
	if ((m = re(String.raw`I (?:click|tap|select|open|go to)(?: on)? (?:the )?${L} tab`).exec(t)))
		return { text: `I open the ${pick(m, 1)} tab` };
	if ((m = re(String.raw`I (?:click|tap|press|hit|select|choose|use)(?: on)? (?:the )?${L} button`).exec(t))) {
		const text = buttonIntent(pick(m, 1));
		return text ? { text } : null;
	}
	if ((m = re(String.raw`I (?:navigate|go) to (?:the )?${L}(?: page| screen| view)?`).exec(t)))
		return { text: `I open the ${pick(m, 1)}` };
	if ((m = re(String.raw`I (?:click|double-click|tap|select)(?: on)? (?:the )?${L}(?: link| row| item| entry| menu item)?(?: in the .+)?`).exec(t))) {
		if (m[1]) return { text: `I open "${m[1]}"` };
		const bare = m[2];
		// A bare capitalised name of a few words is a button's label ("Click Save").
		if (/^[A-Z]/.test(bare) && bare.split(/\s+/).length <= 3) { const text = buttonIntent(bare); return text ? { text } : null; }
		return { text: `I open the ${bare.replace(/^the /i, '')}` };
	}
	return null;
}
