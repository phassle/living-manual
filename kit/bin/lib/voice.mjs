// Voices narration units with ElevenLabs text-to-speech (spec: Video), one MP3 clip per unit,
// measured with ffprobe. Clips are cached by a hash of model, voice, settings and the text
// around them in <cache>/voice/<hash>.mp3 (cache: $LM_CACHE_DIR, default ~/.cache/living-manual),
// so a rerun with unchanged narration asks ElevenLabs for nothing and needs no key.
// The key comes from an environment variable (the product's video.keyEnv, default
// ELEVENLABS_API_KEY) or from the file another one names (video.keyFileEnv, default
// ELEVENLABS_KEY_FILE). It is never written or logged.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
export const FFPROBE = process.env.FFPROBE || '/opt/homebrew/bin/ffprobe';

/** Defaults: "Alice", a premade (stock) ElevenLabs voice, and the multilingual v2 model. */
export const VOICE_DEFAULTS = {
	id: 'Xb7hH8MSUJpSbSDYk0k2',
	name: 'Alice',
	model: 'eleven_multilingual_v2',
	settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
	keyEnv: 'ELEVENLABS_API_KEY',
	keyFileEnv: 'ELEVENLABS_KEY_FILE',
};

export class MissingKey extends Error {}

export const voiceCache = () => join(process.env.LM_CACHE_DIR || join(homedir(), '.cache/living-manual'), 'voice');

export function seconds(file) {
	const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
	return Math.round(Number(out.trim()) * 1000) / 1000;
}

/** The product's voice settings: VOICE_DEFAULTS overridden by the config's `video.voice`. */
export function voiceSettings(section) {
	const v = section?.video?.voice ?? {};
	return { ...VOICE_DEFAULTS, ...v, settings: { ...VOICE_DEFAULTS.settings, ...(v.settings ?? {}) }, keyEnv: section?.video?.keyEnv ?? VOICE_DEFAULTS.keyEnv, keyFileEnv: section?.video?.keyFileEnv ?? VOICE_DEFAULTS.keyFileEnv };
}

function readKey(voice) {
	const direct = process.env[voice.keyEnv];
	if (direct) return direct.trim();
	const file = process.env[voice.keyFileEnv];
	if (file) return readFileSync(file, 'utf8').trim();
	throw new MissingKey(`set ${voice.keyEnv} to an ElevenLabs API key, or ${voice.keyFileEnv} to the path of a file holding one (needed only for clips not yet cached)`);
}

/**
 * Gives every unit a clip: { clip (absolute path), duration (s), hash }. Returns the count generated.
 * Units are voiced with the sentence before and after as context, so the voice runs on naturally.
 */
export async function voiceUnits(units, voice, say = (m) => console.log(m)) {
	const dir = voiceCache();
	mkdirSync(dir, { recursive: true });
	const base = process.env.LM_ELEVENLABS_URL || 'https://api.elevenlabs.io';
	let key = null;
	let generated = 0;
	for (const [i, u] of units.entries()) {
		const body = { text: u.speech, model_id: voice.model, voice_settings: voice.settings, previous_text: units[i - 1]?.speech ?? undefined, next_text: units[i + 1]?.speech ?? undefined };
		const hash = createHash('sha256').update(JSON.stringify([voice.id, body])).digest('hex').slice(0, 32);
		const clip = join(dir, `${hash}.mp3`);
		if (!existsSync(clip)) {
			key ??= readKey(voice);
			const res = await fetch(`${base}/v1/text-to-speech/${voice.id}?output_format=mp3_44100_128`, {
				method: 'POST',
				headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error(`ElevenLabs answered ${res.status} for unit ${u.id}: ${(await res.text()).slice(0, 300)}`);
			writeFileSync(`${clip}.part`, Buffer.from(await res.arrayBuffer()));
			renameSync(`${clip}.part`, clip);
			generated++;
			say(`  voiced ${u.id}: ${u.speech}`);
		}
		Object.assign(u, { clip, hash, duration: seconds(clip) });
	}
	return generated;
}
