// A phone's side of device keys, for tests: P-256 keys (software, standing in for the Secure Enclave)
// and the signatures that enroll it, mint sessions and prove presence.
import { generateKeyPairSync, sign } from 'node:crypto';
import { b64u } from '../../src/e2e.js';
import { deviceMessage, presenceMessage } from '../../src/devices.js';

export function p256Pair() {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const jwk = publicKey.export({ format: 'jwk' });
	const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
	return { privateKey, point: b64u(point) };
}

export const signRaw = (pair, message) => b64u(sign('sha256', message, { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }));
export const signDevice = (pair, nonceB64, channel) => signRaw(pair, deviceMessage(Buffer.from(nonceB64, 'base64url'), channel));
export const signPresence = (pair, nonceB64, token) => signRaw(pair, presenceMessage(Buffer.from(nonceB64, 'base64url'), token));

/** A phone: its two keys and the bearer-token helpers around them. */
export function newPhone(name = 'Test phone', { presence = true } = {}) {
	return { name, device: p256Pair(), presence: presence ? p256Pair() : null };
}

// --- Over a sealed session ------------------------------------------------------------

import { handshake } from './e2e-client.js';
import { Routes } from '@vsremote/protocol';

const route = (r) => r.split(' ')[1];
const json = { 'content-type': 'application/json' };

/**
 * A phone talking to an agent through a sealed session: enrolling with the pairing token, minting
 * a device session, proving presence, and making requests with the session token.
 */
export class PhoneSession {
	constructor(base, agentKey, phone, pairingToken) {
		this.base = base;
		this.agentKey = agentKey;
		this.phone = phone;
		this.pairingToken = pairingToken;
		this.http = null;
		this.token = null;
		this.deviceId = null;
	}

	async open() {
		this.http = await handshake(this.base, this.agentKey);
		return this;
	}

	/** The pairing token in a sealed request. */
	withPairing(method, path, body) {
		return this.http.request(method, path, {
			headers: { authorization: `Bearer ${this.pairingToken}`, ...json },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}

	async enroll() {
		const res = await this.withPairing('POST', route(Routes.deviceEnroll), {
			name: this.phone.name,
			deviceKey: this.phone.device.point,
			presenceKey: this.phone.presence?.point,
		});
		if (res.status === 200) this.deviceId = res.json().id;
		return res;
	}

	/** Challenge, signature, session: sets `token`. Resolves the session answer. */
	async login(deviceId = this.deviceId, { sid = this.http.sid, signer = this.phone.device } = {}) {
		const challenge = await this.http.request('POST', route(Routes.deviceChallenge), { headers: json, body: JSON.stringify({ deviceId }) });
		const { nonce } = challenge.json();
		const res = await this.http.request('POST', route(Routes.deviceSession), {
			headers: json,
			body: JSON.stringify({ deviceId, nonce, signature: signDevice(signer, nonce, sid) }),
		});
		if (res.status === 200) this.token = res.json().token;
		return res;
	}

	/** A request with the device session token. */
	request(method, path, body, headers = {}) {
		return this.http.request(method, path, {
			headers: { authorization: `Bearer ${this.token}`, ...json, ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}

	/** Face ID: a presence challenge, signed with the presence key. */
	async grant({ signer = this.phone.presence } = {}) {
		const challenge = await this.request('POST', route(Routes.presenceChallenge));
		if (challenge.status !== 200) return challenge;
		const { nonce } = challenge.json();
		return this.request('POST', route(Routes.presenceGrant), { nonce, signature: signPresence(signer, nonce, this.token) });
	}
}
