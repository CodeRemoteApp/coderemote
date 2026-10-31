// One-time install links for a build. iOS's installer fetches the manifest and the .ipa without
// any of our headers, and the agent's own tunnel lets nobody in without them, so the files are
// served from a localhost server forwarded and publicly shared through the preview tunnel. Only
// live tokens are served; the share ends as soon as none is left. See PROTOCOL.md, "Builds".
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import { pipeline } from 'node:stream/promises';

const TTL = 10 * 60 * 1000;
// Dev tunnels shares last at least an hour; the server stops serving long before that.
const SHARE_HOURS = 1;

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function manifest({ ipaUrl, bundleId, version, title }) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>items</key><array><dict>
		<key>assets</key><array><dict>
			<key>kind</key><string>software-package</string>
			<key>url</key><string>${xml(ipaUrl)}</string>
		</dict></array>
		<key>metadata</key><dict>
			<key>bundle-identifier</key><string>${xml(bundleId)}</string>
			<key>bundle-version</key><string>${xml(version)}</string>
			<key>kind</key><string>software</string>
			<key>title</key><string>${xml(title)}</string>
		</dict>
	</dict></array>
</dict></plist>
`;
}

/**
 * `preview` is the agent's preview tunnel (`forward(port)` → `{ url }`, `share(port, hours)`,
 * `unshare(port)`, `unforward(port)`). `setTimer` is injectable for tests.
 */
export class InstallLinks {
	#preview;
	#now;
	#ttl;
	#setTimer;
	#server = null;
	#port = null;
	#base = null;
	#tokens = new Map();
	#serial = Promise.resolve();

	constructor({ preview, now = Date.now, ttl = TTL, setTimer = (fn, ms) => setTimeout(fn, ms).unref?.() } = {}) {
		this.#preview = preview;
		this.#now = now;
		this.#ttl = ttl;
		this.#setTimer = setTimer;
	}

	/** A link installing `ipa` (an app `{ bundleId, version, name }`): `{ url, expiresAt }`. */
	create({ ipa, app }) {
		return this.#queue(async () => {
			await this.#listen();
			if (!this.#base) {
				const { url } = await this.#preview.forward(this.#port);
				await this.#preview.share(this.#port, SHARE_HOURS);
				this.#base = url.replace(/\/+$/, '');
			}
			const token = randomBytes(24).toString('hex');
			const expiresAt = this.#now() + this.#ttl;
			const manifestUrl = `${this.#base}/${token}/manifest.plist`;
			this.#tokens.set(token, {
				ipa,
				manifest: manifest({ ipaUrl: `${this.#base}/${token}/app.ipa`, bundleId: app.bundleId, version: app.version, title: app.name }),
			});
			this.#setTimer(() => this.#expire(token), this.#ttl);
			return { url: `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`, expiresAt };
		});
	}

	/** Whether links are being served through the preview tunnel right now. */
	get sharing() {
		return this.#base !== null;
	}

	/** Ends every link now and closes the public window (the Ports tab's Stop). */
	stop() {
		const tokens = [...this.#tokens.keys()];
		if (!tokens.length) return this.#queue(async () => {});
		for (const token of tokens.slice(0, -1)) this.#tokens.delete(token);
		this.#expire(tokens.at(-1));
		return this.#queue(async () => {});
	}

	/** Live tokens, for tests. */
	get size() {
		return this.#tokens.size;
	}

	/** The local port the files are served on (null until first used). */
	get port() {
		return this.#port;
	}

	close() {
		this.#tokens.clear();
		this.#server?.close();
	}

	#queue(fn) {
		const next = this.#serial.then(fn, fn);
		this.#serial = next.catch(() => {});
		return next;
	}

	#expire(token) {
		if (!this.#tokens.delete(token) || this.#tokens.size) return;
		// The last link died: close the public window now rather than when the share runs out.
		this.#queue(async () => {
			if (this.#tokens.size || !this.#base) return;
			this.#base = null;
			try {
				await this.#preview.unshare(this.#port);
				await this.#preview.unforward(this.#port);
			} catch {}
		});
	}

	async #listen() {
		if (this.#server) return;
		this.#server = http.createServer((req, res) => this.#serve(req, res).catch(() => res.destroy()));
		await new Promise((resolve, reject) => {
			this.#server.once('error', reject);
			this.#server.listen(0, '127.0.0.1', resolve);
		});
		this.#port = this.#server.address().port;
	}

	async #serve(req, res) {
		const m = /^\/([0-9a-f]{48})\/(manifest\.plist|app\.ipa)$/.exec(req.url.split('?')[0]);
		const link = m && this.#tokens.get(m[1]);
		if (!link || (req.method !== 'GET' && req.method !== 'HEAD')) {
			res.writeHead(404).end();
			return;
		}
		if (m[2] === 'manifest.plist') {
			const body = Buffer.from(link.manifest);
			res.writeHead(200, { 'content-type': 'text/xml', 'content-length': body.length, 'cache-control': 'no-store' });
			res.end(req.method === 'HEAD' ? undefined : body);
			return;
		}
		const { size } = await fs.stat(link.ipa);
		res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'cache-control': 'no-store' });
		if (req.method === 'HEAD') return res.end();
		await pipeline(createReadStream(link.ipa), res);
		// Downloaded in full: the link has done its job.
		this.#expire(m[1]);
	}
}
