// The Cloud backend client against a fake fetch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Capacity, createCloudApi, Denied, Expired, LimitReached, NoAccess, NotFound, SignedOut, Unreachable } from '../../../src/providers/cloud/api.js';

function fake(status, body) {
	const calls = [];
	const fetchFn = async (url, init) => {
		calls.push({ url, ...init, json: init.body ? JSON.parse(init.body) : undefined });
		return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	};
	return { calls, fetchFn };
}

const errorBody = (code, extra = {}) => ({ error: 'sentence', code, ...extra });

test('machine calls carry the credential; sign-in calls carry none', async () => {
	const f = fake(200, { ok: true });
	const api = createCloudApi({ base: 'https://api.test', credential: () => 'crm_abc', fetchFn: f.fetchFn });
	await api.putHostname('agent-1', 31580);
	await api.startLogin('Mac');
	assert.equal(f.calls[0].url, 'https://api.test/v1/hostnames/agent-1');
	assert.equal(f.calls[0].method, 'PUT');
	assert.equal(f.calls[0].headers.authorization, 'Bearer crm_abc');
	assert.deepEqual(f.calls[0].json, { port: 31580 });
	assert.equal(f.calls[1].headers.authorization, undefined);
	assert.deepEqual(f.calls[1].json, { machineName: 'Mac' });
});

test('without a saved credential a machine call is SignedOut before any request', async () => {
	const f = fake(200, {});
	await assert.rejects(createCloudApi({ fetchFn: f.fetchFn }).me(), SignedOut);
	assert.equal(f.calls.length, 0);
});

test('each error code maps to its CloudError', async () => {
	const cases = [
		[401, errorBody('EAUTH'), SignedOut, /signed out of Code Remote Cloud.*login --cloud/],
		[401, {}, SignedOut, /signed out/],
		[403, errorBody('ENOACCESS'), NoAccess, /doesn't have Code Remote Cloud access/],
		[503, errorBody('ECAPACITY'), Capacity, /full right now.*--tunnel devtunnels/],
		[410, errorBody('EEXPIRED'), Expired, /expired/],
		[403, errorBody('EDENIED'), Denied, /denied/],
		[404, errorBody('ENOTFOUND'), NotFound, /sentence/],
	];
	for (const [status, body, Class, message] of cases) {
		const api = createCloudApi({ credential: () => 'crm_x', fetchFn: fake(status, body).fetchFn });
		await assert.rejects(api.me(), (e) => e instanceof Class && message.test(e.message), `${status} ${body.code}`);
	}
	const other = createCloudApi({ credential: () => 'crm_x', fetchFn: fake(500, errorBody('EINTERNAL')).fetchFn });
	await assert.rejects(other.me(), { code: 'EINTERNAL', message: 'Code Remote Cloud answered 500: sentence' });
});

test('ELIMIT keeps the list and names each host with when it was last used', async () => {
	const hostnames = [
		{ host: 'craaaaaaaaaa.commitplus.app', agentId: 'a', port: 31580, lastSeen: 1_800_000_000, machineName: 'Mac' },
		{ host: 'crbbbbbbbbbb.commitplus.app', agentId: 'b', port: 31581, lastSeen: 0 },
	];
	const api = createCloudApi({ credential: () => 'crm_x', fetchFn: fake(409, errorBody('ELIMIT', { hostnames })).fetchFn });
	const e = await api.putHostname('c', 31582).catch((x) => x);
	assert.ok(e instanceof LimitReached);
	assert.deepEqual(e.hostnames, hostnames);
	assert.match(e.message, /craaaaaaaaaa\.commitplus\.app {2}Mac, port 31580, last used 2027-01-15/);
	assert.match(e.message, /crbbbbbbbbbb\.commitplus\.app {2}port 31581, last used never/);
	assert.match(e.message, /coderemote tunnels --delete <host>/);
});

test('no network is Unreachable, and a hang times out', async () => {
	const down = createCloudApi({ credential: () => 'crm_x', fetchFn: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
	await assert.rejects(down.me(), (e) => e instanceof Unreachable && /ENOTFOUND/.test(e.message));
	const hang = createCloudApi({
		credential: () => 'crm_x',
		timeoutMs: 20,
		fetchFn: (_url, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
	});
	// AbortSignal.timeout's timer doesn't hold the event loop open; this one does.
	const keep = setTimeout(() => {}, 5000);
	await assert.rejects(hang.me(), /timed out/);
	clearTimeout(keep);
});

test('an agent ID is escaped into the path', async () => {
	const f = fake(200, {});
	await createCloudApi({ credential: () => 'crm_x', fetchFn: f.fetchFn }).seen('a/b');
	assert.equal(f.calls[0].url, 'https://cloud.commitplus.app/v1/hostnames/a%2Fb/seen');
});
