// The Dev Tunnels account's tunnels, for `coderemote tunnels`: which belong to this computer, and
// keeping the account under its limit. An account may keep 10 tunnels; creating one more fails
// with "Rate limit exceeded", which reads as if waiting would help.
export const TUNNEL_LIMIT = 10;
// Every agent's preview tunnel carries it; nothing is lost by deleting one no host serves.
export const PREVIEW_LABEL = 'coderemote-preview';

/** "silent-lake-pqv9b80.asse" -> "silent-lake-pqv9b80": ids are given and stored either way. */
const base = (id) => String(id).split('.')[0];

/**
 * The account's tunnels (`devtunnel list --json`), or `{ error }` with devtunnel's own words.
 * @param {(...args: string[]) => Promise<{ ok: boolean, out: string }>} devtunnel
 */
export async function listTunnels(devtunnel) {
	const res = await devtunnel('list', '--limit', '100', '--json');
	if (!res.ok) return { error: res.out.trim() };
	try {
		const { tunnels } = JSON.parse(res.out.slice(res.out.indexOf('{')));
		if (Array.isArray(tunnels)) return { tunnels };
	} catch {}
	return { error: `unexpected devtunnel list output:\n${res.out}` };
}

/**
 * The account's tunnels when it has no room for another, else null (also when they can't be
 * listed: then the original error is the better report).
 */
export async function tunnelsAtLimit(devtunnel) {
	const { tunnels } = await listTunnels(devtunnel);
	return tunnels && tunnels.length >= TUNNEL_LIMIT ? tunnels : null;
}

/**
 * After a failed create: when the account is full, deletes its preview tunnels no host serves
 * (the agent that made one makes a new one on its next preview). `{ freed }` names the deleted
 * ones, `{ full }` lists the account when none could go, null when the account isn't full.
 */
export async function makeRoom(devtunnel) {
	const tunnels = await tunnelsAtLimit(devtunnel);
	if (!tunnels) return null;
	const idle = tunnels.filter((t) => t.labels?.includes(PREVIEW_LABEL) && !(t.hostConnections > 0));
	const deleted = await Promise.all(idle.map((t) => devtunnel('delete', t.tunnelId, '-f')));
	const freed = idle.filter((_, i) => deleted[i].ok).map((t) => t.tunnelId);
	return freed.length ? { freed } : { full: tunnels };
}

/** What this computer uses a tunnel for, from its config ("agent on port 31580"), or null. */
export function ownUse(cfg, id) {
	for (const [port, t] of Object.entries(cfg.tunnels ?? {})) if (base(t) === base(id)) return `agent on port ${port}`;
	if (cfg.tunnelId && base(cfg.tunnelId) === base(id)) return 'agent';
	for (const [port, t] of Object.entries(cfg.previewTunnels ?? {})) if (base(t) === base(id)) return `previews on port ${port}`;
	return null;
}

/** Drops a deleted tunnel from the config; whether anything changed. */
export function forgetTunnel(cfg, id) {
	let changed = false;
	for (const key of ['tunnels', 'previewTunnels']) {
		for (const [port, t] of Object.entries(cfg[key] ?? {})) {
			if (base(t) !== base(id)) continue;
			delete cfg[key][port];
			changed = true;
		}
	}
	if (cfg.tunnelId && base(cfg.tunnelId) === base(id)) {
		delete cfg.tunnelId;
		changed = true;
	}
	return changed;
}

/** The tunnel `id` names, with or without its region suffix. */
export function findTunnel(tunnels, id) {
	return tunnels.find((t) => t.tunnelId === id || base(t.tunnelId) === base(id)) ?? null;
}

/** One line per tunnel: id, whether a host serves it now, this computer's use, description. */
export function formatTunnels(tunnels, cfg) {
	const width = Math.max(...tunnels.map((t) => t.tunnelId.length));
	return tunnels.map((t) => {
		const notes = [t.hostConnections > 0 ? 'online' : null, ownUse(cfg, t.tunnelId) && `this computer's ${ownUse(cfg, t.tunnelId)}`];
		const about = t.description || t.labels?.join(', ') || '(no description)';
		return `  ${t.tunnelId.padEnd(width)}  ${[...notes.filter(Boolean), about].join(' · ')}`;
	});
}

/** The account's tunnels and how to delete the ones nothing uses. */
export function tunnelLimitHelp(tunnels, cfg = {}) {
	return [
		`Your Dev Tunnels account already has ${tunnels.length} tunnels, the most it may keep:`,
		...formatTunnels(tunnels, cfg),
		'Delete the ones nothing uses any more, then try again. Deleting a tunnel an agent still uses',
		'changes its URL and unpairs its phones.',
		'  coderemote tunnels delete <tunnel id>...',
	].join('\n');
}
