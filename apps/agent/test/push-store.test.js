import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pushStore } from '../src/push-store.js';

test('keeps each port’s registrations in its own private file', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coderemote-push-'));
	const a = pushStore(path.join(dir, 'push'), 31580);
	assert.deepEqual(a.load(), []);
	a.save([{ token: 'ab' }]);
	assert.deepEqual(a.load(), [{ token: 'ab' }]);
	assert.deepEqual(pushStore(path.join(dir, 'push'), 31581).load(), []);
	// Windows has no file modes; the user's profile folder is private through its ACL.
	if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'push', '31580.json')).mode & 0o777, 0o600);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('rotate-token deletes every push registration and upload', () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coderemote-home-'));
	pushStore(path.join(home, '.coderemote', 'push'), 31580).save([{ token: 'ab' }]);
	fs.mkdirSync(path.join(home, '.coderemote', 'uploads', '2026-10-28'), { recursive: true });
	fs.writeFileSync(path.join(home, '.coderemote', 'uploads', '2026-10-28', 'x-shot.png'), 'png');
	const bin = fileURLToPath(new URL('../bin/coderemote.js', import.meta.url));
	// Windows finds the home folder through USERPROFILE.
	execFileSync(process.execPath, [bin, 'rotate-token'], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: 'pipe' });
	assert.equal(fs.existsSync(path.join(home, '.coderemote', 'push')), false);
	assert.equal(fs.existsSync(path.join(home, '.coderemote', 'uploads')), false);
	fs.rmSync(home, { recursive: true, force: true });
});
