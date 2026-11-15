// Manual reader story 40: a user finds a task by their own words. The built site, opened from disk
// in a browser: typing in the header lists matching pages as you type; the search page lists them
// with the words marked; a draft never turns up in the published site's search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { bin, manualProduct } from './manual-fixture.mjs';

test('the site finds pages by the reader\'s own words', async () => {
	const { root, folder } = manualProduct({ confirmed: ['WIDGET-01'] });
	for (const cli of ['lm-manual.mjs', 'lm-publish.mjs']) {
		const r = spawnSync(process.execPath, [bin(cli), '--folder', folder], { encoding: 'utf8' });
		assert.equal(r.status, 0, r.stdout + r.stderr);
	}
	const site = (f) => pathToFileURL(join(folder, 'build/site', f)).href;
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.goto(site('index.html'));
		await page.locator('[data-search-input]').fill('registering widgets');
		const pop = page.locator('[data-search-pop]');
		await pop.waitFor();
		assert.equal(await pop.locator('a').first().locator('.r-name').innerText(), 'Register a new widget');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await page.waitForURL(/register-a-widget\.html$/);

		await page.goto(`${site('search.html')}?q=gears`);
		const first = page.locator('[data-results] li').first();
		assert.match(await first.innerText(), /What a widget is/);
		assert.equal(await first.locator('mark').first().innerText(), 'gears');

		await page.goto(`${site('search.html')}?q=print%20label`);
		assert.equal(await page.locator('[data-results] li').count(), 0, 'the draft @manual page is not in the published site');
		assert.match(await page.locator('[data-results-count]').innerText(), /No page matches/);
	} finally {
		await browser.close();
		rmSync(root, { recursive: true });
	}
});
