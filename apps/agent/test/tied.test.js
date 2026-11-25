// A tied child mirrors its command and ends with its owner, however the owner ends.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnTied } from '../src/tied.js';

const TIED = fileURLToPath(new URL('../src/tied.js', import.meta.url));
const skip = process.platform === 'win32';
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const until = async (check, ms = 3000) => {
	for (const end = Date.now() + ms; Date.now() < end; ) {
		if (check()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return check();
};
/** The pid of the command watchdog `shPid` runs (its first child; the stdin reader comes after). */
const commandOf = (shPid) => {
	try {
		return Math.min(...execFileSync('pgrep', ['-P', String(shPid)], { encoding: 'utf8' }).trim().split('\n').map(Number));
	} catch {
		return 0;
	}
};
const started = async (shPid) => (await until(() => commandOf(shPid) > 0)) && commandOf(shPid);

test('its output and exit code are the command\'s', { skip }, async () => {
	const child = spawnTied('sh', ['-c', 'echo ready; echo oops >&2; exit 7'], { stdout: 'pipe', stderr: 'pipe' });
	let out = '';
	child.stdout.on('data', (d) => (out += d));
	child.stderr.on('data', (d) => (out += d));
	const [code] = await once(child, 'exit');
	assert.equal(code, 7);
	assert.match(out, /ready/);
	assert.match(out, /oops/);
});

test('kill() ends the command, and exit reports it', { skip }, async () => {
	const child = spawnTied('sleep', ['60']);
	const pid = await started(child.pid);
	assert.ok(pid);
	child.kill();
	await once(child, 'exit');
	assert.ok(await until(() => !alive(pid)), 'the command outlived kill()');
});

test('the command ends when its owner is killed outright', { skip }, async () => {
	// An owner that starts a tied command, reports the watchdog's pid, then waits to be SIGKILLed.
	const owner = spawn(process.execPath, ['--input-type=module', '-e', `
		const { spawnTied } = await import(${JSON.stringify(TIED)});
		console.log(spawnTied('sleep', ['60']).pid);
		setInterval(() => {}, 1000);
	`], { stdio: ['ignore', 'pipe', 'inherit'] });
	const shPid = Number(await new Promise((r) => owner.stdout.once('data', (d) => r(String(d).trim()))));
	const pid = await started(shPid);
	assert.ok(pid && alive(pid));
	owner.kill('SIGKILL');
	assert.ok(await until(() => !alive(pid)), 'the command outlived its owner');
	assert.ok(await until(() => !alive(shPid)), 'the watchdog outlived its owner');
});

test('on Windows it is a plain spawn', () => {
	const calls = [];
	spawnTied('devtunnel', ['host', 'x'], { stdout: 'pipe', platform: 'win32', spawnFn: (...a) => calls.push(a) });
	assert.deepEqual(calls, [['devtunnel', ['host', 'x'], { stdio: ['ignore', 'pipe', 'ignore'] }]]);
});
