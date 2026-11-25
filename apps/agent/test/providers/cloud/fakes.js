// A fake Code Remote Cloud backend (node:http, following its docs/API.md) and a fake cloudflared,
// for the Cloud provider's tests.
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';

/**
 * `state.login`: what the poll answers after `pendingPolls` pending ones ('approved', or an error
 * code such as 'EDENIED'). `state.fail[path]`: `{ status, code }` to answer instead.
 * `state.before(call)`: awaited before each call is answered; false answers it 500.
 */
export async function fakeBackend() {
	const state = {
		credential: 'crm_test',
		revoked: false,
		login: 'approved',
		pendingPolls: 1,
		polls: 0,
		hostnames: new Map(), // agentId -> { host, port, lastSeen }
		next: 0,
		calls: [],
		fail: {},
		probeTtl: 86_400,
		now: () => Math.floor(Date.now() / 1000),
		offline: false,
		keys: [], // GET /v1/keys
	};
	const error = (res, status, code, extra = {}) => {
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: code, code, ...extra }));
	};
	const ok = (res, body) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(body));
	};
	const probe = () => ({ probeToken: `probe-${state.now()}-${state.calls.length}`, probeExpiresAt: state.now() + state.probeTtl });
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', async () => {
			if (state.offline) return req.socket.destroy();
			const url = new URL(req.url, 'http://x');
			const body = raw ? JSON.parse(raw) : undefined;
			const call = { method: req.method, path: url.pathname, body, auth: req.headers.authorization };
			state.calls.push(call);
			// A test's hook may hold a call back, or answer it with an error.
			if (state.before && !(await state.before(call))) return error(res, 500, 'EINTERNAL');
			const forced = state.fail[`${req.method} ${url.pathname}`];
			if (forced) return error(res, forced.status, forced.code, forced.extra);
			const machineAuth = () => {
				if (state.revoked || req.headers.authorization !== `Bearer ${state.credential}`) {
					error(res, 401, 'EAUTH');
					return false;
				}
				return true;
			};
			const route = `${req.method} ${url.pathname}`;
			const hostname = url.pathname.match(/^\/v1\/hostnames\/([^/]+)(\/seen)?$/);
			if (route === 'POST /v1/login') return ok(res, { userCode: 'ABCD-EFGH', verifyUrl: 'https://cloud.test/link?code=ABCD-EFGH', pollCode: 'poll', interval: 1, expiresIn: 600 });
			if (route === 'POST /v1/login/poll') {
				if (state.polls++ < state.pendingPolls) return ok(res, { status: 'pending', interval: 1 });
				if (state.login !== 'approved') return error(res, state.login === 'EEXPIRED' ? 410 : 403, state.login);
				return ok(res, { status: 'approved', machineId: 'm1', credential: state.credential, account: 'owner@example.com' });
			}
			if (route === 'GET /v1/keys') return ok(res, { keys: state.keys });
			if (!machineAuth()) return;
			if (route === 'GET /v1/me') return ok(res, { uid: 'u1', email: 'owner@example.com', plan: 'beta', machineId: 'm1', machineName: 'Mac' });
			if (route === 'POST /v1/tunnel') return ok(res, { tunnelId: 't1', connectorToken: 'CONNECTOR-TOKEN' });
			if (route === 'GET /v1/machine') return ok(res, { machineId: 'm1', name: 'Mac', hostnames: [...state.hostnames].map(([agentId, h]) => ({ agentId, ...h })) });
			if (route === 'DELETE /v1/machine') {
				const n = state.hostnames.size;
				state.hostnames.clear();
				state.revoked = true;
				return ok(res, { deleted: { machines: 1, hostnames: n } });
			}
			if (hostname) {
				const agentId = decodeURIComponent(hostname[1]);
				const known = state.hostnames.get(agentId);
				if (req.method === 'PUT') {
					const host = known?.host ?? `cr${'abcdefghij'.slice(0, 9)}${state.next++}.commitplus.app`;
					state.hostnames.set(agentId, { host, port: body.port, lastSeen: state.now() });
					return ok(res, { host, url: `https://${host}`, created: !known, ...probe() });
				}
				if (!known) return error(res, 404, 'ENOTFOUND');
				if (req.method === 'POST' && hostname[2]) {
					known.lastSeen = state.now();
					return ok(res, { host: known.host, ...probe() });
				}
				if (req.method === 'DELETE') {
					state.hostnames.delete(agentId);
					return ok(res, { deleted: known.host });
				}
			}
			error(res, 404, 'ENOTFOUND');
		});
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	return {
		state,
		url: `http://127.0.0.1:${server.address().port}`,
		paths: (filter = () => true) => state.calls.filter(filter).map((c) => `${c.method} ${c.path}`),
		close: () => new Promise((r) => server.close(r)),
	};
}

/** A fake `runConnector`: each call is recorded and returns a child that has registered, unless `fail` is set. */
export function fakeConnector() {
	const runs = [];
	const self = {
		runs,
		fail: null,
		live: () => runs.filter((r) => !r.child.exited),
		run: async (bin, token, opts) => {
			const child = new EventEmitter();
			child.stderr = new PassThrough();
			child.exited = false;
			child.kill = () => {
				if (child.exited) return;
				child.exited = true;
				setImmediate(() => child.emit('exit', null, 'SIGTERM'));
			};
			runs.push({ bin, token, opts, child });
			if (self.fail) throw self.fail;
			return child;
		},
	};
	return self;
}

export const quiet = { start() {}, update() {}, succeed() {}, stop() {}, fail() {} };

/** In-memory config as bin/coderemote.js keeps it: `load` gives a fresh copy. */
export function memoryConfig(initial = {}) {
	let saved = structuredClone(initial);
	return {
		cfg: structuredClone(initial),
		load: () => structuredClone(saved),
		save: (cfg) => (saved = structuredClone(cfg)),
		saved: () => saved,
	};
}
