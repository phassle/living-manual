// What a step record says once its clock readings and page addresses are left out. Two runs on unchanged code give
// the same stable record; anything else that differs (a label, a locator, a box, the product
// version, the run's outcome) means the product or the scenario changed. Used by lm-compare
// (run against run) and lm-manual (regenerate a page only when its sources changed).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Keys left out of the comparison. Clock readings differ on every run; a page address holds the
 * ids the server gave the records the run created, and a server may keep counting past a reset
 * (some servers do). What the reader sees is in the label and the screenshot, which are compared.
 */
const CLOCK = ['startedAt', 'endedAt', 'startMs', 'endMs'];
// scenario.spec is the spec's absolute path: the same spec in another checkout (a worktree, the
// writer's machine) has another one, and nothing the reader sees depends on it.
export const UNCOMPARED = new Set([...CLOCK, 'url', 'spec']);

const pick = (value, keep) => {
	if (Array.isArray(value)) return value.map((v) => pick(v, keep));
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k, v]) => keep(k, v)).map(([k, v]) => [k, pick(v, keep)]));
	return value;
};

/** The record without the keys that are not compared. */
export const stableRecord = (rec) => pick(rec, (k) => !UNCOMPARED.has(k));

/** Only the page addresses of a record (with the structure that leads to them). */
export const addresses = (rec) => pick(rec, (k, v) => k === 'url' || (v && typeof v === 'object'));

/** Where two stable records differ, as "path: before → after" lines. */
export function differences(a, b, path = '') {
	if (JSON.stringify(a) === JSON.stringify(b)) return [];
	const isObj = (v) => v && typeof v === 'object';
	if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) return [`${path || '(record)'}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`];
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
	return keys.flatMap((k) => differences(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : path ? `${path}.${k}` : k));
}

/** Reads a run folder's step record. */
export const readRecord = (runDir) => JSON.parse(readFileSync(join(runDir, 'step-record.json'), 'utf8'));

/** The screenshots a record names, in action order. */
export const screenshots = (rec) => rec.steps.flatMap((s) => s.actions.map((a) => a.screenshot));

/**
 * A fingerprint of everything a run's outputs are made from: the stable step record and the
 * bytes of every screenshot it names. Equal fingerprints mean the outputs would come out the same.
 * Pass `rec` when the screenshots' folder holds no step-record.json (the facts pack's screenshots).
 */
export function sourceFingerprint(runDir, rec = readRecord(runDir)) {
	const h = createHash('sha256').update(JSON.stringify(stableRecord(rec)));
	for (const shot of screenshots(rec)) h.update(shot).update(readFileSync(join(runDir, shot)));
	return h.digest('hex');
}
