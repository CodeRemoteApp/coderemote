// End-to-end encryption primitives: handshake, sealing, replay window, sessions and the identity key.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as e2e from '../src/e2e.js';
import { isWindows } from '../src/platform.js';

const vectors = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../protocol/e2e-vectors.json', import.meta.url)), 'utf8'));
const hex = (s) => Buffer.from(s, 'hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));

function handshake(identity = e2e.x25519Pair()) {
	const start = e2e.clientStart(identity.publicKey);
	const answer = e2e.agentAccept(identity, start.epk);
	return { identity, start, answer, client: e2e.clientFinish(start, answer) };
}

test('matches the shared test vectors', () => {
	const S = e2e.x25519Pair(hex(vectors.agentPrivate));
	const C = e2e.x25519Pair(hex(vectors.clientEphemeralPrivate));
	const E = e2e.x25519Pair(hex(vectors.agentEphemeralPrivate));
	assert.equal(S.publicKey.toString('hex'), vectors.agentPublic);
	assert.equal(C.publicKey.toString('hex'), vectors.clientEphemeralPublic);
	assert.equal(E.publicKey.toString('hex'), vectors.agentEphemeralPublic);
	const acc = e2e.agentAccept(S, C.publicKey, E);
	assert.equal(acc.confirm.toString('hex'), vectors.confirm);
	assert.equal(acc.keys.c2s.toString('hex'), vectors.keyC2S);
	assert.equal(acc.keys.s2c.toString('hex'), vectors.keyS2C);
	const client = e2e.clientFinish(e2e.clientStart(S.publicKey, C), { epk: acc.epk, confirm: acc.confirm });
	assert.equal(client.c2s.toString('hex'), vectors.keyC2S);

	const v = vectors.seal;
	const sealed = e2e.seal(hex(vectors[v.key]), v.counter, v.aad, hex(v.plaintext));
	assert.equal(sealed.toString('hex'), v.sealed);
	assert.equal(e2e.open(hex(vectors[v.key]), v.aad, hex(v.sealed)).toString('hex'), v.plaintext);

	const p = vectors.pack;
	assert.equal(e2e.pack(p.header, hex(p.body)).toString('hex'), p.packed);
	const un = e2e.unpack(hex(p.packed));
	assert.deepEqual(un.header, p.header);
	assert.equal(un.body.toString('hex'), p.body);
});

test('both sides derive the same keys', () => {
	const { answer, client } = handshake();
	assert.ok(client);
	assert.deepEqual(client.c2s, answer.keys.c2s);
	assert.deepEqual(client.s2c, answer.keys.s2c);
	assert.notDeepEqual(client.c2s, client.s2c);
});

test('a handshake against the wrong identity fails the confirmation', () => {
	const real = e2e.x25519Pair();
	const forger = e2e.x25519Pair();
	const start = e2e.clientStart(real.publicKey);
	const forged = e2e.agentAccept(forger, start.epk);
	assert.equal(e2e.clientFinish(start, forged), null);
});

test('a tampered answer fails the confirmation', () => {
	const id = e2e.x25519Pair();
	const start = e2e.clientStart(id.publicKey);
	const answer = e2e.agentAccept(id, start.epk);
	const confirm = Buffer.from(answer.confirm);
	confirm[0] ^= 1;
	assert.equal(e2e.clientFinish(start, { epk: answer.epk, confirm }), null);
	assert.equal(e2e.clientFinish(start, { epk: e2e.x25519Pair().publicKey, confirm: answer.confirm }), null);
	assert.equal(e2e.clientFinish(start, { epk: Buffer.alloc(3), confirm: answer.confirm }), null);
});

test('seal and open round trip, and any change fails', () => {
	const { answer } = handshake();
	const key = answer.keys.c2s;
	const msg = e2e.seal(key, 1, 'sid:req', Buffer.from('secret'));
	assert.equal(e2e.counterOf(msg), 1);
	assert.equal(e2e.open(key, 'sid:req', msg).toString(), 'secret');
	assert.equal(e2e.open(key, 'other:req', msg), null);
	assert.equal(e2e.open(answer.keys.s2c, 'sid:req', msg), null);
	for (const i of [0, 7, 8, msg.length - 1]) {
		const bad = Buffer.from(msg);
		bad[i] ^= 1;
		assert.equal(e2e.open(key, 'sid:req', bad), null, `byte ${i}`);
	}
	assert.equal(e2e.open(key, 'sid:req', msg.subarray(0, 10)), null);
	// The same plaintext under another counter is another ciphertext.
	assert.notDeepEqual(e2e.seal(key, 2, 'sid:req', Buffer.from('secret')).subarray(8), msg.subarray(8));
});

test('the replay window rejects repeats and accepts reordering inside the window', () => {
	const w = new e2e.ReplayWindow();
	assert.ok(w.allows(0));
	w.commit(0);
	assert.ok(!w.allows(0));
	// 2 arrives before 1.
	assert.ok(w.allows(2));
	w.commit(2);
	assert.ok(w.allows(1));
	w.commit(1);
	assert.ok(!w.allows(1));
	assert.ok(!w.allows(2));
	// Far ahead: the old ones fall out of the window and are refused.
	w.commit(500);
	assert.ok(!w.allows(500 - e2e.REPLAY_WINDOW));
	assert.ok(w.allows(500 - e2e.REPLAY_WINDOW + 1));
	assert.ok(!w.allows(3));
	assert.ok(w.allows(501));
});

test('an ordered window takes only the next counter', () => {
	const w = new e2e.ReplayWindow({ ordered: true });
	assert.ok(w.allows(0));
	w.commit(0);
	assert.ok(!w.allows(0));
	assert.ok(!w.allows(2));
	assert.ok(w.allows(1));
});

test('packing refuses what is not a packed message', () => {
	assert.equal(e2e.unpack(Buffer.alloc(2)), null);
	assert.equal(e2e.unpack(Buffer.from([0, 0, 0, 99, 1])), null);
	assert.equal(e2e.unpack(Buffer.from([0, 0, 0, 2, 0x7b, 0x7b])), null);
	assert.equal(e2e.unpack(e2e.pack({}, Buffer.from('x'))).body.toString(), 'x');
});

test('base64url keys are strict', () => {
	const raw = Buffer.alloc(32, 7);
	assert.deepEqual(e2e.fromB64u(e2e.b64u(raw), 32), raw);
	assert.equal(e2e.fromB64u(e2e.b64u(raw) + '=', 32), null);
	assert.equal(e2e.fromB64u('abc', 32), null);
	assert.equal(e2e.fromB64u('+'.repeat(43), 32), null);
	assert.equal(e2e.fromB64u(null, 32), null);
});

test('sessions expire, are capped and serve one mode', () => {
	let t = 1000;
	const table = new e2e.SessionTable({ max: 2, idleMs: 100, now: () => t });
	const keys = { c2s: Buffer.alloc(32), s2c: Buffer.alloc(32) };
	const a = table.create(keys);
	const b = table.create(keys);
	assert.ok(table.get(a.id)); // a is now the most recently used
	const c = table.create(keys); // evicts b
	assert.equal(table.get(b.id), null);
	assert.ok(table.get(a.id));
	assert.ok(table.claim(c, 'http'));
	assert.ok(table.claim(c, 'http'));
	assert.ok(!table.claim(c, 'ws'));
	t += 101;
	assert.equal(table.get(a.id), null);
	assert.equal(table.get(c.id), null);
	assert.equal(table.get('nope'), null);
});

test('tickets expire and are good for one scope only', () => {
	let t = 0;
	const tickets = new e2e.TicketTable({ ttlMs: 1000, now: () => t });
	const { ticket } = tickets.mint('read');
	assert.ok(tickets.check(ticket, 'read'));
	assert.ok(!tickets.check(ticket, 'upload'));
	assert.ok(!tickets.check('forged', 'read'));
	t = 1001;
	assert.ok(!tickets.check(ticket, 'read'));
	tickets.mint('read');
	tickets.clear();
	assert.equal(tickets.tickets.size, 0);
});

test('the identity key is created once, kept private and reused', () => {
	const dir = path.join(tmp(), 'e2e');
	const first = e2e.loadIdentity(dir);
	assert.equal(first.error, undefined);
	assert.equal(first.publicKey.length, 32);
	if (!isWindows) assert.equal(fs.statSync(path.join(dir, 'key.json')).mode & 0o777, 0o600);
	const second = e2e.loadIdentity(dir);
	assert.deepEqual(second.publicKey, first.publicKey);
	assert.notDeepEqual(e2e.loadIdentity(path.join(tmp(), 'e2e')).publicKey, first.publicKey);
});

test('an unusable identity directory is reported, not thrown', () => {
	const file = path.join(tmp(), 'plain-file');
	fs.writeFileSync(file, 'x');
	const got = e2e.loadIdentity(path.join(file, 'e2e'));
	assert.ok(got.error);
});

test('a damaged key file is replaced', () => {
	const dir = path.join(tmp(), 'e2e');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'key.json'), '{"d":"nope"}');
	const got = e2e.loadIdentity(dir);
	assert.equal(got.publicKey.length, 32);
});
