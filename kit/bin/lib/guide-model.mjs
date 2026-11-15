// The model behind the guide's question endpoint (bin/lib/guide-match.mjs). One function,
// ask({ system, user, schema }) => Promise<object>, the answer as the schema shapes it.
// Two clients, chosen when the endpoint starts (decision record 0004 of the first product):
//   - anthropic-sdk: the Anthropic SDK, when the environment variable the config names (keyEnv)
//     is set. The key is read from the endpoint process's environment at run time and never leaves
//     this process: not into the guide script, the index, the page or a log.
//   - claude-cli: otherwise, the local Claude Code CLI (`claude -p --model <id>`), signed in with
//     the person's own login. For a demonstration on a machine without an API key.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';

const TIMEOUT_MS = 90_000;

/** { id (model ID), keyEnv (name of the key variable), cli (the claude command; default "claude") }. */
export function modelFor({ id, keyEnv, cli = 'claude' }, env = process.env) {
	if (keyEnv && env[keyEnv]) return sdkModel(id, env[keyEnv]);
	return cliModel(id, cli);
}

function sdkModel(model, apiKey) {
	const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS });
	return {
		kind: 'anthropic-sdk',
		model,
		async ask({ system, user, schema }) {
			const r = await client.messages.create({
				model,
				max_tokens: 1024,
				system,
				messages: [{ role: 'user', content: user }],
				output_config: { effort: 'low', format: { type: 'json_schema', schema } },
			});
			if (r.stop_reason === 'refusal') throw new Error(`the model declined (${r.stop_details?.category ?? 'no category'})`);
			const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
			return JSON.parse(text);
		},
	};
}

function cliModel(model, cli) {
	return {
		kind: 'claude-cli',
		model,
		ask({ system, user, schema }) {
			const args = ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence',
				'--system-prompt', system, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
				'--disable-slash-commands', '--json-schema', JSON.stringify(schema)];
			return new Promise((resolve, reject) => {
				// From a neutral folder, so no project instructions or settings join the prompt.
				const child = spawn(cli, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
				let out = '', err = '';
				const timer = setTimeout(() => { child.kill(); reject(new Error(`${cli} took longer than ${TIMEOUT_MS / 1000} s`)); }, TIMEOUT_MS);
				child.stdout.on('data', (d) => (out += d));
				child.stderr.on('data', (d) => (err += d));
				child.on('error', (e) => { clearTimeout(timer); reject(e); });
				child.on('close', (code) => {
					clearTimeout(timer);
					let r;
					try { r = JSON.parse(out); } catch { return reject(new Error(`${cli} exited ${code}: ${(err || out).trim().slice(0, 300)}`)); }
					if (r.is_error) return reject(new Error(`${cli}: ${String(r.result ?? r.subtype ?? 'error').slice(0, 300)}`));
					if (r.structured_output) return resolve(r.structured_output);
					try { resolve(JSON.parse(r.result)); } catch { reject(new Error(`${cli} gave no JSON answer: ${String(r.result).slice(0, 300)}`)); }
				});
				child.stdin.end(user);
			});
		},
	};
}
