// Keeps a hosted tunnel answering for days on end. `devtunnel host` can exit, or stay running
// after losing the relay (the Mac slept, the network changed): either way the relay then holds
// every request on "Connecting to the forwarded port..." while the agent looks fine locally.
// This hosts the tunnel again when the host exits, and when the agent can't reach itself through
// the relay twice in a row while the relay itself answers.

/**
 * @param {object} opts
 * @param {{ child: import('node:child_process').ChildProcess, url: string }} opts.hosted  the running host
 * @param {() => Promise<{ child: import('node:child_process').ChildProcess, url: string }>} opts.host  starts a new one
 * @param {(url: string) => Promise<boolean>} opts.probe  whether the agent answers through the relay; may throw
 * @param {() => Promise<boolean>} opts.reachable  whether the relay answers at all
 * @param {(hosted: { child, url }) => void} [opts.onHosted]  after every new host
 * @param {(message: string) => void} [opts.log]
 * @returns {{ stop(): void, check(): Promise<void> }}
 */
export function watchTunnel({
	hosted,
	host,
	probe,
	reachable,
	onHosted = () => {},
	log = () => {},
	intervalMs = 120_000,
	failLimit = 2,
	firstRetryMs = 5_000,
	maxRetryMs = 300_000,
	exitGraceMs = 1_000,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
}) {
	let current = hosted;
	let stopped = false;
	let busy = false;
	let failures = 0;
	let probeError = null;
	// A host exit seen while a check was running: hosted again once it ends.
	let pending = false;
	let timer = null;
	const retired = new WeakSet();

	const wait = (ms) =>
		new Promise((resolve) => {
			timer = setTimer(resolve, ms);
			timer?.unref?.();
		});

	function watchExit(child) {
		child.once('exit', (code, signal) => {
			if (stopped || retired.has(child)) return;
			// Ctrl-C reaches the host too, and its exit may land before the agent's own shutdown
			// stops this watcher: give that a moment.
			const later = setTimer(() => {
				if (stopped || retired.has(child) || current.child !== child) return;
				log(`The tunnel host stopped (${signal ?? `exit ${code}`}); connecting the tunnel again.`);
				rehost();
			}, exitGraceMs);
			later?.unref?.();
		});
	}

	async function rehost() {
		if (stopped) return;
		if (busy) {
			pending = true;
			return;
		}
		busy = true;
		pending = false;
		retired.add(current.child);
		current.child.kill();
		let delay = firstRetryMs;
		while (!stopped) {
			try {
				const next = await host();
				if (stopped) {
					next.child.kill();
					break;
				}
				current = next;
				failures = 0;
				watchExit(next.child);
				onHosted(next);
				log(`Tunnel connected again: ${next.url}`);
				break;
			} catch (e) {
				log(`Couldn't host the tunnel (${String(e.message).split('\n')[0]}); retrying in ${Math.round(delay / 1000)}s.`);
				await wait(delay);
				delay = Math.min(delay * 2, maxRetryMs);
			}
		}
		busy = false;
		schedule();
	}

	async function check() {
		if (busy || stopped) return;
		busy = true;
		let restart = false;
		try {
			let ok;
			try {
				ok = await probe(current.url);
				probeError = null;
			} catch (e) {
				// Can't check (say the sign-in expired): hosting again wouldn't help, so just say so once.
				const message = String(e.message).split('\n')[0];
				if (message !== probeError) log(`Couldn't check the tunnel: ${message}`);
				probeError = message;
				return;
			}
			if (ok) failures = 0;
			// Offline: nothing to fix from here; the host reconnects or gets replaced once it's back.
			else if (!(await reachable())) failures = 0;
			else if (++failures >= failLimit) {
				log("The tunnel stopped answering through the relay; connecting it again.");
				restart = true;
			}
		} finally {
			busy = false;
		}
		if ((restart || pending) && !stopped) await rehost();
	}

	function schedule() {
		if (stopped) return;
		if (timer) clearTimer(timer);
		timer = setTimer(async () => {
			timer = null;
			await check();
			if (!busy) schedule();
		}, intervalMs);
		timer?.unref?.();
	}

	watchExit(current.child);
	schedule();
	return {
		check,
		/** The host running now. */
		get hosted() {
			return current;
		},
		stop() {
			stopped = true;
			if (timer) clearTimer(timer);
		},
	};
}

// The agent's landing page (`GET /`) carries this policy; the relay's own pages don't.
const AGENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/**
 * Whether the agent answers at `url` through the relay. With no host the relay holds the request
 * open, so a timeout means no. `headers` are the provider's (a connect token for Dev Tunnels).
 */
export async function probeAgent(url, headers = {}, { timeoutMs = 20_000, fetchFn = fetch } = {}) {
	try {
		const res = await fetchFn(`${url}/`, {
			redirect: 'manual',
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		await res.body?.cancel?.();
		return res.status === 200 && res.headers.get('content-security-policy') === AGENT_CSP;
	} catch {
		return false;
	}
}
