// `--tunnel`, `login --cloud`, `logout --cloud` and `tunnels` on Cloud, with the real CLI as a child
// process in a throwaway HOME, against the fake Cloud backend.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chooseProvider, rememberProvider } from '../src/providers/index.js';
import { fakeBackend } from './providers/cloud/fakes.js';

const BIN = fileURLToPath(new URL('../bin/coderemote.js', import.meta.url));
const backends = [];
after(() => Promise.all(backends.map((b) => b.close())));

function home(config) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cloud-cli-'));
	if (config) {
		fs.mkdirSync(path.join(dir, '.coderemote'), { mode: 0o700 });
		fs.writeFileSync(path.join(dir, '.coderemote', 'config.json'), JSON.stringify(config));
	}
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cloud-folder-'));
	return { dir, folder, config: () => JSON.parse(fs.readFileSync(path.join(dir, '.coderemote', 'config.json'), 'utf8')) };
}

/** Runs the CLI; never with a TTY, a browser, or the update check. */
function cli(h, args, { api = 'http://127.0.0.1:9', timeoutMs = 20_000 } = {}) {
	return new Promise((resolve) => {
		const fakeCloudflared = path.join(h.dir, 'cloudflared');
		fs.writeFileSync(fakeCloudflared, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
		const child = spawn(process.execPath, [BIN, ...args], {
			cwd: h.folder,
			env: {
				...process.env,
				HOME: h.dir,
				USERPROFILE: h.dir,
				CODEREMOTE_CLOUD_API: api,
				CODEREMOTE_CLOUDFLARED: fakeCloudflared,
				CODEREMOTE_NO_BROWSER: '1',
				CODEREMOTE_NO_UPDATE_CHECK: '1',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (out += d));
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		child.on('exit', (code) => {
			clearTimeout(timer);
			resolve({ code, out });
		});
	});
}

test('chooseProvider: the flag, else the remembered one, else Dev Tunnels; unknown names list the valid ones', () => {
	assert.equal(chooseProvider({ flag: 'cloud' }), 'cloud');
	assert.equal(chooseProvider({ remembered: 'cloud' }), 'cloud');
	assert.equal(chooseProvider({ flag: 'devtunnels', remembered: 'cloud' }), 'devtunnels');
	assert.equal(chooseProvider({}), 'devtunnels');
	assert.equal(chooseProvider({ remembered: 'gone' }), 'devtunnels');
	assert.throws(() => chooseProvider({ flag: 'ngrok' }), /Unknown --tunnel ngrok: use one of devtunnels, cloud/);
	assert.throws(() => chooseProvider({ flag: '__proto__' }), /Unknown --tunnel/);
});

test('rememberProvider writes nothing for a folder that never chose, and remembers a switch', () => {
	const cfg = {};
	assert.equal(rememberProvider(cfg, 31580, 'devtunnels'), false);
	assert.deepEqual(cfg, {});
	assert.equal(rememberProvider(cfg, 31580, 'cloud'), true);
	assert.equal(rememberProvider(cfg, 31580, 'cloud'), false);
	assert.equal(rememberProvider(cfg, 31580, 'devtunnels'), true);
	assert.deepEqual(cfg.tunnelProviders, { 31580: 'devtunnels' });
});

test('up with an unknown --tunnel exits naming the valid ones', async () => {
	const r = await cli(home(), ['up', '--tunnel', 'ngrok', '--no-lan']);
	assert.equal(r.code, 1);
	assert.match(r.out, /Unknown --tunnel ngrok: use one of devtunnels, cloud/);
});

test('Cloud refuses --allow-anonymous', async () => {
	const r = await cli(home(), ['up', '--tunnel', 'cloud', '--allow-anonymous', '--no-lan']);
	assert.equal(r.code, 1);
	assert.match(r.out, /always admits only its owner/);
});

test('a first Cloud start that fails (not signed in, no terminal) says what to run and saves no choice', async () => {
	const h = home();
	const r = await cli(h, ['up', '--tunnel', 'cloud', '--no-lan']);
	assert.equal(r.code, 1);
	assert.match(r.out, /Run `coderemote login --cloud`/);
	assert.equal(h.config().tunnelProviders, undefined);
});

test('a remembered Cloud choice is used without the flag', async () => {
	const h = home({ token: 'x'.repeat(43), folderPorts: {}, tunnelProviders: { 31580: 'cloud' } });
	const r = await cli(h, ['up', '--no-lan', '--port', '31580']);
	assert.equal(r.code, 1);
	assert.match(r.out, /Code Remote Cloud/);
	assert.doesNotMatch(r.out, /dev tunnels/i);
});

test('login --cloud saves the credential and says which account; denied, expired and no access save nothing', async () => {
	const backend = await fakeBackend();
	backends.push(backend);
	const h = home();
	const ok = await cli(h, ['login', '--cloud'], { api: backend.url });
	assert.equal(ok.code, 0, ok.out);
	assert.match(ok.out, /ABCD-EFGH/);
	assert.match(ok.out, /Signed this computer in to Code Remote Cloud as owner@example\.com/);
	assert.equal(h.config().cloud.credential, 'crm_test');
	assert.equal(fs.statSync(path.join(h.dir, '.coderemote', 'config.json')).mode & 0o777, 0o600);
	for (const [code, pattern] of [['EDENIED', /denied/], ['EEXPIRED', /expired/], ['ENOACCESS', /doesn't have Code Remote Cloud access/]]) {
		Object.assign(backend.state, { login: code, polls: 0 });
		const fresh = home();
		const r = await cli(fresh, ['login', '--cloud'], { api: backend.url });
		assert.notEqual(r.code, 0, code);
		assert.match(r.out, pattern, code);
		assert.equal(fs.existsSync(path.join(fresh.dir, '.coderemote', 'config.json')) ? fresh.config().cloud?.credential : undefined, undefined, code);
	}
});

test('logout --cloud while offline deletes the credential and mentions the 30-day cleanup', async () => {
	const h = home({ token: 'x'.repeat(43), cloud: { credential: 'crm_test', account: 'owner@example.com', hostnames: { 31580: { host: 'crabcdefghij.commitplus.app' } } } });
	const r = await cli(h, ['logout', '--cloud']);
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /after 30 days unused/);
	assert.equal(h.config().cloud.credential, undefined);
	assert.equal(h.config().cloud.hostnames, undefined);
});

test('logout --cloud online removes the machine', async () => {
	const backend = await fakeBackend();
	backends.push(backend);
	const h = home({ token: 'x'.repeat(43), cloud: { credential: 'crm_test' } });
	const r = await cli(h, ['logout', '--cloud'], { api: backend.url });
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /tunnel and hostnames are removed/);
	assert.deepEqual(backend.paths(), ['DELETE /v1/machine']);
});

test('tunnels on a Cloud folder lists its hostnames; --delete removes one', async () => {
	const backend = await fakeBackend();
	backends.push(backend);
	backend.state.hostnames.set('agent-a', { host: 'crabcdefghij.commitplus.app', port: 31580, lastSeen: 1_800_000_000 });
	const h = home();
	// The folder's port is keyed by its path as the CLI sees it (macOS tmp is behind a symlink).
	const folderPorts = { [h.folder]: 31580, [fs.realpathSync(h.folder)]: 31580 };
	fs.mkdirSync(path.join(h.dir, '.coderemote'), { recursive: true });
	fs.writeFileSync(
		path.join(h.dir, '.coderemote', 'config.json'),
		JSON.stringify({ token: 'x'.repeat(43), folderPorts, tunnelProviders: { 31580: 'cloud' }, cloud: { credential: 'crm_test', hostnames: { 31580: { host: 'crabcdefghij.commitplus.app' } } } }),
	);
	const list = await cli(h, ['tunnels'], { api: backend.url });
	assert.equal(list.code, 0, list.out);
	assert.match(list.out, /crabcdefghij\.commitplus\.app {2}port 31580 .*last used 2027-01-15/);
	const del = await cli(h, ['tunnels', '--delete', 'crabcdefghij'], { api: backend.url });
	assert.equal(del.code, 0, del.out);
	assert.match(del.out, /deleted crabcdefghij\.commitplus\.app/);
	assert.equal(backend.state.hostnames.size, 0);
	assert.deepEqual(h.config().cloud.hostnames, {});
});
