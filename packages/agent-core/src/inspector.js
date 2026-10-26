// Records the HTTP traffic of a previewed dev server, so the phone can see what reached it (a
// webhook, an API call) without the Dev Tunnels inspector, which is desktop Chrome DevTools.
// The preview tunnel forwards to this proxy's port, and the proxy to the dev server.
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';

// Per proxy; the oldest requests drop off first.
const MAX_ENTRIES = 200;
// Bodies beyond this are counted but not kept.
const MAX_BODY = 64 * 1024;
const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|[\w.+-]+\+(json|xml)))/i;

let nextId = 1;

/** Keeps the first MAX_BODY bytes of a stream and counts the rest. */
class BodyTap {
	chunks = [];
	kept = 0;
	size = 0;

	push(chunk) {
		this.size += chunk.length;
		if (this.kept < MAX_BODY) {
			const part = chunk.subarray(0, MAX_BODY - this.kept);
			this.chunks.push(part);
			this.kept += part.length;
		}
	}

	/** { size, truncated, text? | base64? }, decoded when the whole body was kept. */
	describe(headers) {
		const body = { size: this.size, truncated: this.size > this.kept };
		if (!this.size || body.truncated) return body;
		let data = Buffer.concat(this.chunks);
		const encoding = String(headers['content-encoding'] || '').toLowerCase();
		try {
			if (encoding === 'gzip') data = zlib.gunzipSync(data);
			else if (encoding === 'br') data = zlib.brotliDecompressSync(data);
			else if (encoding === 'deflate') data = zlib.inflateSync(data);
		} catch {
			return body;
		}
		if (TEXTUAL.test(String(headers['content-type'] || ''))) body.text = data.toString('utf8');
		else body.base64 = data.toString('base64');
		return body;
	}
}

export class InspectingProxy {
	/** @type {object[]} */
	#entries = [];

	/** @param {number} target  the dev server's port on this machine */
	constructor(target) {
		this.target = target;
		this.server = http.createServer((req, res) => this.#forward(req, res));
		this.server.on('upgrade', (req, socket, head) => this.#tunnelUpgrade(req, socket, head));
	}

	/** Listens on a free loopback port; resolves to it. */
	async listen() {
		await new Promise((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(0, '127.0.0.1', resolve);
		});
		this.port = this.server.address().port;
		return this.port;
	}

	close() {
		this.server.closeAllConnections?.();
		this.server.close();
	}

	/** Summaries, oldest first; `after` skips ids up to and including it. */
	list(after = 0) {
		return this.#entries.filter((e) => e.id > after).map(summary);
	}

	get(id) {
		return this.#entries.find((e) => e.id === id);
	}

	clear() {
		this.#entries = [];
	}

	#record(req) {
		const entry = {
			id: nextId++,
			time: Date.now(),
			method: req.method,
			path: req.url,
			status: null,
			duration: null,
			error: null,
			request: { headers: req.headers, tap: new BodyTap() },
			response: { headers: {}, tap: new BodyTap() },
		};
		this.#entries.push(entry);
		if (this.#entries.length > MAX_ENTRIES) this.#entries.shift();
		return entry;
	}

	/** The dev server sees itself addressed as localhost:<its port>, as without the proxy. */
	#headers(req) {
		return { ...req.headers, host: `localhost:${this.target}` };
	}

	#forward(req, res) {
		const entry = this.#record(req);
		const started = performance.now();
		const finish = () => {
			entry.duration = Math.round(performance.now() - started);
		};
		// "localhost", not 127.0.0.1: dev servers often listen on ::1 only. A fresh connection each
		// time: a kept-alive one may belong to a dev server that has since restarted.
		const upstream = http.request({
			agent: false,
			host: 'localhost',
			port: this.target,
			method: req.method,
			path: req.url,
			headers: this.#headers(req),
		});
		upstream.on('response', (up) => {
			entry.status = up.statusCode;
			entry.response.headers = up.headers;
			res.writeHead(up.statusCode, up.statusMessage, up.rawHeaders);
			up.on('data', (chunk) => {
				entry.response.tap.push(chunk);
				res.write(chunk);
			});
			up.on('end', () => {
				finish();
				res.end();
			});
			up.on('error', () => res.destroy());
		});
		upstream.on('error', (e) => {
			finish();
			entry.error = e.code === 'ECONNREFUSED' ? `nothing is listening on port ${this.target}` : e.message;
			if (res.headersSent) return res.destroy();
			entry.status = 502;
			res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
			res.end(`coderemote preview: ${entry.error}\n`);
		});
		req.on('data', (chunk) => entry.request.tap.push(chunk));
		req.pipe(upstream);
		res.on('close', () => {
			if (!res.writableFinished) upstream.destroy();
		});
	}

	/** WebSockets (hot reload) pass through as raw bytes; only the handshake is recorded. */
	#tunnelUpgrade(req, socket, head) {
		const entry = this.#record(req);
		const upstream = net.connect({ host: 'localhost', port: this.target }, () => {
			const headers = this.#headers(req);
			const lines = [`${req.method} ${req.url} HTTP/1.1`];
			for (const [k, v] of Object.entries(headers)) {
				for (const value of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${value}`);
			}
			upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
			if (head?.length) upstream.write(head);
			entry.status = 101;
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		upstream.on('error', (e) => {
			entry.error = e.message;
			socket.destroy();
		});
		socket.on('error', () => upstream.destroy());
	}
}

function summary(e) {
	return {
		id: e.id,
		time: e.time,
		method: e.method,
		path: e.path,
		status: e.status,
		duration: e.duration,
		error: e.error,
		contentType: e.response.headers['content-type'] ?? null,
		requestSize: e.request.tap.size,
		responseSize: e.response.tap.size,
	};
}

/** Everything recorded about one request, bodies included where they were small enough. */
export function detail(e) {
	return {
		...summary(e),
		request: { headers: e.request.headers, body: e.request.tap.describe(e.request.headers) },
		response: { headers: e.response.headers, body: e.response.tap.describe(e.response.headers) },
	};
}
