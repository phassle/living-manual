// Narrated video (spec: Video; ticket 12). Tested at the files seam: the CLI's stages are run on a
// fixture product and we read what they wrote: narration.json (sentences from the step texts and
// recorded labels), voice clips (cached by hash, so a rerun asks ElevenLabs for nothing), the
// sync check (T1.12: every narration sentence ends before the next action starts) and captions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(KIT, 'bin/lm-video.mjs');
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const FFPROBE = process.env.FFPROBE || '/opt/homebrew/bin/ffprobe';
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;

const action = (n, kind, label, extra = {}) => ({
	n, kind, screen: extra.screen ?? null, label, labelSource: 'page', labelVisible: true, dataSpecific: false,
	locator: { strategy: 'testid', expression: '', testIdTried: null }, languageBound: false, missingTestId: false,
	screenshot: `shots/0${n}.png`, box: { x: 10, y: 10, width: 50, height: 20 }, url: 'x', startedAt: '', endedAt: '', startMs: 0, endMs: 0, ...extra,
});

/** A passed step record in the shape the kit's run writes (src/index.ts). */
const RECORD = {
	kind: 'living-manual/step-record', version: 1, product: 'Fixture', productVersion: '9.9.9',
	scenario: { id: 'WIDGET-01', title: 'Register a new widget', role: 'widget keeper', startScreen: 'widget list', tags: ['@doc'], spec: 'x' },
	run: { startedAt: '', endedAt: '', status: 'passed', error: null },
	steps: [
		{ text: 'I am a widget keeper on the widget list', actions: [action(1, 'click', 'Widgets', { screen: 'Main menu' })] },
		{ text: 'I start a new widget', actions: [action(2, 'click', 'New widget', { screen: 'Widget list' })] },
		{ text: 'I choose the widget type "Round"', actions: [action(3, 'select', 'Widget type:', { value: 'Round', dataSpecific: true })] },
		{ text: 'I name the widget "Blue – Large"', actions: [action(4, 'fill', 'Widget name:', { value: 'Blue – Large' })] },
		{ text: 'I close the widget card', actions: [action(5, 'click', 'close button (×) at the top right', { labelSource: 'author' })] },
		{ text: 'the widget "Blue – Large" is listed under drafts', actions: [action(6, 'click', 'Drafts'), action(7, 'verify', 'Blue – Large')] },
	],
};

/**
 * A workspace with product "fixture": WIDGET-01's doc scenario, its step record in build/runs and,
 * unless `confirmed` is false, the writer's confirmation (through lm-confirm, as the writer session
 * records it).
 */
function workspace(record = RECORD, product = {}, { confirmed = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'lm-video-'));
	const folder = join(root, 'living-manual/products/fixture');
	mkdirSync(join(folder, 'build/runs/WIDGET-01'), { recursive: true });
	mkdirSync(join(folder, 'scenarios'), { recursive: true });
	writeFileSync(join(root, 'living-manual/living-manual.config.json'), JSON.stringify({ products: { fixture: { name: 'Fixture', environment: {}, ...product } } }));
	writeFileSync(join(folder, 'build/runs/WIDGET-01/step-record.json'), JSON.stringify(record));
	writeFileSync(join(folder, 'scenarios/widget.feature'), ['@doc', 'Feature: Widgets', '', '  @WIDGET-01', `  Scenario: ${RECORD.scenario.title}`,
		...RECORD.steps.map((s, i) => `    ${i === 0 ? 'Given' : i === RECORD.steps.length - 1 ? 'Then' : 'When'} ${s.text}`), ''].join('\n'));
	if (confirmed) {
		const c = spawnSync(process.execPath, [join(KIT, 'bin/lm-confirm.mjs'), '--folder', folder, 'confirm', 'WIDGET-01', '--by', 'Fixture writer'], { encoding: 'utf8' });
		if (c.status !== 0) throw new Error(c.stdout + c.stderr);
	}
	return { root, folder, videos: join(folder, 'build/videos') };
}

const cli = (root, args, env = {}) => spawnSync(process.execPath, [CLI, 'fixture', ...args], {
	cwd: root, encoding: 'utf8', env: { ...process.env, ELEVENLABS_API_KEY: '', ELEVENLABS_KEY_FILE: '', LM_CACHE_DIR: join(root, '.cache'), ...env },
});

test('narration is written from the step texts and the recorded labels, one sentence per unit', () => {
	const { root, videos } = workspace();
	const r = cli(root, ['--id', 'WIDGET-01', '--stage', 'narrate']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const plan = JSON.parse(readFileSync(join(videos, 'WIDGET-01/narration.json'), 'utf8'));
	assert.deepEqual(plan.units.map((u) => u.text), [
		'Register a new widget.',
		"Here's how, as a widget keeper.",
		'First, in the main menu, click Widgets.',
		'To start a new widget, click New widget.',
		'In Widget type, choose the one you need: here, Round.',
		'In Widget name, type Blue – Large.',
		'To close the widget card, click the close button (×) at the top right.',
		'Then click Drafts.',
		'And there it is: the widget Blue – Large is listed under drafts.',
		"That's how you register a new widget.",
	]);
	// What the voice says: no symbols a voice would read out or stumble on.
	assert.equal(plan.units[5].speech, 'In Widget name, type Blue, Large.');
	assert.equal(plan.units[6].speech, 'To close the widget card, click the close button at the top right.');
	// Each action unit names the action it comes before (step and action index in the step record).
	assert.deepEqual(plan.units.filter((u) => u.kind === 'action').map((u) => [u.step, u.action]), [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [5, 1]]);
});

test('a scenario the writer has not confirmed gets no video', () => {
	const { root } = workspace(RECORD, {}, { confirmed: false });
	const r = cli(root, ['--id', 'WIDGET-01', '--stage', 'narrate']);
	assert.equal(r.status, 1);
	assert.match(r.stdout, /video refused: WIDGET-01: .*draft/);
});

test('a confirmed scenario whose confirmation lapsed gets no video', () => {
	const { root, folder } = workspace();
	const healed = structuredClone(RECORD);
	healed.steps[1].actions[0].locator = { strategy: 'css', expression: "locator('button.new')" };
	writeFileSync(join(folder, 'build/runs/WIDGET-01/step-record.json'), JSON.stringify(healed));
	const r = cli(root, ['--id', 'WIDGET-01', '--stage', 'narrate']);
	assert.equal(r.status, 1);
	assert.match(r.stdout, /video refused: WIDGET-01: .*broken.*action list changed/);
});

test('a scenario whose run did not pass gets no video', () => {
	const { root } = workspace({ ...RECORD, run: { ...RECORD.run, status: 'failed' } }, {}, { confirmed: false });
	const r = cli(root, ['--id', 'WIDGET-01', '--stage', 'narrate']);
	assert.equal(r.status, 1);
	assert.match(r.stdout + r.stderr, /WIDGET-01: .*did not pass/);
});

/** A fake ElevenLabs: answers every text-to-speech request with a short tone, counts requests. */
async function fakeElevenLabs() {
	const tone = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6', '-c:a', 'libmp3lame', '-f', 'mp3', '-'], { maxBuffer: 1 << 24 }).stdout;
	const seen = [];
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			seen.push({ url: req.url, key: req.headers['xi-api-key'], body: JSON.parse(body) });
			res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
			res.end(tone);
		});
	});
	await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
	return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

test('voice: clips come from ElevenLabs with the key from the environment, and a rerun costs nothing', { skip: !hasFfmpeg }, async () => {
	const { root, videos } = workspace();
	const tts = await fakeElevenLabs();
	try {
		const keyFile = join(root, 'key.txt');
		writeFileSync(keyFile, 'sk-test-123\n');
		const run = () => new Promise((done) => {
			const child = spawn(process.execPath, [CLI, 'fixture', '--id', 'WIDGET-01', '--stage', 'voice'], {
				cwd: root, env: { ...process.env, ELEVENLABS_API_KEY: '', ELEVENLABS_KEY_FILE: keyFile, LM_ELEVENLABS_URL: tts.url, LM_CACHE_DIR: join(root, '.cache') },
			});
			let out = '';
			child.stdout.on('data', (d) => (out += d));
			child.stderr.on('data', (d) => (out += d));
			child.on('exit', (status) => done({ status, out }));
		});
		const first = await run();
		assert.equal(first.status, 0, first.out);
		assert.equal(tts.seen.length, 10);
		assert.ok(tts.seen.every((s) => s.key === 'sk-test-123'));
		assert.match(tts.seen[0].url, /^\/v1\/text-to-speech\/Xb7hH8MSUJpSbSDYk0k2\b/);
		assert.equal(tts.seen[5].body.text, 'In Widget name, type Blue, Large.');
		assert.doesNotMatch(first.out, /sk-test-123/);
		const plan = JSON.parse(readFileSync(join(videos, 'WIDGET-01/narration.json'), 'utf8'));
		for (const u of plan.units) {
			assert.ok(existsSync(u.clip), u.clip);
			assert.ok(u.duration > 0.5 && u.duration < 0.8, String(u.duration));
		}
		const second = await run();
		assert.equal(second.status, 0, second.out);
		assert.equal(tts.seen.length, 10, 'the rerun asked ElevenLabs again');
		assert.match(second.out, /0 clip\(s\) generated, 10 cached/);
	} finally { tts.close(); }
});

test('voice: without a key and with nothing cached it stops and names the environment variables', () => {
	const { root } = workspace();
	const r = cli(root, ['--id', 'WIDGET-01', '--stage', 'voice']);
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.match(r.stderr, /ELEVENLABS_API_KEY/);
	assert.match(r.stderr, /ELEVENLABS_KEY_FILE/);
});

/** A run timeline as the video run writes it: ms from the start of the recording. */
const timeline = (events) => ({ kind: 'living-manual/video-timeline', scenario: { id: 'WIDGET-01', title: 'Register a new widget' }, events });
const say = (unit, text, start, end) => ({ type: 'narration', unit, text, start, end });
const act = (step, action, kind, label, start, end) => ({ type: 'action', step, action, kind, label, start, end });

test('sync check (T1.12) passes when every sentence ends before the next action starts', () => {
	const { root, videos } = workspace();
	mkdirSync(join(videos, 'WIDGET-01'), { recursive: true });
	writeFileSync(join(videos, 'WIDGET-01/timeline.json'), JSON.stringify(timeline([
		say('intro-1', 'Register a new widget.', 100, 1500),
		say('s0a0', 'First, click Widgets.', 1500, 3000),
		act(0, 0, 'click', 'Widgets', 3250, 3600),
		say('s1a0', 'Click New widget.', 3900, 5000),
		act(1, 0, 'click', 'New widget', 5250, 5400),
		say('outro', "That's how.", 5600, 7000),
	])));
	const r = cli(root, ['--id', 'WIDGET-01', '--stage', 'check']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const report = readFileSync(join(videos, 'WIDGET-01/sync-check.txt'), 'utf8');
	assert.match(report, /^PASS T1\.12 WIDGET-01: every narration sentence ends before the next action starts \(4 sentences, 2 actions; smallest gap 0\.25 s\)$/m);
});

test('sync check (T1.12) fails when a sentence is still playing as the next action starts', () => {
	const { root, videos } = workspace();
	mkdirSync(join(videos, 'WIDGET-01'), { recursive: true });
	writeFileSync(join(videos, 'WIDGET-01/timeline.json'), JSON.stringify(timeline([
		say('s0a0', 'First, click Widgets.', 0, 3000),
		act(0, 0, 'click', 'Widgets', 2500, 2700),
		say('s1a0', 'Click New widget.', 2800, 4000),
		act(1, 0, 'click', 'New widget', 4100, 4300),
	])));
	const r = cli(root, ['--id', 'WIDGET-01', '--stage', 'check']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const report = readFileSync(join(videos, 'WIDGET-01/sync-check.txt'), 'utf8');
	assert.match(report, /^FAIL T1\.12 WIDGET-01: 1 sentence\(s\) still playing when the next action starts$/m);
	assert.match(report, /OVERLAP .*First, click Widgets\..*0\.50 s into click Widgets/);
});

test('sync check fails a sentence that lasted much longer than its clip: the run stalled', () => {
	const { root, videos } = workspace();
	mkdirSync(join(videos, 'WIDGET-01'), { recursive: true });
	writeFileSync(join(videos, 'WIDGET-01/narration.json'), JSON.stringify({ units: [{ id: 's0a0', duration: 1.5 }] }));
	writeFileSync(join(videos, 'WIDGET-01/timeline.json'), JSON.stringify(timeline([
		say('s0a0', 'First, click Widgets.', 0, 280_000),
		act(0, 0, 'click', 'Widgets', 280_400, 280_600),
	])));
	const r = cli(root, ['--id', 'WIDGET-01', '--stage', 'check']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const report = readFileSync(join(videos, 'WIDGET-01/sync-check.txt'), 'utf8');
	assert.match(report, /^FAIL T1\.12 WIDGET-01: 1 sentence\(s\) lasted longer than their clip \(the run stalled; record again\)$/m);
	assert.match(report, /STALLED .*First, click Widgets\..*280\.00 s for a 1\.50 s clip/);
});

test('captions: one WebVTT cue per narration sentence, at its time in the film', () => {
	const { root, videos } = workspace();
	mkdirSync(join(videos, 'WIDGET-01'), { recursive: true });
	writeFileSync(join(videos, 'WIDGET-01/timeline.json'), JSON.stringify(timeline([
		say('intro-1', 'Register a new widget.', 100, 1500),
		act(0, 0, 'click', 'Widgets', 1750, 2000),
		say('outro', "That's how you register a new widget.", 62_000, 64_250),
	])));
	const r = cli(root, ['--id', 'WIDGET-01', '--stage', 'captions', '--lead-in', '2']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(readFileSync(join(videos, 'WIDGET-01.vtt'), 'utf8'), [
		'WEBVTT', '',
		'1', '00:00:02.100 --> 00:00:03.500', 'Register a new widget.', '',
		'2', '00:01:04.000 --> 00:01:06.250', "That's how you register a new widget.", '',
	].join('\n'));
});

export { workspace, fakeElevenLabs, KIT, CLI, FFPROBE, hasFfmpeg, readdirSync };

// Ticket 13: a draft preview, so a reviewer can watch a scenario before the writer confirms it.
// It never stands in for the published video: it goes to build/preview-videos/, never to
// build/videos/ (which lm-watch and the published manual read), and its title card and caption
// band say it is a draft. A run that did not pass still gets nothing.
test('--draft-preview: an unconfirmed scenario gets a draft video in build/preview-videos, never in build/videos', () => {
	const { root, folder, videos } = workspace(RECORD, {}, { confirmed: false });
	const r = cli(root, ['--id', 'WIDGET-01', '--stage', 'narrate', '--draft-preview']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /narrate: \d+ sentence\(s\) → .*build\/preview-videos\/WIDGET-01\/narration\.json/);
	assert.ok(existsSync(join(folder, 'build/preview-videos/WIDGET-01/narration.json')));
	assert.equal(existsSync(videos), false, 'nothing is written where published videos live');
});

test('--draft-preview: a run that did not pass still gets no video', () => {
	const { root } = workspace({ ...RECORD, run: { ...RECORD.run, status: 'failed' } }, {}, { confirmed: false });
	const r = cli(root, ['--id', 'WIDGET-01', '--stage', 'narrate', '--draft-preview']);
	assert.equal(r.status, 1);
	assert.match(r.stdout + r.stderr, /WIDGET-01: .*did not pass/);
});

test('--draft-preview: the title card and caption band say the film is a draft not confirmed by the writer', async () => {
	const { cardHtml, bandHtml } = await import('../bin/lib/mix.mjs');
	const card = cardHtml({ product: 'Fixture', title: 'Register a new widget', role: 'widget keeper', steps: 6, id: 'WIDGET-01', version: '9.9.9', draft: true });
	assert.match(card, /Draft preview/);
	assert.match(card, /not confirmed by the writer/);
	assert.match(bandHtml('Click New widget.', 'Step 1 of 6', true), /Draft/);
	assert.doesNotMatch(cardHtml({ product: 'Fixture', title: 'T', role: null, steps: 1, id: 'X-01', version: '1' }), /Draft/);
});

test('a last step with two checks says its result once', async () => {
	const { narrate } = await import(join(KIT, 'bin/lib/narration.mjs'));
	const verify = (label) => ({ kind: 'verify', screen: 'Widget list', label, locator: { strategy: 'text' } });
	const units = narrate({ scenario: { title: 'Ship a widget', role: null }, steps: [
		{ text: 'I ship the widget', actions: [{ kind: 'click', screen: 'Widget list', label: 'Ship', locator: { strategy: 'role' } }] },
		{ text: 'the widget is listed as "Shipped"', actions: [verify('Blue'), verify('Shipped')] },
	] });
	const texts = units.map((u) => u.text);
	assert.equal(texts.filter((x) => x.startsWith('And there it is')).length, 1, texts.join('\n'));
	assert.equal(texts[2], 'And there it is: the widget is listed as Shipped.');
	assert.equal(texts[3], 'Check that Shipped is shown.');
});
