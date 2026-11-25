// The tunnel providers an agent can expose itself through. `up` picks one per run; everything
// provider-specific (its CLI, sign-in, tunnels, previews) lives behind this interface, and
// src/tunnel-session.js drives any of them the same way.
import * as cloud from './cloud/index.js';
import * as devtunnels from './devtunnels/index.js';

/**
 * @typedef {object} ProviderFeatures
 * @property {boolean} preview        forwarding local ports to the phone (`/api/preview`)
 * @property {boolean} share          public links to a forwarded port
 * @property {boolean} machines       the account's other machines (`GET /api/tunnel`)
 * @property {boolean} deleteTunnels  deleting the account's tunnels from the app (`DELETE /api/tunnel`)
 * @property {boolean} signIn         connect-token sign-in (`/vsremote/handoff`, `/api/tunnel/token`)
 */

/**
 * @typedef {object} TunnelProvider
 * @property {string} name  reported to clients as `tunnel.provider` in /api/info
 * @property {ProviderFeatures} features
 * @property {() => Promise<void>} prepare  finds (or installs) what the provider runs
 * @property {(opts: { interactive: boolean }) => Promise<string>} account
 *   the signed-in account, e.g. "thanh (GitHub)". `interactive` may sign in in this terminal;
 *   otherwise it throws `NotSignedIn` (src/tunnel-retry.js).
 * @property {(port: number) => string | null} known  the tunnel this port already has
 * @property {(port: number, opts: { anonymous: boolean }) => Promise<string>} ensure
 *   creates or refreshes the port's tunnel and returns its id. May throw an error with
 *   `code: 'ETUNNELLIMIT'` when the account can't hold another one.
 * @property {(id: string, port: number, opts?: { timeoutMs?: number }) =>
 *   Promise<{ child: import('node:child_process').ChildProcess, url: string }>} host
 *   runs the tunnel's host process; resolves once it serves `url`
 * @property {(id: string) => Promise<{ token: string, expiresAt: number } | null>} connectToken
 *   a token the app signs in with, or null when the provider has none
 * @property {(id: string, opts: { anonymous: boolean }) => Promise<Record<string, string>>} probeHeaders
 *   headers the tunnel watch's self-check sends through the provider
 * @property {() => Promise<boolean>} reachable  whether the provider's service answers at all
 * @property {(ctx: { port: number, tunnelId: () => string | undefined, account: () => string | undefined, anonymous: boolean }) =>
 *   { preview: object | null, status: object | null, remover: object | null }} services
 *   what createAgentServer gets for previews, `GET /api/tunnel` and `DELETE /api/tunnel`; null
 *   for a feature the provider lacks
 * @property {(hosted: { id: string, port: number }) => () => void} [keepAlive]
 *   started once the tunnel is first hosted, for whatever the provider must renew while the agent
 *   runs (Cloud reports its hostname as in use); returns the function that stops it
 * @property {(error: Error) => Promise<boolean>} [resolveLimit]
 *   after `ensure` threw ETUNNELLIMIT in a terminal: lets the user free room; true to try again
 * @property {{ connecting: string, checkingSignIn: string, signedOut: string, access: (account: string) => string }} text
 *   what the terminal says while connecting
 * @property {{ login: (args: string[]) => Promise<void>, tunnels: (args: string[]) => Promise<void> }} commands
 *   the provider's own CLI subcommands
 */

/** name -> module with `create(opts): TunnelProvider` */
export const providers = { devtunnels, cloud };

export const DEFAULT_PROVIDER = 'devtunnels';

/**
 * The provider a folder's agent uses: `--tunnel <name>`, else the one remembered for its port, else
 * the default. Throws, naming the valid ones, for an unknown `--tunnel`.
 */
export function chooseProvider({ flag, remembered } = {}) {
	if (flag !== undefined) {
		if (!Object.hasOwn(providers, flag)) {
			throw Object.assign(new Error(`Unknown --tunnel ${flag || '(empty)'}: use one of ${Object.keys(providers).join(', ')}.`), { code: 'EBADPROVIDER' });
		}
		return flag;
	}
	return Object.hasOwn(providers, remembered ?? '') ? remembered : DEFAULT_PROVIDER;
}

/**
 * Whether `up` should ask which tunnel the folder on `port` uses: nothing on the command line, and
 * nothing chosen for that port before (a remembered provider, or a Dev Tunnels tunnel from before
 * there was a choice).
 */
export function needsProviderChoice(cfg, port, { flag } = {}) {
	if (flag !== undefined) return false;
	if (Object.hasOwn(providers, cfg.tunnelProviders?.[port] ?? '')) return false;
	return !cfg.tunnels?.[port];
}

/** What `up` offers when it asks, in order. */
export const PROVIDER_CHOICES = [
	{ name: 'cloud', label: 'Code Remote Cloud', note: 'sign in with Apple or Google; your phone pairs without a QR code' },
	{ name: 'devtunnels', label: 'Microsoft Dev Tunnels', note: 'sign in with GitHub or Microsoft; free' },
];

/** Remembers `name` for `port` once its tunnel is up; true when the config changed. */
export function rememberProvider(cfg, port, name) {
	const current = cfg.tunnelProviders?.[port];
	// A folder that never chose keeps no entry for the default: Dev Tunnels configs stay as they were.
	if (current === name || (!current && name === DEFAULT_PROVIDER)) return false;
	cfg.tunnelProviders = { ...cfg.tunnelProviders, [port]: name };
	return true;
}
