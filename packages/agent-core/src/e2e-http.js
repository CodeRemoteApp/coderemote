// The agent's side of end-to-end encryption over HTTP: the handshake endpoint and the sealed-request
// endpoint. A sealed request is unsealed and sent to the agent's own loopback port, so every route
// and its authorization run exactly as for a plaintext call; the answer comes back sealed.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { E2E_HANDSHAKE_PATH, E2E_REQUEST_PATH, E2E_SESSION_HEADER, E2E_VERSION } from '@vsremote/protocol';
import {
	MAX_SEALED,
	SessionTable,
	TicketTable,
	agentAccept,
	b64u,
	counterOf,
	fromB64u,
	open,
	pack,
	requestAad,
	responseAad,
	seal,
	unpack,
} from './e2e.js';

const SESSION_HEADER = E2E_SESSION_HEADER.toLowerCase();
/** New sessions allowed per minute: the handshake needs no credential, so it is rationed. */
const HANDSHAKES_PER_MINUTE = 120;
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'date']);
const INNER_HEADER = 'x-coderemote-inner';
const INNER_SID_HEADER = 'x-coderemote-sid';
const DROPPED_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', SESSION_HEADER, INNER_HEADER, INNER_SID_HEADER]);

/** Which route a ticket of each scope opens. */
const TICKET_ROUTES = {
	read: (method, pathname) => method === 'GET' && pathname === '/api/fs/read',
	upload: (method, pathname) => pathname === '/api/agents/uploads' && (method === 'POST' || method === 'GET'),
};

function reply(res, status, body) {
	const json = JSON.stringify(body);
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
	res.end(json);
}

/** The request's body, or null (after answering 413) when it exceeds `limit` bytes. */
async function readBody(req, res, limit) {
	const chunks = [];
	let size = 0;
	for await (const c of req) {
		size += c.length;
		if (size > limit) {
			reply(res, 413, { error: 'too large', code: 'e2e_too_large' });
			req.destroy();
			return null;
		}
		chunks.push(c);
	}
	return Buffer.concat(chunks);
}

/**
 * @param {object} opts
 * @param {{ publicKey: Buffer, privateKey: object }} opts.identity  the agent's identity key
 * @param {() => number} opts.port  the loopback port sealed requests are sent to
 * @param {{ sessions?: object, tickets?: object, handshakesPerMinute?: number, now?: () => number }} [opts.options]
 */
export function createSealedGateway({ identity, port, options = {} }) {
	const now = options.now ?? Date.now;
	const sessions = new SessionTable({ now, ...options.sessions });
	const tickets = new TicketTable({ now, ...options.tickets });
	const rate = options.handshakesPerMinute ?? HANDSHAKES_PER_MINUTE;
	// Known only to this process: it marks the requests this gateway re-enters, so the routes that
	// hand out secrets can tell they came through a sealed session.
	const innerSecret = b64u(randomBytes(16));
	let windowStart = now();
	let used = 0;

	function allowHandshake() {
		if (now() - windowStart >= 60_000) {
			windowStart = now();
			used = 0;
		}
		return ++used <= rate;
	}

	async function handshake(req, res) {
		if (!allowHandshake()) return reply(res, 429, { error: 'too many handshakes', code: 'e2e_rate' });
		const body = await readBody(req, res, 4096);
		if (!body) return;
		let msg;
		try {
			msg = JSON.parse(body.toString('utf8'));
		} catch {
			return reply(res, 400, { error: 'invalid json' });
		}
		if (msg?.v !== E2E_VERSION) return reply(res, 400, { error: 'unsupported version', code: 'e2e_version' });
		const epk = fromB64u(msg.epk, 32);
		if (!epk) return reply(res, 400, { error: 'invalid key' });
		let accepted;
		try {
			accepted = agentAccept(identity, epk);
		} catch {
			return reply(res, 400, { error: 'invalid key' });
		}
		const session = sessions.create(accepted.keys);
		reply(res, 200, { v: E2E_VERSION, sid: session.id, epk: b64u(accepted.epk), confirm: b64u(accepted.confirm) });
	}

	/** Runs the unsealed request against this agent; resolves `{ status, headers, body }` or `{ tooLarge }`. */
	function dispatch(header, body, res, sid) {
		return new Promise((resolve, reject) => {
			const headers = {};
			for (const [k, v] of Object.entries(header.headers ?? {})) {
				if (typeof v === 'string' && !DROPPED_REQUEST_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
			}
			if (body.length) headers['content-length'] = String(body.length);
			headers[INNER_HEADER] = innerSecret;
			headers[INNER_SID_HEADER] = sid;
			const inner = http.request(
				{ host: '127.0.0.1', port: port(), method: header.method, path: header.path, headers },
				(answer) => {
					const chunks = [];
					let size = 0;
					answer.on('data', (c) => {
						size += c.length;
						if (size > MAX_SEALED - 4096) {
							inner.destroy();
							resolve({ tooLarge: true });
						} else chunks.push(c);
					});
					answer.on('end', () => {
						const out = {};
						for (const [k, v] of Object.entries(answer.headers)) {
							if (!DROPPED_RESPONSE_HEADERS.has(k)) out[k] = v;
						}
						resolve({ status: answer.statusCode, headers: out, body: Buffer.concat(chunks) });
					});
					answer.on('error', reject);
				},
			);
			inner.on('error', (e) => reject(e));
			// The phone went away: stop what it asked for.
			res.on('close', () => {
				if (!res.writableFinished) inner.destroy();
			});
			inner.end(body);
		});
	}

	async function request(req, res) {
		const sid = req.headers[SESSION_HEADER];
		const session = typeof sid === 'string' ? sessions.get(sid) : null;
		if (!session) return reply(res, 401, { error: 'unknown session', code: 'e2e_session' });
		if (!sessions.claim(session, 'http')) return reply(res, 400, { error: 'session in use', code: 'e2e_mode' });
		const body = await readBody(req, res, MAX_SEALED + 64);
		if (!body) return;
		const counter = counterOf(body);
		if (counter === null || !session.recv.allows(counter)) {
			return reply(res, 400, { error: 'rejected', code: 'e2e_replay' });
		}
		const plain = open(session.keys.c2s, requestAad(session.id), body);
		if (!plain) return reply(res, 400, { error: 'rejected', code: 'e2e_bad' });
		session.recv.commit(counter);
		const msg = unpack(plain);
		const header = msg?.header;
		const method = typeof header?.method === 'string' ? header.method.toUpperCase() : '';
		let pathname = null;
		try {
			if (typeof header?.path === 'string' && header.path.startsWith('/') && !header.path.startsWith('//')) {
				pathname = new URL(header.path, 'http://localhost').pathname;
			}
		} catch {}
		let result;
		if (!/^[A-Z]{3,7}$/.test(method) || pathname === null) {
			result = answer(400, { error: 'bad request' });
		} else if (pathname === E2E_REQUEST_PATH || pathname === E2E_HANDSHAKE_PATH) {
			result = answer(404, { error: 'not found' });
		} else {
			try {
				result = await dispatch({ ...header, method }, msg.body, res, session.id);
			} catch {
				result = answer(502, { error: 'agent unreachable' });
			}
			if (result.tooLarge) {
				result = answer(413, { error: 'too large for one sealed message', code: 'e2e_too_large' });
			}
		}
		if (res.destroyed) return;
		const out = seal(
			session.keys.s2c,
			session.sent++,
			responseAad(session.id, counter),
			pack({ status: result.status, headers: result.headers }, result.body),
		);
		res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': out.length, 'cache-control': 'no-store' });
		res.end(out);
	}

	function answer(status, json) {
		const body = Buffer.from(JSON.stringify(json));
		return { status, headers: { 'content-type': 'application/json' }, body };
	}

	/** Whether `Authorization: Ticket <t>` opens this request: a live ticket on a route of its scope. */
	function ticketOk(req, pathname) {
		const m = /^Ticket (\S+)$/.exec(req.headers.authorization || '');
		if (!m) return false;
		return Object.entries(TICKET_ROUTES).some(([scope, allows]) => allows(req.method, pathname) && tickets.check(m[1], scope));
	}

	/** The sealed session `req` came through (this gateway re-entered it), or null. */
	function channelOf(req) {
		const got = Buffer.from(String(req.headers[INNER_HEADER] ?? ''));
		const want = Buffer.from(innerSecret);
		if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
		const sid = req.headers[INNER_SID_HEADER];
		return typeof sid === 'string' && sid ? sid : null;
	}

	function end() {
		sessions.clear();
		tickets.clear();
	}

	return { handshake, request, ticketOk, channelOf, tickets, sessions, end };
}
