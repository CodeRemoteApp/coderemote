// Push notifications for coding-agent sessions: a request to answer, a long turn finished. They
// go through the push relay (apps/push-relay), encrypted for the phone, so the relay and APNs see
// no content. See PROTOCOL.md, "Push".
import { execFile } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import os from 'node:os';
import { promisify } from 'node:util';
import { HttpError } from './sandbox.js';

const run = promisify(execFile);
const FINISHED_AFTER = 60 * 1000;
const ACTIVE_WITHIN = 2 * 60;

/** Seconds since the last keyboard or mouse input on this Mac; null where that can't be known. */
async function macIdleSeconds() {
	if (os.platform() !== 'darwin') return null;
	try {
		const { stdout } = await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-k', 'HIDIdleTime'], { timeout: 2000 });
		const ns = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/)?.[1];
		return ns ? Number(BigInt(ns) / 1_000_000_000n) : null;
	} catch {
		return null;
	}
}

/** Whether someone used this computer in the last 2 minutes (false where that can't be known). */
export async function userActiveHere() {
	const idle = await macIdleSeconds();
	return idle !== null && idle < ACTIVE_WITHIN;
}

/** `base64(nonce ‖ ciphertext ‖ tag)` of `data` as JSON under AES-256-GCM. */
export function seal(key, data) {
	const nonce = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, nonce);
	const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
	return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64');
}

function relayUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	const local = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
	return url.protocol === 'https:' || local ? url.href.replace(/\/$/, '') : null;
}

/** A registration from `PUT /api/push/device`, checked field by field. */
function deviceFrom(body) {
	const relay = relayUrl(body?.relay);
	if (!relay) throw new HttpError(400, 'relay must be an https URL');
	if (typeof body.token !== 'string' || !/^[0-9a-f]{64,200}$/i.test(body.token)) throw new HttpError(400, 'token must be an APNs device token (hex)');
	if (body.environment !== 'production' && body.environment !== 'development') {
		throw new HttpError(400, 'environment must be production or development');
	}
	if (typeof body.ticket !== 'string' || !body.ticket || body.ticket.length > 128) throw new HttpError(400, 'ticket required');
	if (typeof body.key !== 'string' || Buffer.from(body.key, 'base64').length !== 32) throw new HttpError(400, 'key must be 32 bytes, base64');
	if (typeof body.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(body.keyId)) throw new HttpError(400, 'keyId required');
	const kinds = body.kinds ?? {};
	return {
		relay,
		token: body.token.toLowerCase(),
		environment: body.environment,
		ticket: body.ticket,
		key: body.key,
		keyId: body.keyId,
		kinds: { requests: kinds.requests !== false, finished: kinds.finished !== false },
	};
}

/** What a request asks, in a line: the command for Bash, the file for edits, the question. */
function describeRequest(request) {
	if (request.kind === 'question') return request.questions[0]?.question ?? 'Claude has a question';
	const input = request.input ?? {};
	const detail = input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.pattern ?? null;
	return detail ? `${request.tool}: ${String(detail).split('\n')[0].slice(0, 200)}` : `Allow ${request.tool}?`;
}

function minutes(ms) {
	const m = Math.round(ms / 60000);
	return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export class PushSender {
	#devices;
	#store;
	#hub;
	#foreground;
	#userActive;
	#fetch;
	// Requests a notification went out for, so their resolution can replace it.
	#notified = new Set();

	/**
	 * @param {object} opts
	 * @param {import('./agents.js').AgentHub} opts.hub
	 * @param {{ load: () => object[], save: (devices: object[]) => void }} [opts.store]
	 * @param {() => boolean} [opts.foreground]  whether a client shows this machine right now
	 * @param {() => Promise<boolean>} [opts.userActive]  whether someone is using the computer
	 */
	constructor({ hub, store = null, foreground = () => false, userActive = null, fetch = globalThis.fetch }) {
		this.#hub = hub;
		this.#store = store;
		this.#devices = store?.load() ?? [];
		this.#foreground = foreground;
		this.#userActive = userActive ?? userActiveHere;
		this.#fetch = fetch;
		hub.on('message', (msg) => this.#follow(msg).catch(() => {}));
	}

	devices() {
		return this.#devices.map(({ key, ticket, ...rest }) => rest);
	}

	register(body) {
		const device = deviceFrom(body);
		this.#devices = [...this.#devices.filter((d) => d.token !== device.token), device];
		this.#save();
	}

	unregister(token) {
		this.#devices = this.#devices.filter((d) => d.token !== String(token).toLowerCase());
		this.#save();
	}

	/** Sends a test notification; throws 404 for an unknown token, 502 when it doesn't go out. */
	async test(token) {
		const device = this.#devices.find((d) => d.token === String(token ?? '').toLowerCase());
		if (!device) throw new HttpError(404, 'that device is not registered');
		const result = await this.#send(device, {
			kind: 'test',
			title: 'Code Remote',
			body: 'Notifications from this computer work.',
			category: null,
			fallback: 'Notifications work',
		});
		if (!result.ok) throw new HttpError(502, `push failed: ${result.reason ?? result.status}`);
	}

	#save() {
		this.#store?.save(this.#devices);
	}

	async #quiet() {
		if (this.#foreground()) return true;
		try {
			return await this.#userActive();
		} catch {
			return false;
		}
	}

	async #follow(msg) {
		if (!this.#devices.length) return;
		if (msg.type === 'request') {
			const { request } = msg;
			if (await this.#quiet()) return;
			// Answered while we checked: nothing to ask any more.
			if (!this.#hub.requests().some((r) => r.id === request.id)) return;
			this.#notified.add(request.id);
			const question = request.kind === 'question';
			// One single-choice question can be answered from the notification; anything else opens the app.
			const answerable = question && request.questions.length === 1 && !request.questions[0].multiSelect;
			await this.#broadcast('requests', {
				kind: 'request',
				title: this.#hub.session(request.session)?.title ?? 'Claude Code',
				body: describeRequest(request),
				session: request.session,
				request: request.id,
				question: answerable ? request.questions[0].question : undefined,
				options: answerable ? request.questions[0].options.map((o) => o.label) : undefined,
				category: question ? 'QUESTION' : 'PERMISSION',
				collapseId: request.id,
				fallback: 'A session needs your attention',
			});
		} else if (msg.type === 'request_resolved') {
			if (!this.#notified.delete(msg.request) || msg.by === 'phone') return;
			// Replace the delivered notification so it no longer offers actions.
			await this.#broadcast('requests', {
				kind: 'resolved',
				title: this.#hub.session(msg.session)?.title ?? 'Claude Code',
				body: msg.outcome === 'expired' ? 'No longer waiting for an answer' : 'Answered on your computer',
				session: msg.session,
				request: msg.request,
				category: null,
				collapseId: msg.request,
				priority: 5,
				silent: true,
				fallback: 'Answered on your computer',
			});
		} else if (msg.type === 'entry' && msg.entry.kind === 'turn_end' && msg.entry.duration >= FINISHED_AFTER) {
			if (await this.#quiet()) return;
			const session = this.#hub.session(msg.session);
			await this.#broadcast('finished', {
				kind: 'finished',
				title: session?.title ?? 'Claude Code',
				body: `Finished after ${minutes(msg.entry.duration)}`,
				session: msg.session,
				category: 'DONE',
				fallback: 'A session finished',
			});
		}
	}

	/** A build ended (see builds.js): ready to install, or failed. Cancelled builds say nothing. */
	async buildEnded(build) {
		if (!this.#devices.length || build.state === 'cancelled') return;
		if (await this.#quiet()) return;
		const ok = build.state === 'succeeded';
		const firstError = String(build.error ?? '').split('\n').find((l) => l.trim()) ?? '';
		await this.#broadcast('finished', {
			kind: 'build',
			title: ok ? 'Build ready to install' : 'Build failed',
			body: ok ? `${build.app?.name ?? build.scheme} ${build.app?.version ?? ''}`.trim() : `${build.scheme}: ${firstError}`,
			build: build.id,
			category: 'BUILD',
			collapseId: `build-${build.id}`,
			fallback: ok ? 'A build is ready to install' : 'A build failed',
		});
	}

	async #broadcast(kind, note) {
		await Promise.all(this.#devices.filter((d) => d.kinds[kind]).map((d) => this.#send(d, note)));
	}

	async #send(device, { kind, title, body, session, request, build, question, options, category, collapseId, priority, silent, fallback }) {
		const secret = { kind, title, body, session, request, build, question, options };
		const aps = { alert: { title: 'Code Remote', body: fallback }, 'mutable-content': 1 };
		if (category) aps.category = category;
		if (session) aps['thread-id'] = session;
		if (!silent) aps.sound = 'default';
		const payload = { aps, k: device.keyId, e: seal(Buffer.from(device.key, 'base64'), secret) };
		let res;
		try {
			res = await this.#fetch(`${device.relay}/v1/send`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					token: device.token,
					environment: device.environment,
					ticket: device.ticket,
					payload,
					...(collapseId ? { collapseId } : {}),
					...(priority ? { priority } : {}),
				}),
				signal: AbortSignal.timeout(10_000),
			});
		} catch (e) {
			return { ok: false, status: 0, reason: e.message };
		}
		let reason = null;
		try {
			reason = (await res.json()).reason ?? null;
		} catch {}
		// APNs says the app is gone from that device (or the token is wrong): stop pushing to it.
		if (res.status === 410 || (res.status === 400 && reason === 'BadDeviceToken')) this.unregister(device.token);
		return { ok: res.ok, status: res.status, reason };
	}
}
