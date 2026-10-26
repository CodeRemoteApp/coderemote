// Dev servers on the phone. Forwarded ports are served by a second tunnel the agent owns: a
// running `devtunnel host` never picks up ports added after it started, and a new host takes the
// tunnel over from the old one, dropping every connection through it. Keeping previews on their
// own tunnel means a restart only blips other previews, never the main tunnel's terminals.
// The preview tunnel is private; the app opens it with a connect token the agent hands out.
import { spawn } from 'node:child_process';

const HOST_READY_TIMEOUT_MS = 30_000;
// Reuse a connect token until it has less than this left (they last 24 hours).
const TOKEN_REUSE_MS = 12 * 3_600_000;

export class PreviewTunnel {
	#queue = Promise.resolve();
	#tunnelId = null;
	/** @type {{ child: import('node:child_process').ChildProcess, urls: Map<number, string> } | null} */
	#host = null;
	#ports = new Set();
	/** port -> ms since the epoch when its public access ends */
	#shares = new Map();
	#token = null;

	/**
	 * @param {object} opts
	 * @param {(...args: string[]) => Promise<{ok: boolean, out: string}>} opts.devtunnel  runs the CLI
	 * @param {() => string} opts.command  the devtunnel executable, for `devtunnel host`
	 * @param {string} opts.description
	 * @param {string | undefined} opts.leftover  a preview tunnel from an earlier run, deleted on first use
	 * @param {(tunnelId: string | null) => void} opts.remember  persists the current tunnel id
	 * @param {(tunnelId: string) => Promise<{token: string, expiresAt: number}>} opts.mintToken
	 */
	constructor({ devtunnel, command, description, leftover, remember, mintToken }) {
		this.devtunnel = devtunnel;
		this.command = command;
		this.description = description;
		this.leftover = leftover;
		this.remember = remember;
		this.mintToken = mintToken;
	}

	/** Runs tunnel changes one at a time: each may restart the host. */
	#serial(fn) {
		const result = this.#queue.then(fn);
		this.#queue = result.catch(() => {});
		return result;
	}

	list() {
		const now = Date.now();
		return [...(this.#host?.urls ?? [])]
			.map(([port, url]) => {
				const until = this.#shares.get(port);
				return { port, url, sharedUntil: until > now ? until : null };
			})
			.sort((a, b) => a.port - b.port);
	}

	/**
	 * Lets anyone with the port's link open it, without signing in, for `hours`. Only that port of
	 * the preview tunnel: the agent's own tunnel, and its shell, stay private. The relay ends it
	 * on time by itself; `unshare` ends it sooner.
	 */
	share(port, hours) {
		return this.#serial(async () => {
			if (!this.#host?.urls.has(port)) throw new Error(`port ${port} is not being previewed`);
			// Replace any earlier share of this port rather than stacking entries.
			await this.devtunnel('access', 'reset', this.#tunnelId, '-p', String(port));
			const res = await this.devtunnel(
				'access', 'create', this.#tunnelId, '-p', String(port), '--anonymous', '--expiration', `${hours}h`, '--json',
			);
			if (!res.ok) throw new Error(`devtunnel access create failed: ${res.out.trim()}`);
			const entries = JSON.parse(res.out.slice(res.out.indexOf('{'))).accessControlEntries ?? [];
			const until = Date.parse(entries.find((e) => e.type === 'Anonymous')?.expiration);
			this.#shares.set(port, Number.isFinite(until) ? until : Date.now() + hours * 3_600_000);
		});
	}

	unshare(port) {
		return this.#serial(async () => {
			if (!this.#shares.delete(port) || !this.#tunnelId) return;
			const res = await this.devtunnel('access', 'reset', this.#tunnelId, '-p', String(port));
			if (!res.ok) throw new Error(`devtunnel access reset failed: ${res.out.trim()}`);
		});
	}

	/** @returns {Promise<{port: number, url: string}>} */
	forward(port) {
		return this.#serial(async () => {
			const url = this.#host?.urls.get(port);
			if (url) return { port, url };
			const id = await this.#ensureTunnel();
			const res = await this.devtunnel('port', 'create', id, '-p', String(port), '--protocol', 'http');
			if (!res.ok && !/already exists|conflict/i.test(res.out)) throw new Error(`devtunnel port create failed: ${res.out.trim()}`);
			this.#ports.add(port);
			try {
				await this.#restartHost();
			} catch (e) {
				this.#ports.delete(port);
				throw e;
			}
			const forwarded = this.#host?.urls.get(port);
			if (!forwarded) throw new Error(`devtunnel host did not forward port ${port}`);
			return { port, url: forwarded };
		});
	}

	unforward(port) {
		return this.#serial(async () => {
			if (!this.#ports.delete(port) || !this.#tunnelId) return;
			// Deleting the port deletes its access entries too, a public share included.
			this.#shares.delete(port);
			await this.devtunnel('port', 'delete', this.#tunnelId, '-p', String(port));
			if (this.#ports.size) await this.#restartHost();
			else this.#stopHost();
		});
	}

	/** A connect token for the preview tunnel, or null before anything is forwarded. */
	async token() {
		if (!this.#tunnelId) return null;
		if (!this.#token || this.#token.expiresAt - Date.now() < TOKEN_REUSE_MS) {
			this.#token = await this.mintToken(this.#tunnelId);
		}
		return this.#token;
	}

	/** Stops hosting; the tunnel is deleted on the next run's first preview. */
	stop() {
		this.#stopHost();
	}

	async #ensureTunnel() {
		if (this.#tunnelId) return this.#tunnelId;
		// Start clean: ports left on an old preview tunnel would be forwarded again.
		if (this.leftover) await this.devtunnel('delete', this.leftover, '-f');
		const created = await this.devtunnel(
			'create', '--expiration', '1d', '-d', this.description, '--labels', 'coderemote-preview', '--json',
		);
		if (!created.ok) throw new Error(`devtunnel create failed: ${created.out.trim()}`);
		const id = JSON.parse(created.out.slice(created.out.indexOf('{'))).tunnel?.tunnelId;
		if (!id) throw new Error(`could not parse tunnel id from:\n${created.out}`);
		this.#tunnelId = id;
		this.leftover = undefined;
		this.remember(id);
		return id;
	}

	/** Starts a host with the current ports; once it's ready, the old one (already displaced) is killed. */
	async #restartHost() {
		const old = this.#host;
		const next = await this.#startHost();
		this.#host = next;
		old?.child.kill();
	}

	#startHost() {
		return new Promise((resolve, reject) => {
			const child = spawn(this.command(), ['host', this.#tunnelId], { stdio: ['ignore', 'pipe', 'pipe'] });
			const urls = new Map();
			let log = '';
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error(`devtunnel host did not get ready:\n${log}`));
			}, HOST_READY_TIMEOUT_MS);
			const onData = (d) => {
				log += d;
				// "Connect via browser: https://abc123.usw2.devtunnels.ms:5173, https://abc123-5173.usw2.devtunnels.ms"
				// (older CLIs print only the second form). The "-inspect" link doesn't match.
				for (const m of log.matchAll(/https:\/\/([a-z0-9]+)-(\d+)\.([a-z0-9.]*devtunnels\.ms)/g)) {
					urls.set(parseInt(m[2], 10), m[0]);
				}
				if (/Ready to accept connections/.test(log)) {
					clearTimeout(timer);
					resolve({ child, urls });
				}
			};
			child.stdout.on('data', onData);
			child.stderr.on('data', onData);
			child.on('exit', (code) => {
				clearTimeout(timer);
				reject(new Error(`devtunnel host exited (${code}):\n${log}`));
				// A host that dies on its own (not replaced by us) leaves nothing forwarded.
				if (this.#host?.child === child) this.#host = null;
			});
		});
	}

	#stopHost() {
		this.#host?.child.kill();
		this.#host = null;
	}
}
