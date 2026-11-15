#!/usr/bin/env node
// Narrated video of a scenario (spec: Video). From the scenario's step record
// (<product>/build/runs/<ID>/step-record.json, written by lm-run) to
// <product>/build/videos/<ID>.mp4 (H.264 + AAC) with captions <ID>.vtt beside it. Stages, in order:
//
//   narrate   narration.json: one sentence per unit, from the step texts and recorded labels
//   voice     an ElevenLabs clip per sentence, cached by hash (a rerun costs nothing)
//   record    a slowed run of the scenario under the run lock, at the fixed window size: each
//             action waits until its sentence has been spoken; a pointer is drawn in; writes
//             timeline.json (when each sentence and each action started and ended)
//   check     T1.12 from the timeline: every sentence ends before the next action starts
//   captions  <ID>.vtt from the timeline
//   mix       title card + recording + caption band, the voice laid at its times; stills
//
// `--stage all` (the default) runs them all and skips a scenario whose video was made from the
// same sources (step record, screenshots, narration, voice) unless --force.
//
// --draft-preview: a preview for a reviewer before the writer has confirmed the scenario (its run
// must still have passed). Written to <product>/build/preview-videos/, never to build/videos/ (which
// the published manual and lm-watch read); the title card and every caption say "Draft preview".
//
// usage: node living-manual/kit/bin/lm-video.mjs <product> --id <ID> [--stage <stage>|all] [--force] [--lead-in <s>] [--draft-preview]
// Exit: 0 done, 1 the scenario cannot have a video or the sync check failed, 2 usage or missing key.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productConfig, productFolder, workspaceRoot } from './lib/workspace.mjs';
import { readRecord, sourceFingerprint } from './lib/record.mjs';
import { narrate } from './lib/narration.mjs';
import { FFMPEG, MissingKey, seconds, voiceSettings, voiceUnits } from './lib/voice.mjs';
import { syncCheck, webvtt } from './lib/timeline.mjs';
import { videoEligible } from './lib/eligible.mjs';
import { takeRunLock } from './lib/lock.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGES = ['narrate', 'voice', 'record', 'check', 'captions', 'mix'];
const usage = () => { process.stderr.write(`usage: lm-video.mjs <product> --id <ID> [--stage ${STAGES.join('|')}|all] [--force] [--lead-in <s>] [--draft-preview]\n`); process.exit(2); };

const [product, ...args] = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const id = opt('--id');
const stage = opt('--stage') ?? 'all';
const draft = args.includes('--draft-preview');
if (!product || product.startsWith('-') || !id || !(stage === 'all' || STAGES.includes(stage))) usage();

const root = workspaceRoot();
const section = productConfig(root, product);
const folder = productFolder(root, product);
const runDir = join(folder, 'build/runs', id);
const videos = join(folder, draft ? 'build/preview-videos' : 'build/videos');
const work = join(videos, id);
const files = {
	plan: join(work, 'narration.json'),
	timeline: join(work, 'timeline.json'),
	check: join(work, 'sync-check.txt'),
	vtt: join(videos, `${id}.vtt`),
	mp4: join(videos, `${id}.mp4`),
	manifest: join(work, 'video.json'),
};
const show = (f) => relative(root, f);
/** Seconds of title card before the recording; captions and voice are shifted by it. */
const LEAD_IN = Number(opt('--lead-in') ?? 3);
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));
const save = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, '\t') + '\n'); };

function record() {
	if (!existsSync(join(runDir, 'step-record.json'))) {
		console.log(`${id}: no step record at ${show(runDir)}; run the scenario first: node living-manual/kit/bin/lm-run.mjs ${product} --grep ${id}`);
		process.exit(1);
	}
	const rec = readRecord(runDir);
	let verdict = videoEligible(rec, folder);
	if (!verdict.eligible && draft && rec.run?.status === 'passed') {
		verdict = { eligible: true, reason: `${id}: last run passed; DRAFT PREVIEW, not confirmed by the writer (${verdict.reason.replace(/^[^:]+: /, '')}); not for the published manual` };
	}
	if (!verdict.eligible) { console.log(`video refused: ${verdict.reason}`); process.exit(1); }
	return { rec, verdict };
}

// ---- stages -------------------------------------------------------------------------------

function stageNarrate() {
	const { rec } = record();
	const units = narrate(rec);
	save(files.plan, { kind: 'living-manual/narration', scenario: rec.scenario, productVersion: rec.productVersion, voice: null, units });
	console.log(`narrate: ${units.length} sentence(s) → ${show(files.plan)}`);
}

async function stageVoice() {
	if (!existsSync(files.plan)) stageNarrate();
	const plan = json(files.plan);
	const voice = voiceSettings(section);
	let generated;
	try { generated = await voiceUnits(plan.units, voice); } catch (e) {
		if (e instanceof MissingKey) { process.stderr.write(`lm-video: ${e.message}\n`); process.exit(2); }
		throw e;
	}
	plan.voice = { id: voice.id, name: voice.name, model: voice.model };
	save(files.plan, plan);
	const total = plan.units.reduce((t, u) => t + u.duration, 0);
	console.log(`voice: ${generated} clip(s) generated, ${plan.units.length - generated} cached; ${total.toFixed(1)} s of narration, voice ${voice.name} (${voice.id})`);
}

function stageRecord() {
	record();
	const plan = json(files.plan);
	if (plan.units.some((u) => !u.duration)) { console.log('record: voice the narration first (--stage voice)'); process.exit(1); }
	takeRunLock(product, `lm-video ${product} --id ${id} --stage record${draft ? ' --draft-preview' : ''}`);
	const runOut = join(work, 'run');
	rmSync(runOut, { recursive: true, force: true });
	mkdirSync(runOut, { recursive: true });
	const env = section.environment ?? {};
	const sh = (command, extra = {}) => spawnSync(command, { cwd: root, shell: '/bin/sh', stdio: 'inherit', env: { ...process.env, ...extra } }).status ?? 1;
	if (env.reset && sh(env.reset) !== 0) { console.log('record refused: reset failed'); process.exit(1); }
	if (env.verify && sh(env.verify) !== 0) { console.log('record refused: verify failed'); process.exit(3); }
	const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
	// The recording is paced by wall-clock waits: keep the machine awake (macOS idle sleep once
	// stalled a sentence for minutes, leaving a long silence in the film).
	const awake = process.platform === 'darwin' && existsSync('/usr/bin/caffeinate') ? '/usr/bin/caffeinate -i ' : '';
	const status = sh(`cd ${q(KIT)} && ${awake}node_modules/.bin/playwright test --project=${q(product)} --grep ${q(`${id}\\b`)}`, { LM_WORKSPACE: root, LM_VIDEO_PLAN: files.plan, LM_VIDEO_DIR: runOut });
	if (status !== 0 || !existsSync(join(runOut, 'timeline.json'))) { console.log(`record: the video run of ${id} failed (exit ${status})`); process.exit(1); }
	const webm = existsSync(join(runOut, 'recording.webm')) ? join(runOut, 'recording.webm') : findFile(join(runOut, 'pw'), '.webm');
	if (!webm) { console.log('record: the run left no recording'); process.exit(1); }
	copyFileSync(webm, join(work, 'recording.webm'));
	copyFileSync(join(runOut, 'timeline.json'), files.timeline);
	const tl = json(files.timeline);
	console.log(`record: ${show(join(work, 'recording.webm'))} (${seconds(join(work, 'recording.webm')).toFixed(1)} s; run ${(tl.closedAt / 1000).toFixed(1)} s) and ${show(files.timeline)}`);
}

function findFile(dir, ext) {
	if (!existsSync(dir)) return null;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) { const f = findFile(p, ext); if (f) return f; } else if (e.name.endsWith(ext)) return p;
	}
	return null;
}

function stageCheck() {
	const clips = existsSync(files.plan) ? Object.fromEntries(json(files.plan).units.map((u) => [u.id, u.duration])) : {};
	const { ok, lines } = syncCheck(json(files.timeline), clips);
	save(files.check, lines.join('\n') + '\n');
	console.log(lines.join('\n'));
	return ok;
}

function stageCaptions() {
	save(files.vtt, webvtt(json(files.timeline), LEAD_IN * 1000));
	console.log(`captions: ${show(files.vtt)}`);
}

async function stageMix() {
	const { mix } = await import('./lib/mix.mjs');
	const plan = json(files.plan);
	const tl = json(files.timeline);
	const rec = readRecord(runDir);
	const out = await mix({ work, plan, timeline: tl, record: rec, product: section.name ?? product, leadIn: LEAD_IN, mp4: files.mp4, draft });
	const audio = out.audioCheck;
	const lines = readFileSync(files.check, 'utf8').trimEnd().split('\n').filter((l) => !l.startsWith('audio:'));
	lines.push(`audio: ${audio.found} of ${audio.total} sentences heard in ${id}.mp4 within 0.3 s of where the timeline puts them (speech onsets by silencedetect)`);
	save(files.check, lines.join('\n') + '\n');
	console.log(`mix: ${show(files.mp4)} (${out.seconds.toFixed(1)} s, ${(statSync(files.mp4).size / 1e6).toFixed(1)} MB, ${out.size}); stills in ${show(join(work, 'stills'))}`);
	console.log(lines.at(-1));
}

/** What the video is made from: the run's sources (step record and screenshots) and the narration as voiced. */
function fingerprint() {
	const plan = existsSync(files.plan) ? json(files.plan) : null;
	return createHash('sha256').update(sourceFingerprint(runDir)).update(JSON.stringify(plan?.units?.map((u) => [u.text, u.hash]) ?? null)).digest('hex');
}

const run = {
	narrate: stageNarrate, voice: stageVoice, record: stageRecord, captions: stageCaptions, mix: stageMix,
	check: () => { if (!stageCheck()) process.exit(1); },
};

if (stage !== 'all') {
	await run[stage]();
} else {
	const { verdict } = record();
	console.log(`video: ${verdict.reason}`);
	stageNarrate();
	await stageVoice();
	const sources = fingerprint();
	if (!args.includes('--force') && existsSync(files.mp4) && existsSync(files.manifest) && json(files.manifest).sources === sources) {
		console.log(`${id}: unchanged since ${show(files.mp4)} was made; video kept (--force to make it again)`);
		process.exit(0);
	}
	stageRecord();
	const ok = stageCheck();
	if (!ok) { console.log(`${id}: the sync check failed; no video`); process.exit(1); }
	stageCaptions();
	await stageMix();
	save(files.manifest, { scenario: id, draftPreview: draft, sources, madeAt: new Date().toISOString(), mp4: show(files.mp4), vtt: show(files.vtt) });
}
