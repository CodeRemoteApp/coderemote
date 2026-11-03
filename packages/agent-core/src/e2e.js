// End-to-end encryption between a client and the agent, so the tunnel relay only forwards
// ciphertext. A Noise-NK-shaped handshake (the client knows the agent's static X25519 key from the
// pairing link) derives two directional ChaCha20-Poly1305 keys; messages carry an 8-byte counter.
// See packages/protocol/PROTOCOL.md, "End-to-end encryption".
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
	timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { E2E_VERSION } from '@vsremote/protocol';

export { E2E_VERSION };

const LABEL = 'coderemote-e2e-1';
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const TAG_LENGTH = 16;
/** The largest sealed message, request or response, in bytes of plaintext. */
export const MAX_SEALED = 8 * 1024 * 1024;
/** How far behind the newest counter a request may arrive and still be accepted. */
export const REPLAY_WINDOW = 128;

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
/** The bytes of unpadded base64url `s`, or null when it isn't exactly `length` bytes of it. */
export function fromB64u(s, length) {
	if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
	const buf = Buffer.from(s, 'base64url');
	return buf.length === length && b64u(buf) === s ? buf : null;
}

// --- X25519 ---------------------------------------------------------------

/** An X25519 key pair: `{ publicKey: Buffer(32), privateKey: KeyObject, raw: Buffer(32) }`. */
export function x25519Pair(raw = null) {
	if (raw) {
		const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
		return { privateKey, publicKey: publicRaw(createPublicKey(privateKey)), raw: Buffer.from(raw) };
	}
	const { privateKey, publicKey } = generateKeyPairSync('x25519');
	return {
		privateKey,
		publicKey: publicRaw(publicKey),
		raw: Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url'),
	};
}

function publicRaw(keyObject) {
	return Buffer.from(keyObject.export({ format: 'jwk' }).x, 'base64url');
}

function publicKeyObject(raw) {
	return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

const dh = (privateKey, publicRawBytes) => diffieHellman({ privateKey, publicKey: publicKeyObject(publicRawBytes) });

// --- Handshake --------------------------------------------------------------

function schedule(es, ee, S, ec, eS) {
	const salt = createHash('sha256').update(LABEL).update(S).update(ec).update(eS).digest();
	const ikm = Buffer.concat([es, ee]);
	const derive = (info) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));
	return {
		c2s: derive('c2s'),
		s2c: derive('s2c'),
		confirm: createHmac('sha256', derive('confirm')).update(salt).digest(),
	};
}

/**
 * The agent's half: given its identity and the client's ephemeral public key, the answer to send
 * (`epk`, `confirm`) and the session keys. `ephemeral` is for test vectors only.
 */
export function agentAccept(identity, clientEpk, ephemeral = x25519Pair()) {
	const es = dh(identity.privateKey, clientEpk);
	const ee = dh(ephemeral.privateKey, clientEpk);
	const k = schedule(es, ee, identity.publicKey, clientEpk, ephemeral.publicKey);
	return { epk: ephemeral.publicKey, confirm: k.confirm, keys: { c2s: k.c2s, s2c: k.s2c } };
}

/** The client's first message: a fresh ephemeral key pair (`ephemeral` is for test vectors only). */
export function clientStart(agentPublicKey, ephemeral = x25519Pair()) {
	return { epk: ephemeral.publicKey, ephemeral, agentPublicKey };
}

/**
 * The client's second half: checks the agent's answer against the key it pinned. Returns the
 * session keys, or null when the confirmation doesn't prove the agent holds the pinned key.
 */
export function clientFinish(start, answer) {
	if (!Buffer.isBuffer(answer?.epk) || answer.epk.length !== 32) return null;
	let k;
	try {
		const es = dh(start.ephemeral.privateKey, start.agentPublicKey);
		const ee = dh(start.ephemeral.privateKey, answer.epk);
		k = schedule(es, ee, start.agentPublicKey, start.epk, answer.epk);
	} catch {
		return null;
	}
	if (!Buffer.isBuffer(answer.confirm) || answer.confirm.length !== 32) return null;
	if (!timingSafeEqual(answer.confirm, k.confirm)) return null;
	return { c2s: k.c2s, s2c: k.s2c };
}

// --- Sealing ------------------------------------------------------------------

function nonceOf(counter) {
	const n = Buffer.alloc(12);
	n.writeBigUInt64BE(BigInt(counter), 4);
	return n;
}

/** `counter (8 bytes, big endian) || ciphertext || tag` for `plaintext`, bound to `aad`. */
export function seal(key, counter, aad, plaintext) {
	const cipher = createCipheriv('chacha20-poly1305', key, nonceOf(counter), { authTagLength: TAG_LENGTH });
	cipher.setAAD(Buffer.from(aad), { plaintextLength: plaintext.length });
	const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
	const head = Buffer.alloc(8);
	head.writeBigUInt64BE(BigInt(counter));
	return Buffer.concat([head, body]);
}

/** The counter of a sealed message, or null when it is too short to be one. */
export function counterOf(message) {
	return message.length >= 8 + TAG_LENGTH ? Number(message.readBigUInt64BE(0)) : null;
}

/** The plaintext of a sealed message, or null when it doesn't authenticate under `key` and `aad`. */
export function open(key, aad, message) {
	if (message.length < 8 + TAG_LENGTH) return null;
	try {
		const counter = message.readBigUInt64BE(0);
		const decipher = createDecipheriv('chacha20-poly1305', key, nonceOf(counter), { authTagLength: TAG_LENGTH });
		const ct = message.subarray(8, message.length - TAG_LENGTH);
		decipher.setAAD(Buffer.from(aad), { plaintextLength: ct.length });
		decipher.setAuthTag(message.subarray(message.length - TAG_LENGTH));
		return Buffer.concat([decipher.update(ct), decipher.final()]);
	} catch {
		return null;
	}
}

/**
 * Which counters a receiver has accepted. Requests run concurrently and may arrive out of order,
 * so by default anything inside the last REPLAY_WINDOW counters that wasn't seen yet is fine; with
 * `ordered`, only the next counter is.
 */
export class ReplayWindow {
	constructor({ ordered = false, window = REPLAY_WINDOW } = {}) {
		this.ordered = ordered;
		this.window = BigInt(window);
		this.next = 0n; // one past the newest accepted
		this.seen = 0n; // bit i: counter next-1-i was accepted
	}

	/** Whether `counter` may still be accepted. Nothing changes until `commit`. */
	allows(counter) {
		const c = BigInt(counter);
		if (this.ordered) return c === this.next;
		if (c >= this.next) return true;
		const back = this.next - 1n - c;
		return back < this.window && ((this.seen >> back) & 1n) === 0n;
	}

	commit(counter) {
		const c = BigInt(counter);
		if (c >= this.next) {
			const shift = c + 1n - this.next;
			this.seen = ((this.seen << shift) | 1n) & ((1n << this.window) - 1n);
			this.next = c + 1n;
		} else {
			this.seen |= 1n << (this.next - 1n - c);
		}
	}
}

// --- Sealed messages -------------------------------------------------------------

/** `u32 header length || JSON header || body`, the plaintext of a sealed request or response. */
export function pack(header, body = Buffer.alloc(0)) {
	const json = Buffer.from(JSON.stringify(header));
	const len = Buffer.alloc(4);
	len.writeUInt32BE(json.length);
	return Buffer.concat([len, json, body]);
}

/** `{ header, body }`, or null when `plain` isn't a packed message. */
export function unpack(plain) {
	if (plain.length < 4) return null;
	const n = plain.readUInt32BE(0);
	if (n > plain.length - 4) return null;
	try {
		const header = JSON.parse(plain.subarray(4, 4 + n).toString('utf8'));
		return header && typeof header === 'object' ? { header, body: plain.subarray(4 + n) } : null;
	} catch {
		return null;
	}
}

export const requestAad = (sid) => `${sid}:req`;
export const responseAad = (sid, requestCounter) => `${sid}:res:${requestCounter}`;
export const socketAad = (sid, direction) => `${sid}:ws:${direction}`;

// --- Sessions -------------------------------------------------------------------

/**
 * The agent's live sessions. Each holds the directional keys, the replay state of what the client
 * sends and the counter of what the agent sends. A session serves either sealed requests or one
 * socket, whichever it is used for first: they would otherwise share a counter space under one key.
 */
export class SessionTable {
	constructor({ max = 64, idleMs = 30 * 60 * 1000, now = Date.now } = {}) {
		this.max = max;
		this.idleMs = idleMs;
		this.now = now;
		this.sessions = new Map();
	}

	create(keys) {
		this.sweep();
		while (this.sessions.size >= this.max) {
			// Map order is insertion order, and touch() re-inserts: the first is the least recently used.
			const oldest = this.sessions.keys().next().value;
			this.sessions.delete(oldest);
		}
		const id = b64u(randomBytes(16));
		const session = {
			id,
			keys,
			mode: null,
			recv: null,
			sent: 0,
			lastUsed: this.now(),
			authorized: false,
		};
		this.sessions.set(id, session);
		return session;
	}

	/** The live session `id`, marked as just used; null when unknown or idle for too long. */
	get(id) {
		const s = this.sessions.get(id);
		if (!s) return null;
		if (this.now() - s.lastUsed > this.idleMs) {
			this.sessions.delete(id);
			return null;
		}
		s.lastUsed = this.now();
		this.sessions.delete(id);
		this.sessions.set(id, s);
		return s;
	}

	/** Claims `session` for `mode` ('http' or 'ws'); false when it already serves the other. */
	claim(session, mode) {
		if (session.mode && session.mode !== mode) return false;
		if (!session.mode) {
			session.mode = mode;
			session.recv = new ReplayWindow({ ordered: mode === 'ws' });
		}
		return true;
	}

	delete(id) {
		this.sessions.delete(id);
	}

	clear() {
		this.sessions.clear();
	}

	sweep() {
		const t = this.now();
		for (const [id, s] of this.sessions) if (t - s.lastUsed > this.idleMs) this.sessions.delete(id);
	}

	get size() {
		return this.sessions.size;
	}
}

/** Short-lived credentials for the transfers that stay outside the envelope. */
export class TicketTable {
	constructor({ ttlMs = 5 * 60 * 1000, max = 256, now = Date.now } = {}) {
		this.ttlMs = ttlMs;
		this.max = max;
		this.now = now;
		this.tickets = new Map();
	}

	mint(scope) {
		this.sweep();
		while (this.tickets.size >= this.max) this.tickets.delete(this.tickets.keys().next().value);
		const ticket = b64u(randomBytes(32));
		this.tickets.set(ticket, { scope, expires: this.now() + this.ttlMs });
		return { ticket, expiresIn: Math.round(this.ttlMs / 1000) };
	}

	/** Whether `ticket` is live and of `scope`. */
	check(ticket, scope) {
		const t = this.tickets.get(ticket);
		if (!t) return false;
		if (t.expires < this.now()) {
			this.tickets.delete(ticket);
			return false;
		}
		return t.scope === scope;
	}

	clear() {
		this.tickets.clear();
	}

	sweep() {
		const t = this.now();
		for (const [k, v] of this.tickets) if (v.expires < t) this.tickets.delete(k);
	}
}

// --- Identity key store ------------------------------------------------------------

/**
 * The agent's identity key in `dir/key.json`, created on first use and reused after so paired
 * devices keep trusting it. Resolves `{ publicKey, privateKey }`, or `{ error }` when none could
 * be made or saved: the agent then runs without end-to-end encryption.
 */
export function loadIdentity(dir) {
	const file = path.join(dir, 'key.json');
	try {
		const { d } = JSON.parse(fs.readFileSync(file, 'utf8'));
		const raw = fromB64u(d, 32);
		if (raw) return x25519Pair(raw);
	} catch {}
	try {
		const pair = x25519Pair();
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(file, JSON.stringify({ d: b64u(pair.raw) }), { mode: 0o600 });
		// An existing file keeps its mode through writeFileSync.
		fs.chmodSync(file, 0o600);
		return pair;
	} catch (e) {
		return { error: e };
	}
}
