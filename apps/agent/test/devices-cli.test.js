// `coderemote devices` and the local credential, against an in-process agent that this test registers
// in a throwaway home folder, with the real CLI as a child process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAgentServer, DeviceRegistry, loadLocalSecret } from '@vsremote/agent-core';
import { AgentRegistry } from '../src/registry.js';

const BIN = fileURLToPath(new URL('../bin/coderemote.js', import.meta.url));
let home;
let root;
let server;
let registry;
let port;

before(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), 'coderemote-devices-cli-'));
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'coderemote-devices-root-'));
	const config = path.join(home, '.coderemote');
	fs.mkdirSync(config, { recursive: true });
	fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ token: 'pair-token' }));
	registry = new DeviceRegistry(path.join(config, 'devices', 'x.json'));
	const { secret } = loadLocalSecret(path.join(config, 'local-secret'));
	server = createAgentServer({ token: 'pair-token', root, devices: registry, localSecret: secret });
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	port = server.address().port;
	new AgentRegistry(path.join(config, 'agents')).register({ port, root, url: `http://127.0.0.1:${port}` });
});

after(() => {
	server.close();
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(root, { recursive: true, force: true });
});

function cli(...args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [BIN, ...args, '--port', String(port)], { env: { ...process.env, HOME: home, USERPROFILE: home } });
		let out = '';
		child.stdout.on('data', (c) => (out += c));
		child.stderr.on('data', (c) => (out += c));
		child.on('close', (code) => resolve({ code, out }));
	});
}

const key = (n) => {
	// A valid P-256 point from a generated key.
	return import('node:crypto').then(({ generateKeyPairSync }) => {
		const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
		const jwk = publicKey.export({ format: 'jwk' });
		return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
	});
};

test('lists no phones, then the ones enrolled, and the policy', async () => {
	let res = await cli('devices');
	assert.equal(res.code, 0, res.out);
	assert.match(res.out, /Face ID: terminal, one check lasts 5m/);
	assert.match(res.out, /No phones enrolled yet/);
	const a = registry.enroll({ name: 'Thanh iPhone', deviceKey: await key(), presenceKey: await key() }).device;
	registry.enroll({ name: 'Old iPad', deviceKey: await key() });
	res = await cli('devices');
	assert.match(res.out, new RegExp(`${a.id}  Thanh iPhone`));
	assert.match(res.out, /Old iPad  \(no Face ID key\)/);
	assert.doesNotMatch(res.out, /applies once a phone is enrolled/);
});

test('the CLI works against a strict agent, with the local secret and without the pairing token', async () => {
	assert.equal(registry.strict, true);
	// The pairing token alone is turned away...
	const plain = await fetch(`http://127.0.0.1:${port}/api/term`, { headers: { authorization: 'Bearer pair-token' } });
	assert.equal(plain.status, 401);
	// ... yet the CLI still lists terminals.
	const res = await cli('status');
	assert.equal(res.code, 0, res.out);
	assert.doesNotMatch(res.out, /could not reach/);
});

test('sets the Face ID level and window', async () => {
	let res = await cli('devices', 'policy', 'terminal+writes', '--window', '1h');
	assert.equal(res.code, 0, res.out);
	assert.match(res.out, /Face ID: terminal\+writes, one check lasts 1h/);
	assert.deepEqual(registry.presence, { level: 'terminal+writes', window: 3600 });
	res = await cli('devices', 'policy', '--window', '30m');
	assert.deepEqual(registry.presence, { level: 'terminal+writes', window: 1800 });
	res = await cli('devices', 'policy', 'none');
	assert.deepEqual(registry.presence, { level: 'none', window: 1800 });
	assert.notEqual((await cli('devices', 'policy', 'sometimes')).code, 0);
	assert.notEqual((await cli('devices', 'policy', 'none', '--window', '2h')).code, 0);
	assert.notEqual((await cli('devices', 'policy')).code, 0);
});

test('revokes by id prefix', async () => {
	const [first] = registry.list();
	let res = await cli('devices', 'revoke', first.id.slice(0, 6));
	assert.equal(res.code, 0, res.out);
	assert.match(res.out, new RegExp(`Revoked ${first.name}`));
	assert.equal(registry.devices.size, 1);
	assert.notEqual((await cli('devices', 'revoke', 'nothing')).code, 0);
	assert.notEqual((await cli('devices', 'revoke')).code, 0);
	assert.equal(registry.strict, true, 'revoking does not reopen the agent');
});
