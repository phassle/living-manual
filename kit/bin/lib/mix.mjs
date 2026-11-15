// Makes the film from a video run (spec: Video), with ffmpeg: a title card, then the recording
// with a caption band under it (the narration's sentences, burned in, and "Step n of m"), the
// voice clips laid at the times the timeline gives them, encoded H.264 + AAC. Writes three stills
// and checks that each sentence is heard where the timeline puts it. The card and the caption
// band are drawn by Chromium (the kit's Playwright) as PNGs, so ffmpeg needs no font support.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { FFMPEG, seconds } from './voice.mjs';

const BAND = 110;
const FPS = 30;
const FONT = `-apple-system, 'SF Pro Text', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function cardHtml({ product, title, role, steps, id, version, draft = false }) {
	return `<html><body style="margin:0;width:100vw;height:100vh;font-family:${FONT};color:#fff;
		background:radial-gradient(120% 90% at 20% 10%,#24476b 0%,#122235 55%,#0b1420 100%);display:flex;flex-direction:column;justify-content:center;padding:0 120px;box-sizing:border-box">
		${draft ? `<div style="position:absolute;right:70px;top:60px;padding:14px 26px;border:3px solid #ff6b5a;border-radius:10px;color:#ff6b5a;font-size:30px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">Draft preview · not confirmed by the writer</div>` : ''}
		<div style="font-size:24px;letter-spacing:.14em;text-transform:uppercase;color:#ffb257;font-weight:600">${esc(product)} · How to</div>
		<div style="font-size:76px;font-weight:700;line-height:1.08;margin:22px 0 26px;max-width:1100px">${esc(title)}</div>
		<div style="font-size:30px;color:#c9d6e3">${role ? `As a ${esc(role)} · ` : ''}${steps} steps</div>
		<div style="position:absolute;left:120px;bottom:70px;font-size:20px;color:#8ea3b8">${esc(id)} · version ${esc(version ?? 'unknown')} · recorded from a machine-verified run${draft ? ' · draft: not confirmed by the writer, not published' : ''}</div>
	</body></html>`;
}

export function bandHtml(text, step, draft = false) {
	return `<html><body style="margin:0;width:100vw;height:100vh;background:#0f1419;font-family:${FONT};display:flex;align-items:center;justify-content:center;position:relative;border-top:1px solid #26303a;box-sizing:border-box">
		${step ? `<div style="position:absolute;left:28px;top:50%;transform:translateY(-50%);font-size:17px;font-weight:600;color:#ffb257;letter-spacing:.06em;text-transform:uppercase">${esc(step)}</div>` : ''}
		${draft ? `<div style="position:absolute;right:28px;top:50%;transform:translateY(-50%);font-size:17px;font-weight:700;color:#ff6b5a;letter-spacing:.06em;text-transform:uppercase">Draft preview</div>` : ''}
		<div style="color:#fff;font-size:${text ? 30 : 0}px;line-height:1.25;max-width:1000px;text-align:center">${esc(text)}</div>
	</body></html>`;
}

/** Renders HTML pages to PNG files of the given size. */
async function render(pages, width, height) {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
		for (const [file, html] of pages) {
			await page.setContent(html);
			await page.screenshot({ path: file });
		}
	} finally { await browser.close(); }
}

const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 1 << 26 });

/**
 * Builds the MP4. Returns { seconds, size, audioCheck: { found, total } }.
 * timeline times are ms from the start of the recording (work/recording.webm).
 */
export async function mix({ work, plan, timeline, record, product, leadIn, mp4, draft = false }) {
	const recording = join(work, 'recording.webm');
	const { width, height } = timeline.viewport;
	const H = height + BAND;
	const parts = join(work, 'parts');
	rmSync(parts, { recursive: true, force: true });
	mkdirSync(parts, { recursive: true });

	// Captions: each sentence from its start until it ends (plus a beat), never past the next one.
	const unitOf = Object.fromEntries(plan.units.map((u) => [u.id, u]));
	const said = timeline.events.filter((e) => e.type === 'narration').sort((a, b) => a.start - b.start);
	const steps = record.steps.length;
	const cues = said.map((n, i) => {
		const u = unitOf[n.unit] ?? {};
		const until = Math.min(n.end + 600, said[i + 1]?.start ?? Infinity);
		return { file: join(parts, `cap-${String(i).padStart(2, '0')}.png`), text: n.text, step: u.kind === 'action' ? `Step ${u.step + 1} of ${steps}` : '', from: n.start / 1000, to: until / 1000, clip: u.clip, at: n.start / 1000 };
	});
	const card = join(parts, 'card.png');
	const empty = join(parts, 'band.png');
	await render([
		[empty, bandHtml('', '', draft)],
		...cues.map((c) => [c.file, bandHtml(c.text, c.step, draft)]),
	], width, BAND);
	await render([[card, cardHtml({ product, title: record.scenario.title, role: record.scenario.role, steps, id: record.scenario.id, version: record.productVersion, draft })]], width, H);

	const length = seconds(recording);
	const total = leadIn + length;
	const inputs = ['-loop', '1', '-framerate', String(FPS), '-t', leadIn.toFixed(3), '-i', card, '-i', recording, '-loop', '1', '-framerate', String(FPS), '-t', length.toFixed(3), '-i', empty];
	const g = [];
	g.push(`[0:v]format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=${(leadIn - 0.45).toFixed(2)}:d=0.45,setsar=1[card]`);
	g.push(`[1:v]fps=${FPS},setpts=PTS-STARTPTS,scale=${width}:${height},setsar=1[rec]`);
	g.push(`[rec][2:v]vstack=inputs=2[m0]`);
	let n = 3;
	cues.forEach((c, i) => {
		inputs.push('-i', c.file);
		g.push(`[m${i}][${n++}:v]overlay=0:${height}:enable='between(t,${c.from.toFixed(3)},${c.to.toFixed(3)})'[m${i + 1}]`);
	});
	g.push(`[m${cues.length}]fade=t=in:st=0:d=0.35,fade=t=out:st=${(length - 0.7).toFixed(2)}:d=0.7,format=yuv420p[main]`);
	g.push(`[card][main]concat=n=2:v=1:a=0[v]`);
	const voices = cues.filter((c) => c.clip);
	voices.forEach((c, i) => {
		inputs.push('-i', c.clip);
		const ms = Math.round((leadIn + c.at) * 1000);
		g.push(`[${n++}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${ms}|${ms}[a${i}]`);
	});
	g.push(`${voices.map((_, i) => `[a${i}]`).join('')}amix=inputs=${voices.length}:normalize=0:dropout_transition=0,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)},alimiter=limit=0.95[a]`);
	ff([...inputs, '-filter_complex', g.join(';'), '-map', '[v]', '-map', '[a]',
		'-c:v', 'libx264', '-preset', 'slow', '-crf', process.env.CRF ?? '20', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', String(FPS),
		'-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-metadata', `title=${record.scenario.title}`, '-metadata', `comment=${record.scenario.id}`, mp4]);

	// Stills: the title card, a sentence in the middle and the last action's sentence (pointer and ring on the element).
	const stills = join(work, 'stills');
	rmSync(stills, { recursive: true, force: true });
	mkdirSync(stills, { recursive: true });
	const actions = cues.filter((c) => c.step);
	const middle = actions[Math.floor(actions.length / 2)] ?? cues[0];
	const last = actions.at(-1) ?? cues.at(-1);
	const at = (name, s) => ff(['-ss', s.toFixed(2), '-i', mp4, '-frames:v', '1', join(stills, `${name}.png`)]);
	at('01-title', leadIn / 2);
	at('02-middle', leadIn + (middle.from + middle.to) / 2);
	at('03-result', leadIn + (last.from + last.to) / 2);

	// Each sentence heard where it was put: speech onsets (silencedetect) within 0.3 s of the clip's place.
	const { stderr } = spawnSync(FFMPEG, ['-hide_banner', '-i', mp4, '-vn', '-af', 'silencedetect=noise=-40dB:d=0.12', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
	const onsets = [...String(stderr).matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
	const found = voices.filter((c) => onsets.some((o) => Math.abs(o - (leadIn + c.at)) <= 0.3)).length;
	return { seconds: seconds(mp4), size: `${width}×${H}`, audioCheck: { found, total: voices.length } };
}
