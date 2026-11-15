#!/usr/bin/env node
// Runs a command under the product's run lock (bin/lib/lock.mjs): waits while another run holds
// it, then runs the command and releases the lock when it ends. lm-run takes the same lock, so
// anything else that drives the live demo environment (setup, exploration, a manual reset) should
// go through here. A command already under the lock passes straight through.
//
// usage: node living-manual/kit/bin/lm-lock.mjs <product> -- <command…>
// Exit: the command's own exit code; 2 usage.
import { spawnSync } from 'node:child_process';
import { takeRunLock } from './lib/lock.mjs';

const [product, sep, ...command] = process.argv.slice(2);
if (!product || product.startsWith('-') || sep !== '--' || !command.length) {
	process.stderr.write('usage: lm-lock.mjs <product> -- <command…>\n');
	process.exit(2);
}
takeRunLock(product, command.join(' '));
process.exit(spawnSync(command.join(' '), { shell: '/bin/sh', stdio: 'inherit' }).status ?? 1);
