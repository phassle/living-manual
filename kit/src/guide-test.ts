// The kit's test API for guide tests (spec: Testing Decisions, the browser seam; Test 2). A guide
// test drives the product with the guide script loaded, as a user would, and checks what the user
// sees: the help panel, the highlight and the guide's words. It imports { test, expect, guide }
// from here; the <product>-guide Playwright project (playwright.config.ts) supplies the options.
//
// Before every test the product's reset and verify run (a guide walk creates records, like a doc
// scenario). Once per worker the guide is built (lm-build-guide, with drafts when lmGuide says so),
// the manual pages and preview are built (lm-manual, lm-publish: the closest-page link opens one),
// and the guide's origin is served as lm-guide-serve serves it (bin/lib/guide-setup.mjs: proxy,
// script, manual, question endpoint) unless something already listens on the guide port.
// Fixtures: guide.open(), guide.help(), guide.choose(title), guide.ask(question), guide.highlight,
// guide.panel, guide.instruction, guide.message, guide.question, guide.manualLink; expectHighlighted(highlight, target); guideCalls(page) lists
// every dispatchEvent/click/focus/value write/submit made by the guide script itself.
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { environmentCommand, type LmOptions } from './index.ts';
// @ts-ignore: a plain ES module of the kit
import { startGuideServer } from '../bin/lib/guide-server.mjs';
// @ts-ignore: a plain ES module of the kit
import { guideServerOptions } from '../bin/lib/guide-setup.mjs';

export { expect };

export type GuideOptions = {
	lmCookies: LmOptions['lmCookies'];
	lmEnvironment: LmOptions['lmEnvironment'];
	lmGuide: { product: string; port: number; upstream: string; basePath: string; role: string | null; includeDrafts: boolean } | null;
};

/**
 * Watches, from before any page script runs, every call that could act on the product:
 * EventTarget.dispatchEvent, HTMLElement.click and focus, form submit and requestSubmit, and
 * writes to an input's value or checked. A call counts as the guide's when the guide script is on
 * the call stack. The product's own calls are not counted.
 */
const WATCH = `(() => {
	const calls = window.__lmGuideCalls = [];
	const fromGuide = () => /lm-guide\\.js/.test(new Error().stack || '');
	const wrap = (proto, name) => {
		const orig = proto[name];
		proto[name] = function (...args) {
			if (fromGuide()) calls.push(name + (args[0] && args[0].type ? ':' + args[0].type : ''));
			return orig.apply(this, args);
		};
	};
	wrap(EventTarget.prototype, 'dispatchEvent');
	wrap(HTMLElement.prototype, 'click');
	wrap(HTMLElement.prototype, 'focus');
	wrap(HTMLFormElement.prototype, 'submit');
	wrap(HTMLFormElement.prototype, 'requestSubmit');
	for (const [proto, prop] of [[HTMLInputElement.prototype, 'value'], [HTMLInputElement.prototype, 'checked'], [HTMLTextAreaElement.prototype, 'value'], [HTMLSelectElement.prototype, 'value']]) {
		const d = Object.getOwnPropertyDescriptor(proto, prop);
		Object.defineProperty(proto, prop, { ...d, set(v) { if (fromGuide()) calls.push('set ' + prop); return d.set.call(this, v); } });
	}
})();`;

/** Every call the guide script made that could act on the product (see WATCH). */
export const guideCalls = (page: Page) => page.evaluate(() => (window as any).__lmGuideCalls as string[]);

/** Passes when the guide's highlight covers the target element. */
export async function expectHighlighted(highlight: Locator, target: Locator) {
	await expect(highlight).toBeVisible();
	await expect(async () => {
		const h = await highlight.boundingBox();
		const t = await target.first().boundingBox();
		expect(h && t, 'both are on screen').toBeTruthy();
		expect(h!.x).toBeLessThanOrEqual(t!.x + 1);
		expect(h!.y).toBeLessThanOrEqual(t!.y + 1);
		expect(h!.x + h!.width).toBeGreaterThanOrEqual(t!.x + t!.width - 1);
		expect(h!.y + h!.height).toBeGreaterThanOrEqual(t!.y + t!.height - 1);
		expect(h!.width).toBeLessThan(t!.width + 40);
	}).toPass({ timeout: 15_000 });
}

export type Guide = {
	page: Page;
	help: Locator;
	panel: Locator;
	highlight: Locator;
	instruction: Locator;
	message: Locator;
	/** The guide's own "Done, next" button (shown for an action the guide does not mark). */
	next: Locator;
	/** Opens the product's address (relative to the guide origin's base path). */
	open(path?: string): Promise<void>;
	/** Opens the help panel and chooses a scenario by its title. */
	choose(title: string): Promise<void>;
	/** The panel's question box. */
	question: Locator;
	/** The link to the closest manual page, shown with the no-answer message. */
	manualLink: Locator;
	/** Opens the help panel (when closed), types the question and asks it. */
	ask(question: string): Promise<void>;
};

let server: Server | null = null;

export const test = base.extend<GuideOptions & { guide: Guide; guideFresh: void }, { guideBuilt: void }>({
	lmCookies: [[], { option: true }],
	lmEnvironment: [{ root: '.', reset: null, verify: null }, { option: true }],
	lmGuide: [null, { option: true }],
	guideBuilt: [async ({}, use, info) => {
		const g = info.project.use as any as GuideOptions;
		const opts = g.lmGuide!;
		const root = g.lmEnvironment.root;
		const r = spawnSync(process.execPath, [join(root, 'living-manual/kit/bin/lm-build-guide.mjs'), opts.product, ...(opts.includeDrafts ? ['--include-drafts'] : [])], { cwd: root, encoding: 'utf8' });
		if (r.status !== 0) throw new Error(`lm-build-guide failed:\n${r.stdout}${r.stderr}`);
		process.stdout.write(`  guide: ${r.stdout.split('\n').find((l) => l.startsWith('guide:'))}\n`);
		for (const cmd of ['lm-manual.mjs', 'lm-publish.mjs']) {
			const m = spawnSync(process.execPath, [join(root, 'living-manual/kit/bin', cmd), opts.product], { cwd: root, encoding: 'utf8' });
			if (m.status !== 0) throw new Error(`${cmd} failed:\n${m.stdout}${m.stderr}`);
		}
		const listening = await fetch(`http://127.0.0.1:${opts.port}/lm-guide/guide-index.json`).then((x) => x.ok, () => false);
		if (!listening) {
			const o = guideServerOptions(root, opts.product, { includeDrafts: opts.includeDrafts, log: (line: string) => process.stdout.write(`  ${line}\n`) });
			if (o.model) process.stdout.write(`  guide: questions matched by ${o.model.model} (${o.model.kind})\n`);
			server = await startGuideServer(o);
		}
		await use();
		server?.close();
		server = null;
	}, { scope: 'worker', auto: true, timeout: 60_000 }],
	guideFresh: [async ({ lmEnvironment }, use) => {
		environmentCommand(lmEnvironment, 'reset');
		environmentCommand(lmEnvironment, 'verify');
		await use();
	}, { auto: true, timeout: 120_000 }],
	context: async ({ context, lmCookies, guideFresh }, use) => {
		void guideFresh;
		if (lmCookies.length) await context.addCookies(lmCookies);
		await context.addInitScript(WATCH);
		await use(context);
	},
	guide: async ({ page }, use) => {
		const g: Guide = {
			page,
			help: page.getByTestId('lm-guide-help'),
			panel: page.getByTestId('lm-guide-panel'),
			highlight: page.getByTestId('lm-guide-highlight'),
			instruction: page.getByTestId('lm-guide-instruction'),
			message: page.getByTestId('lm-guide-message'),
			next: page.getByTestId('lm-guide-next'),
			open: async (path = '') => { await page.goto(path); },
			choose: async (title) => {
				await g.help.click();
				await g.panel.getByRole('button', { name: title }).click();
			},
			question: page.getByTestId('lm-guide-question'),
			manualLink: page.getByTestId('lm-guide-manual-link'),
			ask: async (question) => {
				if (await g.help.isVisible()) await g.help.click();
				await g.question.fill(question);
				await page.getByTestId('lm-guide-ask').click();
			},
		};
		await use(g);
	},
});
