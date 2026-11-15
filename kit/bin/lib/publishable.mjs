// The draft/confirmed split (spec: Confirmation): which manual pages may be published. The site
// build calls isPublishable for every page and nothing else; drafts go only to the preview.
//
// A scenario counts as confirmed only when the confirmation model (bin/lib/confirmation.mjs) says
// so: the writer confirmed it and its fingerprint still matches. A broken (lapsed) scenario is
// not publishable either; lm-publish keeps its last published page instead.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontMatter } from './prose.mjs';
import { scenarioState } from './confirmation.mjs';

/** True when the scenario is confirmed and its confirmation has not lapsed. */
export function scenarioConfirmed(folder, scenarioId) {
	return scenarioState(folder, scenarioId).status === 'confirmed';
}

/** True when the writer has marked the prose file confirmed (front matter `status: confirmed`). */
function proseConfirmed(folder, prose) {
	const file = join(folder, prose);
	return existsSync(file) && frontMatter(readFileSync(file, 'utf8')).data.status === 'confirmed';
}

/**
 * True when a page of the manual may be published. `page` is an entry of manual.json: a page made
 * from a scenario (`scenario`) is publishable when the scenario is confirmed, and a @manual
 * scenario's page also needs its prose confirmed; a page made only from prose (why, reference)
 * when its prose file is confirmed.
 */
export function isPublishable(folder, page) {
	if (page.scenario && !scenarioConfirmed(folder, page.scenario)) return false;
	if (page.prose && !proseConfirmed(folder, page.prose)) return false;
	return Boolean(page.scenario || page.prose);
}
