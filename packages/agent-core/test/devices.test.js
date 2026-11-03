// Device keys: P-256 verification, the registry, challenges, sessions, grants and the local secret.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { b64u } from '../src/e2e.js';
import * as D from '../src/devices.js';
import { isWindows } from '../src/platform.js';
import { newPhone, p256Pair, signDevice, signPresence, signRaw } from './helpers/device-client.js';

const vectors = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../protocol/device-vectors.json', import.meta.url)), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'devices-'));
const registry = (opts) => new D.DeviceRegistry(path.join(tmp(), 'devices.json'), opts);
const enroll = (reg, phone = newPhone()) => reg.enroll({ name: phone.name, deviceKey: phone.device.point, presenceKey: phone.presence?.point }).device;

test('matches the shared vectors', () => {
	const nonce = Buffer.from(vectors.nonce, 'base64url');
	assert.equal(D.deviceMessage(nonce, vectors.channel).toString('hex'), vectors.deviceMessage);
	assert.ok(D.verifySignature(D.importPoint(vectors.deviceKey), D.deviceMessage(nonce, vectors.channel), vectors.deviceSignature));
	assert.equal(D.presenceMessage(nonce, vectors.sessionToken).toString('hex'), vectors.presenceMessage);
	assert.ok(D.verifySignature(D.importPoint(vectors.presenceKey), D.presenceMessage(nonce, vectors.sessionToken), vectors.presenceSignature));
	// Not the other key's, nor for another channel or session.
	assert.ok(!D.verifySignature(D.importPoint(vectors.presenceKey), D.deviceMessage(nonce, vectors.channel), vectors.deviceSignature));
	assert.ok(!D.verifySignature(D.importPoint(vectors.deviceKey), D.deviceMessage(nonce, 'OTHER'), vectors.deviceSignature));
	assert.ok(!D.verifySignature(D.importPoint(vectors.presenceKey), D.presenceMessage(nonce, 'other-token'), vectors.presenceSignature));
});

test('points that are not on P-256 are refused', () => {
	assert.ok(D.importPoint(p256Pair().point));
	assert.equal(D.importPoint('short'), null);
	assert.equal(D.importPoint(b64u(Buffer.alloc(65, 4))), null, 'a point off the curve');
	assert.equal(D.importPoint(b64u(Buffer.alloc(65, 0))), null, 'not uncompressed');
	assert.equal(D.importPoint(null), null);
});

test('signatures that are malformed or tampered fail', () => {
	const pair = p256Pair();
	const key = D.importPoint(pair.point);
	const sig = signRaw(pair, Buffer.from('hi'));
	assert.ok(D.verifySignature(key, Buffer.from('hi'), sig));
	assert.ok(!D.verifySignature(key, Buffer.from('ho'), sig));
	assert.ok(!D.verifySignature(key, Buffer.from('hi'), sig.slice(0, -2)));
	assert.ok(!D.verifySignature(key, Buffer.from('hi'), null));
	assert.ok(!D.verifySignature(null, Buffer.from('hi'), sig));
});

test('enrolling stores the device, makes the agent strict and survives a restart', () => {
	const file = path.join(tmp(), 'devices.json');
	const reg = new D.DeviceRegistry(file);
	assert.equal(reg.strict, false);
	const phone = newPhone('Thanh iPhone');
	const device = enroll(reg, phone);
	assert.match(device.id, /^[0-9a-f]{16}$/);
	assert.equal(reg.strict, true);
	if (!isWindows) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	const again = new D.DeviceRegistry(file);
	assert.equal(again.strict, true);
	assert.equal(again.get(device.id).name, 'Thanh iPhone');
	assert.deepEqual(again.list().map((d) => ({ name: d.name, presence: d.presence })), [{ name: 'Thanh iPhone', presence: true }]);
	// Listing carries no key material.
	assert.ok(!JSON.stringify(again.list()).includes(phone.device.point));
});

test('enrollment refuses bad names and keys, and a full registry', () => {
	const reg = registry();
	const phone = newPhone();
	assert.equal(reg.enroll({ name: '', deviceKey: phone.device.point }).error.status, 400);
	assert.equal(reg.enroll({ name: 'x'.repeat(65), deviceKey: phone.device.point }).error.status, 400);
	assert.equal(reg.enroll({ name: 'p', deviceKey: b64u(Buffer.alloc(65, 4)) }).error.status, 400);
	assert.equal(reg.enroll({ name: 'p', deviceKey: phone.device.point, presenceKey: 'nope' }).error.status, 400);
	assert.equal(reg.strict, false, 'a refused enrollment changes nothing');
	assert.equal(reg.enroll({ name: 'no presence', deviceKey: phone.device.point }).device.presenceKey, null);
	for (let i = 1; i < D.MAX_DEVICES; i++) enroll(reg);
	assert.equal(reg.enroll({ name: 'one too many', deviceKey: phone.device.point }).error.status, 409);
});

test('an enrollment that cannot be saved is not reported as done', () => {
	const file = path.join(tmp(), 'plain-file');
	fs.writeFileSync(file, 'x');
	const reg = new D.DeviceRegistry(path.join(file, 'devices.json'));
	const phone = newPhone();
	assert.equal(reg.enroll({ name: 'p', deviceKey: phone.device.point }).error.status, 500);
	assert.equal(reg.devices.size, 0);
	assert.equal(reg.strict, false);
});

test('strict mode survives revoking the last device and ends only on reset', () => {
	const file = path.join(tmp(), 'devices.json');
	const reg = new D.DeviceRegistry(file);
	const device = enroll(reg);
	assert.ok(reg.remove(device.id));
	assert.ok(!reg.remove(device.id));
	assert.equal(new D.DeviceRegistry(file).strict, true);
	reg.setPresence({ level: 'none' });
	reg.reset();
	assert.equal(reg.strict, false);
	assert.deepEqual(reg.presence, D.DEFAULT_PRESENCE);
	assert.equal(new D.DeviceRegistry(file).strict, false);
});

test('the presence policy takes known levels and windows only, and says what relaxes it', () => {
	const reg = registry();
	assert.deepEqual(reg.presence, { level: 'terminal', window: 300 });
	assert.equal(reg.setPresence({ level: 'everything' }).error.status, 400);
	assert.equal(reg.setPresence({ window: 7200 }).error.status, 400);
	assert.deepEqual(reg.presence, { level: 'terminal', window: 300 });
	assert.ok(reg.relaxes({ level: 'none' }));
	assert.ok(reg.relaxes({ window: D.PRESENCE_WINDOWS['1h'] }));
	assert.ok(!reg.relaxes({ level: 'terminal+writes' }));
	assert.ok(!reg.relaxes({ level: 'terminal', window: 300 }));
	assert.deepEqual(reg.setPresence({ level: 'terminal+writes', window: 1800 }).presence, { level: 'terminal+writes', window: 1800 });
	assert.ok(!reg.relaxes({ window: 300 }));
	assert.ok(reg.relaxes({ level: 'terminal' }));
});

function setup(opts) {
	let t = 1_000_000;
	const reg = registry({ now: () => t });
	const sessions = new D.DeviceSessions(reg, { now: () => t, ...opts });
	const phone = newPhone();
	const device = enroll(reg, phone);
	return { reg, sessions, phone, device, advance: (ms) => (t += ms) };
}

function mint({ sessions, phone, device }, channel = 'SID') {
	const nonce = b64u(sessions.deviceChallenge(device.id, channel));
	return sessions.mint({ deviceId: device.id, nonce, signature: signDevice(phone.device, nonce, channel), channel });
}

test('a signed challenge mints a session', () => {
	const s = setup();
	const got = mint(s);
	assert.ok(got.token);
	assert.equal(got.expiresIn, 3600);
	assert.equal(s.sessions.get(got.token).deviceId, s.device.id);
	assert.equal(s.sessions.get('nope'), null);
	assert.ok(s.reg.get(s.device.id).lastSeen);
});

test('a challenge works once, soon, on its channel, for its device', () => {
	const s = setup();
	const nonce = b64u(s.sessions.deviceChallenge(s.device.id, 'SID'));
	const signature = signDevice(s.phone.device, nonce, 'SID');
	assert.ok(s.sessions.mint({ deviceId: s.device.id, nonce, signature, channel: 'SID' }));
	assert.equal(s.sessions.mint({ deviceId: s.device.id, nonce, signature, channel: 'SID' }).error, 'challenge', 'reused');

	const late = b64u(s.sessions.deviceChallenge(s.device.id, 'SID'));
	s.advance(D.DEVICE_CHALLENGE_MS + 1);
	assert.equal(s.sessions.mint({ deviceId: s.device.id, nonce: late, signature: signDevice(s.phone.device, late, 'SID'), channel: 'SID' }).error, 'challenge', 'expired');

	const here = b64u(s.sessions.deviceChallenge(s.device.id, 'SID'));
	assert.equal(s.sessions.mint({ deviceId: s.device.id, nonce: here, signature: signDevice(s.phone.device, here, 'OTHER'), channel: 'OTHER' }).error, 'challenge', 'another channel');

	const other = enroll(s.reg);
	const mine = b64u(s.sessions.deviceChallenge(s.device.id, 'SID'));
	assert.equal(s.sessions.mint({ deviceId: other.id, nonce: mine, signature: signDevice(s.phone.device, mine, 'SID'), channel: 'SID' }).error, 'challenge', 'another device');

	const stranger = newPhone();
	const forged = b64u(s.sessions.deviceChallenge(s.device.id, 'SID'));
	assert.equal(s.sessions.mint({ deviceId: s.device.id, nonce: forged, signature: signDevice(stranger.device, forged, 'SID'), channel: 'SID' }).error, 'unknown', 'wrong key');
});

test('an unknown device gets a challenge like any other and no session', () => {
	const s = setup();
	const nonce = b64u(s.sessions.deviceChallenge('f'.repeat(16), 'SID'));
	assert.equal(nonce.length, 43);
	assert.equal(s.sessions.mint({ deviceId: 'f'.repeat(16), nonce, signature: signDevice(s.phone.device, nonce, 'SID'), channel: 'SID' }).error, 'unknown');
});

test('sessions expire, are capped, and end with their device', () => {
	const s = setup({ max: 2 });
	const a = mint(s);
	s.advance(D.SESSION_TTL_MS + 1);
	assert.equal(s.sessions.get(a.token), null);
	const b = mint(s);
	const c = mint(s);
	const d = mint(s);
	assert.equal(s.sessions.get(b.token), null, 'the oldest made room');
	assert.ok(s.sessions.get(c.token) && s.sessions.get(d.token));
	const ended = s.sessions.endDevice(s.device.id);
	assert.equal(ended.length, 2);
	assert.equal(s.sessions.get(c.token), null);
});

test('a revoked device loses its sessions and cannot get another', () => {
	const s = setup();
	const got = mint(s);
	s.reg.remove(s.device.id);
	assert.equal(s.sessions.get(got.token), null);
	const nonce = b64u(s.sessions.deviceChallenge(s.device.id, 'SID'));
	assert.equal(s.sessions.mint({ deviceId: s.device.id, nonce, signature: signDevice(s.phone.device, nonce, 'SID'), channel: 'SID' }).error, 'unknown');
});

test('flooding challenges never drops another device\'s, and caps each device', () => {
	const s = setup();
	const mine = b64u(s.sessions.deviceChallenge(s.device.id, 'SID'));
	// A flood for made-up ids fills the table, then is refused; the phone's challenge stays.
	let refused = 0;
	for (let i = 0; i < D.MAX_CHALLENGES + 10; i++) if (!s.sessions.deviceChallenge(`x${i}`, 'SID')) refused++;
	assert.ok(refused >= 10);
	assert.ok(s.sessions.mint({ deviceId: s.device.id, nonce: mine, signature: signDevice(s.phone.device, mine, 'SID'), channel: 'SID' }).token);
	// One id keeps at most a few: its own oldest goes first.
	const t = setup();
	const first = b64u(t.sessions.deviceChallenge(t.device.id, 'SID'));
	for (let i = 0; i < D.MAX_CHALLENGES_PER_DEVICE; i++) t.sessions.deviceChallenge(t.device.id, 'SID');
	assert.equal(t.sessions.mint({ deviceId: t.device.id, nonce: first, signature: signDevice(t.phone.device, first, 'SID'), channel: 'SID' }).error, 'challenge');
});

function presence(s, token, phone = s.phone) {
	const { nonce } = s.sessions.presenceChallenge(token);
	const n = b64u(nonce);
	return s.sessions.grant({ token, nonce: n, signature: signPresence(phone.presence, n, token) });
}

test('a presence signature grants for the window, then it lapses', () => {
	for (const [name, seconds] of Object.entries(D.PRESENCE_WINDOWS)) {
		const s = setup();
		s.reg.setPresence({ window: seconds });
		const { token } = mint(s);
		assert.ok(!s.sessions.granted(token));
		assert.deepEqual(presence(s, token), { grantedFor: seconds }, name);
		s.advance(seconds * 1000 - 1000);
		assert.ok(s.sessions.granted(token), `${name}: still inside`);
		s.advance(2000);
		assert.ok(!s.sessions.granted(token), `${name}: lapsed`);
	}
});

test('a presence grant is for its session and its key', () => {
	const s = setup();
	const { token } = mint(s);
	const second = mint(s);
	const { nonce } = s.sessions.presenceChallenge(token);
	const n = b64u(nonce);
	// A signature made for the other session does not grant this one.
	assert.equal(s.sessions.grant({ token, nonce: n, signature: signPresence(s.phone.presence, n, second.token) }), null);
	// Nor does the device key stand in for the presence key.
	const { nonce: again } = s.sessions.presenceChallenge(token);
	const m = b64u(again);
	assert.equal(s.sessions.grant({ token, nonce: m, signature: signPresence(s.phone.device, m, token) }), null);
	assert.ok(!s.sessions.granted(token));
	// A challenge for one session can't be redeemed by another.
	const { nonce: third } = s.sessions.presenceChallenge(token);
	const x = b64u(third);
	assert.equal(s.sessions.grant({ token: second.token, nonce: x, signature: signPresence(s.phone.presence, x, second.token) }), null);
});

test('a presence challenge works once and within a minute', () => {
	const s = setup();
	const { token } = mint(s);
	const { nonce } = s.sessions.presenceChallenge(token);
	const n = b64u(nonce);
	const signature = signPresence(s.phone.presence, n, token);
	assert.ok(s.sessions.grant({ token, nonce: n, signature }));
	assert.equal(s.sessions.grant({ token, nonce: n, signature }), null);
	const { nonce: late } = s.sessions.presenceChallenge(token);
	const l = b64u(late);
	s.advance(D.PRESENCE_CHALLENGE_MS + 1);
	assert.equal(s.sessions.grant({ token, nonce: l, signature: signPresence(s.phone.presence, l, token) }), null);
});

test('a device without a presence key cannot be granted', () => {
	const s = setup();
	const bare = newPhone('bare', { presence: false });
	const device = enroll(s.reg, bare);
	const { token } = mint({ ...s, phone: bare, device });
	assert.equal(s.sessions.presenceChallenge(token).error.status, 409);
	assert.equal(s.sessions.presenceChallenge('nope'), null);
	assert.ok(!s.sessions.granted(token));
});

test('the local secret is made once, kept private and reused', () => {
	const file = path.join(tmp(), 'local-secret');
	const first = D.loadLocalSecret(file);
	assert.ok(first.secret.length >= 32);
	if (!isWindows) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.equal(D.loadLocalSecret(file).secret, first.secret);
	fs.rmSync(file);
	assert.notEqual(D.loadLocalSecret(file).secret, first.secret);
	const blocked = path.join(tmp(), 'f');
	fs.writeFileSync(blocked, 'x');
	assert.ok(D.loadLocalSecret(path.join(blocked, 'local-secret')).error);
});
