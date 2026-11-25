// Cloud pairing on the agent: the folder's key and name go with its hostname, and only the gate's
// signed word for this computer's owner and hostname passes the owner check.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { after, test } from 'node:test';
import { create } from '../../../src/providers/cloud/index.js';
import { createOwnerCheck, verifyOwnerAssertion } from '../../../src/providers/cloud/owner.js';
import { fakeBackend, fakeConnector, memoryConfig, quiet } from './fakes.js';

const backends = [];
after(() => Promise.all(backends.map((b) => b.close())));
const NOW = 1_800_000_000;

async function keyPair(kid) {
	const pair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
	const publicKey = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
	const sign = async (claims) => {
		const message = `v1.${kid}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
		const sig = Buffer.from(await webcrypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, Buffer.from(message))).toString('base64url');
		return `${message}.${sig}`;
	};
	return { kid, publicKey, sign };
}

test('an assertion passes only for its uid and host, in date, signed by a listed key', async () => {
	const k = await keyPair('k1');
	const other = await keyPair('k1');
	const keys = { k1: k.publicKey };
	const good = await k.sign({ uid: 'u1', host: 'crabc', iat: NOW, exp: NOW + 60 });
	const opts = { publicKeys: keys, host: 'crabc', uid: 'u1', now: NOW };
	assert.ok(await verifyOwnerAssertion(good, opts));
	assert.equal(await verifyOwnerAssertion(good, { ...opts, uid: 'u2' }), null);
	assert.equal(await verifyOwnerAssertion(good, { ...opts, host: 'crxyz' }), null);
	assert.equal(await verifyOwnerAssertion(good, { ...opts, now: NOW + 91 }), null);
	assert.equal(await verifyOwnerAssertion(good, { ...opts, publicKeys: { k1: other.publicKey } }), null);
	assert.equal(await verifyOwnerAssertion(await k.sign({ uid: 'u1', host: 'crabc', iat: NOW, exp: NOW + 600 }), opts), null, 'too long-lived');
	assert.equal(await verifyOwnerAssertion(good.replace(/\.[^.]+$/, '.AAAA'), opts), null);
	assert.equal(await verifyOwnerAssertion(undefined, opts), null);
});

test('the check fetches the keys once, and again for an unknown key ID', async () => {
	const k1 = await keyPair('k1');
	const k2 = await keyPair('k2');
	let listed = [{ kid: 'k1', publicKey: k1.publicKey }];
	let fetches = 0;
	let ms = NOW * 1000;
	const check = createOwnerCheck({ api: { keys: async () => (fetches++, { keys: listed }) }, ownerUid: async () => 'u1', now: () => ms });
	assert.equal(await check(await k1.sign({ uid: 'u1', host: 'crabc', iat: NOW, exp: NOW + 60 }), 'crabc'), true);
	assert.equal(await check(await k1.sign({ uid: 'u1', host: 'crabc', iat: NOW, exp: NOW + 60 }), 'crabc'), true);
	assert.equal(fetches, 1);
	listed = [...listed, { kid: 'k2', publicKey: k2.publicKey }];
	assert.equal(await check(await k2.sign({ uid: 'u1', host: 'crabc', iat: NOW, exp: NOW + 60 }), 'crabc'), true, 'rotated key fetched');
	assert.equal(fetches, 2);
	assert.equal(await check(undefined, 'crabc'), false);
	assert.equal(await check(await k1.sign({ uid: 'u1', host: 'crabc', iat: NOW, exp: NOW + 60 }), null), false);
});

async function setup(opts = {}) {
	const backend = await fakeBackend();
	backends.push(backend);
	const conf = memoryConfig({ cloud: { credential: 'crm_test', account: 'owner@example.com', hostnames: {} }, agentIds: { 31580: 'agent-a' } });
	const provider = create({
		configDir: '/nonexistent',
		spinner: quiet,
		cfg: conf.cfg,
		saveConfig: conf.save,
		loadConfig: conf.load,
		env: { CODEREMOTE_CLOUD_API: backend.url },
		ensureCli: async () => '/bin/cloudflared',
		connector: fakeConnector().run,
		isTTY: () => false,
		...opts,
	});
	return { provider, backend };
}

test("the hostname request carries the folder's key and name, and nothing when pairing is off", async () => {
	const on = await setup({ pairing: () => ({ publicKey: 'K'.repeat(43), label: 'api' }) });
	await on.provider.ensure(31580);
	const put = on.backend.state.calls.find((c) => c.method === 'PUT');
	assert.deepEqual(put.body, { port: 31580, publicKey: 'K'.repeat(43), label: 'api' });

	const off = await setup();
	await off.provider.ensure(31580);
	assert.deepEqual(off.backend.state.calls.find((c) => c.method === 'PUT').body, { port: 31580 });
});

test("checkOwner takes the owner's uid from /v1/me and the hostname from the tunnel URL", async () => {
	const { provider, backend } = await setup();
	const k = await keyPair('k1');
	backend.state.keys = [{ kid: 'k1', publicKey: k.publicKey }];
	const now = Math.floor(Date.now() / 1000);
	const url = 'https://crabcdefghij.commitplus.app';
	assert.equal(await provider.checkOwner(await k.sign({ uid: 'u1', host: 'crabcdefghij', iat: now, exp: now + 60 }), url), true);
	assert.equal(await provider.checkOwner(await k.sign({ uid: 'someone', host: 'crabcdefghij', iat: now, exp: now + 60 }), url), false);
	assert.equal(await provider.checkOwner(await k.sign({ uid: 'u1', host: 'crother00000', iat: now, exp: now + 60 }), url), false);
	assert.equal(await provider.checkOwner(await k.sign({ uid: 'u1', host: 'crabcdefghij', iat: now, exp: now + 60 }), null), false);
});
