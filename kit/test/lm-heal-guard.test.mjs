// The healer's limits (spec: From scenario to test code, Healer): a repair may change locators and
// waits, nothing else. lm-heal-guard compares a spec before and after the healer touched it and
// says which it was. Tested at the CLI seam on fixture diffs: a spec, an edited copy, the verdict
// line and the exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bin } from './manual-fixture.mjs';

const SPEC = `import { test, expect } from '../../../kit/src/index.ts';

const NAME = 'Blue';

async function openList(page, lm) {
	await page.goto('list.html');
	lm.screen('Widget list');
	await lm.click({ css: '.menu [data-name="WIDGETS"]' });
	await expect(page.locator('#list')).toBeVisible();
}

test('WIDGET-01 Register a new widget', { tag: '@doc' }, async ({ page, lm }) => {
	await test.step('I am on the widget list', async () => {
		await openList(page, lm);
	});

	await test.step('I start a new widget', async () => {
		lm.screen('Widget list');
		await lm.click({ testId: 'widget-new', role: 'button', name: 'New widget' });
		await lm.select({ testId: 'widget-type' }, { role: 'option', name: 'Round' }, { dataSpecific: true });
	});

	await test.step('I name the widget "Blue"', async () => {
		await lm.fill({ testId: 'widget-name' }, NAME, { commit: 'Enter' });
		await expect(page.getByTestId('widget-name')).toHaveAttribute('data-value', NAME);
	});

	await test.step('I close the widget card', async () => {
		await lm.click({ css: '.card img.close' }, { describe: 'close button' });
		await expect(page.getByTestId('widget-name')).toBeHidden();
	});

	await test.step('the widget "Blue" is listed', async () => {
		await lm.see({ text: NAME }, { within: page.locator('#list') });
	});
});
`;

/** Runs the guard on SPEC and SPEC with each [from, to] replaced (each must occur). */
function guard(...edits) {
	let after = SPEC;
	for (const [from, to] of edits) {
		assert.ok(after.includes(from), `fixture edit not found: ${from}`);
		after = after.replace(from, to);
	}
	const dir = mkdtempSync(join(tmpdir(), 'lm-guard-'));
	writeFileSync(join(dir, 'before.spec.ts'), SPEC);
	writeFileSync(join(dir, 'after.spec.ts'), after);
	const r = spawnSync(process.execPath, [bin('lm-heal-guard.mjs'), join(dir, 'before.spec.ts'), join(dir, 'after.spec.ts')], { encoding: 'utf8' });
	return { status: r.status, out: r.stdout + r.stderr };
}
const accepted = (r) => { assert.equal(r.status, 0, r.out); assert.match(r.out, /^guard: locator\/wait only/m); };
const rejected = (r, reason) => { assert.equal(r.status, 1, r.out); assert.match(r.out, /^guard: behaviour change/m); assert.match(r.out, reason); };

test('a spec the healer left as it was is no change', () => {
	const r = guard();
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /^guard: no change$/m);
});

test('a moved or renamed target is a locator repair', () => {
	accepted(guard(
		[`{ css: '.card img.close' }`, `{ testId: 'widget-close', css: '.card button.close' }`],
		[`name: 'New widget' }`, `name: 'Add widget' }`],
		[`page.locator('#list')).toBeVisible()`, `page.locator('#widgets')).toBeVisible()`],
	));
});

test('a longer or an added wait is a wait repair', () => {
	accepted(guard(
		[`toBeVisible();\n}`, `toBeVisible({ timeout: 30_000 });\n}`],
		[`await lm.click({ testId: 'widget-new'`, `await page.waitForTimeout(500);\n\t\tawait expect(page.getByTestId('widget-new')).toBeVisible();\n\t\tawait lm.click({ testId: 'widget-new'`],
	));
});

// Review finding 1: an outcome check written as expect(…).toBeVisible/Hidden() has no expected
// value, but it is still an assertion. Only an added positive wait is free.
test('an inverted or deleted outcome assertion is a behaviour change, even without an expected value', () => {
	rejected(guard([`expect(page.getByTestId('widget-name')).toBeHidden()`, `expect(page.getByTestId('widget-name')).not.toBeHidden()`]),
		/assertion changed in step "I close the widget card"/);
	rejected(guard([`expect(page.getByTestId('widget-name')).toBeHidden()`, `expect(page.getByTestId('widget-name')).toBeVisible()`]),
		/assertion changed in step "I close the widget card"/);
	rejected(guard([`\t\tawait expect(page.getByTestId('widget-name')).toBeHidden();\n`, '']),
		/assertion removed in step "I close the widget card"/);
	rejected(guard([`await expect(page.locator('#list')).toBeVisible();\n}`, `\n}`]), /assertion removed in openList/);
});

test('an added negated check is not a wait', () => {
	rejected(guard([`await lm.click({ testId: 'widget-new'`, `await expect(page.getByText('Error')).not.toBeVisible();\n\t\tawait lm.click({ testId: 'widget-new'`]),
		/assertion added in step "I start a new widget"/);
});

test('the subject of an assertion may be found another way, its expected value may not change', () => {
	accepted(guard([`expect(page.getByTestId('widget-name')).toHaveAttribute`, `expect(page.locator('#name')).toHaveAttribute`]));
	rejected(guard([`toHaveAttribute('data-value', NAME)`, `toHaveAttribute('data-value', 'Blue widget')`]), /assertion changed in step "I name the widget "Blue""/);
});

test('an added action is a behaviour change, named with its step', () => {
	rejected(guard([`{ describe: 'close button' });`, `{ describe: 'close button' });\n\t\tawait lm.click({ role: 'button', name: 'Close card' });`]),
		/action added in step "I close the widget card": lm\.click/);
});

test('a removed action is a behaviour change', () => {
	rejected(guard([`\t\tawait lm.select({ testId: 'widget-type' }, { role: 'option', name: 'Round' }, { dataSpecific: true });\n`, '']),
		/action removed in step "I start a new widget": lm\.select/);
});

test('reordered actions are a behaviour change', () => {
	const click = `\t\tawait lm.click({ testId: 'widget-new', role: 'button', name: 'New widget' });\n`;
	const select = `\t\tawait lm.select({ testId: 'widget-type' }, { role: 'option', name: 'Round' }, { dataSpecific: true });\n`;
	rejected(guard([click + select, select + click]), /actions reordered in step "I start a new widget"/);
});

test('a changed filled value, chosen option or final check is a behaviour change', () => {
	rejected(guard([`NAME, { commit: 'Enter' }`, `'Green', { commit: 'Enter' }`]), /action changed in step "I name the widget "Blue"": lm\.fill/);
	rejected(guard([`{ role: 'option', name: 'Round' }`, `{ role: 'option', name: 'Square' }`]), /action changed in step "I start a new widget": lm\.select/);
	rejected(guard([`lm.see({ text: NAME }`, `lm.see({ text: 'Blue widget' }`]), /action changed in step "the widget "Blue" is listed": lm\.see/);
});

test('an action added inside a helper the steps call is a behaviour change too', () => {
	rejected(guard([`await expect(page.locator('#list')).toBeVisible();\n}`, `await expect(page.locator('#list')).toBeVisible();\n\tawait lm.click({ text: 'Accept cookies' });\n}`]),
		/action added in openList: lm\.click/);
});

test('a changed step title is a behaviour change', () => {
	rejected(guard([`test.step('I start a new widget'`, `test.step('I start a widget'`]), /step title changed/);
});
