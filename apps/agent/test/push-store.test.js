import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pushStore } from '../src/push-store.js';

test('keeps each port’s registrations in its own private file', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coderemote-push-'));
	const a = pushStore(path.join(dir, 'push'), 31580);
	assert.deepEqual(a.load(), []);
	a.save([{ token: 'ab' }]);
	assert.deepEqual(a.load(), [{ token: 'ab' }]);
	assert.deepEqual(pushStore(path.join(dir, 'push'), 31581).load(), []);
	assert.equal(fs.statSync(path.join(dir, 'push', '31580.json')).mode & 0o777, 0o600);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('rotate-token deletes every push registration', () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coderemote-home-'));
	pushStore(path.join(home, '.coderemote', 'push'), 31580).save([{ token: 'ab' }]);
	const bin = new URL('../bin/coderemote.js', import.meta.url).pathname;
	execFileSync(process.execPath, [bin, 'rotate-token'], { env: { ...process.env, HOME: home }, stdio: 'pipe' });
	assert.equal(fs.existsSync(path.join(home, '.coderemote', 'push')), false);
	fs.rmSync(home, { recursive: true, force: true });
});
