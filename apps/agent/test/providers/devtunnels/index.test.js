// The Dev Tunnels provider, driven with a stubbed `devtunnel` runner.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create, parseConnectToken } from '../../../src/providers/devtunnels/index.js';
import { PREVIEW_LABEL, TUNNEL_LIMIT } from '../../../src/providers/devtunnels/tunnels.js';

const quiet = { start() {}, update() {}, succeed() {}, stop() {} };

/** `answer(args)` gives each call's `{ ok, out }`; every call is recorded with when it started and ended. */
function setup(answer, cfg = {}) {
	const calls = [];
	let saved = 0;
	const provider = create({
		configDir: '/nonexistent',
		spinner: quiet,
		cfg,
		saveConfig: () => saved++,
		loadConfig: () => ({ ...cfg }),
		defaultPort: 31580,
		run: async (_command, args) => {
			const call = { args, open: true };
			calls.push(call);
			// Let any call started alongside this one begin before it ends.
			await new Promise((r) => setImmediate(r));
			call.open = false;
			call.openOthers = calls.filter((c) => c !== call && c.open).length;
			return answer(args, calls);
		},
	});
	return { provider, calls, cfg, saves: () => saved };
}

const ok = (out = '') => ({ ok: true, out });
const fail = (out) => ({ ok: false, out });
const verb = (call) => call.args.slice(0, 2).join(' ');

test('ensure on a known tunnel updates it and its access at once, redoing the one the service rejected', async () => {
	let accessTries = 0;
	const { provider, calls } = setup(
		(args) => {
			if (args[0] === 'access') return ++accessTries === 1 ? fail('Conflicting request: tunnel was modified') : ok();
			return ok();
		},
		{ tunnels: { 31580: 'known-tunnel' } },
	);
	assert.equal(await provider.ensure(31580, { anonymous: false }), 'known-tunnel');
	assert.deepEqual(calls.map(verb), ['update known-tunnel', 'access reset', 'access reset']);
	// The first two overlapped: each saw the other still running.
	assert.ok(calls[0].openOthers + calls[1].openOthers >= 1);
	assert.deepEqual(calls[0].args, ['update', 'known-tunnel', '--expiration', '30d', '--add-labels', 'coderemote']);
});

test('ensure replaces a tunnel that is gone, and only then', async () => {
	const created = JSON.stringify({ tunnel: { tunnelId: 'new-tunnel.asse' } });
	const { provider, calls, cfg } = setup(
		(args) => {
			if (args[0] === 'update') return fail('Tunnel not found');
			if (args[0] === 'create') return ok(`Welcome\n${created}`);
			return ok();
		},
		{ tunnels: { 31580: 'old-tunnel' } },
	);
	assert.equal(await provider.ensure(31580, { anonymous: true }), 'new-tunnel.asse');
	assert.deepEqual(calls.map((c) => c.args[0]), ['update', 'access', 'create', 'port']);
	assert.ok(calls[2].args.includes('--allow-anonymous'));
	assert.equal(cfg.tunnels[31580], 'new-tunnel.asse');
	assert.equal(cfg.tunnelId, 'new-tunnel.asse', 'older releases read it for the default port');

	const other = setup((args) => (args[0] === 'update' ? fail('Rate limit exceeded') : ok()), { tunnels: { 31580: 'old-tunnel' } });
	await assert.rejects(other.provider.ensure(31580, { anonymous: false }), /devtunnel update failed/);
	assert.equal(other.calls.filter((c) => c.args[0] === 'create').length, 0);
});

const listing = (tunnels) => ok(`Welcome\n${JSON.stringify({ tunnels })}`);
const full = (fields = () => ({})) =>
	Array.from({ length: TUNNEL_LIMIT }, (_, i) => ({ tunnelId: `t-${i}`, hostConnections: 0, labels: [], ...fields(i) }));

test('at the limit, idle preview tunnels are deleted and the create tried again', async () => {
	const account = full((i) => (i === 3 ? { labels: [PREVIEW_LABEL] } : {}));
	let creates = 0;
	const created = JSON.stringify({ tunnel: { tunnelId: 'fresh' } });
	const { provider, calls } = setup((args) => {
		if (args[0] === 'create') return ++creates === 1 ? fail('Rate limit exceeded') : ok(created);
		if (args[0] === 'list') return listing(account);
		return ok();
	});
	assert.equal(await provider.ensure(31581, { anonymous: false }), 'fresh');
	assert.deepEqual(
		calls.map((c) => c.args.slice(0, 2).join(' ')),
		['create --expiration', 'list --limit', 'delete t-3', 'create --expiration', 'port create'],
	);
});

test('at the limit with nothing idle, ensure fails with ETUNNELLIMIT and the list', async () => {
	const account = full();
	const { provider } = setup((args) => (args[0] === 'create' ? fail('Rate limit exceeded') : args[0] === 'list' ? listing(account) : ok()));
	await assert.rejects(provider.ensure(31581, { anonymous: false }), (e) => e.code === 'ETUNNELLIMIT' && e.tunnels.length === TUNNEL_LIMIT);
});

test('connect tokens: the expiration is parsed; the probe reuses one until it is close to expiring', async () => {
	const body = (token, at) => ok(`Welcome\n${JSON.stringify({ token, expiration: at })}`);
	assert.deepEqual(parseConnectToken(body('abc', '2026-10-27 01:52:06 UTC').out), { token: 'abc', expiresAt: Date.UTC(2026, 9, 27, 1, 52, 6) });
	assert.throws(() => parseConnectToken('{"token":"x","expiration":"soon"}'), /unexpected/);

	const later = new Date(Date.now() + 20 * 3_600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
	const { provider, calls } = setup(() => body('tok', later));
	assert.deepEqual(await provider.probeHeaders('t', { anonymous: false }), { 'x-tunnel-authorization': 'tunnel tok' });
	await provider.probeHeaders('t', { anonymous: false });
	assert.equal(calls.length, 1);
	assert.deepEqual(await provider.probeHeaders('t', { anonymous: true }), {});
});

test('account: an expired login is not signed in; without a terminal that throws NotSignedIn', async () => {
	const expired = setup(() => ok('Login token expired. Please log in again.'));
	await assert.rejects(expired.provider.account({ interactive: false }), (e) => e.code === 'ENOTSIGNEDIN');
	const signedIn = setup(() => ok('Logged in as thanh using GitHub.'));
	assert.equal(await signedIn.provider.account({ interactive: false }), 'thanh (GitHub)');
});

test('it supports every optional feature', () => {
	const { provider } = setup(() => ok());
	assert.equal(provider.name, 'devtunnels');
	assert.ok(Object.values(provider.features).every(Boolean));
	assert.equal(provider.known(31580), null);
});
