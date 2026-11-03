// End-to-end encryption over HTTP: the handshake, sealed requests through the real routes, replay,
// tickets, and what stays plaintext.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { E2E_HANDSHAKE_PATH, E2E_REQUEST_PATH, E2E_SESSION_HEADER, Routes } from '@vsremote/protocol';
import https from 'node:https';
import { createAgentServer } from '../src/index.js';
import { lanCertificate } from '../src/lan.js';
import { x25519Pair } from '../src/e2e.js';
import { handshake } from './helpers/e2e-client.js';

const token = 'pairing-token';
const bearer = { authorization: `Bearer ${token}` };
let tmp;
let identity;
let server;
let base;

before(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-server-'));
	await fs.writeFile(path.join(tmp, 'note.txt'), 'top secret contents');
	await fs.writeFile(path.join(tmp, 'big.bin'), Buffer.alloc(9 * 1024 * 1024, 1));
	identity = x25519Pair();
	server = createAgentServer({ token, root: tmp, e2e: identity, uploadsDir: path.join(tmp, 'uploads') });
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	server.killAllSessions();
	server.close();
	await fs.rm(tmp, { recursive: true, force: true });
});

const path_ = (p) => `/api/fs/read?path=${encodeURIComponent(p)}`;

test('info advertises support without the key', async () => {
	const res = await fetch(base + Routes.info.split(' ')[1], { headers: bearer });
	const info = await res.json();
	assert.deepEqual(info.e2e, { version: 1 });
	assert.ok(!JSON.stringify(info).includes(identity.publicKey.toString('base64url')));
	assert.ok(!JSON.stringify(info).includes(identity.publicKey.toString('hex')));
});

test('a sealed request returns what the plaintext call returns', async () => {
	const s = await handshake(base, identity.publicKey);
	const sealed = await s.request('GET', '/api/fs/list?path=' + encodeURIComponent(tmp), { headers: bearer });
	const plain = await (await fetch(base + '/api/fs/list?path=' + encodeURIComponent(tmp), { headers: bearer })).json();
	assert.equal(sealed.status, 200);
	assert.deepEqual(sealed.json(), plain);
	const file = await s.request('GET', path_(path.join(tmp, 'note.txt')), { headers: bearer });
	assert.equal(file.body.toString(), 'top secret contents');
});

test('a sealed request carries a body and nothing readable goes over the wire', async () => {
	const s = await handshake(base, identity.publicKey);
	const target = path.join(tmp, 'written.txt');
	const body = Buffer.from('written through the envelope');
	const { wire } = s.sealRequest('PUT', '/api/fs/write?path=' + encodeURIComponent(target), { headers: bearer, body });
	assert.ok(!wire.includes(Buffer.from(token)));
	assert.ok(!wire.includes(Buffer.from('written')));
	assert.ok(!wire.includes(Buffer.from('/api/fs')));
	const res = await s.postWire(wire);
	assert.equal(res.status, 200);
	assert.equal(await fs.readFile(target, 'utf8'), 'written through the envelope');
});

test('a missing or wrong token inside is a sealed 401', async () => {
	const s = await handshake(base, identity.publicKey);
	assert.equal((await s.request('GET', '/api/fs/list')).status, 401);
	assert.equal((await s.request('GET', '/api/fs/list', { headers: { authorization: 'Bearer nope' } })).status, 401);
});

test('routes that throw come back sealed with their status', async () => {
	const s = await handshake(base, identity.publicKey);
	const missing = await s.request('GET', path_(path.join(tmp, 'absent.txt')), { headers: bearer });
	assert.equal(missing.status, 404);
	const outside = await s.request('GET', path_('/etc/hosts'), { headers: bearer });
	assert.equal(outside.status, 403);
});

test('the handshake needs no token, and a bad one is refused', async () => {
	const bad = (body, headers = { 'content-type': 'application/json' }) =>
		fetch(base + E2E_HANDSHAKE_PATH, { method: 'POST', headers, body });
	assert.equal((await bad('not json')).status, 400);
	assert.equal((await bad(JSON.stringify({ v: 9, epk: 'x' }))).status, 400);
	assert.equal((await bad(JSON.stringify({ v: 1, epk: 'short' }))).status, 400);
	assert.equal((await fetch(base + E2E_HANDSHAKE_PATH)).status, 405);
});

test('a tampered envelope runs nothing', async () => {
	const s = await handshake(base, identity.publicKey);
	const target = path.join(tmp, 'tampered.txt');
	const { wire } = s.sealRequest('PUT', '/api/fs/write?path=' + encodeURIComponent(target), { headers: bearer, body: 'x' });
	const bad = Buffer.from(wire);
	bad[bad.length - 1] ^= 1;
	assert.equal((await s.postWire(bad)).status, 400);
	await assert.rejects(fs.stat(target));
});

test('a replayed request is not run twice', async () => {
	const s = await handshake(base, identity.publicKey);
	const target = path.join(tmp, 'replayed.txt');
	const { wire } = s.sealRequest('POST', Routes.fsMkdir.split(' ')[1] + '?path=' + encodeURIComponent(target), { headers: bearer });
	assert.equal((await s.postWire(wire)).status, 200);
	await fs.rmdir(target);
	assert.equal((await s.postWire(wire)).status, 400);
	await assert.rejects(fs.stat(target));
});

test('requests that arrive out of order are both accepted', async () => {
	const s = await handshake(base, identity.publicKey);
	const first = s.sealRequest('GET', '/api/info', { headers: bearer });
	const second = s.sealRequest('GET', '/api/info', { headers: bearer });
	assert.equal((await s.postWire(second.wire)).status, 200);
	assert.equal((await s.postWire(first.wire)).status, 200);
});

test('an unknown session is told to handshake again', async () => {
	const s = await handshake(base, identity.publicKey);
	s.sid = 'does-not-exist';
	const { wire } = s.sealRequest('GET', '/api/info', { headers: bearer });
	const res = await s.postWire(wire);
	assert.equal(res.status, 401);
	assert.equal((await res.json()).code, 'e2e_session');
});

test('a sealed request cannot reach the envelope endpoints again', async () => {
	const s = await handshake(base, identity.publicKey);
	assert.equal((await s.request('POST', E2E_REQUEST_PATH, { headers: bearer })).status, 404);
	assert.equal((await s.request('POST', E2E_HANDSHAKE_PATH, { headers: bearer })).status, 404);
	assert.equal((await s.request('GET', '//evil.example/x', { headers: bearer })).status, 400);
	assert.equal((await s.request('bad method', '/api/info', { headers: bearer })).status, 400);
});

test('a response too large for one message says so', async () => {
	const s = await handshake(base, identity.publicKey);
	const big = await s.request('GET', path_(path.join(tmp, 'big.bin')), { headers: bearer });
	assert.equal(big.status, 413);
	assert.equal(big.json().code, 'e2e_too_large');
});

test('an outside X-E2E-Session header on a plain request changes nothing', async () => {
	const res = await fetch(base + '/api/info', { headers: { ...bearer, [E2E_SESSION_HEADER]: 'abc' } });
	assert.equal(res.status, 200);
});

test('plaintext with the token still works for local tools', async () => {
	assert.equal((await fetch(base + '/api/info', { headers: bearer })).status, 200);
	assert.equal((await fetch(base + '/api/info')).status, 401);
});

test('a wrong identity cannot be handshaken with', async () => {
	await assert.rejects(handshake(base, x25519Pair().publicKey), /prove its identity/);
});

test('a session serves sealed requests or one socket, not both', async () => {
	const s = await handshake(base, identity.publicKey);
	assert.equal((await s.request('GET', '/api/info', { headers: bearer })).status, 200);
	assert.ok(server.sealed.sessions.get(s.sid));
	assert.equal(server.sealed.sessions.claim(server.sealed.sessions.get(s.sid), 'ws'), false);
});

const mintTicket = async (s, body) =>
	s.request('POST', Routes.e2eTicket.split(' ')[1], { headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a read ticket opens one file, in ranges, and nothing else', async () => {
	const s = await handshake(base, identity.publicKey);
	const note = path.join(tmp, 'note.txt');
	const minted = await mintTicket(s, { scope: 'read', target: note });
	assert.equal(minted.status, 200);
	const auth = { authorization: `Ticket ${minted.json().ticket}` };
	// The file, with a byte range, the way media playback asks, as often as it likes.
	for (let i = 0; i < 3; i++) {
		const ranged = await fetch(base + path_(note), { headers: { ...auth, range: 'bytes=0-2' } });
		assert.equal(ranged.status, 206);
		assert.equal(await ranged.text(), 'top');
	}
	// Not another file next to it: a relay that copies the ticket gets this transfer only.
	await fs.writeFile(path.join(tmp, '.env'), 'SECRET=1');
	assert.equal((await fetch(base + path_(path.join(tmp, '.env')), { headers: auth })).status, 401);
	assert.equal((await fetch(base + path_(path.join(tmp, '.', 'note.txt')) + '&x=1', { headers: auth })).status, 200);
	assert.equal((await fetch(base + '/api/fs/read', { headers: auth })).status, 401);
	// Not the upload routes, not anything else.
	assert.equal((await fetch(base + '/api/agents/uploads?id=x', { headers: auth })).status, 401);
	assert.equal((await fetch(base + '/api/fs/list?path=' + encodeURIComponent(tmp), { headers: auth })).status, 401);
	assert.equal((await fetch(base + '/api/fs/write?path=' + encodeURIComponent(note), { method: 'PUT', headers: auth, body: 'x' })).status, 401);
	assert.equal((await fetch(base + '/api/term', { headers: auth })).status, 401);
	assert.equal((await fetch(base + path_(note), { headers: { authorization: 'Ticket forged' } })).status, 401);
	// A ticket can't mint another.
	assert.equal((await fetch(base + Routes.e2eTicket.split(' ')[1], { method: 'POST', headers: auth, body: '{"scope":"read"}' })).status, 401);
});

test('a ticket must say what it is for', async () => {
	const s = await handshake(base, identity.publicKey);
	assert.equal((await mintTicket(s, { scope: 'read' })).status, 400);
	assert.equal((await mintTicket(s, { scope: 'attachment' })).status, 400);
	assert.equal((await mintTicket(s, { scope: 'all' })).status, 400);
});

test('an upload ticket works once, and an attachment ticket reads one attachment', async () => {
	const s = await handshake(base, identity.publicKey);
	const { ticket } = (await mintTicket(s, { scope: 'upload' })).json();
	const post = () =>
		fetch(base + '/api/agents/uploads', {
			method: 'POST',
			headers: { authorization: `Ticket ${ticket}`, 'content-type': 'text/plain', 'x-filename': 'a.txt' },
			body: 'hello',
		});
	const first = await post();
	assert.equal(first.status, 200);
	const { id } = await first.json();
	assert.equal((await post()).status, 401, 'used up');
	const read = (await mintTicket(s, { scope: 'attachment', target: id })).json().ticket;
	const got = await fetch(base + `/api/agents/uploads?id=${encodeURIComponent(id)}`, { headers: { authorization: `Ticket ${read}` } });
	assert.equal(got.status, 200);
	assert.equal(await got.text(), 'hello');
	assert.equal((await fetch(base + '/api/agents/uploads?id=other', { headers: { authorization: `Ticket ${read}` } })).status, 401);
	assert.equal((await fetch(base + path_(path.join(tmp, 'note.txt')), { headers: { authorization: `Ticket ${read}` } })).status, 401);
});

test('ending the sealed sessions drops sessions and tickets', async () => {
	const s = await handshake(base, identity.publicKey);
	const { ticket } = (await mintTicket(s, { scope: 'read', target: path.join(tmp, 'note.txt') })).json();
	server.endSealedSessions();
	const { wire } = s.sealRequest('GET', '/api/info', { headers: bearer });
	assert.equal((await s.postWire(wire)).status, 401);
	assert.equal((await fetch(base + path_(path.join(tmp, 'note.txt')), { headers: { authorization: `Ticket ${ticket}` } })).status, 401);
});

test('without an identity there is nothing to hand-shake with', async () => {
	const bare = createAgentServer({ token, root: tmp });
	await new Promise((r) => bare.listen(0, '127.0.0.1', r));
	const b = `http://127.0.0.1:${bare.address().port}`;
	try {
		assert.equal((await fetch(b + E2E_HANDSHAKE_PATH, { method: 'POST', body: '{}' })).status, 404);
		assert.equal((await (await fetch(b + '/api/info', { headers: bearer })).json()).e2e, null);
	} finally {
		bare.killAllSessions();
		bare.close();
	}
});

test('a sealed request is answered for a client that disconnects without hanging the agent', async () => {
	const s = await handshake(base, identity.publicKey);
	const { wire } = s.sealRequest('GET', '/api/info', { headers: bearer });
	await new Promise((resolve) => {
		const req = http.request(base + E2E_REQUEST_PATH, { method: 'POST', headers: { [E2E_SESSION_HEADER]: s.sid } }, () => {});
		req.on('error', resolve);
		req.write(wire);
		req.destroy();
		setTimeout(resolve, 50);
	});
	assert.equal((await fetch(base + '/api/info', { headers: bearer })).status, 200);
});

test('handshakes are rationed', async () => {
	const limited = createAgentServer({ token, root: tmp, e2e: identity, e2eOptions: { handshakesPerMinute: 2 } });
	await new Promise((r) => limited.listen(0, '127.0.0.1', r));
	const b = `http://127.0.0.1:${limited.address().port}`;
	try {
		await handshake(b, identity.publicKey);
		await handshake(b, identity.publicKey);
		await assert.rejects(handshake(b, identity.publicKey), (e) => e.status === 429);
	} finally {
		limited.killAllSessions();
		limited.close();
	}
});

test('the identity key is shown on the LAN listener only, and never through loopback or the tunnel', async () => {
	const lan = await lanCertificate(path.join(tmp, 'lan'));
	const withLan = createAgentServer({ token, root: tmp, e2e: identity, lan, lanAddresses: () => ['192.168.1.5'] });
	await new Promise((r) => withLan.listen(0, '127.0.0.1', r));
	const lanPort = (await withLan.listenLan(0)).address().port;
	const loopback = `http://127.0.0.1:${withLan.address().port}`;
	const pk = identity.publicKey.toString('base64url');
	try {
		const overLan = await new Promise((resolve, reject) => {
			https
				.get({ host: '127.0.0.1', port: lanPort, path: '/api/info', headers: bearer, rejectUnauthorized: false, agent: false }, (res) => {
					let text = '';
					res.on('data', (c) => (text += c));
					res.on('end', () => resolve(JSON.parse(text)));
				})
				.on('error', reject);
		});
		assert.deepEqual(overLan.e2e, { version: 1, publicKey: pk });
		const plain = await (await fetch(loopback + '/api/info', { headers: bearer })).json();
		assert.deepEqual(plain.e2e, { version: 1 });
		// A sealed answer (the tunnel's path) doesn't carry it either.
		const s = await handshake(loopback, identity.publicKey);
		const sealed = (await s.request('GET', '/api/info', { headers: bearer })).json();
		assert.deepEqual(sealed.e2e, { version: 1 });
		assert.ok(!JSON.stringify(sealed).includes(pk));
	} finally {
		withLan.killAllSessions();
		withLan.close();
	}
});
