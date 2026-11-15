#!/usr/bin/env node
// Serves the guide demonstration (spec: Guide; decision record 0002 of the first product): the running product
// at environment.baseUrl, behind its own port (guide.port), with the one line that loads the guide
// script added to the product's pages. Build the script and index first with lm-build-guide.
// The configuration object the line sets holds the role from guide.role (in a real product the
// product fills in the signed-in user's role).
//
// With guide.match and guide.session set it also serves the question endpoint, POST
// /lm-guide/match (bin/lib/guide-match.mjs): the session is checked with guide.session.validate,
// the model is guide.match.model, through the Anthropic SDK when the variable guide.match.keyEnv is
// set in this process's environment, otherwise through the local `claude` CLI (decisions/0004).
// The key is read here at run time and goes nowhere else. Unanswered questions are appended to
// build/guide/unanswered.jsonl (lm-issues after-run files them). The built manual is served at
// /lm-manual/ for the closest-page link: build/site, or with --include-drafts build/preview.
//
// usage: node living-manual/kit/bin/lm-guide-serve.mjs <product> [--include-drafts]
// Runs until stopped. Exit 2 usage or no guide built, 1 the port is taken.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { productConfig, workspaceRoot } from './lib/workspace.mjs';
import { startGuideServer } from './lib/guide-server.mjs';
import { guideServerOptions } from './lib/guide-setup.mjs';

const product = process.argv[2];
if (!product || product.startsWith('-')) { process.stderr.write('usage: lm-guide-serve.mjs <product> [--include-drafts]\n'); process.exit(2); }
const root = workspaceRoot();
const section = productConfig(root, product);
if (!section.guide?.port) { process.stderr.write(`lm-guide-serve: products.${product}.guide.port is not set\n`); process.exit(2); }
const opts = guideServerOptions(root, product, { includeDrafts: process.argv.includes('--include-drafts') });
if (!existsSync(join(opts.guideDir, 'guide-index.json'))) { process.stderr.write(`lm-guide-serve: no guide built; run lm-build-guide.mjs ${product} first\n`); process.exit(2); }
try {
	await startGuideServer(opts);
} catch (e) {
	process.stderr.write(`lm-guide-serve: ${e.message}\n`);
	process.exit(1);
}
const { model } = opts;
if (model) console.log(`guide: questions matched by ${model.model} through the ${model.kind === 'anthropic-sdk' ? 'Anthropic SDK' : 'claude CLI'}; the manual from ${opts.manualDir}`);
else console.log('guide: no question endpoint (set guide.match and guide.session)');
console.log(`guide: http://localhost:${opts.port}${opts.basePath} (the product at ${opts.upstream} with the guide loaded)`);
