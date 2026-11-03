// Device keys: which phones may use this agent, the sessions they mint, and the presence grants
// (Face ID) that guarded actions need. A phone has two P-256 keys made in its Secure Enclave: a
// device key that signs a challenge for a session, and a presence key that signs one for a grant.
// See packages/protocol/PROTOCOL.md, "Devices".
import {
	createHash,
	createPublicKey,
	randomBytes,
	randomUUID,
	verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { b64u, fromB64u } from './e2e.js';

const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const LOCAL_SECRET_BYTES = 32;

export const MAX_DEVICES = 16;
export const SESSION_TTL_MS = 60 * 60 * 1000;
export const MAX_SESSIONS = 256;
export const DEVICE_CHALLENGE_MS = 30_000;
export const PRESENCE_CHALLENGE_MS = 60_000;
/** Outstanding challenges: in all, and per device id. */
export const MAX_CHALLENGES = 4096;
export const MAX_CHALLENGES_PER_DEVICE = 4;
export const PRESENCE_LEVELS = Object.freeze(['none', 'terminal', 'terminal+writes']);
/** The grant windows a user may pick, by the name the CLI takes, in seconds. */
export const PRESENCE_WINDOWS = Object.freeze({ '5m': 300, '30m': 1800, '1h': 3600 });
export const DEFAULT_PRESENCE = Object.freeze({ level: 'terminal', window: 300 });

// --- P-256 --------------------------------------------------------------------

/** A public key from its 65-byte uncompressed point (base64url), or null when it isn't a P-256 point. */
export function importPoint(text) {
	const point = fromB64u(text, 65);
	if (!point || point[0] !== 0x04) return null;
	try {
		return createPublicKey({ key: Buffer.concat([P256_SPKI_PREFIX, point]), format: 'der', type: 'spki' });
	} catch {
		return null;
	}
}

/** Whether `signature` (raw r||s, base64url) is `key`'s ECDSA/SHA-256 signature of `message`. */
export function verifySignature(key, message, signature) {
	const sig = fromB64u(signature, 64);
	if (!sig || !key) return false;
	try {
		return cryptoVerify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, sig);
	} catch {
		return false;
	}
}

/** What a device signs to get a session: the challenge and the channel it came through. */
export function deviceMessage(nonce, channel) {
	return Buffer.concat([Buffer.from('coderemote-device-1\0'), nonce, Buffer.from(channel)]);
}

/** What a device signs to be granted presence: the challenge and the session it is for. */
export function presenceMessage(nonce, sessionToken) {
	return Buffer.concat([
		Buffer.from('coderemote-presence-1\0'),
		nonce,
		createHash('sha256').update(sessionToken).digest(),
	]);
}

// --- Registry ------------------------------------------------------------------

/**
 * The enrolled devices and the agent's presence policy, in `file` (mode 0600). `strict` is set at the
 * first enrollment and stays until `reset()`: a registry that empties itself must not reopen the
 * agent to a leaked pairing token.
 */
export class DeviceRegistry {
	constructor(file, { now = Date.now } = {}) {
		this.file = file;
		this.now = now;
		this.strict = false;
		this.presence = { ...DEFAULT_PRESENCE };
		this.devices = new Map();
		this.saveTimer = null;
		this.load();
	}

	load() {
		try {
			const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			this.strict = data.strict === true;
			if (PRESENCE_LEVELS.includes(data.presence?.level)) this.presence.level = data.presence.level;
			if (Object.values(PRESENCE_WINDOWS).includes(data.presence?.window)) this.presence.window = data.presence.window;
			for (const d of data.devices ?? []) {
				if (typeof d.id === 'string' && importPoint(d.deviceKey)) {
					this.devices.set(d.id, {
						id: d.id,
						name: String(d.name ?? '').slice(0, 64),
						deviceKey: d.deviceKey,
						presenceKey: importPoint(d.presenceKey) ? d.presenceKey : null,
						enrolledAt: d.enrolledAt ?? 0,
						lastSeen: d.lastSeen ?? null,
					});
				}
			}
		} catch {}
	}

	/** Writes the file, or throws: a device that can't be saved must not be reported as enrolled. */
	save() {
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
		fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
		const body = JSON.stringify({ v: 1, strict: this.strict, presence: this.presence, devices: [...this.devices.values()] }, null, 2);
		const tmp = `${this.file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, body, { mode: 0o600 });
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, this.file);
	}

	/** `{ device }`, or `{ error: { status, message } }`. */
	enroll({ name, deviceKey, presenceKey = null }) {
		const trimmed = typeof name === 'string' ? name.trim() : '';
		if (!trimmed || trimmed.length > 64) return { error: { status: 400, message: 'a device needs a name of up to 64 characters' } };
		if (!importPoint(deviceKey)) return { error: { status: 400, message: 'invalid device key' } };
		if (presenceKey !== null && presenceKey !== undefined && !importPoint(presenceKey)) {
			return { error: { status: 400, message: 'invalid presence key' } };
		}
		if (this.devices.size >= MAX_DEVICES) {
			return { error: { status: 409, message: `at most ${MAX_DEVICES} devices; revoke one with \`coderemote devices revoke\`` } };
		}
		const device = {
			id: randomUUID().replace(/-/g, '').slice(0, 16),
			name: trimmed,
			deviceKey,
			presenceKey: presenceKey || null,
			enrolledAt: this.now(),
			lastSeen: null,
		};
		const before = { strict: this.strict };
		this.devices.set(device.id, device);
		this.strict = true;
		try {
			this.save();
		} catch (e) {
			this.devices.delete(device.id);
			this.strict = before.strict;
			return { error: { status: 500, message: `could not save the device: ${e.message}` } };
		}
		return { device };
	}

	get(id) {
		return this.devices.get(id) ?? null;
	}

	remove(id) {
		if (!this.devices.delete(id)) return false;
		this.save();
		return true;
	}

	/** Removes every device and ends strict mode (`rotate-token`). The policy goes back to its default. */
	reset() {
		this.devices.clear();
		this.strict = false;
		this.presence = { ...DEFAULT_PRESENCE };
		fs.rmSync(this.file, { force: true });
	}

	touch(id) {
		const d = this.devices.get(id);
		if (!d) return;
		d.lastSeen = this.now();
		// Saved soon, not on every request.
		this.saveTimer ??= setTimeout(() => {
			try {
				this.save();
			} catch {}
		}, 30_000);
		this.saveTimer.unref?.();
	}

	list() {
		return [...this.devices.values()].map(({ id, name, enrolledAt, lastSeen, presenceKey }) => ({
			id,
			name,
			enrolledAt,
			lastSeen,
			presence: presenceKey !== null,
		}));
	}

	/** `{ error }` when `change` holds a level or window that isn't one of the choices, else null. */
	validate({ level, window }) {
		if (level !== undefined && !PRESENCE_LEVELS.includes(level)) return { error: { status: 400, message: 'unknown presence level' } };
		if (window !== undefined && !Object.values(PRESENCE_WINDOWS).includes(window)) {
			return { error: { status: 400, message: 'the window is 5m, 30m or 1h' } };
		}
		return null;
	}

	/** Sets the level and/or the window (a value of PRESENCE_WINDOWS); `{ error }` for anything else. */
	setPresence({ level, window }) {
		const invalid = this.validate({ level, window });
		if (invalid) return invalid;
		const next = { level: level ?? this.presence.level, window: window ?? this.presence.window };
		const before = this.presence;
		this.presence = next;
		try {
			this.save();
		} catch (e) {
			this.presence = before;
			return { error: { status: 500, message: `could not save: ${e.message}` } };
		}
		return { presence: next };
	}

	/** Whether moving from the current policy to `next` relaxes it (a lower level or a longer window). */
	relaxes({ level, window }) {
		const rank = (l) => PRESENCE_LEVELS.indexOf(l);
		return (level !== undefined && rank(level) < rank(this.presence.level)) || (window !== undefined && window > this.presence.window);
	}
}

// --- Challenges, sessions and grants ------------------------------------------------

/** In-memory device challenges, sessions and presence grants. A restart ends them all. */
export class DeviceSessions {
	constructor(registry, { now = Date.now, ttlMs = SESSION_TTL_MS, max = MAX_SESSIONS } = {}) {
		this.registry = registry;
		this.now = now;
		this.ttlMs = ttlMs;
		this.max = max;
		this.challenges = new Map();
		this.sessions = new Map();
		// A grant belongs to the device, so a session renewed inside the window keeps it.
		this.grants = new Map();
	}

	sweep() {
		const t = this.now();
		for (const [k, v] of this.challenges) if (v.expires < t) this.challenges.delete(k);
		for (const [k, v] of this.sessions) if (v.expires < t) this.sessions.delete(k);
	}

	/** A challenge for `deviceId` on `channel`; made the same for an unknown device, so it can't be probed. */
	/**
	 * A challenge for `deviceId` on `channel`, made the same for an unknown device so it can't be
	 * probed; null when too many are outstanding. A device keeps at most a few: its oldest goes first,
	 * and nobody else's are ever dropped to make room, so flooding can't make a phone's sign-in fail.
	 */
	deviceChallenge(deviceId, channel) {
		this.sweep();
		const id = String(deviceId);
		const mine = [...this.challenges].filter(([, c]) => c.kind === 'device' && c.deviceId === id);
		while (mine.length >= MAX_CHALLENGES_PER_DEVICE) this.challenges.delete(mine.shift()[0]);
		if (this.challenges.size >= MAX_CHALLENGES) return null;
		const nonce = randomBytes(32);
		this.challenges.set(b64u(nonce), { kind: 'device', deviceId: id, channel, expires: this.now() + DEVICE_CHALLENGE_MS });
		return nonce;
	}

	/**
	 * Redeems a device challenge: `{ token, expiresIn, device }`, or `{ error: 'challenge' }` for a
	 * nonce used before, expired or made for another channel or device, or `{ error: 'unknown' }` for
	 * an unknown or revoked device or a bad signature (those are not told apart).
	 */
	mint({ deviceId, nonce, signature, channel }) {
		const key = typeof nonce === 'string' ? nonce : '';
		const c = this.challenges.get(key);
		this.challenges.delete(key);
		// The challenge itself: used, expired, or not this one. The device may simply ask again.
		if (!c || c.kind !== 'device' || c.expires < this.now() || c.deviceId !== deviceId || c.channel !== channel) {
			return { error: 'challenge' };
		}
		// The device: unknown, revoked, or not holding its key. Not told apart, so ids can't be probed.
		const device = this.registry.get(deviceId);
		const raw = fromB64u(nonce, 32);
		if (!device || !raw) return { error: 'unknown' };
		if (!verifySignature(importPoint(device.deviceKey), deviceMessage(raw, channel), signature)) return { error: 'unknown' };
		while (this.sessions.size >= this.max) this.sessions.delete(this.sessions.keys().next().value);
		const token = b64u(randomBytes(32));
		this.sessions.set(token, { deviceId, expires: this.now() + this.ttlMs });
		this.registry.touch(deviceId);
		return { token, expiresIn: Math.round(this.ttlMs / 1000), device };
	}

	/** `{ deviceId, ... }` for a live session token, else null. */
	get(token) {
		const s = this.sessions.get(token);
		if (!s) return null;
		if (s.expires < this.now() || !this.registry.get(s.deviceId)) {
			this.sessions.delete(token);
			return null;
		}
		return s;
	}

	/** A presence challenge for the session `token`, or null when it has no presence key. */
	presenceChallenge(token) {
		const s = this.get(token);
		if (!s) return null;
		if (!this.registry.get(s.deviceId).presenceKey) return { error: { status: 409, message: 'this device has no presence key' } };
		this.sweep();
		const nonce = randomBytes(32);
		this.challenges.set(b64u(nonce), { kind: 'presence', token, expires: this.now() + PRESENCE_CHALLENGE_MS });
		return { nonce };
	}

	/** Records a grant on the session when `signature` proves the presence key; `{ grantedFor }` or null. */
	grant({ token, nonce, signature }) {
		const key = typeof nonce === 'string' ? nonce : '';
		const c = this.challenges.get(key);
		this.challenges.delete(key);
		const s = this.get(token);
		if (!c || !s || c.kind !== 'presence' || c.token !== token || c.expires < this.now()) return null;
		const raw = fromB64u(nonce, 32);
		const device = this.registry.get(s.deviceId);
		if (!raw || !device?.presenceKey) return null;
		if (!verifySignature(importPoint(device.presenceKey), presenceMessage(raw, token), signature)) return null;
		const window = this.registry.presence.window;
		this.grants.set(s.deviceId, this.now() + window * 1000);
		return { grantedFor: window };
	}

	/** Whether the session `token` holds a live grant. */
	granted(token) {
		const s = this.get(token);
		return !!s && (this.grants.get(s.deviceId) ?? 0) > this.now();
	}

	/** Ends every session and grant of `deviceId`; returns the session tokens. */
	endDevice(deviceId) {
		this.grants.delete(deviceId);
		const ended = [];
		for (const [token, s] of this.sessions) {
			if (s.deviceId === deviceId) {
				this.sessions.delete(token);
				ended.push(token);
			}
		}
		return ended;
	}

	clear() {
		this.challenges.clear();
		this.sessions.clear();
		this.grants.clear();
	}
}

// --- Local secret ------------------------------------------------------------------

/**
 * The secret the CLI sends to a running agent on the loopback port (`Authorization: Local <secret>`),
 * created on first use in `file` (mode 0600). Resolves `{ secret }` or `{ error }`.
 */
export function loadLocalSecret(file) {
	try {
		const secret = fs.readFileSync(file, 'utf8').trim();
		if (secret.length >= 32) return { secret };
	} catch {}
	try {
		const secret = b64u(randomBytes(LOCAL_SECRET_BYTES));
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.writeFileSync(file, secret, { mode: 0o600 });
		fs.chmodSync(file, 0o600);
		return { secret };
	} catch (e) {
		return { error: e };
	}
}
