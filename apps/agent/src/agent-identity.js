// What identifies an agent (one folder, on its port) across runs, whatever tunnel it uses.
import { randomBytes } from 'node:crypto';

/**
 * The agent on `port`'s identity: 128 random bits, made once and kept across runs and token
 * rotations, so a phone that pairs again lands on the same machine. Returns it; `cfg` is
 * changed (and must be saved) when it was just made.
 */
export function ensureAgentId(cfg, port) {
	const known = cfg.agentIds?.[port];
	if (typeof known === 'string' && /^[0-9a-f]{32}$/.test(known)) return known;
	const id = randomBytes(16).toString('hex');
	cfg.agentIds = { ...cfg.agentIds, [port]: id };
	return id;
}

/** Remembers the public URL `port`'s tunnel was hosted at; true when that changed `cfg`. */
export function rememberTunnelUrl(cfg, port, url) {
	if (!url || cfg.tunnelUrls?.[port] === url) return false;
	cfg.tunnelUrls = { ...cfg.tunnelUrls, [port]: url };
	return true;
}
