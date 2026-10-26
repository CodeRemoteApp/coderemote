import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { availableUpdate, installCommand, isNewer } from '../src/update.js';

test('compares versions', () => {
	assert.equal(isNewer('0.3.0', '0.2.0'), true);
	assert.equal(isNewer('0.2.10', '0.2.9'), true);
	assert.equal(isNewer('1.0.0', '0.9.9'), true);
	assert.equal(isNewer('0.2.0', '0.2.0'), false);
	assert.equal(isNewer('0.1.9', '0.2.0'), false);
	assert.equal(isNewer('0.2.0', '0.2.0-beta.1'), true, 'a release is newer than its own beta');
	assert.equal(isNewer('0.2.0-beta.1', '0.2.0'), false);
	assert.equal(isNewer('garbage', '0.2.0'), false);
	assert.equal(isNewer(undefined, '0.2.0'), false);
});

test('asks the registry at most once a day, and stays quiet offline', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coderemote-update-'));
	let calls = 0;
	const registry = (version) => async () => {
		calls++;
		return { ok: true, json: async () => ({ version }) };
	};
	const offline = async () => {
		calls++;
		throw new Error('offline');
	};
	const day = 24 * 3_600_000;

	assert.equal(await availableUpdate({ current: '0.2.0', dir, fetch: offline, now: 0 }), null);
	assert.equal(await availableUpdate({ current: '0.2.0', dir, fetch: registry('0.3.0'), now: 1 }), '0.3.0');
	calls = 0;
	assert.equal(await availableUpdate({ current: '0.2.0', dir, fetch: registry('0.4.0'), now: day / 2 }), '0.3.0', 'cached');
	assert.equal(calls, 0);
	assert.equal(await availableUpdate({ current: '0.3.0', dir, fetch: offline, now: day / 2 }), null, 'already on it');
	assert.equal(await availableUpdate({ current: '0.2.0', dir, fetch: offline, now: day + 2 }), '0.3.0', 'stale cache beats nothing');
	assert.equal(await availableUpdate({ current: '0.2.0', dir, fetch: registry('0.4.0'), now: day + 3 }), '0.4.0');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('updates with the package manager that installed it', () => {
	assert.deepEqual(installCommand('/opt/homebrew/lib/node_modules/coderemote/dist/coderemote.js'), ['npm', ['install', '-g', 'coderemote@latest']]);
	assert.deepEqual(installCommand('/Users/me/Library/pnpm/global/5/node_modules/coderemote/dist/coderemote.js')[0], 'pnpm');
	assert.deepEqual(installCommand('/Users/me/.bun/install/global/node_modules/coderemote/dist/coderemote.js')[0], 'bun');
	assert.deepEqual(installCommand('/Users/me/.config/yarn/global/node_modules/coderemote/dist/coderemote.js')[0], 'yarn');
});
