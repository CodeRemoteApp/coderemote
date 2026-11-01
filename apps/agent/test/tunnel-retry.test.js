// Bringing the tunnel up later: the reachability check and the retry loop, on a fake clock.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { NotSignedIn, relayReachable, retryTunnel } from '../src/tunnel-retry.js';

/** Timers that run only when the test says so. */
function fakeClock() {
	const timers = [];
	return {
		delays: () => timers.map((t) => t.ms),
		setTimer: (fn, ms) => {
			const t = { fn, ms };
			timers.push(t);
			return t;
		},
		clearTimer: (t) => (t.cleared = true),
		/** Fires the latest timer and lets its async work settle. */
		async tick() {
			const t = timers.at(-1);
			assert.ok(t && !t.cleared, 'a timer is pending');
			await t.fn();
		},
	};
}

test('waits longer after each miss, up to the cap, and stops at the first success', async () => {
	const clock = fakeClock();
	const online = [false, false, false, true];
	let connects = 0;
	const retry = retryTunnel({
		reachable: async () => online.shift(),
		connect: async () => (++connects, 'https://x.devtunnels.ms'),
		firstMs: 15, maxMs: 40,
		...clock,
	});
	for (let i = 0; i < 4; i++) await clock.tick();
	assert.deepEqual(clock.delays(), [15, 30, 40, 40]);
	assert.equal(connects, 1);
	assert.equal(await retry.done, 'https://x.devtunnels.ms');
});

test('says once that nobody is signed in, and keeps trying without a browser', async () => {
	const clock = fakeClock();
	let signedIn = false;
	let told = 0;
	const retry = retryTunnel({
		reachable: async () => true,
		connect: async () => {
			if (!signedIn) throw new NotSignedIn();
			return 'ok';
		},
		onSignedOut: () => told++,
		...clock,
	});
	await clock.tick();
	await clock.tick();
	assert.equal(told, 1);
	signedIn = true;
	await clock.tick();
	assert.equal(await retry.done, 'ok');
});

test('other failures are reported and retried; stop() ends it', async () => {
	const clock = fakeClock();
	const errors = [];
	const retry = retryTunnel({
		reachable: async () => true,
		connect: async () => {
			throw new Error('devtunnel host exited (1)');
		},
		onError: (e) => errors.push(e.message),
		...clock,
	});
	await clock.tick();
	assert.deepEqual(errors, ['devtunnel host exited (1)']);
	retry.stop();
	assert.equal(clock.delays().length, 2);
	await clock.tick().catch(() => {});
});

/** A stand-in for https.request that answers, fails or hangs. */
function fakeRequest(behavior) {
	return (_url, _opts, onResponse) => {
		const req = new EventEmitter();
		req.end = () => {
			if (behavior === 'answer') onResponse(Object.assign(new EventEmitter(), { resume() {} }));
			if (behavior === 'error') req.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
			if (behavior === 'hang') req.emit('timeout');
		};
		req.destroy = () => {};
		return req;
	};
}

test('any HTTP answer means reachable; DNS failures and timeouts do not', async () => {
	assert.equal(await relayReachable({ request: fakeRequest('answer') }), true);
	assert.equal(await relayReachable({ request: fakeRequest('error') }), false);
	assert.equal(await relayReachable({ request: fakeRequest('hang') }), false);
});
