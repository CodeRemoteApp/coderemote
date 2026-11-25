// The Code Remote Cloud backend, as the CLI uses it: device-code sign-in for the computer, its
// tunnel's connector token, and one hostname per agent. Every call has a timeout; the backend's
// error codes become the CloudError subclasses below, whose messages say what to do.

export const DEFAULT_API = 'https://cloud.commitplus.app';

export class CloudError extends Error {
	constructor(message, code, extra = {}) {
		super(message);
		this.code = code;
		Object.assign(this, extra);
	}
}

/** The computer's credential was revoked (signed out here or removed from the app). */
export class SignedOut extends CloudError {
	constructor() {
		super('This computer was signed out of Code Remote Cloud. Run `coderemote login --cloud` to sign it in again.', 'EAUTH');
	}
}

export class NoAccess extends CloudError {
	constructor() {
		super("This account doesn't have Code Remote Cloud access.", 'ENOACCESS');
	}
}

/** `hostnames`: the account's ones, `{ host, agentId, port, lastSeen, machineName }`. */
export class LimitReached extends CloudError {
	constructor(body) {
		const list = body.hostnames ?? [];
		const machines = body.machines ?? [];
		const lines = list.length
			? [
					`Your Code Remote Cloud account already has ${list.length} hostnames, the most it may keep:`,
					...list.map((h) => `  ${h.host}  ${h.machineName ? `${h.machineName}, ` : ''}port ${h.port}, last used ${day(h.lastSeen)}`),
					'Remove one nothing uses any more with `coderemote tunnels --delete <host>` on its computer, or from the app.',
				]
			: [
					`Your Code Remote Cloud account already has ${machines.length} computers, the most it may keep:`,
					...machines.map((m) => `  ${m.name}, last used ${day(m.lastSeen)}`),
					'Sign one out with `coderemote logout --cloud` on it, or remove it from the app.',
				];
		super(lines.join('\n'), 'ELIMIT', { hostnames: list, machines });
	}
}

export class Capacity extends CloudError {
	constructor() {
		super('Code Remote Cloud is full right now. Use `coderemote up --tunnel devtunnels` for the time being.', 'ECAPACITY');
	}
}

export class Expired extends CloudError {
	constructor() {
		super('The sign-in code expired. Run `coderemote login --cloud` again.', 'EEXPIRED');
	}
}

export class Denied extends CloudError {
	constructor() {
		super('The sign-in was denied in the browser.', 'EDENIED');
	}
}

/** The hostname was cleaned up after 30 days unused; `PUT` again for a new one. */
export class NotFound extends CloudError {
	constructor(message) {
		super(message || 'not found', 'ENOTFOUND');
	}
}

export class Unreachable extends CloudError {
	constructor(cause) {
		super(`Couldn't reach Code Remote Cloud (${cause}).`, 'EUNREACHABLE');
	}
}

const day = (seconds) => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : 'never');

function toError(status, body) {
	switch (body?.code) {
		case 'EAUTH':
			return new SignedOut();
		case 'ENOACCESS':
			return new NoAccess();
		case 'ELIMIT':
			return new LimitReached(body);
		case 'ECAPACITY':
			return new Capacity();
		case 'EEXPIRED':
			return new Expired();
		case 'EDENIED':
			return new Denied();
		case 'ENOTFOUND':
			return new NotFound(body.error);
	}
	if (status === 401) return new SignedOut();
	return new CloudError(`Code Remote Cloud answered ${status}${body?.error ? `: ${body.error}` : ''}`, body?.code ?? 'EINTERNAL');
}

/**
 * @param {object} opts
 * @param {string} [opts.base]  the API's origin
 * @param {() => string | undefined} [opts.credential]  the machine credential, read at each call
 */
export function createCloudApi({ base = DEFAULT_API, credential = () => undefined, fetchFn = fetch, timeoutMs = 15_000 } = {}) {
	async function call(method, path, { body, auth = true } = {}) {
		const headers = { accept: 'application/json' };
		if (body !== undefined) headers['content-type'] = 'application/json';
		if (auth) {
			const c = credential();
			if (!c) throw new SignedOut();
			headers.authorization = `Bearer ${c}`;
		}
		let res;
		try {
			res = await fetchFn(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
		} catch (e) {
			throw new Unreachable(e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code ?? e.message));
		}
		let data = null;
		try {
			data = await res.json();
		} catch {}
		if (!res.ok) throw toError(res.status, data);
		return data;
	}
	const agent = (agentId) => `/v1/hostnames/${encodeURIComponent(agentId)}`;

	return {
		base,
		/** `{ userCode, verifyUrl, pollCode, interval, expiresIn }` */
		startLogin: (machineName) => call('POST', '/v1/login', { body: { machineName }, auth: false }),
		/** `{ status: 'pending', interval }` or `{ status: 'approved', machineId, credential, account }`; throws Expired, Denied, NoAccess. */
		pollLogin: (pollCode) => call('POST', '/v1/login/poll', { body: { pollCode }, auth: false }),
		me: () => call('GET', '/v1/me'),
		/** `{ tunnelId, connectorToken }` */
		tunnel: () => call('POST', '/v1/tunnel'),
		/**
		 * `{ host, url, created, probeToken, probeExpiresAt }`. `pairing`: `{ publicKey, label }`, listed
		 * to the owner's phone for Cloud pairing; left out, the backend forgets them.
		 */
		putHostname: (agentId, port, pairing = {}) => call('PUT', agent(agentId), { body: { port, ...pairing } }),
		/** `{ keys: [{ kid, publicKey }] }`: what checks the gate's owner assertions. */
		keys: () => call('GET', '/v1/keys', { auth: false }),
		/** `{ host, probeToken, probeExpiresAt }`; NotFound once the hostname was cleaned up. */
		seen: (agentId) => call('POST', `${agent(agentId)}/seen`),
		/** `{ machineId, name, hostnames: [{ host, agentId, port, lastSeen }] }` */
		machine: () => call('GET', '/v1/machine'),
		deleteHostname: (agentId) => call('DELETE', agent(agentId)),
		deleteMachine: () => call('DELETE', '/v1/machine'),
	};
}
