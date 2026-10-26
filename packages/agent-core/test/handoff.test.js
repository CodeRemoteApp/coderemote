// The private-tunnel sign-in handoff, against an in-process agent with a fake token minter.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { TUNNEL_HANDOFF_PATH } from '@vsremote/protocol';
import { createAgentServer } from '../src/index.js';

const token = 'pairing-token';
let mints = 0;
const servers = [];
let tmpRoot;

async function start(tunnelToken) {
	const server = createAgentServer({ token, root: tmpRoot, tunnelToken });
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	servers.push(server);
	return `http://127.0.0.1:${server.address().port}`;
}

let base;
let anonymousBase;
before(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vsremote-handoff-'));
	base = await start(async () => ({ token: `tunnel-${++mints}`, expiresAt: Date.now() + 24 * 3_600_000 }));
	anonymousBase = await start(undefined);
});

after(async () => {
	for (const s of servers) s.close();
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

function link(baseUrl, { key = token, nonce = `${Math.floor(Date.now() / 1000)}.${Math.random().toString(36).slice(2)}`, state = 'state-12345' } = {}) {
	const url = new URL(TUNNEL_HANDOFF_PATH, baseUrl);
	url.searchParams.set('nonce', nonce);
	url.searchParams.set('sig', createHmac('sha256', key).update(nonce).digest('base64url'));
	url.searchParams.set('state', state);
	return url;
}

test('a signed handoff redirects to the app with a tunnel token', async () => {
	const res = await fetch(link(base), { redirect: 'manual' });
	assert.equal(res.status, 302);
	const target = new URL(res.headers.get('location'));
	assert.equal(target.protocol, 'vsremote:');
	assert.equal(target.host, 'tunnel-auth');
	assert.match(target.searchParams.get('token'), /^tunnel-\d+$/);
	assert.ok(Number(target.searchParams.get('expires')) > Date.now());
	assert.equal(target.searchParams.get('state'), 'state-12345');
	assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('links signed without the pairing token, stale or replayed are refused', async () => {
	assert.equal((await fetch(link(base, { key: 'wrong' }), { redirect: 'manual' })).status, 403);
	const stale = `${Math.floor(Date.now() / 1000) - 3600}.x`;
	assert.equal((await fetch(link(base, { nonce: stale }), { redirect: 'manual' })).status, 403);
	assert.equal((await fetch(link(base, { state: 'bad state!' }), { redirect: 'manual' })).status, 403);
	const once = link(base);
	assert.equal((await fetch(once, { redirect: 'manual' })).status, 302);
	assert.equal((await fetch(once, { redirect: 'manual' })).status, 403);
});

test('token renewal needs the bearer token and reuses a fresh token', async () => {
	const url = new URL('/api/tunnel/token', base);
	assert.equal((await fetch(url, { method: 'POST' })).status, 401);
	const before = mints;
	const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.match(body.token, /^tunnel-\d+$/);
	assert.equal(mints, before === 0 ? 1 : before, 'a token with >12h left is reused');
});

test('anonymous tunnels have nothing to hand out', async () => {
	assert.equal((await fetch(link(anonymousBase), { redirect: 'manual' })).status, 404);
	const res = await fetch(new URL('/api/tunnel/token', anonymousBase), { method: 'POST', headers: { authorization: `Bearer ${token}` } });
	assert.equal(res.status, 404);
});
