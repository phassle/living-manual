// The kit's test API for generated doc-scenario specs (spec: From scenario to test code; Locators
// and the step record). A spec imports { test, expect } from here, wraps each Gherkin step in
// test.step('<step text verbatim>', …) and acts only through the `lm` fixture:
//
//   lm.screen('Order list')                       name the screen the next actions happen on
//   lm.click(target, opts)                        click; screenshot first, element marked
//   lm.fill(target, value, opts)                  fill; screenshot after typing, field marked
//   lm.select(trigger, option, opts)              open a dropdown and pick; option marked
//   lm.check(target, opts)                        tick a checkbox
//   lm.see(target, opts)                          assert visible: the step's visible result
//
// A target names the element: { testId } first, then { role, name }, then { text } or { css }.
// The first that matches on the page is used and recorded; anything but a test ID is reported as
// missing a test ID, and role-and-name or text is flagged language-bound. Options:
// dataSpecific (the element exists only because of the demo data), describe (words for an
// element with no visible label), within (a Locator to search inside), commit (key to press after
// fill), keys (fill by typing key by key, for masked inputs). After the test the step record is
// written to <build>/runs/<ID>/step-record.json, with
// the screenshots in <build>/runs/<ID>/shots/; the scenario's previous run is kept in
// <build>/previous/<ID> for bin/lm-compare.mjs.
//
// Repeatable runs (spec: Repeatable runs): before every scenario the product's reset and verify
// commands run; the browser's clock starts at the configured fixed time in the configured time
// zone, the configured window size, and every CSS transition and animation ends at once. Each
// action waits for the page's requests to settle before it reads the page, and each screenshot
// is taken again until two in a row are the same.
//
// Video mode (spec: Video; bin/lm-video.mjs sets lmVideo through LM_VIDEO_PLAN / LM_VIDEO_DIR):
// the same spec runs slowed down and recorded. Before each action its narration sentence is
// "spoken": the run waits for the length of the sentence's voice clip while a drawn pointer
// (src/pointer.ts) glides to the element and a ring marks it; only then does the action happen.
// Nothing is screenshot; the step record goes to the video folder (the run's own record in
// <build>/runs/<ID> stays as it is), with <dir>/timeline.json: when each sentence and each action
// started and ended, in ms from the start of the recording.
import { test as base, expect, type Locator, type Page, type Request, type TestInfo } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { POINTER_SCRIPT } from './pointer.ts';
// @ts-ignore: plain JavaScript module of the kit
import { drawFrame } from '../bin/lib/png.mjs';

export { expect };

type Role = Parameters<Page['getByRole']>[0];
export type Target = { testId?: string; role?: Role; name?: string | RegExp; text?: string; css?: string };
export type ActionOptions = { dataSpecific?: boolean; describe?: string; within?: Locator; commit?: string; screen?: string; keys?: boolean };
export type LmOptions = {
	lmBuildDir: string;
	lmProduct: string;
	lmVersion: { css: string; pattern?: string } | null;
	lmCookies: { name: string; value: string; domain: string; path: string }[];
	/** The product's reset and verify commands, run from the workspace root before every scenario. */
	lmEnvironment: { root: string; reset: string | null; verify: string | null };
	/** The fixed clock every run uses (an ISO time with offset): the page's clock starts there on every run. */
	lmClock: string | null;
	/** Video mode: the voiced narration plan (bin/lm-video.mjs) and the folder for the run's output. */
	lmVideo: { plan: string; dir: string } | null;
};

type Unit = { id: string; kind: 'intro' | 'action' | 'outro'; step?: number; action?: number; text: string; duration: number };
type TimelineEvent =
	| { type: 'narration'; unit: string; text: string; start: number; end: number }
	| { type: 'action'; step: number; action: number; kind: string; label: string; start: number; end: number };

/** Pauses of the video run, in ms: before an action once its sentence has ended, and at the end. */
const VIDEO_GAP = 350;
const VIDEO_HOLD = 1500;

/** The video run's clock: ms since the recorded page was created (the recording starts with it). */
let videoStart = 0;
const videoNow = () => Date.now() - videoStart;

/** Narrates a video run: speaks (waits out) the plan's units and moves the drawn pointer. */
class Narrator {
	events: TimelineEvent[] = [];
	private units: Unit[];
	private spoken = new Set<string>();
	private pointerShown = false;
	constructor(private page: Page, plan: string) { this.units = JSON.parse(readFileSync(plan, 'utf8')).units; }

	/** Glides the real mouse (and so the drawn pointer) to x, y in small eased steps. */
	private async glide(x: number, y: number, ms = 900) {
		const vp = this.page.viewportSize() ?? { width: 1440, height: 900 };
		if (!this.pointerShown) {
			this.pointerShown = true;
			await this.page.evaluate(() => (window as any).__lmPointer?.speed(0));
			await this.page.mouse.move(vp.width * 0.55, vp.height * 0.55);
			await sleep(50);
		}
		await this.page.evaluate(() => (window as any).__lmPointer?.speed(45));
		const from = await this.page.evaluate(() => { try { return JSON.parse(sessionStorage.getItem('__lmPointer') || 'null'); } catch { return null; } }) ?? [vp.width * 0.55, vp.height * 0.55];
		const n = Math.max(8, Math.round(ms / 40));
		for (let i = 1; i <= n; i++) {
			const t = i / n;
			const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
			await this.page.mouse.move(from[0] + (x - from[0]) * e, from[1] + (y - from[1]) * e);
			await sleep(ms / n);
		}
	}

	private async say(u: Unit) {
		this.spoken.add(u.id);
		const start = videoNow();
		await sleep(u.duration * 1000);
		this.events.push({ type: 'narration', unit: u.id, text: u.text, start, end: videoNow() });
	}

	/** Before action [step][action]: speaks any intro left, then the action's sentence while the pointer glides there. */
	async before(step: number, action: number, loc: Locator) {
		for (const u of this.units.filter((x) => x.kind === 'intro' && !this.spoken.has(x.id))) await this.say(u);
		const mine = this.units.filter((x) => x.kind === 'action' && x.step === step && x.action === action);
		await loc.scrollIntoViewIfNeeded().catch(() => {});
		const box = await loc.boundingBox();
		if (box) await this.page.evaluate((b) => (window as any).__lmPointer?.ring(b), box);
		const glide = box ? this.glide(box.x + box.width / 2, box.y + box.height / 2) : Promise.resolve();
		for (const u of mine) await this.say(u);
		await glide;
		await this.page.evaluate(() => (window as any).__lmPointer?.ring(null));
		await this.page.evaluate(() => (window as any).__lmPointer?.speed(120));
		await sleep(VIDEO_GAP);
	}

	action(step: number, action: number, kind: string, label: string, start: number) {
		this.events.push({ type: 'action', step, action, kind, label, start, end: videoNow() });
	}

	/** After the last action: the outro, then a moment on the result. */
	async end() {
		await sleep(600);
		for (const u of this.units.filter((x) => !this.spoken.has(x.id) && x.kind !== 'action')) await this.say(u);
		await sleep(VIDEO_HOLD);
	}
}

type Strategy = 'testid' | 'role' | 'text' | 'css';
type Box = { x: number; y: number; width: number; height: number };
export type ActionRecord = {
	n: number;
	kind: 'click' | 'fill' | 'select' | 'check' | 'verify';
	screen: string | null;
	locator: { strategy: Strategy; expression: string; testIdTried: string | null };
	label: string;
	labelSource: 'page' | 'author';
	/** False when the label is in the page but not shown (an icon-only button); the manual then points at the mark. */
	labelVisible: boolean;
	value?: string;
	option?: { strategy: Strategy; expression: string };
	dataSpecific: boolean;
	languageBound: boolean;
	missingTestId: boolean;
	screenshot: string;
	box: Box | null;
	url: string;
	startedAt: string;
	endedAt: string;
	startMs: number;
	endMs: number;
};

/**
 * Animations off: every CSS transition and animation ends at once (zero duration, one iteration),
 * smooth scrolling is instant and the text caret is not drawn. Added to every document, so what a
 * step records and shoots never depends on how far an animation had got. No fill mode either: an
 * ended animation that kept its last frame (a dialog's `scale(1)` with fill `both`) left the
 * element on its own compositor layer, and its rounded corners and icons were drawn one of two
 * ways at random, about one run in five (ticket 03's evidence).
 */
const STILL = `(() => {
	const css = '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;animation-fill-mode:none!important;scroll-behavior:auto!important;caret-color:transparent!important}';
	const add = () => {
		if (document.getElementById('__lm_still')) return;
		const s = document.createElement('style');
		s.id = '__lm_still';
		s.textContent = css;
		(document.head || document.documentElement).appendChild(s);
	};
	if (document.documentElement) add();
	document.addEventListener('DOMContentLoaded', add);
})();`;

/** Network quiet: no request for this long. Screenshot stable: two shots this far apart are equal. */
const QUIET = 300;
const STABLE_GAP = 150;
const SETTLE_MAX = 15_000;
/** With the fixed clock, a screenshot first runs this much of the page's pending timers (debounces). */
const TIMERS_AHEAD = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ID_TITLE = /^([A-Z][A-Z0-9]*-\d+)\s+(.*)$/;
const MARK = '#e4002b';

/** Visible label of an element, as a reader would name it: its <label>, else its own text. */
async function labelOf(loc: Locator): Promise<string> {
	return loc.evaluate((el: Element) => {
		const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
		const id = (el as HTMLElement).id;
		const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
		if (forLabel && clean(forLabel.textContent)) return clean(forLabel.textContent);
		// A field inside its <label> (<label>Title <input></label>): the label's own words.
		const wrapping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ? el.closest('label') : null;
		if (wrapping && clean(wrapping.textContent)) return clean(wrapping.textContent);
		const own = clean((el as HTMLElement).innerText);
		const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.querySelector('input, textarea, select');
		const prev = el.previousElementSibling;
		if ((isField || !own) && prev?.tagName === 'LABEL' && clean(prev.textContent)) return clean(prev.textContent);
		for (const a of ['aria-label', 'title', 'alt']) if (clean(el.getAttribute(a))) return clean(el.getAttribute(a));
		return own || clean(el.getAttribute('placeholder')) || clean(el.textContent);
	});
}

/** True when the label is not on screen: it came from text the page hides (an icon-only button). */
async function labelHidden(loc: Locator, label: string): Promise<boolean> {
	return !!label && loc.evaluate((el: Element, l: string) => {
		const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
		return !clean((el as HTMLElement).innerText) && clean(el.textContent) === l && !el.querySelector('input, textarea, select');
	}, label);
}

class Recorder {
	steps: { text: string; startedAt: string; endedAt?: string; actions: ActionRecord[] }[] = [];
	private current: (typeof this.steps)[number] | null = null;
	private screenName: string | null = null;
	private n = 0;
	productVersion: string | null = null;
	readonly started = Date.now();

	private inflight = new Set<Request>();
	private lastNetwork = Date.now();

	constructor(private page: Page, readonly dir: string, private version: LmOptions['lmVersion'], readonly narrator: Narrator | null = null, private clockInstalled = false) {
		const seen = () => { this.lastNetwork = Date.now(); };
		page.on('request', (r) => { this.inflight.add(r); seen(); });
		page.on('requestfinished', (r) => { this.inflight.delete(r); seen(); });
		page.on('requestfailed', (r) => { this.inflight.delete(r); seen(); });
	}

	/**
	 * Waits until the page has had no request in flight for QUIET ms (at most SETTLE_MAX), so an
	 * action reads and shoots the page after what the last one started has come back.
	 */
	async settle() {
		for (const end = Date.now() + SETTLE_MAX; Date.now() < end; await sleep(25)) {
			if (!this.inflight.size && Date.now() - this.lastNetwork >= QUIET) return;
		}
	}

	/** A screenshot taken again until two in a row are the same (at most SETTLE_MAX): the page has stopped changing. */
	private async stableScreenshot() {
		const take = () => this.page.screenshot({ animations: 'disabled', caret: 'hide' });
		let last = await take();
		for (const end = Date.now() + SETTLE_MAX; Date.now() < end; ) {
			await sleep(STABLE_GAP);
			const next = await take();
			if (next.equals(last)) return next;
			last = next;
		}
		return last;
	}

	/** How deep in test.step we are: only the outermost (Gherkin) step opens a step record. */
	private depth = 0;
	beginStep(text: string) {
		if (this.depth++ > 0) return; // a test.step inside a Gherkin step belongs to that step
		this.current = { text, startedAt: new Date().toISOString(), actions: [] };
		this.steps.push(this.current);
	}
	endStep() {
		if (--this.depth > 0) return;
		this.depth = 0;
		if (this.current) this.current.endedAt = new Date().toISOString();
		this.current = null;
	}

	screen(name: string) { this.screenName = name; }

	/** Resolves a target: waits for any candidate, then takes the first strategy that matches. */
	async resolve(t: Target, within?: Locator) {
		const scope = within ?? this.page;
		const prefix = within ? `${String(within)}.` : '';
		const candidates: { strategy: Strategy; loc: Locator; expression: string }[] = [];
		const q = (s: string) => `'${s.replace(/'/g, "\\'")}'`;
		const nameExpr = (n: string | RegExp) => (typeof n === 'string' ? q(n) : String(n));
		if (t.testId) candidates.push({ strategy: 'testid', loc: scope.getByTestId(t.testId), expression: `getByTestId(${q(t.testId)})` });
		if (t.role && t.name !== undefined) candidates.push({ strategy: 'role', loc: scope.getByRole(t.role, { name: t.name, exact: typeof t.name === 'string' }), expression: `getByRole(${q(t.role)}, { name: ${nameExpr(t.name)} })` });
		if (t.text) candidates.push({ strategy: 'text', loc: scope.getByText(t.text, { exact: true }), expression: `getByText(${q(t.text)}, { exact: true })` });
		if (t.css) candidates.push({ strategy: 'css', loc: scope.locator(t.css), expression: `locator(${q(t.css)})` });
		if (!candidates.length) throw new Error(`lm: target names no element: ${JSON.stringify(t)}`);
		const any = candidates.map((c) => c.loc.first()).reduce((a, b) => a.or(b));
		await any.first().waitFor({ state: 'visible' });
		for (const c of candidates) if (await c.loc.first().isVisible()) return { ...c, loc: c.loc.first(), expression: prefix + c.expression };
		const c = candidates[0];
		return { ...c, loc: c.loc.first(), expression: prefix + c.expression };
	}

	private async readVersion() {
		if (this.productVersion || !this.version) return;
		const el = this.page.locator(this.version.css).first();
		if (!(await el.count())) return;
		const text = ((await el.textContent()) ?? '').trim();
		const m = this.version.pattern ? new RegExp(this.version.pattern).exec(text) : null;
		this.productVersion = m ? (m[1] ?? m[0]) : text || null;
	}

	/**
	 * Screenshot with a frame drawn round `loc`; returns the file (relative to the run folder) and box.
	 * The frame is drawn into the picture, not the page: an element added to the page changed how
	 * Chromium composited a rounded dialog behind it, and the shot's corners then differed between
	 * runs (ORDER-02, ticket 06).
	 */
	private async shot(loc: Locator) {
		// The pointer rests on the element being marked, so what is drawn hovered is always the same:
		// left where the previous click put it, a field that moved under it was hovered in some runs
		// and not in others (seen in the first product's Test 1). force: no actionability wait; an element
		// the pointer cannot reach is shot as it is.
		await loc.hover({ force: true, timeout: 2000 }).catch(() => {});
		const box = await loc.boundingBox();
		const file = `shots/${String(this.steps.length).padStart(2, '0')}-${String(this.n).padStart(2, '0')}.png`;
		// What a user sees after a moment's pause: a search that filters as you type waits for a pause
		// (a timer, not a request) and the network wait cannot see it. Ticket 06: ORDER-03's search shot
		// showed the old count about one run in five. The fixed clock runs those timers now.
		if (this.clockInstalled) await this.page.clock.runFor(TIMERS_AHEAD);
		await this.settle();
		const png = await this.stableScreenshot();
		writeFileSync(join(this.dir, file), box ? drawFrame(png, box, MARK) : png);
		return { file, box };
	}

	async act(kind: ActionRecord['kind'], target: Target, opts: ActionOptions, perform: (r: { loc: Locator; mark: (l: Locator) => Promise<void> }) => Promise<Partial<ActionRecord> | void>) {
		if (!this.current) throw new Error('lm: actions must run inside test.step(<step text>)');
		const startedAt = new Date();
		this.n++;
		if (opts.screen) this.screenName = opts.screen;
		await this.settle();
		const r = await this.resolve(target, opts.within);
		await this.readVersion();
		let shot: { file: string; box: Box | null } | null = null;
		// A video run shoots nothing: the recording is the picture.
		const mark = async (l: Locator) => { shot = this.narrator ? { file: '', box: await l.boundingBox() } : await this.shot(l); };
		const pageLabel = await labelOf(r.loc);
		const hidden = await labelHidden(r.loc, pageLabel);
		const at = [this.steps.length - 1, this.current.actions.length] as const;
		if (this.narrator) await this.narrator.before(at[0], at[1], r.loc);
		const actionStart = videoNow();
		const extra = (await perform({ loc: r.loc, mark })) ?? {};
		this.narrator?.action(at[0], at[1], kind, (extra.label ?? pageLabel) || opts.describe || '', actionStart);
		const label = (extra.label ?? pageLabel) || opts.describe || '';
		const endedAt = new Date();
		const rec: ActionRecord = {
			n: this.n,
			kind,
			screen: this.screenName,
			locator: { strategy: r.strategy, expression: r.expression, testIdTried: target.testId ?? null },
			// What the action returned (value, option) first: the label worked out above, with its
			// fallback to the author's description, must not be overwritten by an empty page label.
			...extra,
			label,
			labelSource: (extra.label ?? pageLabel) ? 'page' : 'author',
			labelVisible: !(extra.label === undefined && hidden),
			dataSpecific: !!opts.dataSpecific,
			languageBound: [r.strategy, extra.option?.strategy].some((x) => x === 'role' || x === 'text'),
			missingTestId: r.strategy !== 'testid' || (!!extra.option && extra.option.strategy !== 'testid'),
			screenshot: shot!.file,
			box: shot!.box,
			url: this.page.url(),
			startedAt: startedAt.toISOString(),
			endedAt: endedAt.toISOString(),
			startMs: startedAt.getTime() - this.started,
			endMs: endedAt.getTime() - this.started,
		};
		this.current.actions.push(rec);
		return rec;
	}

	write(info: TestInfo, product: string) {
		const m = ID_TITLE.exec(info.title);
		const ann = (type: string) => info.annotations.find((a) => a.type === type)?.description ?? null;
		const record = {
			kind: 'living-manual/step-record',
			version: 1,
			product,
			productVersion: this.productVersion,
			scenario: { id: m?.[1] ?? null, title: m?.[2] ?? info.title, role: ann('role'), startScreen: ann('start screen'), tags: info.tags, spec: info.file },
			run: { startedAt: new Date(this.started).toISOString(), endedAt: new Date().toISOString(), status: info.status, error: info.error?.message?.split('\n')[0] ?? null },
			steps: this.steps,
		};
		writeFileSync(join(this.dir, 'step-record.json'), JSON.stringify(record, null, '\t') + '\n');
	}
}

let active: Recorder | null = null;

export type Lm = {
	screen(name: string): void;
	click(target: Target, opts?: ActionOptions): Promise<ActionRecord>;
	fill(target: Target, value: string, opts?: ActionOptions): Promise<ActionRecord>;
	select(trigger: Target, option: Target, opts?: ActionOptions & { optionWithin?: Locator }): Promise<ActionRecord>;
	check(target: Target, opts?: ActionOptions): Promise<ActionRecord>;
	see(target: Target, opts?: ActionOptions): Promise<ActionRecord>;
};

/** Runs one of the product's environment commands; throws with its output when it fails. */
export function environmentCommand(env: LmOptions['lmEnvironment'], which: 'reset' | 'verify') {
	const command = env[which];
	if (!command) return;
	const r = spawnSync(command, { cwd: env.root, shell: '/bin/sh', encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`lm: ${which} failed before the scenario (exit ${r.status}): ${command}\n${r.stdout}${r.stderr}`);
	const last = `${r.stdout}`.trim().split('\n').pop();
	if (last) process.stdout.write(`  before the scenario: ${last}\n`);
}

/**
 * True once per `lm-env run --fresh`: the gate has just reset and verified the data, so the first
 * scenario need not do it again. Removing the token file is atomic, so only one scenario takes it.
 */
function takeFreshToken() {
	const token = process.env.LM_FRESH_TOKEN;
	if (!token) return false;
	try { unlinkSync(token); return true; } catch { return false; }
}

const extended = base.extend<LmOptions & { lm: Lm; lmFresh: void }>({
	lmBuildDir: ['build', { option: true }],
	lmProduct: ['product', { option: true }],
	lmVersion: [null, { option: true }],
	lmCookies: [[], { option: true }],
	lmEnvironment: [{ root: '.', reset: null, verify: null }, { option: true }],
	// Repeatable runs: every scenario starts from the demo data. The reset runs before the browser
	// context exists, then verify, so a scenario never sees what another one changed.
	lmFresh: [async ({ lmEnvironment }, use) => {
		if (takeFreshToken()) process.stdout.write('  before the scenario: reset and verified by the run gate (lm-env run --fresh)\n');
		else {
			environmentCommand(lmEnvironment, 'reset');
			environmentCommand(lmEnvironment, 'verify');
		}
		await use();
	}, { auto: true, timeout: 120_000 }],
	lmClock: [null, { option: true }],
	lmVideo: [null, { option: true }],
	context: async ({ context, lmCookies, lmClock, lmFresh, lmVideo }, use) => {
		void lmFresh; // named so the reset runs before the context is used
		if (lmCookies.length) await context.addCookies(lmCookies);
		// Every run starts at the same moment and time then flows as usual (a frozen Date stops
		// jQuery-style animations, which measure elapsed time), so dates in the product do not move.
		if (lmClock) await context.clock.install({ time: new Date(lmClock) });
		await context.addInitScript(STILL);
		if (lmVideo) {
			await context.addInitScript(POINTER_SCRIPT);
			context.on('page', () => { videoStart ||= Date.now(); });
			videoStart = 0;
		}
		await use(context);
	},
	lm: async ({ page, lmBuildDir, lmProduct, lmVersion, lmVideo, lmClock }, use, info) => {
		const id = ID_TITLE.exec(info.title)?.[1] ?? info.titlePath.join(' ').replace(/[^\w-]+/g, '_');
		const dir = lmVideo ? lmVideo.dir : join(lmBuildDir, 'runs', id);
		// The scenario's previous run moves to build/previous/<ID>, for lm-compare.
		const previous = join(lmBuildDir, 'previous', id);
		if (!lmVideo && existsSync(join(dir, 'step-record.json'))) {
			rmSync(previous, { recursive: true, force: true });
			mkdirSync(join(lmBuildDir, 'previous'), { recursive: true });
			renameSync(dir, previous);
		}
		// (a video run's folder also holds Playwright's output, recording in progress: lm-video empties it)
		if (!lmVideo) rmSync(dir, { recursive: true, force: true });
		mkdirSync(join(dir, 'shots'), { recursive: true });
		const narrator = lmVideo ? new Narrator(page, lmVideo.plan) : null;
		const rec = new Recorder(page, dir, lmVersion, narrator, !!lmClock);
		active = rec;
		const fillable = async (loc: Locator) =>
			(await loc.evaluate((el) => ['INPUT', 'TEXTAREA'].includes(el.tagName) || (el as HTMLElement).isContentEditable)) ? loc : loc.locator('input, textarea').first();
		await use({
			screen: (name) => rec.screen(name),
			click: (t, o = {}) => rec.act('click', t, o, async ({ loc, mark }) => { await mark(loc); await loc.click(); }),
			check: (t, o = {}) => rec.act('check', t, o, async ({ loc, mark }) => { await mark(loc); await loc.check(); }),
			fill: (t, value, o = {}) => rec.act('fill', t, o, async ({ loc, mark }) => {
				const input = await fillable(loc);
				if (narrator) {
					// On video the viewer sees the field clicked and the text typed.
					await input.click();
					await input.fill('');
					await input.pressSequentially(value, { delay: 45 });
				} else if (o.keys) {
					// Key by key, for masked inputs that read keypresses (a date field's text box).
					await input.click();
					await input.press('ControlOrMeta+A');
					await input.pressSequentially(value);
				} else await input.fill(value);
				await mark(loc);
				if (o.commit) await input.press(o.commit);
				return { value };
			}),
			select: (trigger, option, o = {}) => rec.act('select', trigger, o, async ({ loc, mark }) => {
				const label = await labelOf(loc);
				if (await loc.evaluate((el) => el.tagName === 'SELECT')) {
					// A native <select> cannot be shown open in a screenshot: mark the field, then choose.
					const value = option.text ?? String(option.name ?? '');
					await mark(loc);
					await loc.selectOption({ label: value });
					return { label, value };
				}
				await loc.click();
				const opt = await rec.resolve(option, o.optionWithin);
				const value = await labelOf(opt.loc);
				await mark(opt.loc);
				await opt.loc.click();
				return { label, value, option: { strategy: opt.strategy, expression: opt.expression } };
			}),
			see: (t, o = {}) => rec.act('verify', t, o, async ({ loc, mark }) => { await expect(loc).toBeVisible(); await mark(loc); }),
		});
		if (narrator) {
			if (info.status === 'passed') await narrator.end();
			const vp = page.viewportSize();
			writeFileSync(join(dir, 'timeline.json'), JSON.stringify({
				kind: 'living-manual/video-timeline', scenario: { id, title: ID_TITLE.exec(info.title)?.[2] ?? info.title }, viewport: vp,
				recordingStartedAt: new Date(videoStart).toISOString(), closedAt: videoNow(), events: narrator.events,
			}, null, '\t') + '\n');
		}
		rec.write(info, lmProduct);
		active = null;
		if (narrator) {
			// The recording ends when the page closes; keep it in the video folder.
			const video = page.video();
			await page.close();
			if (video) await video.saveAs(join(dir, 'recording.webm'));
			else writeFileSync(join(dir, 'no-recording.txt'), 'the context recorded no video\n');
		}
	},
});

const originalStep = extended.step.bind(extended);
/** test.step, which also opens the step in the step record. Its title is the Gherkin step text. */
const step = ((title: string, body: (s: any) => any, options?: any) =>
	originalStep(title, async (s: any) => {
		active?.beginStep(title);
		try { return await body(s); } finally { active?.endStep(); }
	}, options)) as typeof extended.step;
Object.assign(step, { skip: extended.step.skip });

export const test = extended;
(test as any).step = step;
