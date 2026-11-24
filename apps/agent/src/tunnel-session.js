// One agent's tunnel, through whichever provider it uses (src/providers): sign in, create or
// refresh the tunnel and host it, keep it answering (tunnel-watch.js), connect it later when the
// agent started offline (tunnel-retry.js), and leave nothing running at shutdown.
import { retryTunnel } from './tunnel-retry.js';
import { probeAgent, watchTunnel } from './tunnel-watch.js';

/**
 * @param {object} opts
 * @param {import('./providers/index.js').TunnelProvider} opts.provider
 * @param {number} opts.port  the agent's local port
 * @param {boolean} opts.anonymous  no sign-in in front of the tunnel (--allow-anonymous)
 * @param {{ start(text: string): void, succeed(): void }} opts.spinner
 * @param {(url: string) => void} [opts.onUrl]  every time the tunnel is hosted at a URL
 * @param {(message: string) => void} [opts.log]  what happens later, in the agent's terminal
 */
export function createTunnelSession({
	provider,
	port,
	anonymous,
	spinner,
	onUrl = () => {},
	log = (message) => console.log(`\n  ${message}`),
	watch = watchTunnel,
	probe = probeAgent,
	retry = retryTunnel,
	watchOptions = {},
	retryOptions = {},
}) {
	let tunnelId;
	let account;
	let child = null;
	let watcher = null;
	let stopKeepAlive = null;
	let later = null;
	let hostedUrl = null;
	let stopped = false;

	// What the agent's routes get; null for a feature the provider lacks, so those answer 404.
	const offered = provider.services({ port, tunnelId: () => tunnelId, account: () => account, anonymous });
	const { features } = provider;
	const services = {
		preview: features.preview ? offered.preview : null,
		status: features.machines ? offered.status : null,
		remover: features.deleteTunnels ? offered.remover : null,
	};
	const kill = (hosting) => hosting?.then((h) => h.child.kill(), () => {});

	/**
	 * Signs in (only when `interactive`: in the background there's no one to open a browser for),
	 * creates or updates the tunnel and hosts it. Resolves `{ url, access }`.
	 */
	async function connect({ interactive }) {
		await provider.prepare();
		if (interactive) spinner.start(provider.text.checkingSignIn);
		const user = await provider.account({ interactive });
		account = user;
		if (interactive) {
			spinner.succeed();
			// Connecting to the relay is the slow part; update the tunnel's settings meanwhile.
			spinner.start(provider.text.connecting);
		}
		const known = provider.known(port);
		let hosting = known ? provider.host(known, port) : null;
		hosting?.catch(() => {});
		let id;
		try {
			id = await provider.ensure(port, { anonymous });
		} catch (e) {
			kill(hosting);
			throw e;
		}
		if (id !== known) {
			// The saved tunnel was gone and a new one was created.
			kill(hosting);
			hosting = provider.host(id, port);
		}
		const hosted = await hosting;
		if (stopped) {
			hosted.child.kill();
			throw new Error('the agent is stopping');
		}
		tunnelId = id;
		child = hosted.child;
		hostedUrl = hosted.url;
		// Days later the host may have exited or lost the relay: host it again when it has.
		watcher = watch({
			hosted,
			host: () => provider.host(id, port, { timeoutMs: 90_000 }),
			probe: async (at) => probe(at, await provider.probeHeaders(id, { anonymous })),
			reachable: () => provider.reachable(),
			onHosted: (next) => {
				child = next.child;
			},
			log,
			...watchOptions,
		});
		stopKeepAlive = provider.keepAlive?.({ id, port }) ?? null;
		services.status?.invalidate?.();
		onUrl(hostedUrl);
		const access = anonymous ? 'anyone with the link (no sign-in, --allow-anonymous)' : provider.text.access(user);
		return { url: hostedUrl, access };
	}

	return {
		provider,
		services,
		connect,
		/** For an agent started offline: connects once the provider answers. Resolves the URL. */
		connectLater() {
			later = retry({
				reachable: () => provider.reachable(),
				connect: async () => (await connect({ interactive: false })).url,
				onSignedOut: () => log(provider.text.signedOut),
				onError: (e) => log(`Couldn't connect the tunnel yet (${e.message.split('\n')[0]}); retrying.`),
				...retryOptions,
			});
			return later.done;
		},
		/** A token the app signs in with, while the tunnel is hosted and the provider has them. */
		tunnelToken: provider.features.signIn ? async () => (!anonymous && tunnelId ? provider.connectToken(tunnelId) : null) : null,
		/** The URL it's hosted at, or null. */
		hostedUrl: () => hostedUrl,
		get tunnelId() {
			return tunnelId;
		},
		/** Ends the retry, the watch and the host. */
		stop() {
			stopped = true;
			later?.stop();
			watcher?.stop();
			stopKeepAlive?.();
			child?.kill();
		},
	};
}
