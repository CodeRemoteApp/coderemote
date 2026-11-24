// Keeping the tunnel hosted: hosting again after the host exits or stops answering, on a fake clock.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { probeAgent, watchTunnel } from '../src/tunnel-watch.js';

/** Timers that run only when the test says so. */
function fakeClock() {
	const timers = [];
	return {
		pending: () => timers.filter((t) => !t.cleared && !t.fired),
		setTimer: (fn, ms) => {
			const t = { fn, ms };
			timers.push(t);
			return t;
		},
		clearTimer: (t) => (t.cleared = true),
		/** Fires the earliest pending timer of `ms` (any when omitted) and lets it settle. */
		async fire(ms) {
			const t = timers.find((x) => !x.cleared && !x.fired && (ms === undefined || x.ms === ms));
			assert.ok(t, `a ${ms ?? ''} timer is pending`);
			t.fired = true;
			await t.fn();
			await new Promise((r) => setImmediate(r));
		},
	};
}

function fakeChild() {
	const child = new EventEmitter();
	child.killed = false;
	child.kill = () => {
		child.killed = true;
		child.emit('exit', null, 'SIGTERM');
	};
	return child;
}

function setup({ probes = [], reachable = true, hostFails = 0 } = {}) {
	const clock = fakeClock();
	const logs = [];
	const hosts = [];
	let failing = hostFails;
	const first = { child: fakeChild(), url: 'https://x-1.devtunnels.ms' };
	const watcher = watchTunnel({
		hosted: first,
		host: async () => {
			if (failing-- > 0) throw new Error('relay said no');
			const next = { child: fakeChild(), url: 'https://x-1.devtunnels.ms' };
			hosts.push(next);
			return next;
		},
		probe: async () => {
			const p = probes.shift();
			if (p instanceof Error) throw p;
			return p ?? true;
		},
		reachable: async () => reachable,
		log: (m) => logs.push(m),
		intervalMs: 100,
		failLimit: 2,
		firstRetryMs: 10,
		exitGraceMs: 1,
		...clock,
	});
	return { clock, logs, hosts, first, watcher };
}

test('a host that exits is hosted again', async () => {
	const { clock, logs, hosts, first, watcher } = setup();
	first.child.emit('exit', 1, null);
	await clock.fire(1);
	assert.equal(hosts.length, 1);
	assert.equal(watcher.hosted, hosts[0]);
	assert.match(logs[0], /stopped \(exit 1\)/);
	assert.match(logs[1], /connected again/);
	watcher.stop();
});

test('an exit after stop (Ctrl-C) hosts nothing', async () => {
	const { clock, hosts, first, watcher } = setup();
	first.child.emit('exit', 143, null);
	watcher.stop();
	await clock.fire(1);
	assert.equal(hosts.length, 0);
});

test('two failed probes in a row while the relay answers host again, killing the old host', async () => {
	const { clock, hosts, first, watcher } = setup({ probes: [false, true, false, false] });
	await clock.fire(100); // fail
	await clock.fire(100); // ok: resets
	await clock.fire(100); // fail
	assert.equal(hosts.length, 0);
	await clock.fire(100); // fail again: rehost
	assert.equal(hosts.length, 1);
	assert.ok(first.child.killed);
	// The killed host's exit doesn't trigger another round.
	assert.equal(clock.pending().filter((t) => t.ms === 1).length, 0);
	assert.equal(clock.pending().filter((t) => t.ms === 100).length, 1, 'checks go on');
	watcher.stop();
});

test('offline, failed probes change nothing', async () => {
	const { clock, hosts, watcher } = setup({ probes: [false, false, false], reachable: false });
	for (let i = 0; i < 3; i++) await clock.fire(100);
	assert.equal(hosts.length, 0);
	watcher.stop();
});

test("a probe that can't run is reported once and hosts nothing", async () => {
	const { clock, logs, hosts, watcher } = setup({ probes: [new Error('login expired'), new Error('login expired')] });
	await clock.fire(100);
	await clock.fire(100);
	assert.equal(hosts.length, 0);
	assert.deepEqual(logs, ["Couldn't check the tunnel: login expired"]);
	watcher.stop();
});

test('hosting again retries with growing waits until it works', async () => {
	const { clock, logs, hosts, first, watcher } = setup({ hostFails: 2 });
	first.child.emit('exit', 1, null);
	const done = clock.fire(1);
	await new Promise((r) => setImmediate(r));
	await clock.fire(10);
	await clock.fire(20);
	await done;
	assert.equal(hosts.length, 1);
	assert.equal(logs.filter((m) => m.startsWith("Couldn't host")).length, 2);
	watcher.stop();
});

test('probeAgent: only the agent page counts; errors and timeouts are no', async () => {
	const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";
	let sent;
	const respond = (status, headers) => async (url, init) => {
		sent = { url, init };
		return new Response('', { status, headers });
	};
	assert.equal(await probeAgent('https://a', { 'x-tunnel-authorization': 'tunnel tok' }, { fetchFn: respond(200, { 'content-security-policy': csp }) }), true);
	assert.equal(sent.url, 'https://a/');
	assert.equal(sent.init.headers['x-tunnel-authorization'], 'tunnel tok');
	assert.equal(await probeAgent('https://a', {}, { fetchFn: respond(200, {}) }), false);
	assert.deepEqual(sent.init.headers, {});
	assert.equal(await probeAgent('https://a', {}, { fetchFn: respond(302, {}) }), false);
	assert.equal(await probeAgent('https://a', {}, { fetchFn: async () => { throw new Error('timeout'); } }), false);
});
