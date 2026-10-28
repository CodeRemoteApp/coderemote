import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import relay, { ticketFor } from '../src/index.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const token = 'a1'.repeat(32);

let apns;
let limited;
const env = {
	RELAY_SECRET: 'relay-secret',
	APNS_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
	APNS_KEY_ID: 'KEY123',
	APNS_TEAM_ID: 'TEAM45',
	BUNDLE_ID: 'com.example.app',
	LIMITER: { limit: async ({ key }) => ({ success: !limited.has(key) }) },
};

beforeEach(() => {
	apns = [];
	limited = new Set();
	globalThis.fetch = async (url, init) => {
		apns.push({ url, init });
		return new Response(apns.status === 410 ? JSON.stringify({ reason: 'Unregistered' }) : '', {
			status: apns.status ?? 200,
			headers: { 'apns-id': 'ID-1' },
		});
	};
});

const post = (path, body) => relay.fetch(new Request(`https://relay.example${path}`, { method: 'POST', body: JSON.stringify(body) }), env);

async function registered(environment = 'production') {
	const res = await post('/v1/register', { token, environment });
	assert.equal(res.status, 200);
	return (await res.json()).ticket;
}

test('register issues a ticket bound to the token and environment', async () => {
	const ticket = await registered();
	assert.equal(ticket, await ticketFor('relay-secret', 'production', token));
	assert.notEqual(ticket, await ticketFor('relay-secret', 'development', token));
	assert.equal((await post('/v1/register', { token: 'nope', environment: 'production' })).status, 400);
	assert.equal(apns.length, 0);
});

test('a valid send reaches APNs with a signed provider token', async () => {
	const ticket = await registered();
	const payload = { aps: { alert: { title: 'Code Remote', body: 'A session needs your attention' }, 'mutable-content': 1, category: 'PERMISSION' }, k: 'key-1', e: 'Y2lwaGVy' };
	const res = await post('/v1/send', { token, environment: 'production', ticket, payload, collapseId: 'req-1' });
	assert.deepEqual(await res.json(), { status: 200, apnsId: 'ID-1' });
	const [{ url, init }] = apns;
	assert.equal(url, `https://api.push.apple.com/3/device/${token}`);
	assert.deepEqual(JSON.parse(init.body), payload);
	assert.equal(init.headers['apns-topic'], 'com.example.app');
	assert.equal(init.headers['apns-push-type'], 'alert');
	assert.equal(init.headers['apns-collapse-id'], 'req-1');
	const [header, claims, sig] = init.headers.authorization.replace('bearer ', '').split('.');
	assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'KEY123' });
	assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, 'TEAM45');
	const ok = verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
	assert.ok(ok);
});

test('development tokens go to the sandbox', async () => {
	const ticket = await registered('development');
	await post('/v1/send', { token, environment: 'development', ticket, payload: { aps: {} } });
	assert.match(apns[0].url, /^https:\/\/api\.sandbox\.push\.apple\.com\//);
});

test('a forged ticket is refused without contacting APNs', async () => {
	const other = await ticketFor('relay-secret', 'production', 'b2'.repeat(32));
	for (const ticket of [other, 'x'.repeat(43), undefined]) {
		assert.equal((await post('/v1/send', { token, environment: 'production', ticket, payload: { aps: {} } })).status, 403);
	}
	assert.equal(apns.length, 0);
});

test('rate limited per token', async () => {
	const ticket = await registered();
	limited.add(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url'));
	assert.equal((await post('/v1/send', { token, environment: 'production', ticket, payload: { aps: {} } })).status, 429);
	assert.equal(apns.length, 0);
});

test('APNs rejections come back so the agent can drop the token', async () => {
	const ticket = await registered();
	apns.status = 410;
	const res = await post('/v1/send', { token, environment: 'production', ticket, payload: { aps: {} } });
	assert.equal(res.status, 410);
	assert.deepEqual(await res.json(), { status: 410, reason: 'Unregistered' });
});

test('oversized payloads, other methods and unknown paths', async () => {
	const ticket = await registered();
	assert.equal((await post('/v1/send', { token, environment: 'production', ticket, payload: { pad: 'x'.repeat(5000) } })).status, 400);
	assert.equal((await relay.fetch(new Request('https://relay.example/v1/send'), env)).status, 405);
	assert.equal((await post('/nope', {})).status, 404);
	assert.equal(apns.length, 0);
});
