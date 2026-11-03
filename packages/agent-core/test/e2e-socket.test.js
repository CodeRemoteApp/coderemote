// Sealed WebSockets: a terminal and the agents feed, with every frame encrypted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createAgentServer } from '../src/index.js';
import { x25519Pair } from '../src/e2e.js';
import { handshake, openSocket } from './helpers/e2e-client.js';

const token = 'pairing-token';
let tmp;
let identity;
let server;
let base;

before(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-socket-'));
	identity = x25519Pair();
	server = createAgentServer({ token, root: tmp, e2e: identity, e2eOptions: { socket: { openTimeoutMs: 300 } } });
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	server.killAllSessions();
	server.close();
	await fs.rm(tmp, { recursive: true, force: true });
});

const term = (params = {}, opts = {}) => openSocket(base, identity.publicKey, 'term', { cols: 80, rows: 24, ...params }, { WebSocket, ...opts });

test('a terminal over a sealed socket runs commands and nothing readable goes over the wire', async () => {
	const c = await term();
	c.open();
	await c.waitFor((f) => f.some((x) => !x.bad && !x.binary && x.data.toString().includes('"session"')));
	const frame = c.sealFrame(1, 'echo sealed-$((6*7))\r');
	assert.ok(!frame.includes(Buffer.from('echo')));
	c.sendRaw(frame);
	await c.waitFor(() => c.output().includes('sealed-42'));
	assert.ok(c.frames.every((f) => !f.bad));
	c.ws.close();
});

test('a sealed terminal reattaches under a new session with its scrollback', async () => {
	const first = await term();
	first.open();
	const info = await first.waitFor((f) => f.find((x) => !x.bad && !x.binary && x.data.toString().includes('"session"')));
	const id = JSON.parse(info.data.toString()).id;
	first.sendBinary('echo remembered-$((1+1))\r');
	await first.waitFor(() => first.output().includes('remembered-2'));
	first.ws.close();
	const second = await term({ id });
	second.open();
	await second.waitFor(() => second.output().includes('remembered-2'));
	second.ws.close();
});

test('resize frames are understood', async () => {
	const c = await term();
	c.open();
	await c.waitFor((f) => f.length > 0);
	c.sendText(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
	c.sendBinary('stty size\r');
	await c.waitFor(() => c.output().includes('30 100'));
	c.ws.close();
});

test('the agents socket sends its snapshot sealed', async () => {
	const c = await openSocket(base, identity.publicKey, 'agents', {}, { WebSocket });
	c.open();
	const snap = await c.waitFor((f) => f.find((x) => !x.bad && JSON.parse(x.data.toString()).type === 'snapshot'));
	assert.equal(JSON.parse(snap.data.toString()).type, 'snapshot');
	c.ws.close();
});

test('the wrong token inside the open frame closes the socket', async () => {
	const c = await term({}, { token: 'nope' });
	c.open();
	await c.waitFor((f, closed) => closed);
	assert.equal(c.closed, 4401);
	assert.deepEqual(c.frames, []);
});

test('an unknown terminal id closes with not found', async () => {
	const c = await term({ id: 'missing' });
	c.open();
	await c.waitFor((f, closed) => closed);
	assert.equal(c.closed, 4404);
});

test('a socket that never opens is closed, and sends nothing before', async () => {
	const c = await term();
	await c.waitFor((f, closed) => closed);
	assert.equal(c.closed, 4408);
	assert.deepEqual(c.frames, []);
});

test('the wrong kind in the open frame is refused', async () => {
	const c = await term();
	c.open({ kind: 'agents' });
	await c.waitFor((f, closed) => closed);
	assert.equal(c.closed, 4400);
});

test('a replayed frame closes the socket', async () => {
	const c = await term();
	const open = c.sealFrame(0, JSON.stringify({ type: 'open', kind: 'term', token, cols: 80, rows: 24 }));
	c.sendRaw(open);
	await c.waitFor((f) => f.length > 0);
	c.sendRaw(open);
	await c.waitFor((f, closed) => closed);
	assert.equal(c.closed, 4400);
});

test('a dropped frame closes the socket', async () => {
	const c = await term();
	c.open();
	await c.waitFor((f) => f.length > 0);
	c.sealFrame(1, 'lost'); // sealed, never sent
	c.sendRaw(c.sealFrame(1, 'after the gap'));
	await c.waitFor((f, closed) => closed);
	assert.equal(c.closed, 4400);
});

test('a plaintext frame on a sealed socket closes it', async () => {
	const c = await term();
	c.ws.send('{"type":"open"}');
	await c.waitFor((f, closed) => closed);
	assert.equal(c.closed, 4400);
});

test('a tampered frame closes the socket', async () => {
	const c = await term();
	const frame = Buffer.from(c.sealFrame(0, JSON.stringify({ type: 'open', kind: 'term', token })));
	frame[frame.length - 1] ^= 1;
	c.sendRaw(frame);
	await c.waitFor((f, closed) => closed);
	assert.equal(c.closed, 4400);
});

test('an unknown session cannot upgrade', async () => {
	const ws = new WebSocket(base.replace('http', 'ws') + '/api/term/ws?e2e=nope');
	const status = await new Promise((resolve) => {
		ws.on('unexpected-response', (_, res) => resolve(res.statusCode));
		ws.on('error', () => {});
	});
	assert.equal(status, 401);
});

test('a session that served requests cannot also be a socket', async () => {
	const s = await handshake(base, identity.publicKey);
	await s.request('GET', '/api/info', { headers: { authorization: `Bearer ${token}` } });
	const ws = new WebSocket(base.replace('http', 'ws') + `/api/term/ws?e2e=${s.sid}`);
	const status = await new Promise((resolve) => {
		ws.on('unexpected-response', (_, res) => resolve(res.statusCode));
		ws.on('error', () => {});
	});
	assert.equal(status, 400);
});

test('a plain socket still works beside the sealed ones', async () => {
	const ws = new WebSocket(base.replace('http', 'ws') + '/api/agents/ws', { headers: { authorization: `Bearer ${token}` } });
	const first = await new Promise((resolve, reject) => {
		ws.once('message', (d) => resolve(JSON.parse(d.toString())));
		ws.once('error', reject);
	});
	assert.equal(first.type, 'snapshot');
	ws.close();
});
