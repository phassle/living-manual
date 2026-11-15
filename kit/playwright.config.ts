// The kit's own Playwright project. One Playwright project per product in the workspace config
// (living-manual/living-manual.config.json): tests from living-manual/products/<product>/tests,
// build output (step records, screenshots, test results) to living-manual/products/<product>/build.
// LM_WORKSPACE points the kit at another workspace root (the kit's own tests use a fixture one).
// Run doc scenarios through bin/lm-run.mjs, which checks parity and the environment first.
import { defineConfig, devices, type Project } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LmOptions } from './src/index.ts';

const KIT = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.LM_WORKSPACE ?? join(KIT, '../..'));
const config = JSON.parse(readFileSync(join(ROOT, 'living-manual/living-manual.config.json'), 'utf8'));

/** Only the selected projects (all when none is named on the command line). */
const selected = (product: string) => {
	const named = process.argv.flatMap((a, i) => a.startsWith('--project=') ? [a.slice(10)] : a === '--project' ? [process.argv[i + 1]] : []);
	return named.length === 0 || named.includes(product);
};

/** A secret, read from the environment variable the configuration names, when the run starts. */
function fromEnv(product: string, path: string, name: string): string {
	const value = process.env[name];
	if (value === undefined && selected(product)) throw new Error(`set environment variable ${name} (named by products.${product}.${path})`);
	return value ?? '';
}

// Video mode (bin/lm-video.mjs): the narrated, recorded run of one scenario. The recording is
// the configured window size; Playwright's output (the .webm) goes to <LM_VIDEO_DIR>/pw.
const VIDEO = process.env.LM_VIDEO_PLAN && process.env.LM_VIDEO_DIR ? { plan: process.env.LM_VIDEO_PLAN, dir: process.env.LM_VIDEO_DIR } : null;

const docProjects: Project<LmOptions>[] = Object.entries<any>(config.products ?? {}).map(([product, section]) => {
	const folder = join(ROOT, 'living-manual/products', product);
	const env = section.environment ?? {};
	const viewport = env.viewport ?? { width: 1440, height: 900 };
	const signIn = env.signIn;
	const cookies = signIn?.kind === 'cookie' ? [{
		name: signIn.cookie,
		value: signIn.valueEnv ? fromEnv(product, 'environment.signIn.valueEnv', signIn.valueEnv)
			: String(signIn.value).replace('{persona}', signIn.persona ?? ''),
		domain: signIn.domain,
		path: '/',
	}] : [];
	return {
		name: product,
		testDir: join(folder, 'tests'),
		outputDir: VIDEO ? join(VIDEO.dir, 'pw') : join(folder, 'build/test-results'),
		use: {
			...devices['Desktop Chrome'],
			baseURL: env.baseUrl,
			viewport,
			...(VIDEO ? { video: { mode: 'on' as const, size: viewport } } : {}),
			lmVideo: VIDEO,
			deviceScaleFactor: 1,
			// Same pixels on every run: software rendering, one colour profile, no partial or
			// runtime-optimised rasterisation (they vary anti-aliased edges by a shade between runs).
			launchOptions: { args: ['--disable-gpu', '--force-color-profile=srgb', '--disable-partial-raster', '--disable-skia-runtime-opts', '--font-render-hinting=none', '--disable-lcd-text', '--num-raster-threads=1', '--run-all-compositor-stages-before-draw', '--disable-threaded-animation', '--disable-checker-imaging'] },
			reducedMotion: 'reduce',
			locale: 'en-GB',
			// Repeatable runs: the configured fixed clock and its time zone (src/index.ts sets the clock).
			...(env.clock?.timezone ? { timezoneId: env.clock.timezone } : {}),
			lmClock: env.clock?.time ?? null,
			lmBuildDir: join(folder, 'build'),
			lmProduct: section.name ?? product,
			lmVersion: env.productVersion ?? null,
			lmCookies: cookies,
			lmEnvironment: { root: ROOT, reset: env.reset ?? null, verify: env.verify ?? null },
		},
	};
});

/** The cookies that sign the test persona in (environment.signIn). */
function signInCookies(product: string, signIn: any) {
	return signIn?.kind === 'cookie' ? [{
		name: signIn.cookie,
		value: signIn.valueEnv ? fromEnv(product, 'environment.signIn.valueEnv', signIn.valueEnv)
			: String(signIn.value).replace('{persona}', signIn.persona ?? ''),
		domain: signIn.domain,
		path: '/',
	}] : [];
}

/**
 * One guide project per product with a `guide` section: tests from
 * living-manual/products/<product>/guide-tests (src/guide-test.ts), against the product behind the
 * guide's own port with the guide script loaded (bin/lm-guide-serve.mjs, decisions/0002).
 * Drafts go into the index for these tests until scenarios can be confirmed (ticket 07).
 */
const guideProjects: Project<any>[] = Object.entries<any>(config.products ?? {}).filter(([, s]) => s.guide?.port).map(([product, section]) => {
	const folder = join(ROOT, 'living-manual/products', product);
	const env = section.environment ?? {};
	const base = new URL(env.baseUrl);
	return {
		name: `${product}-guide`,
		testDir: join(folder, 'guide-tests'),
		outputDir: join(folder, 'build/guide-test-results'),
		use: {
			...devices['Desktop Chrome'],
			baseURL: `http://localhost:${section.guide.port}${base.pathname}`,
			viewport: env.viewport ?? { width: 1440, height: 900 },
			locale: 'en-GB',
			// LM_GUIDE_VIDEO=1 records each guide test (evidence of the walk).
			video: process.env.LM_GUIDE_VIDEO ? { mode: 'on', size: { width: 1440, height: 900 } } : 'off',
			lmCookies: selected(`${product}-guide`) ? signInCookies(product, env.signIn) : [],
			lmEnvironment: { root: ROOT, reset: env.reset ?? null, verify: env.verify ?? null },
			lmGuide: { product, port: section.guide.port, upstream: base.origin, basePath: base.pathname, role: section.guide.role ?? null, includeDrafts: true },
		},
	};
});

const projects = [...docProjects, ...guideProjects];

export default defineConfig<LmOptions>({
	timeout: VIDEO ? 600_000 : 180_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	projects,
});
