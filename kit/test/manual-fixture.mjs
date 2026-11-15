// A fixture product folder for the manual and site tests: one feature "widget" with a run doc
// scenario (WIDGET-01, with a passed step record), a @manual one (WIDGET-09), a prose file and a
// page plan. Each piece can be overridden, so a test changes only what it is about.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const bin = (name) => join(KIT, 'bin', name);
// A 1×1 white PNG stands in for a screenshot.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');

const action = (n, kind, label, extra = {}) => ({
	n, kind, screen: 'Widget list', label, labelSource: 'page', dataSpecific: false, languageBound: false, missingTestId: false,
	locator: { strategy: 'testid', expression: `getByTestId('w-${n}')` }, screenshot: `shots/01-0${n}.png`, box: { x: 1, y: 1, width: 1, height: 1 },
	startedAt: '2026-11-15T10:00:00.000Z', endedAt: '2026-11-15T10:00:01.000Z', ...extra,
});

export const RECORD = {
	kind: 'living-manual/step-record', version: 1, product: 'Fixture', productVersion: '9.9.9',
	scenario: { id: 'WIDGET-01', title: 'Register a new widget', role: 'widget keeper', startScreen: 'widget list' },
	run: { startedAt: '2026-11-15T10:00:00.000Z', endedAt: '2026-11-15T10:00:09.000Z', status: 'passed' },
	steps: [
		{ text: 'I start a new widget', actions: [action(1, 'click', 'New widget')] },
		{ text: 'I name the widget "Blue"', actions: [
			action(2, 'select', 'Widget type:', { value: 'Round', screen: 'New widget form' }),
			action(3, 'fill', 'Widget name:', { value: 'Blue', screen: 'New widget form' }),
		] },
		{ text: 'the widget "Blue" is listed', actions: [action(4, 'verify', 'Blue', { dataSpecific: true })] },
	],
};

export const FEATURE = `@doc
Feature: Widgets

  @WIDGET-01 @draft
  Scenario: Register a new widget
    Given I am a widget keeper on the widget list
    When I start a new widget
    Then the widget "Blue" is listed

  @WIDGET-09 @manual @draft
  Scenario: Print a widget label
    Given I am a widget keeper on the widget card
    When I print the widget's label
    Then the printer prints the label
`;

export const PROSE = `---
feature: widget
status: confirmed
---

# Widgets

## What a widget is

A widget is a small round thing that keeps **gears** in place.

Widgets wear out after ten years.

## Widget fields

- **Widget type**: The shape of the widget. Round widgets fit every gear.
- **Widget name**: What the widget is called in the widget list.
- **Colour code**: A code the factory uses.

## Print a widget label

Labels are printed from the widget card.

1. Open the widget card.
2. Choose **Print label**.
`;

export const PLAN = {
	features: [{
		feature: 'widget', title: 'Widgets', prose: 'prose/widget.md',
		pages: [
			{ slug: 'what-a-widget-is', type: 'why', section: 'What a widget is' },
			{ slug: 'register-a-widget', type: 'how', scenario: 'WIDGET-01' },
			{ slug: 'print-a-widget-label', type: 'how', scenario: 'WIDGET-09', section: 'Print a widget label' },
			{ slug: 'widget-fields', type: 'reference', section: 'Widget fields', screens: ['New widget form'] },
		],
	}],
};

/**
 * A product folder (and, with `config`, a workspace around it whose product is "fixture").
 * Returns { root, folder }. Pass null for a piece to leave it out.
 */
export function manualProduct({ record = RECORD, feature = FEATURE, prose = PROSE, plan = PLAN, confirmed = undefined, config = null } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'lm-pages-'));
	const folder = join(root, 'living-manual/products/fixture');
	mkdirSync(join(folder, 'scenarios'), { recursive: true });
	mkdirSync(join(folder, 'prose'), { recursive: true });
	if (record) {
		const run = join(folder, 'build/runs', record.scenario.id);
		mkdirSync(join(run, 'shots'), { recursive: true });
		for (const s of record.steps) for (const a of s.actions) writeFileSync(join(run, a.screenshot), PNG);
		writeFileSync(join(run, 'step-record.json'), JSON.stringify(record));
	}
	if (feature) writeFileSync(join(folder, 'scenarios/widget.feature'), feature);
	if (prose) writeFileSync(join(folder, 'prose/widget.md'), prose);
	if (plan) writeFileSync(join(folder, 'page-plan.json'), JSON.stringify(plan));
	if (config) writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({ products: { fixture: config } }));
	// Confirmed scenarios go through the kit's own confirmation CLI, as the writer session does.
	for (const id of confirmed ?? []) {
		const r = spawnSync(process.execPath, [bin('lm-confirm.mjs'), '--folder', folder, 'confirm', id, '--by', 'Fixture writer'], { encoding: 'utf8' });
		if (r.status !== 0) throw new Error(`fixture: could not confirm ${id}: ${r.stdout}${r.stderr}`);
	}
	return { root, folder };
}
