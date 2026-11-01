// What the app shows of the tunnel: this agent's tunnel (Machine Info), and the other machines
// running coderemote on the same dev tunnels account (found by the label every agent gives its
// tunnel), with how many of the account's tunnels are taken (Settings, Connections).
import { findTunnel, listTunnels, PREVIEW_LABEL, signedInUser, TUNNEL_LIMIT } from './tunnels.js';

export const MACHINE_LABEL = 'coderemote';
// Which tunnel service the agent uses; the app names the connection after it.
export const PROVIDER = 'devtunnels';

// Each devtunnel call takes 1-2s; the screen may ask again right away.
const CACHE_MS = 15_000;

function parse(out) {
	return JSON.parse(out.slice(out.indexOf('{')));
}

/**
 * "coderemote Thanhs-MacBook-Air.local" -> "Thanhs-MacBook-Air" (older agents said "vsremote");
 * a second agent on the machine adds its port: "Thanhs-MacBook-Air :31581".
 */
function machineName(description) {
	return (description || '').replace(/^(coderemote|vsremote)\s+/, '').replace(/\.local\b/, '') || null;
}

// `code tunnel` (VS Code's Remote Tunnels) labels the tunnels it makes with this.
const VSCODE_LABEL = 'vscode-server-launcher';

/**
 * A tunnel of the account that isn't a machine: a coderemote preview tunnel, VS Code's
 * `code tunnel`, or another tool's. They count against the account's limit all the same.
 */
function otherTunnel(tunnel) {
	const labels = tunnel.labels ?? [];
	const kind = labels.includes(PREVIEW_LABEL) ? 'preview' : labels.includes(VSCODE_LABEL) ? 'vscode' : 'other';
	// "coderemote preview Thanhs-MacBook-Air.local" -> "Thanhs-MacBook-Air"
	const name =
		kind === 'preview'
			? machineName((tunnel.description || '').replace(/^coderemote preview\s+/, ''))
			: tunnel.description || null;
	return { id: tunnel.tunnelId, kind, name, online: tunnel.hostConnections > 0 };
}

function machine(tunnel, current) {
	return {
		id: tunnel.tunnelId,
		name: machineName(tunnel.description),
		// The agent's address, the same URL its pairing link carries.
		url: tunnel.ports?.[0]?.portUri?.replace(/\/$/, '') ?? null,
		// This agent is answering, so its own tunnel is hosted: the service's count lags a fresh start.
		online: current || tunnel.hostConnections > 0,
		current,
	};
}

/**
 * @param {object} opts
 * @param {(...args: string[]) => Promise<{ok: boolean, out: string}>} opts.devtunnel
 * @param {() => string | undefined} opts.tunnelId  this agent's tunnel, once it exists
 * @param {() => string | undefined} opts.account  the signed-in dev tunnels account
 * @param {boolean} opts.anonymous
 * @param {{ list(): object[] } | null} opts.preview
 * @returns {() => Promise<object | null>}
 */
export function tunnelStatus({ devtunnel, tunnelId, account, anonymous, preview }) {
	let cached = null;
	const status = async () => {
		const id = tunnelId();
		if (!id) return null;
		if (cached && Date.now() - cached.at < CACHE_MS) return { ...cached.value, previewPorts: preview?.list().length ?? 0 };

		const [own, listed] = await Promise.all([
			devtunnel('show', id, '--json'),
			// Every tunnel, previews' too: they all count against the account's limit.
			devtunnel('list', '--limit', '100', '--json'),
		]);
		if (!own.ok) throw new Error(`devtunnel show failed: ${own.out.trim()}`);
		const tunnel = parse(own.out).tunnel;
		const all = listed.ok ? (parse(listed.out).tunnels ?? []) : null;
		// Listing gives no addresses, so each other machine's tunnel is looked up too.
		const others = (all ?? []).filter((t) => t.tunnelId !== id && t.labels?.includes(MACHINE_LABEL));
		const shown = await Promise.all(
			others.map(async (t) => {
				const res = await devtunnel('show', t.tunnelId, '--json');
				return res.ok ? parse(res.out).tunnel : null;
			}),
		);
		const machines = [machine(tunnel, true), ...shown.filter(Boolean).map((t) => machine(t, false))];

		const value = {
			provider: PROVIDER,
			account: account() ?? null,
			tunnel: {
				id,
				url: machine(tunnel, true).url,
				access: anonymous ? 'anonymous' : 'private',
				// "30 days": pushed back every time `coderemote up` starts.
				expiration: tunnel.tunnelExpiration ?? null,
				connections: tunnel.clientConnections ?? 0,
				uploaded: tunnel.uploadTotal ?? null,
				downloaded: tunnel.downloadTotal ?? null,
			},
			machines,
			// The account's tunnels that aren't machines; empty when it couldn't be listed.
			others: (all ?? []).filter((t) => t.tunnelId !== id && !t.labels?.includes(MACHINE_LABEL)).map(otherTunnel),
			// null when the account couldn't be listed
			quota: all && { used: all.length, limit: TUNNEL_LIMIT },
		};
		cached = { at: Date.now(), value };
		return { ...value, previewPorts: preview?.list().length ?? 0 };
	};
	// After a tunnel is deleted, the next answer lists the account afresh.
	status.invalidate = () => {
		cached = null;
	};
	return status;
}

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

/**
 * Deletes a tunnel of the account this agent is signed in to, for the app's Settings ›
 * Connections. The computer's login must still be valid and still be the account the app showed
 * (`account`), so a phone never deletes from an account it didn't mean. The agent's own tunnel
 * is refused (it would cut the request's own connection); one an agent serves right now needs
 * `force`, as deleting it unpairs its phones.
 * @param {object} opts
 * @param {(...args: string[]) => Promise<{ok: boolean, out: string}>} opts.devtunnel
 * @param {() => string | undefined} opts.tunnelId  this agent's tunnel
 * @param {(id: string) => void} [opts.deleted]  called with each deleted tunnel's id
 * @returns {(req: { id: string, account: string, force?: boolean }) => Promise<{ deleted: string }>}
 */
export function tunnelDelete({ devtunnel, tunnelId, deleted = () => {} }) {
	return async ({ id, account, force = false }) => {
		if (typeof id !== 'string' || !id) throw fail(400, 'EINVAL', 'id is required');
		if (typeof account !== 'string' || !account) throw fail(400, 'EINVAL', 'account is required');
		const user = signedInUser(await devtunnel('user', 'show'));
		if (!user) {
			throw fail(403, 'ELOGIN', 'The computer’s dev tunnels sign-in has expired. Run `coderemote login` on it, then try again.');
		}
		if (user !== account) {
			throw fail(409, 'EACCOUNT', `The computer is now signed in as ${user}, not ${account}. Refresh, then try again.`);
		}
		const { tunnels, error } = await listTunnels(devtunnel);
		if (error) throw fail(502, 'EDEVTUNNEL', error);
		const tunnel = findTunnel(tunnels, id);
		if (!tunnel) throw fail(404, 'ENOTUNNEL', `No tunnel ${id} on ${account}.`);
		const own = tunnelId();
		if (own && findTunnel([tunnel], own)) {
			throw fail(409, 'EOWN', 'This is the tunnel this connection runs through. Delete it on the computer: `coderemote tunnels delete <id> --force`.');
		}
		if (tunnel.hostConnections > 0 && !force) {
			throw fail(409, 'EONLINE', 'An agent is serving this tunnel right now. Deleting it unpairs its phones; send force to delete it anyway.');
		}
		const res = await devtunnel('delete', tunnel.tunnelId, '-f');
		if (!res.ok) throw fail(502, 'EDEVTUNNEL', res.out.trim());
		deleted(tunnel.tunnelId);
		return { deleted: tunnel.tunnelId };
	};
}
