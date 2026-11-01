// The LAN listener: TLS in front of the same agent, the routes it refuses, and `lan` in /api/info.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { HOOK_SECRET_HEADER, Routes, TERMINAL_WS_PATH, TUNNEL_HANDOFF_PATH } from '@vsremote/protocol';
import WebSocket from 'ws';
import { createAgentServer } from '../src/index.js';
import { lanCertificate } from '../src/lan.js';
import { isWindows } from '../src/platform.js';

const token = 'pairing-token';
const hookSecret = 'hook-secret';
let tmp;
let lan;
let server;
let local;
let lanPort;
let hostedUrl = null;

before(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lan-server-'));
	lan = await lanCertificate(path.join(tmp, 'lan'));
	server = createAgentServer({
		token,
		root: tmp,
		hookSecret,
		lan,
		lanAddresses: () => ['192.168.1.5'],
		agentId: 'c'.repeat(32),
		tunnelUrl: () => hostedUrl,
		tunnelToken: async () => ({ token: 'tunnel-1', expiresAt: Date.now() + 3_600_000 }),
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	local = `http://127.0.0.1:${server.address().port}`;
	lanPort = (await server.listenLan(0)).address().port;
});

after(async () => {
	server.killAllSessions();
	server.close();
	await fs.rm(tmp, { recursive: true, force: true });
});

/** A request over the LAN listener, trusting only the agent's certificate, as the app pins it. */
function lanRequest(route, { method = 'GET', headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const req = https.request(
			{ host: '127.0.0.1', port: lanPort, path: route, method, headers, rejectUnauthorized: false, agent: false },
			(res) => {
				let text = '';
				res.on('data', (c) => (text += c));
				res.on('end', () => resolve({ status: res.statusCode, text, fp }));
			},
		);
		let fp;
		req.on('socket', (socket) =>
			socket.once('secureConnect', () => (fp = socket.getPeerX509Certificate().fingerprint256.replace(/:/g, '').toLowerCase())),
		);
		req.on('error', reject);
		req.end(body);
	});
}

const auth = { authorization: `Bearer ${token}` };
/** `Routes` name the method too: `GET /api/info`. */
const at = (route) => route.split(' ')[1];
const infoPath = at(Routes.info);

test('the API answers over TLS with the agent certificate and the bearer token', async () => {
	const res = await lanRequest(infoPath, { headers: auth });
	assert.equal(res.status, 200);
	assert.equal(res.fp, lan.fingerprint);
	const info = JSON.parse(res.text);
	assert.deepEqual(info.lan, { port: lanPort, addresses: ['192.168.1.5'], fingerprint: lan.fingerprint });
	// The same answer over loopback, where the tunnel delivers.
	const viaLoopback = await (await fetch(new URL(infoPath, local), { headers: auth })).json();
	assert.deepEqual(viaLoopback.lan, info.lan);
});

test('without the token the LAN listener answers 401', async () => {
	assert.equal((await lanRequest(infoPath)).status, 401);
});

test('a terminal opens over wss', { skip: isWindows }, async () => {
	const ws = new WebSocket(`wss://127.0.0.1:${lanPort}${TERMINAL_WS_PATH}?cols=80&rows=24`, { headers: auth, rejectUnauthorized: false });
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});
	ws.close();
});

function handoffLink() {
	const nonce = `${Math.floor(Date.now() / 1000)}.${Math.random().toString(36).slice(2)}`;
	const q = new URLSearchParams({ nonce, sig: createHmac('sha256', token).update(nonce).digest('base64url'), state: 'state-12345' });
	return `${TUNNEL_HANDOFF_PATH}?${q}`;
}

test('the sign-in handoff is refused over LAN and still works over loopback', async () => {
	assert.equal((await lanRequest(handoffLink())).status, 404);
	assert.equal((await fetch(new URL(handoffLink(), local), { redirect: 'manual' })).status, 302);
});

test('hook deliveries are refused over LAN, even with the secret', async () => {
	const [method, route] = Routes.agentsHook.split(' ');
	const body = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'lan-hook', cwd: tmp });
	const headers = { [HOOK_SECRET_HEADER]: hookSecret, 'content-type': 'application/json' };
	assert.equal((await lanRequest(route, { method, headers, body })).status, 404);
	const res = await fetch(new URL(route, local), { method, headers, body });
	assert.equal(res.status, 200);
});

test('tunnel tokens, tunnel management, previews and install links are refused over LAN', async () => {
	for (const route of [Routes.tunnelToken, Routes.tunnelStatus, Routes.tunnelDelete, Routes.previewList, Routes.previewOpen, Routes.previewShare, Routes.buildsInstall]) {
		const [method, path] = route.split(' ');
		assert.equal((await lanRequest(path, { method, headers: auth })).status, 404, route);
	}
	// Still answered over loopback, where the tunnel delivers (after the relay's sign-in).
	const renewed = await fetch(new URL(at(Routes.tunnelToken), local), { method: 'POST', headers: auth });
	assert.equal(renewed.status, 200);
});

test('/api/info reports the agent id, and the tunnel once it is hosted', async () => {
	const before = JSON.parse((await lanRequest(infoPath, { headers: auth })).text);
	assert.equal(before.agentId, 'c'.repeat(32));
	assert.equal(before.tunnel, null);
	hostedUrl = 'https://x-31580.asse.devtunnels.ms';
	const after = JSON.parse((await lanRequest(infoPath, { headers: auth })).text);
	assert.deepEqual(after.tunnel, { url: hostedUrl });
	assert.equal(after.agentId, before.agentId);
	hostedUrl = null;
});

test('without a LAN listener, /api/info says lan: null', async () => {
	const bare = createAgentServer({ token, root: tmp });
	await new Promise((r) => bare.listen(0, '127.0.0.1', r));
	const info = await (await fetch(`http://127.0.0.1:${bare.address().port}${infoPath}`, { headers: auth })).json();
	assert.equal(info.lan, null);
	bare.close();
	await assert.rejects(bare.listenLan(0), /certificate/);
});
