// Microsoft Dev Tunnels as a tunnel provider (see ../index.js for the interface): one tunnel per
// local port, kept private to the signed-in GitHub or Microsoft account unless --allow-anonymous.
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { confirm, pick } from '../../picker.js';
import { spawnTied } from '../../tied.js';
import { NotSignedIn, relayReachable } from '../../tunnel-retry.js';
import { ensureDevtunnel } from './cli.js';
import { PreviewTunnel } from './preview.js';
import { MACHINE_LABEL, tunnelDelete, tunnelStatus } from './status.js';
import { findTunnel, forgetTunnel, formatTunnels, inUse, listTunnels, makeRoom, ownUse, pickerItems, signedInUser, TUNNEL_LIMIT, tunnelLimitHelp } from './tunnels.js';

export const name = 'devtunnels';

const execFileAsync = promisify(execFile);

/** Runs a CLI and reports its output, never rejecting. */
async function runCli(command, args) {
	try {
		const { stdout } = await execFileAsync(command, args);
		return { ok: true, out: stdout };
	} catch (e) {
		return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` || e.message };
	}
}

/** `devtunnel user login` arguments: GitHub by default, as `coderemote login` documents. */
export function loginArgs(opts) {
	const args = ['user', 'login'];
	if (!opts.includes('--microsoft')) args.push('-g');
	if (opts.includes('--device-code')) args.push('-d');
	return args;
}

/** Parses `devtunnel token --json`. */
export function parseConnectToken(out) {
	const body = JSON.parse(out.slice(out.indexOf('{')));
	// "2026-10-27 01:52:06 UTC"
	const expiresAt = Date.parse(body.expiration.replace(' UTC', 'Z').replace(' ', 'T'));
	if (!body.token || !Number.isFinite(expiresAt)) throw new Error(`unexpected devtunnel token output:\n${out}`);
	return { token: body.token, expiresAt };
}

/**
 * @param {object} opts
 * @param {string} opts.configDir  ~/.coderemote
 * @param {{ start(text: string): void, update(text: string): void, succeed(): void, stop(): void }} opts.spinner
 * @param {object} opts.cfg  the agent's config, read and changed in place
 * @param {(cfg: object) => void} opts.saveConfig
 * @param {() => object} opts.loadConfig  a fresh copy, for writes another agent may race
 * @param {number} opts.defaultPort
 * @param {(command: string, args: string[]) => Promise<{ok: boolean, out: string}>} [opts.run]  for tests
 * @param {typeof spawnTied} [opts.spawnHost]  for tests
 * @param {typeof ensureDevtunnel} [opts.ensureCli]  for tests
 * @returns {import('../index.js').TunnelProvider}
 */
export function create({ configDir, spinner, cfg, saveConfig, loadConfig, defaultPort, run = runCli, spawnHost = spawnTied, ensureCli = ensureDevtunnel }) {
	// The Dev Tunnels CLI: the one on PATH, or a copy downloaded into ~/.coderemote/bin on first use.
	let command = 'devtunnel';
	const devtunnel = (...args) => run(command, args);

	function interactiveLogin(args) {
		return new Promise((resolve) => {
			spawn(command, args, { stdio: 'inherit' }).on('exit', resolve);
		});
	}

	/** Runs `devtunnel user login` in this terminal (it opens the browser), or explains how to. */
	async function login(reason) {
		spinner.stop();
		console.error(`Dev tunnels: ${reason.trim()}`);
		if (!process.stdin.isTTY) {
			console.error('Run `coderemote login` (--microsoft for a Microsoft account), then try again.');
			process.exit(1);
		}
		console.error('Signing in with GitHub (use `coderemote login --microsoft` for a Microsoft account)...\n');
		if ((await interactiveLogin(loginArgs([]))) !== 0) {
			console.error('\nLogin failed. Run `coderemote login` (--microsoft, --device-code), then try again.');
			process.exit(1);
		}
	}

	/**
	 * Makes the tunnel private (only the account that owns it, after signing in on the phone or
	 * browser) or anonymous (the agent token alone). The tunnel id, and so its URL, never changes.
	 */
	function applyAccess(tunnelId, anonymous) {
		return anonymous ? devtunnel('access', 'create', tunnelId, '--anonymous') : devtunnel('access', 'reset', tunnelId);
	}

	/** Deletes the account's `chosen` tunnels and forgets this computer's ones; whether all went. */
	async function deleteTunnels(chosen) {
		let ok = true;
		for (const tunnel of chosen) {
			const use = ownUse(cfg, tunnel.tunnelId);
			const res = await devtunnel('delete', tunnel.tunnelId, '-f');
			if (!res.ok) {
				console.error(`${tunnel.tunnelId}: ${res.out.trim()}`);
				ok = false;
				continue;
			}
			if (forgetTunnel(cfg, tunnel.tunnelId)) saveConfig(cfg);
			console.log(`deleted ${tunnel.tunnelId}${use ? ` (this computer's ${use}: the next \`coderemote up\` makes a new one)` : ''}`);
		}
		return ok;
	}

	/**
	 * Lists the account's tunnels to tick the ones to delete, asks once more when any is in use, and
	 * deletes them. True when some were deleted, null when the user backed out, false on a failure.
	 * Needs a terminal.
	 */
	async function chooseTunnelsToDelete(tunnels) {
		const { tunnels: listed, items } = pickerItems(tunnels, cfg);
		const picked = await pick({ title: `Delete tunnels on your dev tunnels account (${tunnels.length} of ${TUNNEL_LIMIT}):`, items });
		if (!picked) {
			console.error('Nothing deleted.');
			return null;
		}
		const chosen = picked.map((i) => listed[i]);
		const busy = chosen.filter((t) => inUse(t, cfg));
		if (busy.length) {
			console.error(`\n${busy.length === 1 ? 'This one is' : 'These are'} in use: deleting changes the URL and unpairs its phones.`);
			for (const t of busy) console.error(`  ${t.tunnelId}  ${t.hostConnections > 0 ? 'online' : `this computer's ${ownUse(cfg, t.tunnelId)}`}`);
			if (!(await confirm('Delete anyway?'))) {
				console.error('Nothing deleted.');
				return null;
			}
		}
		return deleteTunnels(chosen);
	}

	async function connectToken(tunnelId) {
		const res = await devtunnel('token', tunnelId, '--scopes', 'connect', '--json');
		if (!res.ok) throw new Error(res.out.trim());
		return parseConnectToken(res.out);
	}

	// The watch's self-check token, reused until it has less than an hour left.
	let probeToken = null;

	const provider = {
		name,
		features: { preview: true, share: true, machines: true, deleteTunnels: true, signIn: true },

		async prepare() {
			let installing = false;
			command = await ensureCli({
				dir: path.join(configDir, 'bin'),
				progress: (detail) => {
					if (!installing) {
						installing = true;
						spinner.start('Installing devtunnel (Microsoft Dev Tunnels CLI, one time)');
					}
					spinner.update(detail);
				},
			});
			if (installing) spinner.succeed();
		},

		async account({ interactive }) {
			let who = await devtunnel('user', 'show');
			if (signedInUser(who)) return signedInUser(who);
			if (!interactive) throw new NotSignedIn();
			await login(who.out || 'not logged in');
			who = await devtunnel('user', 'show');
			return signedInUser(who) ?? who.out.trim();
		},

		known(port) {
			return cfg.tunnels?.[port] ?? null;
		},

		// One tunnel per local port, so agents for different folders each keep their own URL and pairings.
		async ensure(port, { anonymous }) {
			const known = cfg.tunnels?.[port];
			if (known) {
				// Each devtunnel call takes 1-2s, so run them together. Tunnels expire 30 days after the
				// last update; pushing that back keeps the URL (and every pairing) for good. The label
				// lets the account's other agents list this machine (tunnels from older releases lack it).
				const update = () => devtunnel('update', known, '--expiration', '30d', '--add-labels', MACHINE_LABEL);
				let [updated, access] = await Promise.all([update(), applyAccess(known, anonymous)]);
				// Both calls write the same tunnel, so the service can reject the loser with "Conflicting
				// request" (optimistic concurrency). The other one has finished by now: just redo the loser.
				const conflict = (res) => !res.ok && /conflicting request/i.test(res.out);
				if (conflict(updated)) updated = await update();
				if (conflict(access)) access = await applyAccess(known, anonymous);
				if (updated.ok) {
					if (!access.ok) throw new Error(`devtunnel access failed:\n${access.out}`);
					return known;
				}
				// Only a tunnel that's really gone is replaced: a new one changes the URL and unpairs every device.
				if (!/not found/i.test(updated.out)) throw new Error(`devtunnel update failed:\n${updated.out}`);
			}

			// Every request needs the agent's bearer token either way; a private tunnel also needs a sign-in.
			// Agents beyond the first on this machine say which port they are, to tell them apart in the app.
			const machine = port === defaultPort ? os.hostname() : `${os.hostname()} :${port}`;
			const createArgs = ['create', '--expiration', '30d', '-d', `coderemote ${machine}`, '--labels', MACHINE_LABEL, '--json'];
			if (anonymous) createArgs.push('--allow-anonymous');
			let created = await devtunnel(...createArgs);
			if (!created.ok) {
				const room = await makeRoom(devtunnel);
				// Thrown, not exited: an agent bringing its tunnel up later keeps serving the LAN.
				if (room?.full) throw Object.assign(new Error(tunnelLimitHelp(room.full, cfg)), { code: 'ETUNNELLIMIT', tunnels: room.full });
				if (room?.freed) {
					spinner.update(`(deleted ${room.freed.length} idle preview tunnel${room.freed.length > 1 ? 's' : ''} to make room)`);
					if (room.freed.filter((id) => forgetTunnel(cfg, id)).length) saveConfig(cfg);
					created = await devtunnel(...createArgs);
				}
				if (!created.ok) throw new Error(`devtunnel create failed:\n${created.out}`);
			}
			const tunnelId = JSON.parse(created.out.slice(created.out.indexOf('{'))).tunnel?.tunnelId;
			if (!tunnelId) throw new Error(`could not parse tunnel id from:\n${created.out}`);

			const portRes = await devtunnel('port', 'create', tunnelId, '-p', String(port), '--protocol', 'http');
			if (!portRes.ok) throw new Error(`devtunnel port create failed:\n${portRes.out}`);

			cfg.tunnels = { ...cfg.tunnels, [port]: tunnelId };
			// Still read by older releases, so going back to one keeps the default port's pairings.
			if (port === defaultPort) cfg.tunnelId = tunnelId;
			saveConfig(cfg);
			return tunnelId;
		},

		/** `timeoutMs`: give up (and end the host) when it hasn't connected by then. */
		host(tunnelId, port, { timeoutMs = 0 } = {}) {
			return new Promise((resolve, reject) => {
				// Tied to the agent: a host outliving it would keep the tunnel and block the next `up`.
				const child = spawnHost(command, ['host', tunnelId], { stdout: 'pipe', stderr: 'pipe' });
				let log = '';
				const timer = timeoutMs
					? setTimeout(() => {
							child.kill();
							reject(new Error(`devtunnel host didn't connect within ${timeoutMs / 1000}s:\n${log}`));
						}, timeoutMs)
					: null;
				const onData = (d) => {
					log += d;
					const m = log.match(new RegExp(`https://\\S*-${port}\\.\\S*devtunnels\\.ms\\S*`));
					if (m) {
						clearTimeout(timer);
						resolve({ child, url: m[0].replace(/\/$/, '') });
					}
				};
				child.stdout.on('data', onData);
				child.stderr.on('data', onData);
				child.on('exit', (code) => reject(new Error(`devtunnel host exited (${code}):\n${log}`)));
			});
		},

		/** A dev tunnels connect token (24h) for the app's sign-in handoff and renewals. */
		connectToken,

		async probeHeaders(tunnelId, { anonymous }) {
			if (anonymous) return {};
			if (!(probeToken && probeToken.expiresAt - Date.now() > 3_600_000)) probeToken = await connectToken(tunnelId);
			return { 'x-tunnel-authorization': `tunnel ${probeToken.token}` };
		},

		reachable: () => relayReachable(),

		services({ port, tunnelId, account, anonymous }) {
			// Created on the first preview; keyed by port so agents for different folders don't share one.
			const preview = new PreviewTunnel({
				devtunnel,
				command: () => command,
				description: `coderemote preview ${os.hostname()}`,
				leftover: cfg.previewTunnels?.[port],
				remember: (id) => {
					cfg.previewTunnels = { ...cfg.previewTunnels, [port]: id };
					if (!id) delete cfg.previewTunnels[port];
					saveConfig(cfg);
				},
				mintToken: connectToken,
			});
			const status = tunnelStatus({ devtunnel, tunnelId, account, anonymous, preview });
			// The app's Settings › Connections deletes tunnels the account no longer needs through here.
			const remover = tunnelDelete({
				devtunnel,
				tunnelId,
				deleted: (id) => {
					status.invalidate();
					// Another agent of this computer's: its next `coderemote up` makes a new one.
					const saved = loadConfig();
					if (forgetTunnel(saved, id)) saveConfig(saved);
				},
			});
			return { preview, status, remover };
		},

		async resolveLimit(error) {
			// In a terminal, choose what to delete right here and carry on.
			console.error(`\nYour dev tunnels account already has ${error.tunnels.length} tunnels, the most it may keep. Choose ones nothing uses any more:\n`);
			return Boolean(await chooseTunnelsToDelete(error.tunnels));
		},

		text: {
			checkingSignIn: 'Checking dev tunnels sign-in',
			connecting: 'Connecting to the relay',
			signedOut: 'Internet is back, but no one is signed in to dev tunnels: run `coderemote login`.',
			access: (account) => `sign-in required as ${account}`,
		},

		commands: {
			async login(args) {
				await provider.prepare();
				process.exit(await interactiveLogin(loginArgs(args)));
			},

			async tunnels(args) {
				await provider.prepare();
				const { tunnels, error } = await listTunnels(devtunnel);
				if (error) {
					console.error(error);
					console.error('Signed in? Run `coderemote login`.');
					process.exit(1);
				}
				if (args[0] !== 'delete') {
					console.log(tunnels.length ? formatTunnels(tunnels, cfg).join('\n') : 'No tunnels on this account.');
					return;
				}
				const ids = args.slice(1).filter((a) => !a.startsWith('--'));
				if (!ids.length) {
					if (!process.stdin.isTTY || !process.stderr.isTTY) {
						console.error('Usage: coderemote tunnels delete <tunnel id>... [--force]  (run it in a terminal to choose from a list)');
						process.exit(1);
					}
					if (!tunnels.length) {
						console.log('No tunnels on this account.');
						return;
					}
					const result = await chooseTunnelsToDelete(tunnels);
					if (result === false) process.exit(1);
					return;
				}
				let failed = false;
				const chosen = [];
				for (const id of ids) {
					const tunnel = findTunnel(tunnels, id);
					if (!tunnel) {
						console.error(`${id}: no such tunnel on this account`);
						failed = true;
						continue;
					}
					// Deleting a tunnel in use changes its URL and unpairs every phone, here or on another computer.
					const use = ownUse(cfg, tunnel.tunnelId);
					if (!args.includes('--force') && inUse(tunnel, cfg)) {
						const why = tunnel.hostConnections > 0 ? 'an agent is serving it right now' : `it is this computer's ${use}`;
						console.error(`${tunnel.tunnelId}: kept, ${why}. Deleting it unpairs its phones; add --force to delete it anyway.`);
						failed = true;
						continue;
					}
					chosen.push(tunnel);
				}
				if (!(await deleteTunnels(chosen)) || failed) process.exit(1);
			},
		},
	};
	return provider;
}
