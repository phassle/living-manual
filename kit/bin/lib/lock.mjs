// The run lock: one live demo environment per product, so one run at a time. A run holds
// <cache>/<product>/run.lock (cache: $LM_CACHE_DIR, default ~/.cache/living-manual) for its whole
// length; another run waits for it rather than failing. The file holds the holder's pid and
// command; a lock whose pid is gone is stale and taken over. A takeover is done under a second,
// short lock (<lock>.takeover, a directory: mkdir is atomic): the stale file is read again inside
// it and removed only when it still names the same dead pid, so two runs that find the same stale
// lock never both remove it, and one run never removes the lock another has just taken. Children of the holder inherit
// LM_RUN_LOCK=<lock file>, so a command run under the lock that asks for it again (lm-run inside
// lm-lock, say) gets it at once instead of waiting for itself.
import { mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const lockFile = (product) =>
	join(process.env.LM_CACHE_DIR || join(homedir(), '.cache/living-manual'), product, 'run.lock');

const alive = (pid) => {
	try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Removes the stale lock `seen` under the takeover lock, only if the file still holds exactly what
 * was read (the same dead pid and start time). Returns true when it removed it.
 */
function removeStale(file, seen) {
	const guard = `${file}.takeover`;
	try { mkdirSync(guard); } catch (e) {
		if (e.code !== 'EEXIST') throw e;
		// A takeover lock left by a run that died inside it (a few milliseconds' work) is old.
		try { if (Date.now() - statSync(guard).mtimeMs > 10_000) rmdirSync(guard); } catch { /* gone */ }
		return false;
	}
	try {
		let now = null;
		try { now = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return false; }
		const same = (now?.pid ?? null) === (seen?.pid ?? null) && (now?.since ?? null) === (seen?.since ?? null);
		if (!same || (now?.pid && alive(now.pid))) return false;
		rmSync(file, { force: true });
		return true;
	} finally {
		try { rmdirSync(guard); } catch { /* gone */ }
	}
}

/**
 * Takes the product's run lock, waiting while another live process holds it. Released when this
 * process exits (also on SIGINT/SIGTERM). `say` gets the waiting and takeover messages.
 */
export function takeRunLock(product, command, say = (m) => process.stderr.write(`${m}\n`)) {
	const file = lockFile(product);
	if (process.env.LM_RUN_LOCK === file) return file;
	mkdirSync(join(file, '..'), { recursive: true });
	let waiting = false;
	for (;;) {
		try {
			writeFileSync(file, JSON.stringify({ pid: process.pid, command, since: new Date().toISOString() }) + '\n', { flag: 'wx' });
			break;
		} catch (e) {
			if (e.code !== 'EEXIST') throw e;
		}
		let holder = null;
		try { holder = JSON.parse(readFileSync(file, 'utf8')); } catch { sleep(100); continue; }
		if (!holder?.pid || !alive(holder.pid)) {
			if (removeStale(file, holder)) say(`lock: removed stale run lock ${file} (pid ${holder?.pid ?? '?'} is gone)`);
			else sleep(20 + Math.random() * 30);
			continue;
		}
		if (!waiting) say(`lock: waiting for the run lock ${file}, held by pid ${holder.pid} since ${holder.since ?? '?'} (${holder.command ?? '?'})`);
		waiting = true;
		sleep(500);
	}
	if (waiting) say('lock: run lock taken');
	process.env.LM_RUN_LOCK = file;
	const release = () => {
		try { if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) rmSync(file, { force: true }); } catch { /* gone */ }
	};
	process.on('exit', release);
	for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { release(); process.exit(130); });
	return file;
}
