// Presence (Face ID) policy: which actions need a grant at each level, grants and their windows,
// the terminal sockets, and who may change the policy.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Routes } from '@vsremote/protocol';
import WebSocket from 'ws';
import { createAgentServer } from '../src/index.js';
import { DeviceRegistry, PRESENCE_WINDOWS } from '../src/devices.js';
import { x25519Pair } from '../src/e2e.js';
import { ROUTE_CLASSES, routeClass } from '../src/presence.js';
import { newPhone, PhoneSession } from './helpers/device-client.js';
import { openSocket } from './helpers/e2e-client.js';

const pairingToken = 'pairing-token';
const localSecret = 'l'.repeat(43);
const route = (r) => r.split(' ')[1];
const clock = { t: 5_000_000 };
const now = () => clock.t;
const advance = (seconds) => (clock.t += seconds * 1000);
let tmp;
let identity;
let server;
let registry;
let base;
let phone;

before(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'device-presence-'));
	identity = x25519Pair();
	registry = new DeviceRegistry(path.join(tmp, 'devices.json'), { now });
	server = createAgentServer({
		token: pairingToken,
		root: tmp,
		e2e: identity,
		devices: registry,
		localSecret,
		deviceOptions: { now },
		e2eOptions: { socket: { openTimeoutMs: 300 } },
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${server.address().port}`;
	phone = await signedIn();
});

after(async () => {
	server.killAllSessions();
	server.close();
	await fs.rm(tmp, { recursive: true, force: true });
});

async function signedIn(opts) {
	const p = await new PhoneSession(base, identity.publicKey, newPhone('phone', opts), pairingToken).open();
	assert.equal((await p.enroll()).status, 200);
	assert.equal((await p.login()).status, 200);
	return p;
}

const setPolicy = (level, window) => {
	const r = registry.setPresence({ level, window });
	assert.ok(!r.error);
};
const code = (res) => res.json().code;

test('every route has an explicit class', () => {
	for (const r of Object.values(Routes)) assert.ok(routeClass(r), `${r} has no presence class`);
	for (const r of Object.keys(ROUTE_CLASSES)) assert.ok(Object.values(Routes).includes(r), `${r} is not a route`);
});

test('at none nothing needs a grant', async () => {
	setPolicy('none', 300);
	assert.notEqual((await phone.request('POST', route(Routes.buildsStart), {})).status, 403);
	assert.notEqual((await phone.request('PUT', route(Routes.fsWrite) + '?path=' + encodeURIComponent(path.join(tmp, 'a.txt')), {})).status, 403);
});

test('at terminal the command-running routes need a grant and reading does not', async () => {
	setPolicy('terminal', 300);
	for (const [method, r] of [
		['POST', route(Routes.buildsStart)],
		['POST', route(Routes.agentsPrompt)],
		['POST', route(Routes.agentsKeys)],
		['POST', route(Routes.agentsLaunch)],
	]) {
		const res = await phone.request(method, r, {});
		assert.equal(res.status, 403, `${method} ${r}`);
		assert.equal(code(res), 'presence_required');
	}
	assert.equal((await phone.request('GET', route(Routes.fsList) + '?path=' + encodeURIComponent(tmp))).status, 200);
	assert.equal((await phone.request('GET', route(Routes.agentsSessions))).status, 200);
	// Writing files is not guarded at this level.
	assert.notEqual((await phone.request('PUT', route(Routes.fsWrite) + '?path=' + encodeURIComponent(path.join(tmp, 'w.txt')), {})).status, 403);
});

test('at terminal+writes writes, publishing, stopping and answering need a grant too', async () => {
	setPolicy('terminal+writes', 300);
	const guarded = [
		['PUT', route(Routes.fsWrite) + '?path=x'],
		['POST', route(Routes.fsMkdir) + '?path=x'],
		['POST', route(Routes.fsRename)],
		['DELETE', route(Routes.fsDelete) + '?path=x'],
		['POST', route(Routes.gitCommit)],
		['POST', route(Routes.gitDiscard)],
		['POST', route(Routes.gitPull)],
		['POST', route(Routes.gitPush)],
		['POST', route(Routes.gitCheckout)],
		['POST', route(Routes.gitStash)],
		['POST', route(Routes.portsKill)],
		['POST', route(Routes.previewShare)],
		['POST', route(Routes.agentsAnswer)],
		['POST', route(Routes.agentsStop)],
		['DELETE', route(Routes.termKill)],
	];
	for (const [method, r] of guarded) {
		const res = await phone.request(method, r, {});
		assert.equal(res.status, 403, `${method} ${r}`);
	}
	// Staging and reading stay free.
	assert.notEqual((await phone.request('POST', route(Routes.gitStage), {})).status, 403);
	assert.equal((await phone.request('GET', route(Routes.fsList) + '?path=' + encodeURIComponent(tmp))).status, 200);
});

test('a grant opens the guarded routes for its window and then lapses', async () => {
	for (const [name, seconds] of Object.entries(PRESENCE_WINDOWS)) {
		setPolicy('terminal', seconds);
		const p = await signedIn();
		assert.equal((await p.request('POST', route(Routes.buildsStart), {})).status, 403, name);
		const granted = await p.grant();
		assert.equal(granted.status, 200);
		assert.equal(granted.json().grantedFor, seconds);
		assert.notEqual((await p.request('POST', route(Routes.buildsStart), {})).status, 403, `${name} inside`);
		advance(seconds - 5);
		assert.notEqual((await p.request('POST', route(Routes.buildsStart), {})).status, 403, `${name} just inside`);
		advance(10);
		// A session lives an hour; once it lapsed the phone signs in again, silently.
		if ((await p.request('GET', '/api/info')).status === 401) assert.equal((await p.login()).status, 200);
		assert.equal((await p.request('POST', route(Routes.buildsStart), {})).status, 403, `${name} lapsed`);
	}
});

test('a grant is for its session and its key', async () => {
	setPolicy('terminal', 300);
	const p = await signedIn();
	// The device key can't stand in for the presence key.
	const wrong = await p.grant({ signer: p.phone.device });
	assert.equal(wrong.status, 401);
	assert.equal((await p.request('POST', route(Routes.buildsStart), {})).status, 403);
	// Another session's grant does not carry over.
	const q = await signedIn();
	assert.equal((await q.grant()).status, 200);
	assert.equal((await p.request('POST', route(Routes.buildsStart), {})).status, 403);
	// A challenge works once.
	const ch = (await p.request('POST', route(Routes.presenceChallenge))).json();
	assert.ok(ch.nonce);
});

test('a device without a presence key cannot be granted and is refused the guarded routes', async () => {
	setPolicy('terminal', 300);
	const bare = await signedIn({ presence: false });
	const res = await bare.request('POST', route(Routes.presenceChallenge));
	assert.equal(res.status, 409);
	assert.equal((await bare.request('POST', route(Routes.buildsStart), {})).status, 403);
	assert.equal((await bare.request('GET', route(Routes.fsList) + '?path=' + encodeURIComponent(tmp))).status, 200);
});

test('the terminal socket needs a grant: sealed and plain', async () => {
	setPolicy('terminal', 300);
	const p = await signedIn();
	const sealed = await openSocket(base, identity.publicKey, 'term', { cols: 80, rows: 24 }, { token: p.token, WebSocket });
	sealed.open();
	await sealed.waitFor((f, closed) => closed);
	assert.equal(sealed.closed, 4403);
	assert.deepEqual(sealed.frames, []);

	const plain = new WebSocket(base.replace('http', 'ws') + '/api/term/ws', { headers: { authorization: `Bearer ${p.token}` } });
	const status = await new Promise((resolve) => {
		plain.on('unexpected-response', (_, res) => resolve(res.statusCode));
		plain.on('open', () => resolve(101));
		plain.on('error', () => {});
	});
	assert.equal(status, 403);

	assert.equal((await p.grant()).status, 200);
	const ok = await openSocket(base, identity.publicKey, 'term', { cols: 80, rows: 24 }, { token: p.token, WebSocket });
	ok.open();
	const session = await ok.waitFor((f) => f.find((x) => !x.bad && !x.binary && x.data.toString().includes('"session"')));
	const id = JSON.parse(session.data.toString()).id;
	ok.ws.close();
	// Reattaching inside the window needs no new Face ID.
	advance(120);
	const again = await openSocket(base, identity.publicKey, 'term', { id }, { token: p.token, WebSocket });
	again.open();
	await again.waitFor((f) => f.length > 0);
	assert.equal(again.closed, null);
	again.ws.close();
	// After the window it asks again.
	advance(400);
	const late = await openSocket(base, identity.publicKey, 'term', { id }, { token: p.token, WebSocket });
	late.open();
	await late.waitFor((f, closed) => closed);
	assert.equal(late.closed, 4403);
	// The agents feed is not guarded.
	const feed = await openSocket(base, identity.publicKey, 'agents', {}, { token: p.token, WebSocket });
	feed.open();
	await feed.waitFor((f) => f.length > 0);
	feed.ws.close();
	registry.setPresence({ level: 'terminal' });
});

test('tightening the policy needs a session, relaxing it needs a grant', async () => {
	setPolicy('terminal', 300);
	const p = await signedIn();
	const put = (body) => p.request('PUT', route(Routes.devicePolicy), body);
	assert.equal((await put({ level: 'terminal+writes' })).status, 200);
	assert.equal((await put({ window: 1800 })).status, 403, 'a longer window needs Face ID');
	assert.equal(code(await put({ window: 1800 })), 'presence_required');
	assert.equal((await put({ level: 'none' })).status, 403, 'a lower level needs Face ID');
	assert.equal(registry.presence.level, 'terminal+writes');
	assert.equal((await put({ window: 300 })).status, 200, 'a shorter window is free');
	assert.equal((await put({ window: 7200 })).status, 400);
	assert.equal((await put({ level: 'everything' })).status, 400);
	assert.deepEqual(registry.presence, { level: 'terminal+writes', window: 300 });

	assert.equal((await p.grant()).status, 200);
	assert.equal((await put({ window: 3600 })).status, 200);
	assert.equal((await put({ level: 'none' })).status, 200);
	assert.deepEqual(registry.presence, { level: 'none', window: 3600 });
});

test('the computer changes the policy without a grant', async () => {
	setPolicy('terminal+writes', 300);
	const res = await fetch(base + route(Routes.devicePolicy), {
		method: 'PUT',
		headers: { authorization: `Local ${localSecret}`, 'content-type': 'application/json' },
		body: JSON.stringify({ level: 'none', window: 3600 }),
	});
	assert.equal(res.status, 200);
	assert.deepEqual(registry.presence, { level: 'none', window: 3600 });
	setPolicy('terminal', 300);
});

test('a grant outlives the session it was made in', async () => {
	setPolicy('terminal', 3600);
	const p = await signedIn();
	assert.equal((await p.grant()).status, 200);
	advance(1800);
	// Half an hour later: a new session of the same device, no new Face ID needed.
	assert.equal((await p.login()).status, 200);
	assert.notEqual((await p.request('POST', route(Routes.buildsStart), {})).status, 403);
	advance(1900);
	assert.equal((await p.login()).status, 200);
	assert.equal((await p.request('POST', route(Routes.buildsStart), {})).status, 403);
	setPolicy('terminal', 300);
});

test('info reports the level and the window to a device', async () => {
	setPolicy('terminal+writes', 1800);
	const p = await signedIn();
	const info = (await p.request('GET', '/api/info')).json();
	assert.equal(info.devices.presence, 'terminal+writes');
	assert.equal(info.devices.presenceWindow, 1800);
	setPolicy('terminal', 300);
});

test('the policy survives a restart', async () => {
	setPolicy('terminal+writes', 3600);
	const again = new DeviceRegistry(registry.file);
	assert.deepEqual(again.presence, { level: 'terminal+writes', window: 3600 });
	setPolicy('terminal', 300);
});
