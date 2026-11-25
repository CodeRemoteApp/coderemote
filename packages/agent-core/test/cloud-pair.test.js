// POST /api/cloud/pair: the pairing for the owner's phone, only sealed and only with the gate's word.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Routes } from '@vsremote/protocol';
import { createAgentServer } from '../src/index.js';
import { x25519Pair } from '../src/e2e.js';
import { handshake } from './helpers/e2e-client.js';

const PATH = Routes.cloudPair.split(' ')[1];
const GOOD = 'v1.k1.good.sig';
let tmp;
let identity;
const paired = [];
const pair = { enabled: true, check: async (a) => a === GOOD, onPaired: (name) => paired.push(name) };
const servers = [];

async function start(opts = {}) {
	const server = createAgentServer({ token: 'pairing-token', root: tmp, e2e: identity, uploadsDir: path.join(tmp, 'uploads'), agentId: 'agent-1', cloudPair: pair, ...opts });
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	servers.push(server);
	return `http://127.0.0.1:${server.address().port}`;
}

before(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-pair-'));
	identity = x25519Pair();
});

after(async () => {
	for (const s of servers) {
		s.killAllSessions();
		s.close();
	}
	await fs.rm(tmp, { recursive: true, force: true });
});

const ask = (s, { outer = { 'x-coderemote-owner': GOOD }, headers = {}, name = 'iPhone' } = {}) =>
	s.request('POST', PATH, { outer, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name }) });

test("the owner's sealed request gets the token and agent id, and the terminal is told", async () => {
	const base = await start();
	const res = await ask(await handshake(base, identity.publicKey), { name: 'Thanh\u0007 iPhone' });
	assert.equal(res.status, 200);
	assert.deepEqual(res.json(), { token: 'pairing-token', agentId: 'agent-1' });
	assert.equal(paired.at(-1), 'Thanh iPhone');
});

test('a plaintext request is refused and never sees the token', async () => {
	const base = await start();
	const res = await fetch(base + PATH, { method: 'POST', headers: { 'x-coderemote-owner': GOOD, 'content-type': 'application/json' }, body: '{}' });
	assert.equal(res.status, 403);
	const text = await res.text();
	assert.equal(JSON.parse(text).code, 'ESEALED');
	assert.ok(!text.includes('pairing-token'));
});

test('no, a bad, or only a sealed (client-written) owner header: ENOTOWNER', async () => {
	const base = await start();
	const s = await handshake(base, identity.publicKey);
	for (const opts of [{ outer: {} }, { outer: { 'x-coderemote-owner': 'v1.k1.bad.sig' } }, { outer: {}, headers: { 'x-coderemote-owner': GOOD } }]) {
		const res = await ask(s, opts);
		assert.equal(res.status, 403, JSON.stringify(opts));
		assert.equal(res.json().code, 'ENOTOWNER');
	}
});

test('turned off: ECLOUDPAIROFF; not a Cloud tunnel: 404', async () => {
	const off = await start({ cloudPair: { ...pair, enabled: false } });
	assert.equal((await ask(await handshake(off, identity.publicKey))).json().code, 'ECLOUDPAIROFF');
	const none = await start({ cloudPair: null });
	assert.equal((await ask(await handshake(none, identity.publicKey))).status, 404);
});

test('tries are rate-limited', async () => {
	const base = await start({ cloudPairsPerMinute: 2 });
	const s = await handshake(base, identity.publicKey);
	assert.equal((await ask(s, { outer: {} })).status, 403);
	assert.equal((await ask(s, { outer: {} })).status, 403);
	assert.equal((await ask(s)).status, 429);
});
