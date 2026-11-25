// A client of the end-to-end encryption, for tests: the handshake, sealed requests and sealed sockets.
import {
	E2E_HANDSHAKE_PATH,
	E2E_REQUEST_PATH,
	E2E_SESSION_HEADER,
	E2E_VERSION,
} from '@vsremote/protocol';
import * as e2e from '../../src/e2e.js';

/** Opens a session with the agent at `base` (`http://host:port`) whose identity public key is `pk`. */
export async function handshake(base, pk, { post = fetch } = {}) {
	const start = e2e.clientStart(pk);
	const res = await post(base + E2E_HANDSHAKE_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ v: E2E_VERSION, epk: e2e.b64u(start.epk) }),
	});
	if (res.status !== 200) throw Object.assign(new Error(`handshake ${res.status}`), { status: res.status });
	const j = await res.json();
	const keys = e2e.clientFinish(start, { epk: e2e.fromB64u(j.epk, 32), confirm: e2e.fromB64u(j.confirm, 32) });
	if (!keys) throw new Error('the agent could not prove its identity');
	return new Session(base, j.sid, keys);
}

export class Session {
	constructor(base, sid, keys) {
		this.base = base;
		this.sid = sid;
		this.keys = keys;
		this.sent = 0;
		this.received = 0;
	}

	/** The wire bytes of a sealed request, and the counter they carry. */
	sealRequest(method, path, { headers = {}, body = Buffer.alloc(0) } = {}) {
		const counter = this.sent++;
		const wire = e2e.seal(this.keys.c2s, counter, e2e.requestAad(this.sid), e2e.pack({ method, path, headers }, Buffer.from(body)));
		return { counter, wire };
	}

	async postWire(wire, extra = {}) {
		return fetch(this.base + E2E_REQUEST_PATH, {
			method: 'POST',
			headers: { [E2E_SESSION_HEADER]: this.sid, 'content-type': 'application/octet-stream' },
			body: wire,
			...extra,
		});
	}

	/** `{ status, headers, body, json() }` of the answer to a sealed request. */
	async request(method, path, opts = {}) {
		const { counter, wire } = this.sealRequest(method, path, opts);
		const res = await this.postWire(wire);
		if (res.status !== 200) throw Object.assign(new Error(`sealed request ${res.status}`), { status: res.status, body: await res.text() });
		const plain = e2e.open(this.keys.s2c, e2e.responseAad(this.sid, counter), Buffer.from(await res.arrayBuffer()));
		if (!plain) throw new Error('answer did not authenticate');
		const { header, body } = e2e.unpack(plain);
		return { status: header.status, headers: header.headers, body, json: () => JSON.parse(body.toString('utf8')) };
	}
}

/** A sealed socket on a session of its own: `kind` is 'term' or 'agents'. */
export async function openSocket(base, pk, kind, params = {}, { token = 'pairing-token', WebSocket } = {}) {
	const session = await handshake(base, pk);
	const path = kind === 'term' ? '/api/term/ws' : '/api/agents/ws';
	const ws = new WebSocket(base.replace('http', 'ws') + `${path}?e2e=${session.sid}`);
	const frames = [];
	const waiters = [];
	let closed = null;
	let sent = 0;
	let next = 0;
	ws.on('message', (data, isBinary) => {
		if (!isBinary) return;
		const counter = e2e.counterOf(data);
		const plain = e2e.open(session.keys.s2c, e2e.socketAad(session.sid, 's2c'), data);
		if (!plain || counter !== next++) {
			frames.push({ bad: true });
		} else {
			frames.push({ binary: plain[0] === 1, data: plain.subarray(1) });
		}
		waiters.splice(0).forEach((w) => w());
	});
	ws.on('close', (code) => {
		closed = code;
		waiters.splice(0).forEach((w) => w());
	});
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
		ws.once('unexpected-response', (_, res) => reject(Object.assign(new Error(`upgrade ${res.statusCode}`), { status: res.statusCode })));
	});
	const wire = (type, payload) => e2e.seal(session.keys.c2s, sent++, e2e.socketAad(session.sid, 'c2s'), Buffer.concat([Buffer.from([type]), Buffer.from(payload)]));
	const client = {
		session,
		ws,
		get closed() {
			return closed;
		},
		sendRaw: (buf) => ws.send(buf, { binary: true }),
		sealFrame: wire,
		open: (extra = {}) => client.sendRaw(wire(0, JSON.stringify({ type: 'open', kind, token, ...params, ...extra }))),
		sendText: (text) => client.sendRaw(wire(0, text)),
		sendBinary: (buf) => client.sendRaw(wire(1, buf)),
		async waitFor(predicate, ms = 3000) {
			const deadline = Date.now() + ms;
			for (;;) {
				const hit = predicate(frames, closed);
				if (hit) return hit;
				if (Date.now() > deadline) throw new Error(`timed out; frames=${frames.length} closed=${closed}`);
				await new Promise((r) => {
					waiters.push(r);
					setTimeout(r, 50);
				});
			}
		},
		frames,
		text: () => frames.filter((f) => !f.bad && !f.binary).map((f) => f.data.toString('utf8')),
		output: () => Buffer.concat(frames.filter((f) => !f.bad && f.binary).map((f) => f.data)).toString('utf8'),
	};
	return client;
}
