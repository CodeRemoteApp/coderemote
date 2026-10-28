// Forwards notifications from Code Remote agents to APNs. Agents can't hold Apple's key, so
// they send here; a ticket the app got for its device token is what lets them. Payloads arrive
// already encrypted for the phone. Nothing is stored or logged. See README.md.

const APNS_HOSTS = { production: 'https://api.push.apple.com', development: 'https://api.sandbox.push.apple.com' };
const MAX_PAYLOAD = 4096;
const PUSH_TYPES = new Set(['alert', 'background', 'liveactivity']);
const enc = new TextEncoder();

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function b64url(bytes) {
	let s = '';
	for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
	const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const validToken = (t) => typeof t === 'string' && /^[0-9a-f]{64,200}$/i.test(t);
const validEnv = (e) => Object.hasOwn(APNS_HOSTS, e);

async function hmacKey(secret) {
	return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** The ticket for a device token: an HMAC over the APNs environment and the token. */
export async function ticketFor(secret, environment, token) {
	return b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${environment}:${token.toLowerCase()}`)));
}

async function ticketValid(secret, environment, token, ticket) {
	if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return false;
	// subtle.verify compares in constant time.
	return crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(ticket), enc.encode(`${environment}:${token.toLowerCase()}`));
}

// The provider token APNs wants, reused for up to 50 minutes (APNs accepts it for an hour and
// rejects refreshing it more often than every 20 minutes).
let cachedJwt = null;

async function providerToken(env, now = Date.now()) {
	if (cachedJwt && cachedJwt.keyId === env.APNS_KEY_ID && now - cachedJwt.issuedAt < 50 * 60 * 1000) return cachedJwt.token;
	const pem = env.APNS_KEY.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
	const key = await crypto.subtle.importKey('pkcs8', fromB64url(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
	const header = b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID })));
	const claims = b64url(enc.encode(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) })));
	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
	cachedJwt = { token: `${header}.${claims}.${b64url(signature)}`, keyId: env.APNS_KEY_ID, issuedAt: now };
	return cachedJwt.token;
}

async function readBody(request) {
	try {
		const body = await request.json();
		return body && typeof body === 'object' ? body : null;
	} catch {
		return null;
	}
}

async function register(request, env) {
	const body = await readBody(request);
	if (!body || !validToken(body.token) || !validEnv(body.environment)) return json(400, { error: 'token and environment required' });
	return json(200, { ticket: await ticketFor(env.RELAY_SECRET, body.environment, body.token) });
}

async function send(request, env) {
	const body = await readBody(request);
	if (!body || !validToken(body.token) || !validEnv(body.environment)) return json(400, { error: 'token and environment required' });
	const { token, environment, ticket, payload } = body;
	if (!(await ticketValid(env.RELAY_SECRET, environment, token, ticket))) return json(403, { error: 'invalid ticket' });
	const pushType = body.pushType ?? 'alert';
	if (!PUSH_TYPES.has(pushType)) return json(400, { error: 'unknown pushType' });
	const data = JSON.stringify(payload ?? null);
	if (!payload || typeof payload !== 'object' || enc.encode(data).length > MAX_PAYLOAD) return json(400, { error: 'payload must be an object of at most 4 KB' });

	const digest = b64url(await crypto.subtle.digest('SHA-256', enc.encode(token.toLowerCase())));
	if (env.LIMITER && !(await env.LIMITER.limit({ key: digest })).success) return json(429, { error: 'too many pushes for this device' });

	const headers = {
		authorization: `bearer ${await providerToken(env)}`,
		'apns-topic': pushType === 'liveactivity' ? `${env.BUNDLE_ID}.push-type.liveactivity` : env.BUNDLE_ID,
		'apns-push-type': pushType,
		'apns-priority': String(body.priority === 5 || pushType === 'background' ? 5 : 10),
		'content-type': 'application/json',
	};
	if (typeof body.collapseId === 'string' && body.collapseId) headers['apns-collapse-id'] = body.collapseId.slice(0, 64);
	if (Number.isInteger(body.expiration)) headers['apns-expiration'] = String(body.expiration);

	const res = await fetch(`${APNS_HOSTS[environment]}/3/device/${token}`, { method: 'POST', headers, body: data });
	if (res.ok) return json(200, { status: res.status, apnsId: res.headers.get('apns-id') });
	let reason = null;
	try {
		reason = (await res.json()).reason ?? null;
	} catch {}
	// Pass APNs's verdict through: 410 Unregistered and 400 BadDeviceToken tell the agent to drop it.
	return json(res.status, { status: res.status, reason });
}

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (request.method !== 'POST') return json(405, { error: 'POST only' });
		if (!env.RELAY_SECRET || !env.APNS_KEY) return json(503, { error: 'relay not configured' });
		if (pathname === '/v1/register') return register(request, env);
		if (pathname === '/v1/send') return send(request, env);
		return json(404, { error: 'not found' });
	},
};
