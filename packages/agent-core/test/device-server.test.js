// Device keys through the agent: enrolling, sessions, strict mode, local credential, revocation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Routes } from '@vsremote/protocol';
import WebSocket from 'ws';
import { createAgentServer } from '../src/index.js';
import { DeviceRegistry } from '../src/devices.js';
import { x25519Pair, b64u } from '../src/e2e.js';
import { lanCertificate } from '../src/lan.js';
import { newPhone, PhoneSession, signDevice } from './helpers/device-client.js';
import { openSocket } from './helpers/e2e-client.js';

const pairingToken = 'pairing-token';
const localSecret = 'l'.repeat(43);
const route = (r) => r.split(' ')[1];
const jsonHeaders = { 'content-type': 'application/json' };
let tmp;
let identity;
let server;
let base;
let lanPort;
let registry;
let enrolled = [];

const clock = { t: 1_000_000 };
const now = () => clock.t;

before(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'device-server-'));
	await fs.writeFile(path.join(tmp, 'note.txt'), 'hello');
	identity = x25519Pair();
	registry = new DeviceRegistry(path.join(tmp, 'devices.json'), { now });
	const lan = await lanCertificate(path.join(tmp, 'lan'));
	server = createAgentServer({
		token: pairingToken,
		root: tmp,
		agentId: 'agent-under-test',
		e2e: identity,
		devices: registry,
		localSecret,
		onDeviceEnrolled: (d) => enrolled.push(d),
		deviceOptions: { now },
		lan,
		lanAddresses: () => ['192.168.1.5'],
		uploadsDir: path.join(tmp, 'uploads'),
		e2eOptions: { socket: { openTimeoutMs: 300 } },
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	lanPort = (await server.listenLan(0)).address().port;
	base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	server.killAllSessions();
	server.close();
	await fs.rm(tmp, { recursive: true, force: true });
});

const newDevice = async (name, opts) => {
	const phone = newPhone(name, opts);
	const p = await new PhoneSession(base, identity.publicKey, phone, pairingToken).open();
	return p;
};

const plain = (method, p, { headers = {}, body } = {}) =>
	fetch(base + p, { method, headers: { ...jsonHeaders, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const pairingHeader = { authorization: `Bearer ${pairingToken}` };

test('1. before any device the pairing token works as it always did', async () => {
	const res = await plain('GET', '/api/info', { headers: pairingHeader });
	assert.equal(res.status, 200);
	const info = await res.json();
	assert.deepEqual(info.devices, { version: 2, strict: false, presence: 'terminal', presenceWindow: 300 });
	assert.equal((await plain('GET', '/api/fs/list?path=' + encodeURIComponent(tmp), { headers: pairingHeader })).status, 200);
});

test('2. enrolling needs a sealed request or the LAN, and valid keys', async () => {
	const phone = newPhone();
	// A plain request through the tunnel (loopback with no sealed marker) is refused.
	const refused = await plain('POST', route(Routes.deviceEnroll), {
		headers: pairingHeader,
		body: { name: 'x', deviceKey: phone.device.point },
	});
	assert.equal(refused.status, 403);
	assert.equal(registry.devices.size, 0);
	assert.equal(registry.strict, false);

	const p = await newDevice('bad');
	assert.equal((await p.withPairing('POST', route(Routes.deviceEnroll), { name: 'x', deviceKey: 'AAAA' })).status, 400);
	assert.equal((await p.withPairing('POST', route(Routes.deviceEnroll), { name: '', deviceKey: phone.device.point })).status, 400);
	assert.equal(registry.devices.size, 0);
});

test('3. forged internal headers from outside change nothing', async () => {
	const phone = newPhone();
	const res = await plain('POST', route(Routes.deviceEnroll), {
		headers: { ...pairingHeader, 'x-coderemote-inner': 'guess', 'x-coderemote-sid': 'whatever' },
		body: { name: 'x', deviceKey: phone.device.point },
	});
	assert.equal(res.status, 403);
	assert.equal(registry.devices.size, 0);
});

let first;
test('4. a sealed enrollment stores the device and tells the user', async () => {
	first = await newDevice('Thanh iPhone');
	const res = await first.enroll();
	assert.equal(res.status, 200);
	assert.match(res.json().id, /^[0-9a-f]{16}$/);
	assert.equal(enrolled.at(-1).name, 'Thanh iPhone');
	assert.equal(registry.strict, true);
});

test('5. strict: the pairing token is good for enrolling and nothing else', async () => {
	const other = await plain('GET', '/api/fs/list?path=' + encodeURIComponent(tmp), { headers: pairingHeader });
	assert.equal(other.status, 401);
	assert.deepEqual(await other.json(), { error: 'this machine needs an enrolled device', code: 'device_required', agentId: 'agent-under-test' });
	const info = await plain('GET', '/api/info', { headers: pairingHeader });
	assert.equal(info.status, 401);
	// A made-up bearer token is told its session is gone.
	const gone = await plain('GET', '/api/info', { headers: { authorization: 'Bearer nope' } });
	assert.equal(gone.status, 401);
	assert.equal((await gone.json()).code, 'device_session');
	assert.equal((await plain('GET', '/api/info')).status, 401);
	// Sealed, the same.
	const sealed = await first.withPairing('GET', route(Routes.fsList) + '?path=' + encodeURIComponent(tmp));
	assert.equal(sealed.status, 401);
	assert.equal(sealed.json().code, 'device_required');
});

test('6. a device signs a challenge for a session and uses it', async () => {
	const res = await first.login();
	assert.equal(res.status, 200);
	assert.equal(res.json().expiresIn, 3600);
	const list = await first.request('GET', route(Routes.fsList) + '?path=' + encodeURIComponent(tmp));
	assert.equal(list.status, 200);
	const info = (await first.request('GET', '/api/info')).json();
	assert.equal(info.devices.strict, true);
	const devices = (await first.request('GET', route(Routes.deviceList))).json().devices;
	assert.equal(devices.length, 1);
	assert.equal(devices[0].name, 'Thanh iPhone');
	assert.ok(!JSON.stringify(devices).includes(first.phone.device.point));
});

test('7. challenges are single use, per channel, per device, and tell nothing about unknown ids', async () => {
	const p = await newDevice('x');
	p.deviceId = first.deviceId;
	// The phone's signature made for another sealed session.
	const wrongChannel = await p.login(first.deviceId, { sid: 'another-session', signer: first.phone.device });
	assert.equal(wrongChannel.status, 401);
	// Another phone's key.
	const stranger = newPhone();
	assert.equal((await p.login(first.deviceId, { signer: stranger.device })).status, 401);
	// An id nobody enrolled answers like a bad signature.
	const unknown = await p.login('f'.repeat(16), { signer: first.phone.device });
	assert.equal(unknown.status, 401);
	assert.deepEqual(unknown.json(), wrongChannel.json());
	// A signed answer used twice.
	const { nonce } = (await p.http.request('POST', route(Routes.deviceChallenge), { headers: jsonHeaders, body: JSON.stringify({ deviceId: first.deviceId }) })).json();
	const body = JSON.stringify({ deviceId: first.deviceId, nonce, signature: signDevice(first.phone.device, nonce, p.http.sid) });
	assert.equal((await p.http.request('POST', route(Routes.deviceSession), { headers: jsonHeaders, body })).status, 200);
	assert.equal((await p.http.request('POST', route(Routes.deviceSession), { headers: jsonHeaders, body })).status, 401);
});

test('8. challenges and sessions are refused outside a sealed or LAN channel', async () => {
	assert.equal((await plain('POST', route(Routes.deviceChallenge), { body: { deviceId: first.deviceId } })).status, 403);
	assert.equal((await plain('POST', route(Routes.deviceSession), { body: { deviceId: first.deviceId, nonce: 'x', signature: 'y' } })).status, 403);
});

test('9. a device session cannot enroll, only the pairing token can', async () => {
	assert.equal((await first.request('POST', route(Routes.deviceEnroll), { name: 'sneaky', deviceKey: newPhone().device.point })).status, 403);
	assert.equal(registry.devices.size, 1);
});

let second;
test('10. a second device enrolls with the pairing token and has its own session', async () => {
	second = await newDevice('iPad');
	assert.equal((await second.enroll()).status, 200);
	assert.equal((await second.login()).status, 200);
	assert.notEqual(second.token, first.token);
	assert.equal(registry.devices.size, 2);
});

test('11. the local secret works on loopback, not as a bearer token, not on the LAN', async () => {
	const local = await plain('GET', route(Routes.deviceList), { headers: { authorization: `Local ${localSecret}` } });
	assert.equal(local.status, 200);
	assert.equal((await local.json()).devices.length, 2);
	assert.equal((await plain('GET', route(Routes.deviceList), { headers: { authorization: `Bearer ${localSecret}` } })).status, 401);
	assert.equal((await plain('GET', route(Routes.deviceList), { headers: { authorization: 'Local wrong' } })).status, 401);
	const overLan = await lanRequest('GET', route(Routes.deviceList), { authorization: `Local ${localSecret}` });
	assert.equal(overLan.status, 401);
});

function lanRequest(method, p, headers = {}, body) {
	return new Promise((resolve, reject) => {
		const req = https.request(
			{ host: '127.0.0.1', port: lanPort, path: p, method, headers: { ...jsonHeaders, ...headers }, rejectUnauthorized: false, agent: false },
			(res) => {
				let text = '';
				res.on('data', (c) => (text += c));
				res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
			},
		);
		req.on('error', reject);
		req.end(body === undefined ? undefined : JSON.stringify(body));
	});
}

test('12. over the LAN a device enrolls and mints a session inside pinned TLS', async () => {
	const phone = newPhone('LAN phone');
	const enroll = await lanRequest('POST', route(Routes.deviceEnroll), { authorization: `Bearer ${pairingToken}` }, {
		name: phone.name,
		deviceKey: phone.device.point,
		presenceKey: phone.presence.point,
	});
	assert.equal(enroll.status, 200);
	const { id } = enroll.json();
	const { nonce } = (await lanRequest('POST', route(Routes.deviceChallenge), {}, { deviceId: id })).json();
	const session = await lanRequest('POST', route(Routes.deviceSession), {}, { deviceId: id, nonce, signature: signDevice(phone.device, nonce, 'lan') });
	assert.equal(session.status, 200);
	const { token } = session.json();
	assert.equal((await lanRequest('GET', '/api/info', { authorization: `Bearer ${token}` })).status, 200);
	// A phone probing this address with the pairing token learns which agent answered, nothing more.
	const probe = await lanRequest('GET', '/api/info', { authorization: `Bearer ${pairingToken}` });
	assert.equal(probe.status, 401);
	assert.deepEqual(probe.json(), { error: 'this machine needs an enrolled device', code: 'device_required', agentId: 'agent-under-test' });
	// The same signature does not work through a sealed session.
	const p = await newDevice('x');
	const { nonce: n2 } = (await p.http.request('POST', route(Routes.deviceChallenge), { headers: jsonHeaders, body: JSON.stringify({ deviceId: id }) })).json();
	assert.equal((await p.http.request('POST', route(Routes.deviceSession), { headers: jsonHeaders, body: JSON.stringify({ deviceId: id, nonce: n2, signature: signDevice(phone.device, n2, 'lan') }) })).status, 401);
	// Revoke it: the LAN device is gone, the others stay.
	assert.ok(server.revokeDevice(id));
	assert.equal((await lanRequest('GET', '/api/info', { authorization: `Bearer ${token}` })).status, 401);
});

test('13. the computer revokes: a revoked phone loses its session, sockets and tickets', async () => {
	// A device may not revoke another without Face ID.
	const refused = await second.request('DELETE', route(Routes.deviceRevoke) + `?id=${first.deviceId}`);
	assert.equal(refused.status, 403);
	assert.equal(refused.json().code, 'presence_required');
	// Nor may the pairing token.
	assert.equal((await first.withPairing('DELETE', route(Routes.deviceRevoke) + `?id=${first.deviceId}`)).status, 401);
	const notePath = path.join(tmp, 'note.txt');
	const ticket = (await second.request('POST', route(Routes.e2eTicket), { scope: 'read', target: notePath })).json().ticket;
	const readTicket = () => plain('GET', route(Routes.fsRead) + '?path=' + encodeURIComponent(path.join(tmp, 'note.txt')), { headers: { authorization: `Ticket ${ticket}` } });
	assert.equal((await readTicket()).status, 200);
	registry.setPresence({ level: 'none' });
	const socket = await openSocket(base, identity.publicKey, 'term', { cols: 80, rows: 24 }, { token: second.token, WebSocket });
	socket.open();
	await socket.waitFor((f) => f.length > 0);

	const res = await plain('DELETE', route(Routes.deviceRevoke) + `?id=${second.deviceId}`, { headers: { authorization: `Local ${localSecret}` } });
	assert.equal(res.status, 200);
	await socket.waitFor((f, closed) => closed);
	assert.equal(socket.closed, 1008);
	assert.equal((await second.request('GET', '/api/info')).status, 401);
	assert.equal((await readTicket()).status, 401);
	assert.equal((await second.login()).status, 401, 'it can not get another session');
	// The other device carries on.
	assert.equal((await first.request('GET', '/api/info')).status, 200);
	assert.equal((await plain('DELETE', route(Routes.deviceRevoke) + '?id=nope', { headers: { authorization: `Local ${localSecret}` } })).status, 404);
	registry.setPresence({ level: 'terminal' });
});

test('13b. a device renames itself, revokes itself, and revokes another with Face ID', async () => {
	const third = await newDevice('iPhone');
	assert.equal((await third.enroll()).status, 200);
	assert.equal((await third.login()).status, 200);
	const renamed = await third.request('PUT', route(Routes.deviceName), { name: '  Work iPhone ' });
	assert.equal(renamed.status, 200);
	assert.equal(registry.get(third.deviceId).name, 'Work iPhone');
	assert.equal((await third.request('PUT', route(Routes.deviceName), { name: '' })).status, 400);
	assert.equal((await plain('PUT', route(Routes.deviceName), { headers: { authorization: `Local ${localSecret}` }, body: { name: 'x' } })).status, 403);

	// Revoking another needs a grant; with one it works.
	const fourth = await newDevice('old enrollment');
	assert.equal((await fourth.enroll()).status, 200);
	assert.equal((await third.request('DELETE', route(Routes.deviceRevoke) + `?id=${fourth.deviceId}`)).status, 403);
	assert.equal((await third.grant()).status, 200);
	assert.equal((await third.request('DELETE', route(Routes.deviceRevoke) + `?id=${fourth.deviceId}`)).status, 200);
	assert.equal(registry.get(fourth.deviceId), null);
	assert.equal((await third.request('DELETE', route(Routes.deviceRevoke) + '?id=nope')).status, 404);

	// Revoking itself needs no grant, and ends its own session.
	const fifth = await newDevice('pairing again');
	assert.equal((await fifth.enroll()).status, 200);
	assert.equal((await fifth.login()).status, 200);
	assert.equal((await fifth.request('DELETE', route(Routes.deviceRevoke) + `?id=${fifth.deviceId}`)).status, 200);
	assert.equal(registry.get(fifth.deviceId), null);
	assert.equal((await fifth.request('GET', '/api/info')).status, 401);
	assert.ok(server.revokeDevice(third.deviceId));
});

test('14. after the last device is revoked the agent stays strict', async () => {
	assert.equal((await plain('DELETE', route(Routes.deviceRevoke) + `?id=${first.deviceId}`, { headers: { authorization: `Local ${localSecret}` } })).status, 200);
	assert.equal(registry.devices.size, 0);
	assert.equal(registry.strict, true);
	assert.equal((await plain('GET', '/api/info', { headers: pairingHeader })).status, 401);
	// The token can still enroll, which is its one use.
	const again = await newDevice('again');
	assert.equal((await again.enroll()).status, 200);
	assert.equal((await again.login()).status, 200);
});

test('15. the CLI-style local secret reaches every route in strict mode', async () => {
	const res = await plain('GET', '/api/fs/list?path=' + encodeURIComponent(tmp), { headers: { authorization: `Local ${localSecret}` } });
	assert.equal(res.status, 200);
});
