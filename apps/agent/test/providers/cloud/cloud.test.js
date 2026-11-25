// The Cloud provider against a fake backend and a fake cloudflared.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { SignedOut } from '../../../src/providers/cloud/api.js';
import { create, deviceLogin } from '../../../src/providers/cloud/index.js';
import { fakeBackend, fakeConnector, memoryConfig, quiet } from './fakes.js';

const backends = [];
after(() => Promise.all(backends.map((b) => b.close())));

async function setup({ cloud = { credential: 'crm_test', account: 'owner@example.com', hostnames: {} }, agentIds = { 31580: 'agent-a', 31581: 'agent-b' }, ...opts } = {}) {
	const backend = await fakeBackend();
	backends.push(backend);
	const conf = memoryConfig({ cloud, agentIds });
	const connector = fakeConnector();
	const timers = [];
	let now = 1_800_000_000;
	const provider = create({
		configDir: '/nonexistent',
		spinner: quiet,
		cfg: conf.cfg,
		saveConfig: conf.save,
		loadConfig: conf.load,
		env: { CODEREMOTE_CLOUD_API: backend.url },
		ensureCli: async () => '/bin/cloudflared',
		connector: connector.run,
		isTTY: () => false,
		nowS: () => now,
		setTimer: (fn, ms) => {
			const t = { fn, ms };
			timers.push(t);
			return t;
		},
		clearTimer: (t) => (t.cleared = true),
		...opts,
	});
	backend.state.now = () => now;
	return { provider, backend, conf, connector, timers, clock: { advance: (s) => (now += s), get: () => now } };
}

test('ensure saves the host and probe token per port; known returns the host', async () => {
	const { provider, backend, conf } = await setup();
	assert.equal(provider.known(31580), null);
	const host = await provider.ensure(31580, { anonymous: false });
	assert.match(host, /^cr[a-z0-9]{10}\.commitplus\.app$/);
	const saved = conf.saved().cloud.hostnames[31580];
	assert.equal(saved.host, host);
	assert.match(saved.probeToken, /^probe-/);
	assert.equal(provider.known(31580), host);
	assert.deepEqual(backend.paths(), ['POST /v1/tunnel', 'PUT /v1/hostnames/agent-a']);
	assert.deepEqual(backend.state.calls[1].body, { port: 31580 });
	const other = await provider.ensure(31581, { anonymous: false });
	assert.notEqual(other, host);
	assert.equal(backend.paths((c) => c.path === '/v1/tunnel').length, 1, 'one connector token per run');
	assert.equal(conf.saved().cloud.hostnames[31580].host, host, 'the other port kept');
});

test('host runs cloudflared with the connector token and serves https://<host>', async () => {
	const { provider, connector } = await setup();
	const host = await provider.ensure(31580, { anonymous: false });
	const hosted = await provider.host(host, 31580);
	assert.equal(hosted.url, `https://${host}`);
	assert.equal(connector.runs[0].bin, 'cloudflared');
	assert.equal(connector.runs[0].token, 'CONNECTOR-TOKEN');
	assert.equal(connector.runs[0].opts.timeoutMs, 90_000);
});

test('the connector token is never written to the config', async () => {
	const { provider, conf } = await setup();
	await provider.host(await provider.ensure(31580, { anonymous: false }), 31580);
	assert.ok(!JSON.stringify(conf.saved()).includes('CONNECTOR-TOKEN'));
});

test('a 401 on /v1/me clears the credential: SignedOut in a terminal, NotSignedIn in the background', async () => {
	const { provider, backend, conf } = await setup();
	assert.equal(await provider.account({ interactive: true }), 'owner@example.com');
	backend.state.revoked = true;
	await assert.rejects(provider.account({ interactive: true }), SignedOut);
	assert.equal(conf.saved().cloud.credential, undefined);
	await assert.rejects(provider.account({ interactive: false }), { code: 'ENOTSIGNEDIN' });
});

test('in a terminal, up signs in on the spot: never signed in, or removed from the account', async () => {
	const logins = [];
	const login = async () => (logins.push(1), { machineId: 'm2', credential: 'crm_new', account: 'owner@example.com' });
	const fresh = await setup({ cloud: null, isTTY: () => true, login });
	assert.equal(await fresh.provider.account({ interactive: true }), 'owner@example.com');
	assert.equal(fresh.conf.saved().cloud.credential, 'crm_new');

	const removed = await setup({ isTTY: () => true, login });
	removed.backend.state.revoked = true;
	assert.equal(await removed.provider.account({ interactive: true }), 'owner@example.com');
	assert.equal(removed.conf.saved().cloud.credential, 'crm_new');
	assert.equal(logins.length, 2);
});

test('not signed in: the background waits, a terminal without a TTY says what to run', async () => {
	const { provider } = await setup({ cloud: null });
	await assert.rejects(provider.account({ interactive: false }), { code: 'ENOTSIGNEDIN' });
	await assert.rejects(provider.account({ interactive: true }), /Run `coderemote login --cloud`/);
});

test('a sign-in from another terminal is picked up', async () => {
	const { provider, conf } = await setup({ cloud: null });
	await assert.rejects(provider.account({ interactive: false }));
	conf.save({ ...conf.load(), cloud: { credential: 'crm_test', account: 'owner@example.com' } });
	assert.equal(await provider.account({ interactive: false }), 'owner@example.com');
});

test('probeHeaders reuses the token, and renews it through /seen when under an hour is left', async () => {
	const { provider, backend, clock } = await setup();
	const host = await provider.ensure(31580, { anonymous: false });
	const first = await provider.probeHeaders(host, { anonymous: false });
	assert.match(first['x-coderemote-probe'], /^probe-/);
	assert.deepEqual(await provider.probeHeaders(host, { anonymous: false }), first);
	assert.equal(backend.paths((c) => c.path.endsWith('/seen')).length, 0);
	clock.advance(86_400 - 3000);
	const renewed = await provider.probeHeaders(host, { anonymous: false });
	assert.notDeepEqual(renewed, first);
	assert.deepEqual(backend.paths((c) => c.path.endsWith('/seen')), ['POST /v1/hostnames/agent-a/seen']);
});

test('keepAlive reports the hostname at start and every 12 hours, until stopped', async () => {
	const { provider, backend, timers } = await setup();
	const host = await provider.ensure(31580, { anonymous: false });
	const stop = provider.keepAlive({ id: host, port: 31580 });
	await new Promise((r) => setTimeout(r, 50));
	const seen = () => backend.paths((c) => c.path.endsWith('/seen')).length;
	assert.equal(seen(), 1);
	assert.equal(timers.at(-1).ms, 12 * 3_600_000);
	await timers.at(-1).fn();
	assert.equal(seen(), 2);
	stop();
	assert.equal(timers.at(-1).cleared, true);
});

test('services are all null and every optional feature is off', async () => {
	const { provider } = await setup();
	assert.deepEqual(provider.services({ port: 31580 }), { preview: null, status: null, remover: null });
	assert.ok(Object.values(provider.features).every((on) => on === false));
	assert.equal(await provider.connectToken('x'), null);
});

test('reachable asks the API and counts any answer', async () => {
	let asked;
	const { provider, backend } = await setup({ reachableFn: async (o) => ((asked = o), true) });
	assert.equal(await provider.reachable(), true);
	assert.deepEqual(asked, { url: `${backend.url}/v1/me`, timeoutMs: 5000 });
});

test('a failed connector asks for a new connector token the next time', async () => {
	const { provider, backend, connector } = await setup();
	const host = await provider.ensure(31580, { anonymous: false });
	connector.fail = new Error('cloudflared exited (1): Provided Tunnel token is not valid.');
	await assert.rejects(provider.host(host, 31580));
	connector.fail = null;
	await provider.host(host, 31580);
	assert.equal(backend.paths((c) => c.path === '/v1/tunnel').length, 2);
});

test('device login: prints the code, opens the link, polls until approved', async () => {
	const backend = await fakeBackend();
	backends.push(backend);
	const { createCloudApi } = await import('../../../src/providers/cloud/api.js');
	const api = createCloudApi({ base: backend.url });
	const printed = [];
	const opened = [];
	const sleeps = [];
	const got = await deviceLogin(api, { machineName: 'Mac', print: (s) => printed.push(s), open: (u) => opened.push(u), sleep: async (ms) => sleeps.push(ms) });
	assert.equal(got.credential, 'crm_test');
	assert.match(printed.join(''), /https:\/\/cloud\.test\/link\?code=ABCD-EFGH[\s\S]*ABCD-EFGH/);
	assert.deepEqual(opened, ['https://cloud.test/link?code=ABCD-EFGH']);
	assert.deepEqual(sleeps, [1000, 1000]);
	for (const [code, pattern] of [['EDENIED', /denied/], ['EEXPIRED', /expired/], ['ENOACCESS', /doesn't have Code Remote Cloud access/]]) {
		Object.assign(backend.state, { login: code, polls: 0 });
		await assert.rejects(deviceLogin(api, { print() {}, open() {}, sleep: async () => {} }), pattern, code);
	}
	let t = 0;
	Object.assign(backend.state, { login: 'approved', polls: 0, pendingPolls: 1e9 });
	await assert.rejects(deviceLogin(api, { print() {}, open() {}, sleep: async () => {}, now: () => (t += 200_000) }), /expired/);
});
