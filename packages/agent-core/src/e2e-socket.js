// Sealed WebSockets. The upgrade names a session (`?e2e=<sid>`) and nothing else; every frame in
// both directions is `counter || ciphertext || tag`, and the first client frame is `open`, which
// carries what a plaintext socket puts in its URL and headers (the bearer token, the terminal
// session, its size and folder). The socket handed to the terminal and agents code is an adapter
// with the same surface as a `ws`, so they don't know the difference.
import { EventEmitter } from 'node:events';
import { counterOf, open, seal, socketAad } from './e2e.js';

/** WebSocket close codes the agent uses for a sealed socket it ends. */
export const SealedClose = Object.freeze({
	badFrame: 4400,
	unauthorized: 4401,
	notFound: 4404,
	noOpen: 4408,
	failed: 4500,
});
const OPEN_TIMEOUT_MS = 5000;

class SealedSocket extends EventEmitter {
	constructor(ws, session) {
		super();
		this.ws = ws;
		this.session = session;
	}

	send(data, opts = {}) {
		const binary = typeof data !== 'string' || opts.binary === true;
		if (this.ws.readyState !== 1) return;
		const payload = Buffer.concat([Buffer.from([binary ? 1 : 0]), Buffer.from(data)]);
		const frame = seal(this.session.keys.s2c, this.session.sent++, socketAad(this.session.id, 's2c'), payload);
		this.ws.send(frame, { binary: true });
	}

	close(code, reason) {
		try {
			this.ws.close(code, reason);
		} catch {}
	}
}

/**
 * Takes over `ws`, the accepted upgrade of `session` (already claimed for sockets). Calls
 * `onOpen(message, socket)` with the first decrypted frame, parsed as JSON; it resolves true to
 * go on, or a close code (a SealedClose value) to end the socket with.
 */
export function acceptSealedSocket(ws, session, onOpen, { openTimeoutMs = OPEN_TIMEOUT_MS } = {}) {
	const socket = new SealedSocket(ws, session);
	let opened = false;
	let dead = false;
	const end = (code) => {
		dead = true;
		clearTimeout(timer);
		try {
			ws.close(code);
		} catch {}
	};
	const timer = setTimeout(() => !opened && end(SealedClose.noOpen), openTimeoutMs);
	timer.unref?.();
	ws.on('close', () => {
		dead = true;
		clearTimeout(timer);
		socket.emit('close');
	});
	ws.on('error', () => {});
	ws.on('message', async (data, isBinary) => {
		if (dead) return;
		if (!isBinary) return end(SealedClose.badFrame);
		const counter = counterOf(data);
		if (counter === null || !session.recv.allows(counter)) return end(SealedClose.badFrame);
		const plain = open(session.keys.c2s, socketAad(session.id, 'c2s'), data);
		if (!plain || plain.length < 1) return end(SealedClose.badFrame);
		session.recv.commit(counter);
		const payload = plain.subarray(1);
		if (opened) return socket.emit('message', payload, plain[0] === 1);
		let msg;
		try {
			msg = JSON.parse(payload.toString('utf8'));
		} catch {
			return end(SealedClose.badFrame);
		}
		if (msg?.type !== 'open') return end(SealedClose.badFrame);
		opened = true;
		clearTimeout(timer);
		let result;
		try {
			result = await onOpen(msg, socket);
		} catch {
			result = SealedClose.failed;
		}
		if (result !== true) end(result);
	});
}
