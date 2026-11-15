// The model behind the guide's question endpoint (spec: Guide, Matching; first product's decision
// 0004). Pluggable: the Anthropic SDK when the configured key variable is set in the endpoint's
// environment, otherwise the local Claude Code CLI (the person's own login). Tested at the
// function seam guide-match uses, with a stand-in `claude` command that records its arguments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelFor } from '../bin/lib/guide-model.mjs';
import { matchPrompt } from '../bin/lib/guide-match.mjs';

const PROMPT = matchPrompt({ question: 'how do I pay', screen: 'basket', role: 'customer' },
	[{ id: 'SHOP-02', title: 'Pay for the basket', startScreen: 'basket' }], [{ slug: 'baskets', title: 'How baskets work' }]);

function fakeClaude(answer) {
	const dir = mkdtempSync(join(tmpdir(), 'lm-fake-claude-'));
	const bin = join(dir, 'claude');
	writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = ''; process.stdin.on('data', (d) => stdin += d).on('end', () => {
	fs.writeFileSync(${JSON.stringify(join(dir, 'call.json'))}, JSON.stringify({ argv: process.argv.slice(2), stdin, key: process.env.SECRET_KEY ?? null }));
	process.stdout.write(JSON.stringify(${JSON.stringify(answer)}));
});
`);
	chmodSync(bin, 0o755);
	return { bin, call: () => JSON.parse(readFileSync(join(dir, 'call.json'), 'utf8')) };
}

test('without the key variable the endpoint asks the local claude CLI with the configured model, no tools, and reads its structured answer', async () => {
	const fake = fakeClaude({ type: 'result', is_error: false, structured_output: { scenario: 'SHOP-02', page: null } });
	const m = modelFor({ id: 'claude-haiku-5-5', keyEnv: 'SECRET_KEY', cli: fake.bin }, {});
	assert.equal(m.kind, 'claude-cli');
	assert.deepEqual(await m.ask(PROMPT), { scenario: 'SHOP-02', page: null });
	const { argv, stdin } = fake.call();
	assert.equal(argv[argv.indexOf('--model') + 1], 'claude-haiku-5-5');
	assert.ok(argv.includes('-p'));
	assert.equal(argv[argv.indexOf('--tools') + 1], '');
	assert.deepEqual(JSON.parse(argv[argv.indexOf('--json-schema') + 1]), PROMPT.schema);
	assert.match(stdin, /Question: how do I pay/);
});

test('a CLI that reports an error makes the ask fail', async () => {
	const fake = fakeClaude({ type: 'result', is_error: true, result: 'Not logged in' });
	await assert.rejects(modelFor({ id: 'claude-haiku-5-5', keyEnv: 'SECRET_KEY', cli: fake.bin }, {}).ask(PROMPT), /Not logged in/);
});

test('with the key variable set, the Anthropic SDK client is used', () => {
	const m = modelFor({ id: 'claude-haiku-5-5', keyEnv: 'SECRET_KEY' }, { SECRET_KEY: 'sk-test' });
	assert.equal(m.kind, 'anthropic-sdk');
	assert.equal(m.model, 'claude-haiku-5-5');
});
