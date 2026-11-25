// Checks the Code Remote Cloud gate's owner assertion (`X-CodeRemote-Owner`, PROTOCOL.md "Cloud
// pairing"): `v1.<kid>.<base64url json>.<base64url Ed25519 signature>` over `v1.<kid>.<json part>`,
// json `{ uid, host, iat, exp }`. Only the gate can sign; the agent checks with the keys the API
// publishes, so neither a missing gate nor a local process on the loopback port can pass it.
import { webcrypto } from 'node:crypto';

const TTL_S = 60;
const FUTURE_SKEW_S = 60;
const PAST_SKEW_S = 30;
const KEYS_TTL_MS = 10 * 60_000;
const UNKNOWN_KID_RETRY_MS = 60_000;

/** The assertion's payload when `publicKeys[kid]` signed it for `host` and `uid`, in date; else null. */
export async function verifyOwnerAssertion(text, { publicKeys, host, uid, now = Math.floor(Date.now() / 1000) }) {
	const m = /^v1\.([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(typeof text === 'string' ? text : '');
	if (!m) return null;
	const raw = Object.hasOwn(publicKeys, m[1]) ? publicKeys[m[1]] : null;
	if (!raw) return null;
	let payload;
	try {
		payload = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	const { iat, exp } = payload ?? {};
	if (!uid || payload?.uid !== uid || payload?.host !== host || !Number.isInteger(iat) || !Number.isInteger(exp)) return null;
	if (iat > now + FUTURE_SKEW_S || exp < now - PAST_SKEW_S || exp - iat > TTL_S) return null;
	try {
		const key = await webcrypto.subtle.importKey('raw', Buffer.from(raw, 'base64url'), { name: 'Ed25519' }, false, ['verify']);
		const ok = await webcrypto.subtle.verify({ name: 'Ed25519' }, key, Buffer.from(m[3], 'base64url'), Buffer.from(`v1.${m[1]}.${m[2]}`));
		return ok ? payload : null;
	} catch {
		return null;
	}
}

/**
 * `check(assertion, host)` for the agent's pairing route: keys from `api.keys()`, fetched on first
 * use, every 10 minutes, and again (at most once a minute) for a key ID they didn't list.
 * @param {{ keys: () => Promise<{ keys: { kid: string, publicKey: string }[] }> }} api
 * @param {() => Promise<string | null>} ownerUid  the uid that owns this computer
 */
export function createOwnerCheck({ api, ownerUid, now = Date.now }) {
	let keys = null;
	let fetchedAt = 0;
	let lastUnknown = 0;
	async function refresh() {
		const got = await api.keys();
		keys = Object.fromEntries((got?.keys ?? []).filter((k) => typeof k?.kid === 'string' && typeof k?.publicKey === 'string').map((k) => [k.kid, k.publicKey]));
		fetchedAt = now();
	}
	return async function check(assertion, host) {
		if (typeof assertion !== 'string' || !host) return false;
		if (!keys || now() - fetchedAt >= KEYS_TTL_MS) await refresh();
		const kid = /^v1\.([A-Za-z0-9_-]{1,32})\./.exec(assertion)?.[1];
		if (kid && !Object.hasOwn(keys, kid) && now() - lastUnknown >= UNKNOWN_KID_RETRY_MS) {
			lastUnknown = now();
			await refresh();
		}
		const uid = await ownerUid();
		return Boolean(await verifyOwnerAssertion(assertion, { publicKeys: keys, host, uid, now: Math.floor(now() / 1000) }));
	};
}
