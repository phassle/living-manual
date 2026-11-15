#!/usr/bin/env node
// Runs a product's doc scenarios the only way a run counts (spec: From scenario to test code,
// Repeatable runs, Data safety): under the product's run lock (bin/lib/lock.mjs; waits while
// another run holds it), parity check first, then the product's reset, then the run gate
// (verify, and the tests only when verify passes; each scenario resets and verifies again before
// it starts, src/index.ts), then the comparison with each scenario's previous run (lm-compare;
// reported, not a failure), then the facts pack (lm-facts: facts/pack.json, and a confirmed
// scenario the run found broken is recorded as broken), then the batched issues (lm-issues after-run:
// broken scenarios, missing cases, missing test IDs, unanswered guide questions), then the manual pages from the step records (only changed ones), then
// the site and the preview (lm-publish).
// The agents' seed test (tag @seed, bin/lm-agent.mjs) is not a doc scenario and is left out.
//
// usage: node living-manual/kit/bin/lm-run.mjs <product> [--grep <ID>] [--no-manual]
// Exit: 1 parity failed or tests failed, 3 verify refused the run, else the manual's exit code.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { workspaceRoot } from './lib/workspace.mjs';
import { takeRunLock } from './lib/lock.mjs';

const [product, ...args] = process.argv.slice(2);
if (!product || product.startsWith('-')) { process.stderr.write('usage: lm-run.mjs <product> [--grep <ID>] [--no-manual]\n'); process.exit(2); }
takeRunLock(product, `lm-run ${process.argv.slice(2).join(' ')}`);
const grep = args.includes('--grep') ? args[args.indexOf('--grep') + 1] : null;
const root = workspaceRoot();
const bin = (f) => join(root, 'living-manual/kit/bin', f);
const node = (...a) => spawnSync(process.execPath, a, { cwd: root, stdio: 'inherit' }).status ?? 1;

const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
if (node(bin('lm-parity.mjs'), product) !== 0) { console.log('run refused: parity failed'); process.exit(1); }
if (node(bin('lm-env.mjs'), product, 'reset') !== 0) { console.log('run refused: reset failed'); process.exit(1); }
const playwright = ['cd living-manual/kit &&', 'node_modules/.bin/playwright test', `--project=${q(product)}`, '--grep-invert @seed', grep ? `--grep ${q(grep)}` : ''].join(' ');
const ran = node(bin('lm-env.mjs'), product, 'run', '--', playwright);
if (ran === 3) process.exit(3);
node(bin('lm-compare.mjs'), product, ...(grep ? ['--id', grep] : []));
const facts = node(bin('lm-facts.mjs'), product);
if (facts !== 0) { console.log('run: the facts pack was not written (lm-facts failed)'); process.exit(ran || facts); }
// What the run found goes to the workspace's tracker, batched (lm-issues; a refusal is reported, not a failure).
node(bin('lm-issues.mjs'), product, 'after-run');
if (args.includes('--no-manual')) process.exit(ran);
const manual = node(bin('lm-manual.mjs'), product, ...(grep ? ['--id', grep] : []));
// The site and the preview follow the pages; a manual with problems is not published.
const published = manual ? 0 : node(bin('lm-publish.mjs'), product);
process.exit(ran || manual || published);
