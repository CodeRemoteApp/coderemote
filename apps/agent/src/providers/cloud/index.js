// Code Remote Cloud as a tunnel provider (see ../index.js for the interface). The computer signs in
// once by device code; the backend gives it one Cloudflare tunnel and each agent (port) its own
// hostname on it. Every agent runs its own `cloudflared` for the machine's tunnel: connectors of one
// tunnel are replicas, each serving every hostname's ingress on this computer, so stopping one
// folder leaves the others answering. A gate in front of each hostname admits only its owner.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { NotSignedIn, relayReachable } from '../../tunnel-retry.js';
import { CloudError, createCloudApi, DEFAULT_API, Expired, SignedOut } from './api.js';
import { ensureCloudflared, runConnector } from './cloudflared.js';
import { createOwnerCheck } from './owner.js';

export const name = 'cloud';
export const PROBE_HEADER = 'x-coderemote-probe';
const SEEN_INTERVAL_MS = 12 * 3_600_000;
const PROBE_MARGIN_S = 3600;

/** Opens `url` in the default browser, if there is one (not with $CODEREMOTE_NO_BROWSER); never throws. */
export function openBrowser(url, { platform = process.platform, run = execFile, env = process.env } = {}) {
	if (env.CODEREMOTE_NO_BROWSER) return;
	const [command, args] = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
	try {
		run(command, args, () => {}).on?.('error', () => {});
	} catch {}
}

/**
 * Signs the computer in by device code: prints the code and link, opens the browser, polls until
 * the user decides. Resolves the poll's `{ machineId, credential, account }`; throws Denied,
 * Expired or NoAccess.
 */
export async function deviceLogin(api, { machineName = os.hostname(), print = (s) => console.error(s), open = openBrowser, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
	const start = await api.startLogin(machineName.slice(0, 64) || 'computer');
	print(`\nOpen ${start.verifyUrl}\nand confirm the code ${start.userCode} to sign this computer in to Code Remote Cloud.\n`);
	open(start.verifyUrl);
	const deadline = now() + (start.expiresIn ?? 600) * 1000;
	let interval = (start.interval ?? 5) * 1000;
	while (now() < deadline) {
		await sleep(interval);
		const poll = await api.pollLogin(start.pollCode);
		if (poll.status === 'approved') return poll;
		if (poll.interval) interval = poll.interval * 1000;
	}
	throw new Expired();
}

/**
 * @param {object} opts
 * @param {string} opts.configDir  ~/.coderemote
 * @param {{ start(text: string): void, update(text: string): void, succeed(): void, stop(): void }} opts.spinner
 * @param {object} opts.cfg  the agent's config, read and changed in place
 * @param {(cfg: object) => void} opts.saveConfig
 * @param {() => object} opts.loadConfig  a fresh copy, for writes another agent may race
 * @param {() => { publicKey?: string, label?: string }} [opts.pairing]  what the owner's phone is
 *        shown of this folder for Cloud pairing (the E2E key, the folder's name); {} when it's off
 * @returns {import('../index.js').TunnelProvider}
 */
export function create({
	configDir,
	spinner,
	cfg,
	saveConfig,
	loadConfig = () => structuredClone(cfg),
	env = process.env,
	fetchFn = fetch,
	ensureCli = ensureCloudflared,
	connector = runConnector,
	login = deviceLogin,
	reachableFn = relayReachable,
	isTTY = () => Boolean(process.stdin.isTTY && process.stderr.isTTY),
	nowS = () => Math.floor(Date.now() / 1000),
	setTimer = setTimeout,
	clearTimer = clearTimeout,
	pairing = () => ({}),
}) {
	const base = env.CODEREMOTE_CLOUD_API || DEFAULT_API;
	const api = createCloudApi({ base, credential: () => cfg.cloud?.credential, fetchFn });
	let command = 'cloudflared';
	// The account that owns this computer, from /v1/me: the only one Cloud pairing hands the token to.
	let ownerUid = null;
	const checkOwner = createOwnerCheck({
		api,
		ownerUid: async () => {
			ownerUid ??= (await api.me()).uid ?? null;
			return ownerUid;
		},
	});

	/** Changes `cloud` in a fresh copy of the config (another agent may have written its own port), then saves. */
	function updateCloud(change) {
		const fresh = loadConfig();
		fresh.cloud = { ...fresh.cloud };
		change(fresh.cloud);
		saveConfig(fresh);
		cfg.cloud = fresh.cloud;
	}

	// The machine tunnel's connector token: asked for once per run, never written to disk.
	let tokenRequest = null;
	function connectorToken() {
		tokenRequest ??= api.tunnel().then(
			(r) => r.connectorToken,
			(e) => {
				tokenRequest = null;
				throw e;
			},
		);
		return tokenRequest;
	}

	/** host -> { port, agentId } for the hostnames this run ensured. */
	const mine = new Map();
	const agentIdOf = (port) => {
		const id = cfg.agentIds?.[port];
		if (!id) throw new Error(`no agent ID for port ${port}`);
		return id;
	};

	async function renewProbe(host, { force = false } = {}) {
		const own = mine.get(host);
		const saved = own && cfg.cloud?.hostnames?.[own.port];
		if (!own) throw new Error(`${host} isn't this agent's hostname`);
		if (!force && saved?.probeToken && saved.probeExpiresAt - nowS() > PROBE_MARGIN_S) return saved.probeToken;
		const r = await api.seen(own.agentId);
		updateCloud((c) => {
			c.hostnames = { ...c.hostnames, [own.port]: { host: r.host, probeToken: r.probeToken, probeExpiresAt: r.probeExpiresAt } };
		});
		return r.probeToken;
	}

	async function signIn() {
		spinner.stop();
		ownerUid = null;
		const got = await login(api);
		updateCloud((c) => {
			c.machineId = got.machineId;
			c.credential = got.credential;
			c.account = got.account;
			c.hostnames = {};
		});
		console.error(`Signed this computer in to Code Remote Cloud as ${got.account}.`);
		return got.account;
	}

	async function signOut() {
		const signedIn = Boolean(cfg.cloud?.credential);
		let remote = null;
		if (signedIn) {
			try {
				await api.deleteMachine();
				remote = 'removed';
			} catch (e) {
				remote = e instanceof SignedOut ? 'gone' : e;
			}
		}
		updateCloud((c) => {
			for (const key of ['machineId', 'credential', 'account', 'hostnames']) delete c[key];
		});
		return { signedIn, remote };
	}

	const provider = {
		name,
		features: { preview: false, share: false, machines: false, deleteTunnels: false, signIn: false },

		async prepare() {
			let installing = false;
			command = await ensureCli({
				dir: path.join(configDir, 'bin'),
				progress: (detail) => {
					if (!installing) {
						installing = true;
						spinner.start('Installing cloudflared (Cloudflare Tunnel connector, one time)');
					}
					spinner.update(detail);
				},
			});
			if (installing) spinner.succeed();
		},

		async account({ interactive }) {
			// Another terminal may have signed in (or out) since this agent started.
			cfg.cloud = loadConfig().cloud ?? cfg.cloud;
			if (!cfg.cloud?.credential) {
				if (!interactive) throw new NotSignedIn();
				if (!isTTY()) throw new CloudError('This computer isn\'t signed in to Code Remote Cloud. Run `coderemote login --cloud`, then try again.', 'ENOTSIGNEDIN');
				console.log('\nSign in to Code Remote Cloud to share this folder through it.');
				return signIn();
			}
			try {
				const me = await api.me();
				ownerUid = me.uid ?? ownerUid;
				return me.email ?? cfg.cloud.account;
			} catch (e) {
				if (!(e instanceof SignedOut)) throw e;
				// Revoked (signed out elsewhere, or removed from the app): forget it.
				updateCloud((c) => {
					delete c.credential;
					c.hostnames = {};
				});
				if (!interactive) throw new NotSignedIn();
				if (!isTTY()) throw e;
				// Removed from the account, or signed out elsewhere: sign in again right here.
				console.log(`\n${e.message.split('. ')[0]}. Sign in again to share this folder.`);
				return signIn();
			}
		},

		known(port) {
			return cfg.cloud?.hostnames?.[port]?.host ?? null;
		},

		async ensure(port) {
			const agentId = agentIdOf(port);
			// The connector token, asked for alongside: `host` for a known hostname waits on it too.
			const token = connectorToken();
			token.catch(() => {}); // awaited below; a failure while PUT is out mustn't go unhandled
			const r = await api.putHostname(agentId, port, pairing());
			await token;
			mine.set(r.host, { port, agentId });
			updateCloud((c) => {
				c.hostnames = { ...c.hostnames, [port]: { host: r.host, probeToken: r.probeToken, probeExpiresAt: r.probeExpiresAt } };
			});
			return r.host;
		},

		async host(host, _port, { timeoutMs = 90_000 } = {}) {
			const token = await connectorToken();
			try {
				const child = await connector(command, token, { timeoutMs });
				return { child, url: `https://${host}` };
			} catch (e) {
				// The tunnel may have been replaced (signed out and in): ask for its token again next time.
				tokenRequest = null;
				throw e;
			}
		},

		connectToken: async () => null,

		/** True when `assertion` is the gate's word that the caller is this computer's owner, for `host`'s URL. */
		async checkOwner(assertion, url) {
			let host = null;
			try {
				host = new URL(url).hostname.split('.')[0];
			} catch {}
			return checkOwner(assertion, host);
		},

		async probeHeaders(host) {
			return { [PROBE_HEADER]: await renewProbe(host) };
		},

		reachable: () => reachableFn({ url: `${base}/v1/me`, timeoutMs: 5000 }),

		services: () => ({ preview: null, status: null, remover: null }),

		/** Marks the hostname as used at start and every 12 hours (unused ones are removed after 30 days). */
		keepAlive({ id }) {
			let timer = null;
			let stopped = false;
			const beat = async () => {
				try {
					await renewProbe(id, { force: true });
				} catch {}
				if (stopped) return;
				timer = setTimer(beat, SEEN_INTERVAL_MS);
				timer?.unref?.();
			};
			beat();
			return () => {
				stopped = true;
				if (timer) clearTimer(timer);
			};
		},

		text: {
			checkingSignIn: 'Checking Code Remote Cloud sign-in',
			connecting: 'Connecting to Cloudflare',
			signedOut: "Internet is back, but this computer isn't signed in to Code Remote Cloud: run `coderemote login --cloud`.",
			access: (account) => `only ${account}, signed in to Code Remote Cloud in the app`,
		},

		commands: {
			async login() {
				if (cfg.cloud?.credential) {
					try {
						const me = await api.me();
						console.log(`This computer is already signed in to Code Remote Cloud as ${me.email}. Run \`coderemote logout --cloud\` first to switch accounts.`);
						return;
					} catch (e) {
						if (!(e instanceof SignedOut)) throw e;
					}
				}
				await signIn();
			},

			async logout() {
				const { signedIn, remote } = await signOut();
				if (!signedIn) console.log("This computer isn't signed in to Code Remote Cloud.");
				else if (remote === 'removed' || remote === 'gone') console.log('Signed this computer out of Code Remote Cloud; its tunnel and hostnames are removed.');
				else {
					console.log(`Signed this computer out (${remote.message}).`);
					console.log('Code Remote Cloud removes the computer by itself after 30 days unused.');
				}
			},

			async tunnels(args) {
				const del = args.indexOf('--delete');
				if (del < 0) {
					const m = await api.machine();
					if (!m.hostnames.length) {
						console.log('No Code Remote Cloud hostnames on this computer.');
						return;
					}
					const ports = new Map(Object.entries(cfg.folderPorts ?? {}).map(([folder, p]) => [p, folder]));
					for (const h of m.hostnames) {
						const day = h.lastSeen ? new Date(h.lastSeen * 1000).toISOString().slice(0, 10) : 'never';
						console.log(`${h.host}  port ${h.port}${ports.has(h.port) ? ` (${ports.get(h.port)})` : ''}, last used ${day}`);
					}
					return;
				}
				const target = args[del + 1];
				if (!target) {
					console.error('Usage: coderemote tunnels --delete <host>');
					process.exit(1);
				}
				const m = await api.machine();
				const found = m.hostnames.find((h) => h.host === target || h.host.split('.')[0] === target);
				if (!found) {
					console.error(`${target}: no such hostname on this computer`);
					process.exit(1);
				}
				await api.deleteHostname(found.agentId);
				updateCloud((c) => {
					c.hostnames = Object.fromEntries(Object.entries(c.hostnames ?? {}).filter(([, h]) => h.host !== found.host));
				});
				console.log(`deleted ${found.host} (the next \`coderemote up --tunnel cloud\` on port ${found.port} gets a new one)`);
			},
		},
	};
	return provider;
}
