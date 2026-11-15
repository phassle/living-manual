// What the guide's origin serves for one product of a workspace (bin/lm-guide-serve.mjs and the
// guide tests, src/guide-test.ts, start the same thing): the proxy in front of the product, the
// guide script and index, the built manual at /lm-manual/, and, when the product's guide section
// names guide.match and guide.session, the question endpoint (bin/lib/guide-match.mjs) with its
// model (bin/lib/guide-model.mjs; the key is read from this process's environment).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { productConfig, productFolder } from './workspace.mjs';
import { MANUAL_PREFIX } from './guide-server.mjs';
import { createMatchHandler, manualPages, sessionCheck } from './guide-match.mjs';
import { modelFor } from './guide-model.mjs';

/**
 * Options for startGuideServer, plus { model } (the model client, or null without an endpoint).
 * includeDrafts serves the manual preview (drafts included) instead of the published site.
 */
export function guideServerOptions(root, product, { includeDrafts = false, env = process.env, log = (line) => console.log(line) } = {}) {
	const section = productConfig(root, product);
	const guide = section.guide ?? {};
	const folder = productFolder(root, product);
	const guideDir = join(folder, 'build/guide');
	const manualDir = join(folder, includeDrafts ? 'build/preview' : 'build/site');
	const base = new URL(section.environment.baseUrl);
	let match = null, model = null;
	if (guide.match && guide.session) {
		model = modelFor({ id: guide.match.model, keyEnv: guide.match.keyEnv, cli: guide.match.cli }, env);
		match = createMatchHandler({
			guideDir, model: model.ask, session: sessionCheck(guide.session),
			pages: () => manualPages(join(folder, 'build/manual/manual.json'), manualDir, MANUAL_PREFIX),
			manualHome: existsSync(join(manualDir, 'index.html')) ? { title: 'The manual', url: `${MANUAL_PREFIX}index.html` } : null,
			unanswered: join(guideDir, 'unanswered.jsonl'),
			log,
		});
	}
	return {
		port: guide.port, upstream: base.origin, basePath: base.pathname, guideDir, manualDir,
		config: { role: guide.role ?? null }, match, model,
	};
}
