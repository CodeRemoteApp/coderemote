import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { keepAwake, keepAwakeCommand, WINDOWS_SCRIPT } from '../src/keep-awake.js';

function fakeSpawn(calls, { throws = false } = {}) {
	return (command, args, options) => {
		if (throws) throw new Error('nope');
		const child = new EventEmitter();
		child.stdin = new EventEmitter();
		child.killed = false;
		child.kill = () => (child.killed = true);
		child.unref = () => {};
		calls.push({ command, args, options, child });
		return child;
	};
}

test('macOS holds off idle sleep with caffeinate, tied to the agent pid', () => {
	assert.deepEqual(keepAwakeCommand('darwin', 4242), { command: 'caffeinate', args: ['-i', '-w', '4242'], tied: false });
});

test('Windows sets ES_CONTINUOUS | ES_SYSTEM_REQUIRED and waits for the agent', () => {
	const how = keepAwakeCommand('win32', 4242);
	assert.equal(how.command, 'powershell.exe');
	assert.ok(how.args.at(-1).endsWith(' 4242'));
	assert.match(WINDOWS_SCRIPT, /SetThreadExecutionState\(\[uint32\]2147483649\)/);
	assert.equal(2147483649, 0x80000000 + 0x1);
	assert.match(WINDOWS_SCRIPT, /Get-Process -Id \$args\[0\]/);
});

test('Linux takes a logind idle and sleep inhibitor, tied so it ends with the agent', () => {
	const how = keepAwakeCommand('linux', 1);
	assert.equal(how.command, 'systemd-inhibit');
	assert.ok(how.args.includes('--what=idle:sleep'));
	assert.equal(how.tied, true);
	const calls = [];
	keepAwake({ platform: 'linux', spawnFn: fakeSpawn(calls) });
	assert.equal(calls[0].command, '/bin/sh', 'through the watchdog');
	assert.ok(calls[0].args.includes('systemd-inhibit'));
});

test('stop() ends the holder; other platforms and a missing tool do nothing', () => {
	const calls = [];
	const awake = keepAwake({ platform: 'darwin', pid: 7, spawnFn: fakeSpawn(calls) });
	assert.equal(calls[0].command, 'caffeinate');
	awake.stop();
	assert.equal(calls[0].child.killed, true);
	calls[0].child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
	assert.equal(keepAwake({ platform: 'aix', spawnFn: fakeSpawn([]) }), null);
	assert.equal(keepAwake({ platform: 'darwin', spawnFn: fakeSpawn([], { throws: true }) }), null);
});
