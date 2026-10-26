// What the app's Tunnel screen shows: this agent's tunnel, and the other machines running
// coderemote on the same dev tunnels account (found by the label every agent gives its tunnel).
export const MACHINE_LABEL = 'coderemote';

// Each devtunnel call takes 1-2s; the screen may ask again right away.
const CACHE_MS = 15_000;

function parse(out) {
	return JSON.parse(out.slice(out.indexOf('{')));
}

/** "coderemote Thanhs-MacBook-Air.local" -> "Thanhs-MacBook-Air" (older agents said "vsremote"). */
function machineName(description) {
	return (description || '').replace(/^(coderemote|vsremote)\s+/, '').replace(/\.local$/, '') || null;
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
	return async () => {
		const id = tunnelId();
		if (!id) return null;
		if (cached && Date.now() - cached.at < CACHE_MS) return { ...cached.value, previewPorts: preview?.list().length ?? 0 };

		const [own, listed] = await Promise.all([
			devtunnel('show', id, '--json'),
			devtunnel('list', '--labels', MACHINE_LABEL, '--json'),
		]);
		if (!own.ok) throw new Error(`devtunnel show failed: ${own.out.trim()}`);
		const tunnel = parse(own.out).tunnel;
		// Listing gives no addresses, so each other machine's tunnel is looked up too.
		const others = listed.ok ? (parse(listed.out).tunnels ?? []).filter((t) => t.tunnelId !== id) : [];
		const shown = await Promise.all(
			others.map(async (t) => {
				const res = await devtunnel('show', t.tunnelId, '--json');
				return res.ok ? parse(res.out).tunnel : null;
			}),
		);
		const machines = [machine(tunnel, true), ...shown.filter(Boolean).map((t) => machine(t, false))];

		const value = {
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
		};
		cached = { at: Date.now(), value };
		return { ...value, previewPorts: preview?.list().length ?? 0 };
	};
}
