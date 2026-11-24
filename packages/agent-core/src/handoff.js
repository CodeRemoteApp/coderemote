import { createHmac, timingSafeEqual } from 'node:crypto';

const NONCE_WINDOW_MS = 5 * 60_000;
// Hand out a cached tunnel token while it has at least this long to live.
const REUSE_MIN_LIFETIME_MS = 12 * 3_600_000;

/**
 * Sign-in handoff for private tunnels. The app opens TUNNEL_HANDOFF_PATH in the system browser;
 * the relay only lets the tunnel's owner through, and the request must also carry
 * `sig = base64url(HMAC-SHA256(agent token, nonce))`, so a crafted link from someone without
 * the pairing token gets nothing. The answer is a dev tunnels connect token the app then sends
 * as `X-Tunnel-Authorization` (the relay checks and strips it; the agent never sees it).
 */
export class TunnelHandoff {
	/**
	 * @param {object} opts
	 * @param {string} opts.token  the agent's bearer token (the HMAC key)
	 * @param {() => Promise<{token: string, expiresAt: number} | null>} opts.mint
	 */
	constructor({ token, mint, now = Date.now }) {
		this.key = token;
		this.mint = mint;
		this.now = now;
		this.used = new Map();
		this.cached = null;
	}

	/**
	 * `nonce` is `<unix seconds>.<random>`, good for five minutes. Returns `{ ok: true }`,
	 * `{ ok: false, reason: 'invalid' }` (bad signature or malformed) or `{ ok: false, reason:
	 * 'expired' }` (outside the window). A nonce used once comes back `{ ok: true, replay: true }`
	 * when it carries the same `state` within the window: the relay's "connecting" page and a
	 * browser reload both resend the same link, and only the app that made it holds that state.
	 */
	check(nonce, sig, state) {
		if (typeof nonce !== 'string' || typeof sig !== 'string') return { ok: false, reason: 'invalid' };
		const want = Buffer.from(createHmac('sha256', this.key).update(nonce).digest('base64url'));
		const got = Buffer.from(sig);
		if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'invalid' };
		const issued = Number(nonce.split('.')[0]) * 1000;
		const now = this.now();
		if (!Number.isFinite(issued)) return { ok: false, reason: 'invalid' };
		if (Math.abs(now - issued) > NONCE_WINDOW_MS) return { ok: false, reason: 'expired' };
		for (const [n, use] of this.used) if (now - use.at > 2 * NONCE_WINDOW_MS) this.used.delete(n);
		const seen = this.used.get(nonce);
		if (seen) return seen.state === state ? { ok: true, replay: true } : { ok: false, reason: 'invalid' };
		this.used.set(nonce, { at: now, state });
		return { ok: true };
	}

	/** Whether the link is good (see `check`). */
	verify(nonce, sig, state) {
		return this.check(nonce, sig, state).ok;
	}

	/** A connect token, or null when the tunnel is anonymous (nothing to hand out). */
	async issue() {
		if (this.cached && this.cached.expiresAt - this.now() > REUSE_MIN_LIFETIME_MS) return this.cached;
		this.cached = await this.mint();
		return this.cached;
	}
}
