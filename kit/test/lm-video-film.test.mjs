// The whole video stage on a fixture product (spec: Video, T1.12): a normal run writes the step
// record, then `lm-video --stage all` (with a fake ElevenLabs) narrates, voices, records a slowed
// run under the run lock, checks sync and mixes. We check what lands on disk: an H.264 + AAC MP4
// at the fixed window size plus the caption band, WebVTT captions, a passing sync check, three
// stills, the pointer drawn in the recording, and the run's own step record left as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspace, playwright } from './fixture-workspace.mjs';
import { readPng } from './png.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const FFPROBE = process.env.FFPROBE || '/opt/homebrew/bin/ffprobe';
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;

// A plain page: two big blue buttons with their label in a corner, so the middle of each is one
// colour and anything dark there is the drawn pointer.
const PAGE = `<style>body{margin:0;background:#fff;font:16px sans-serif} button{position:absolute;width:260px;height:160px;background:#2a6fdb;border:0;color:#fff;text-align:left;vertical-align:top;padding:6px}</style>
<button data-testid="go-button" style="left:200px;top:200px">Go</button>
<button data-testid="done-button" style="left:800px;top:400px" onclick="document.getElementById('out').textContent='Finished'">Done</button>
<div id="out" style="position:absolute;left:200px;top:600px;font-size:24px"></div>`;

const spec = () => `
test('DEMO-01 Finish a demo', {
	tag: '@doc',
	annotation: [{ type: 'role', description: 'demo user' }, { type: 'start screen', description: 'demo page' }],
}, async ({ page, lm }) => {
	await test.step('I open the demo page', async () => {
		await page.setContent(${JSON.stringify(PAGE)});
		lm.screen('Demo page');
		await lm.click({ testId: 'go-button' });
	});
	await test.step('I finish the demo', async () => {
		await lm.click({ testId: 'done-button' });
	});
	await test.step('the demo is finished', async () => {
		await lm.see({ text: 'Finished' });
	});
});
`;

async function fakeElevenLabs(duration) {
	const tone = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${duration}`, '-af', 'adelay=150', '-c:a', 'libmp3lame', '-f', 'mp3', '-'], { maxBuffer: 1 << 24 }).stdout;
	let count = 0;
	const server = createServer((req, res) => { req.resume(); req.on('end', () => { count++; res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(tone); }); });
	await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
	return { url: `http://127.0.0.1:${server.address().port}`, count: () => count, close: () => server.close() };
}

const probe = (file, entries) => JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', entries, '-of', 'json', file], { encoding: 'utf8' }).stdout);

test('lm-video makes a narrated film of a scenario whose sentences all end before the next action', { skip: !hasFfmpeg, timeout: 300_000 }, async () => {
	const { root, runs } = workspace({ pages: {}, spec });
	const first = playwright(root);
	assert.equal(first.status, 0, first.stdout + first.stderr);
	const recordBefore = readFileSync(join(runs, 'DEMO-01/step-record.json'), 'utf8');
	// Only a confirmed scenario gets a video: its doc scenario, confirmed as the writer session does.
	const folder = join(root, 'living-manual/products/fixture');
	mkdirSync(join(folder, 'scenarios'), { recursive: true });
	writeFileSync(join(folder, 'scenarios/demo.feature'), '@doc\nFeature: Demo\n\n  @DEMO-01\n  Scenario: Finish a demo\n    Given I open the demo page\n    When I finish the demo\n    Then the demo is finished\n');
	const confirmed = spawnSync(process.execPath, [join(KIT, 'bin/lm-confirm.mjs'), '--folder', folder, 'confirm', 'DEMO-01', '--by', 'Fixture writer'], { encoding: 'utf8' });
	assert.equal(confirmed.status, 0, confirmed.stdout + confirmed.stderr);

	const tts = await fakeElevenLabs(1.2);
	try {
		const cache = mkdtempSync(join(tmpdir(), 'lm-video-cache-'));
		const out = await new Promise((done) => {
			const child = spawn(process.execPath, [join(KIT, 'bin/lm-video.mjs'), 'fixture', '--id', 'DEMO-01'], {
				cwd: root, env: { ...process.env, ELEVENLABS_API_KEY: 'sk-fake', ELEVENLABS_KEY_FILE: '', LM_ELEVENLABS_URL: tts.url, LM_CACHE_DIR: cache, LM_RUN_LOCK: '' },
			});
			let text = '';
			child.stdout.on('data', (d) => (text += d));
			child.stderr.on('data', (d) => (text += d));
			child.on('exit', (status) => done({ status, text }));
		});
		assert.equal(out.status, 0, out.text);
		const videos = join(root, 'living-manual/products/fixture/build/videos');

		// The film: H.264 + AAC, the fixed window size with the caption band under it.
		const mp4 = join(videos, 'DEMO-01.mp4');
		const streams = probe(mp4, 'stream=codec_name,codec_type,width,height').streams;
		assert.deepEqual(streams.map((s) => s.codec_name).sort(), ['aac', 'h264']);
		const v = streams.find((s) => s.codec_type === 'video');
		assert.equal(v.width, 1440);
		assert.equal(v.height, 900 + 110);

		// T1.12 from the run's timeline.
		const check = readFileSync(join(videos, 'DEMO-01/sync-check.txt'), 'utf8');
		assert.match(check, /^PASS T1\.12 DEMO-01: every narration sentence ends before the next action starts \(6 sentences, 3 actions/m);
		assert.match(check, /^audio: 6 of 6 sentences heard/m);

		// Captions: one cue per sentence, in the order spoken.
		const vtt = readFileSync(join(videos, 'DEMO-01.vtt'), 'utf8');
		assert.equal((vtt.match(/ --> /g) ?? []).length, 6);
		assert.match(vtt, /First, in the demo page, click Go\./);
		assert.match(vtt, /That's how you finish a demo\./);

		assert.deepEqual(readdirSync(join(videos, 'DEMO-01/stills')).sort(), ['01-title.png', '02-middle.png', '03-result.png']);

		// The pointer is drawn: while "click Done" is spoken, the middle of the Done button
		// (one flat blue) holds the arrow's dark outline and white fill.
		const tl = JSON.parse(readFileSync(join(videos, 'DEMO-01/timeline.json'), 'utf8'));
		const done = tl.events.find((e) => e.type === 'action' && e.label === 'Done');
		const frame = join(videos, 'frame.png');
		spawnSync(FFMPEG, ['-v', 'error', '-y', '-ss', ((done.start - 150) / 1000).toFixed(2), '-i', join(videos, 'DEMO-01/recording.webm'), '-frames:v', '1', frame]);
		const png = readPng(readFileSync(frame));
		let dark = 0, white = 0;
		for (let y = 480; y < 520; y++) for (let x = 930; x < 965; x++) {
			const [r, g, b] = png.pixel(x, y);
			if (r < 60 && g < 60 && b < 60) dark++;
			if (r > 220 && g > 220 && b > 220) white++;
		}
		assert.ok(dark > 10 && white > 10, `no pointer at the Done button (dark ${dark}, white ${white})`);

		// The video run left the scenario's own run alone.
		assert.equal(readFileSync(join(runs, 'DEMO-01/step-record.json'), 'utf8'), recordBefore);

		// A second run with nothing changed keeps the film and asks ElevenLabs for nothing.
		const asked = tts.count();
		const again = spawnSync(process.execPath, [join(KIT, 'bin/lm-video.mjs'), 'fixture', '--id', 'DEMO-01'], { cwd: root, encoding: 'utf8', env: { ...process.env, ELEVENLABS_API_KEY: '', ELEVENLABS_KEY_FILE: '', LM_CACHE_DIR: cache, LM_RUN_LOCK: '' } });
		assert.equal(again.status, 0, again.stdout + again.stderr);
		assert.match(again.stdout, /DEMO-01: unchanged .*video kept/);
		assert.equal(tts.count(), asked);
	} finally { tts.close(); }
});
