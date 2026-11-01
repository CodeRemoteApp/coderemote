// An agent started without internet runs on the local network only; this brings its tunnel up
// once the dev tunnels service can be reached, without restarting the agent.
import http from 'node:http';
import https from 'node:https';

// CODEREMOTE_RELAY_CHECK_URL points the check elsewhere, to try the offline start with the internet on.
export const RELAY_CHECK_URL = process.env.CODEREMOTE_RELAY_CHECK_URL || 'https://global.rel.tunnels.api.visualstudio.com/';

/**
 * Whether the dev tunnels service answers at all: any HTTP status counts, only a network-level
 * failure (no DNS, no route, TLS cut, timeout) means offline. Never rejects.
 */
export function relayReachable({ url = RELAY_CHECK_URL, timeoutMs = 4000, request = url.startsWith('http:') ? http.request : https.request } = {}) {
	return new Promise((resolve) => {
		let done = false;
		const finish = (ok) => {
			if (done) return;
			done = true;
			resolve(ok);
		};
		try {
			const req = request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
				res.resume();
				finish(true);
			});
			req.on('timeout', () => {
				req.destroy();
				finish(false);
			});
			req.on('error', () => finish(false));
			req.end();
		} catch {
			finish(false);
		}
	});
}

/** Thrown by `connect` when no one is signed in to dev tunnels: there's no browser to sign in from here. */
export class NotSignedIn extends Error {
	constructor() {
		super('not signed in to dev tunnels');
		this.code = 'ENOTSIGNEDIN';
	}
}

/**
 * Tries `connect()` whenever `reachable()` says the service answers: first after `firstMs`, then
 * waiting twice as long after each miss, up to `maxMs`. `onSignedOut` runs once while nobody is
 * signed in (`connect` threw NotSignedIn); `onError` gets any other failure. Stops after the first
 * success, resolving `done`, or on `stop()`.
 */
export function retryTunnel({
	reachable,
	connect,
	onSignedOut = () => {},
	onError = () => {},
	firstMs = 15_000,
	maxMs = 300_000,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
}) {
	let delay = firstMs;
	let timer = null;
	let stopped = false;
	let toldSignedOut = false;
	let resolveDone;
	const done = new Promise((r) => (resolveDone = r));

	const schedule = () => {
		if (stopped) return;
		timer = setTimer(attempt, delay);
		timer?.unref?.();
		delay = Math.min(delay * 2, maxMs);
	};

	async function attempt() {
		timer = null;
		if (stopped) return;
		if (!(await reachable())) return schedule();
		try {
			const result = await connect();
			if (stopped) return;
			stopped = true;
			resolveDone(result);
		} catch (e) {
			if (stopped) return;
			if (e?.code === 'ENOTSIGNEDIN') {
				if (!toldSignedOut) onSignedOut();
				toldSignedOut = true;
			} else onError(e);
			schedule();
		}
	}

	schedule();
	return {
		done,
		stop() {
			stopped = true;
			if (timer) clearTimer(timer);
		},
	};
}
