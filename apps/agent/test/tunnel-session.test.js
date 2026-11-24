// The provider-independent tunnel flow (connect, watch, offline retry, shutdown) with a fake provider.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { NotSignedIn } from '../src/tunnel-retry.js';
import { createTunnelSession } from '../src/tunnel-session.js';

const quiet = { start() {}, update() {}, succeed() {}, stop() {}, fail() {} };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakeChild() {
	const child = new EventEmitter();
	child.killed = false;
	child.kill = () => {
		if (child.killed) return;
		child.killed = true;
		child.emit('exit', null, 'SIGTERM');
	};
	return child;
}

/**
 * A provider that records what it's asked. `ensure` waits for `release()` when `holdEnsure`.
 * `signedIn` may be flipped later; `online` too.
 */
function fakeProvider({ known = null, ensureId = known ?? 'new-id', ensureError = null, holdEnsure = false, features = {} } = {}) {
	const events = [];
	const hosts = [];
	let release;
	const held = new Promise((r) => (release = r));
	const state = { signedIn: true, online: true };
	const provider = {
		name: 'fake',
		features: { preview: true, share: true, machines: true, deleteTunnels: true, signIn: true, ...features },
		state,
		events,
		hosts,
		release,
		async prepare() {
			events.push('prepare');
		},
		async account({ interactive }) {
			events.push(`account ${interactive}`);
			if (!state.signedIn) throw new NotSignedIn();
			return 'me (Fake)';
		},
		known: () => known,
		async ensure(port, { anonymous }) {
			events.push(`ensure ${port} ${anonymous}`);
			if (holdEnsure) await held;
			if (ensureError) throw ensureError;
			return ensureId;
		},
		async host(id, port) {
			events.push(`host ${id}`);
			const hosted = { id, child: fakeChild(), url: `https://${id}-${port}.example` };
			hosts.push(hosted);
			return hosted;
		},
		async connectToken(id) {
			return { token: `token-${id}`, expiresAt: Date.now() + 1000 };
		},
		async probeHeaders() {
			return { 'x-fake': '1' };
		},
		reachable: async () => state.online,
		services: () => ({ preview: null, status: null, remover: null }),
		text: { checkingSignIn: 'checking', connecting: 'connecting', signedOut: 'signed out', access: (who) => `as ${who}` },
		commands: {},
	};
	return provider;
}

// The real code unrefs its timers so they never keep the agent alive; here they must keep the
// test's event loop running until the awaited step happens.
const keptTimers = { setTimer: (fn, ms) => ({ id: setTimeout(fn, ms) }), clearTimer: (t) => clearTimeout(t.id) };

function session(provider, opts = {}) {
	const logs = [];
	const urls = [];
	const s = createTunnelSession({
		provider,
		port: 31590,
		anonymous: false,
		spinner: quiet,
		log: (m) => logs.push(m),
		onUrl: (u) => urls.push(u),
		watchOptions: { intervalMs: 1e9, exitGraceMs: 1, firstRetryMs: 1, ...keptTimers },
		retryOptions: { firstMs: 1, maxMs: 1, ...keptTimers },
		...opts,
	});
	return { s, logs, urls };
}

test("the known tunnel's host starts before ensure finishes", async () => {
	const provider = fakeProvider({ known: 'known-id', holdEnsure: true });
	const { s, urls } = session(provider);
	const connecting = s.connect({ interactive: true });
	await tick();
	assert.deepEqual(provider.events, ['prepare', 'account true', 'host known-id', 'ensure 31590 false']);
	provider.release();
	const { url, access } = await connecting;
	assert.equal(url, 'https://known-id-31590.example');
	assert.equal(access, 'as me (Fake)');
	assert.deepEqual(urls, [url]);
	assert.equal(s.hostedUrl(), url);
	assert.equal(s.tunnelId, 'known-id');
	assert.equal((await s.tunnelToken()).token, 'token-known-id');
	s.stop();
});

test('a changed tunnel id ends the first host and hosts the new one', async () => {
	const provider = fakeProvider({ known: 'gone-id', ensureId: 'fresh-id' });
	const { s } = session(provider);
	const { url } = await s.connect({ interactive: false });
	assert.equal(url, 'https://fresh-id-31590.example');
	assert.deepEqual(provider.hosts.map((h) => [h.id, h.child.killed]), [['gone-id', true], ['fresh-id', false]]);
	s.stop();
});

test('an ensure failure ends the host started ahead of it', async () => {
	const provider = fakeProvider({ known: 'known-id', ensureError: Object.assign(new Error('full'), { code: 'ETUNNELLIMIT' }) });
	const { s } = session(provider);
	await assert.rejects(s.connect({ interactive: true }), (e) => e.code === 'ETUNNELLIMIT');
	await tick();
	assert.equal(provider.hosts.length, 1);
	assert.ok(provider.hosts[0].child.killed);
	assert.equal(s.hostedUrl(), null);
});

test('started offline, it connects once the provider answers, never interactively', async () => {
	const provider = fakeProvider();
	provider.state.online = false;
	provider.state.signedIn = false;
	const { s, logs } = session(provider);
	const done = s.connectLater();
	await tick(5);
	assert.equal(provider.hosts.length, 0);
	provider.state.online = true;
	await tick(5);
	assert.deepEqual(logs, ['signed out']);
	provider.state.signedIn = true;
	assert.equal(await done, 'https://new-id-31590.example');
	assert.ok(provider.events.filter((e) => e.startsWith('account')).every((e) => e === 'account false'));
	s.stop();
});

test('a host that exits after the start is hosted again through the provider', async () => {
	const provider = fakeProvider({ known: 'known-id' });
	const { s, logs } = session(provider);
	await s.connect({ interactive: false });
	provider.hosts[0].child.emit('exit', 1, null);
	await tick(20);
	assert.equal(provider.hosts.length, 2);
	assert.match(logs.join('\n'), /stopped \(exit 1\)/);
	s.stop();
	assert.ok(provider.hosts[1].child.killed, 'stop ends the current host');
});

test('stop leaves no host running, even one still connecting', async () => {
	const provider = fakeProvider({ known: 'known-id', holdEnsure: true });
	const { s } = session(provider);
	const connecting = s.connect({ interactive: false });
	await tick();
	s.stop();
	provider.release();
	await assert.rejects(connecting);
	assert.ok(provider.hosts.every((h) => h.child.killed));
});

test('a provider without sign-in hands out no tokens', () => {
	const { s } = session(fakeProvider({ features: { signIn: false } }));
	assert.equal(s.tunnelToken, null);
});

test('a provider without the optional features gets their routes answering 404, the rest working', async () => {
	const { createAgentServer } = await import('@vsremote/agent-core');
	const { TUNNEL_HANDOFF_PATH } = await import('@vsremote/protocol');
	const { createHmac } = await import('node:crypto');
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const off = { preview: false, share: false, machines: false, deleteTunnels: false, signIn: false };
	const provider = fakeProvider({ features: off });
	// Even when a provider builds them anyway, what it says it lacks stays off.
	const status = async () => ({ provider: 'fake' });
	provider.services = () => ({ preview: { list: () => [] }, status, remover: async () => ({}) });
	const { s } = session(provider);
	await s.connect({ interactive: false });
	assert.deepEqual(s.services, { preview: null, status: null, remover: null });

	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-session-'));
	const token = 'pair-token';
	const server = createAgentServer({
		token,
		root,
		tunnelToken: s.tunnelToken ?? undefined,
		preview: s.services.preview,
		tunnelStatus: s.services.status,
		tunnelDelete: s.services.remover,
		tunnelUrl: () => s.hostedUrl(),
		tunnelProvider: provider.name,
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = (method, route) => fetch(new URL(route, base), { method, headers: { authorization: `Bearer ${token}` }, redirect: 'manual' });
	try {
		const preview = await call('GET', '/api/preview');
		assert.equal(preview.status, 404);
		assert.match((await preview.json()).error, /tunnel that supports them/);
		assert.equal((await call('GET', '/api/tunnel')).status, 404);
		assert.equal((await call('DELETE', '/api/tunnel')).status, 404);
		assert.equal((await call('POST', '/api/tunnel/token')).status, 404);
		const nonce = `${Math.floor(Date.now() / 1000)}.abc`;
		const handoff = new URL(TUNNEL_HANDOFF_PATH, base);
		handoff.searchParams.set('nonce', nonce);
		handoff.searchParams.set('sig', createHmac('sha256', token).update(nonce).digest('base64url'));
		handoff.searchParams.set('state', 'state-12345');
		assert.equal((await fetch(handoff, { redirect: 'manual' })).status, 404);

		const info = await call('GET', '/api/info');
		assert.equal(info.status, 200);
		assert.deepEqual((await info.json()).tunnel, { url: 'https://new-id-31590.example', provider: 'fake' });
		assert.equal((await call('GET', '/api/term')).status, 200);
	} finally {
		server.close();
		s.stop();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
