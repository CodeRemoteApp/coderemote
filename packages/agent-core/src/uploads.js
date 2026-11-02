// Files a client sends for coding-agent sessions (screenshots, recordings), kept outside the
// shared folder so they never end up in a repository: <dir>/<yyyy-mm-dd>/<id>-<name>.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { HttpError } from './sandbox.js';

const run = promisify(execFile);
export const UPLOAD_LIMIT = 100 * 1024 * 1024;
const KEEP = 7 * 24 * 60 * 60 * 1000;
const ID = /^[0-9a-f-]{36}$/;
// The images Claude Code takes, and what a prompt's images are told apart by.
export const IMAGE_EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

/** The media type of an image file Claude Code takes, by its name; null for anything else. */
export function imageType(file) {
	const ext = path.extname(String(file)).toLowerCase();
	if (ext === '.jpeg') return 'image/jpeg';
	return Object.keys(IMAGE_EXTENSIONS).find((t) => IMAGE_EXTENSIONS[t] === ext) ?? null;
}

/**
 * Files a client attached to a prompt, which reach Claude Code as their paths on lines of their
 * own (images it turns into `[Image #N]`; the rest stay paths). Returns the text without those
 * lines, and the uploads they name as `{ id, name, type }` (`type` from `typeOf(name)`).
 */
export function attachedFiles(text, dir, typeOf = () => 'application/octet-stream') {
	if (!dir || !text.includes(dir)) return { text, files: [] };
	const root = dir.endsWith(path.sep) ? dir : dir + path.sep;
	const files = [];
	const kept = [];
	for (const line of text.split('\n')) {
		const rest = line.trim().startsWith(root) ? line.trim().slice(root.length) : null;
		const m = rest && /^\d{4}-\d{2}-\d{2}[\\/]([0-9a-f-]{36})-(.+)$/.exec(rest);
		if (m) files.push({ id: m[1], name: m[2], type: typeOf(m[2]) });
		else kept.push(line);
	}
	return files.length ? { text: kept.join('\n').trim(), files } : { text, files };
}

/** A file name that is safe on disk and still recognisable: no paths, no odd characters. */
export function safeName(name) {
	const base = path.basename(String(name ?? '').replace(/\\/g, '/'));
	const clean = base.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^[.\s]+/, '').slice(-80).trim();
	return clean || 'file';
}

export class UploadStore {
	constructor(dir, { now = Date.now } = {}) {
		this.dir = dir;
		this.now = now;
	}

	/** Streams `body` to disk. 413 past `limit`; HEIC photos become JPEG on macOS. */
	async save(body, { name, type, length, limit = UPLOAD_LIMIT }) {
		if (Number(length) > limit) throw new HttpError(413, `files are limited to ${limit / 1024 / 1024} MB`);
		const id = randomUUID();
		const day = new Date(this.now()).toISOString().slice(0, 10);
		await fs.mkdir(path.join(this.dir, day), { recursive: true, mode: 0o700 });
		let file = path.join(this.dir, day, `${id}-${safeName(name)}`);
		let size = 0;
		const counter = new Transform({
			transform(chunk, _enc, done) {
				size += chunk.length;
				done(size > limit ? new HttpError(413, `files are limited to ${limit / 1024 / 1024} MB`) : null, chunk);
			},
		});
		try {
			await pipeline(body, counter, createWriteStream(file, { mode: 0o600 }));
		} catch (e) {
			await fs.rm(file, { force: true });
			throw e;
		}
		let kind = type || 'application/octet-stream';
		if ((kind === 'image/heic' || /\.heic$/i.test(file)) && os.platform() === 'darwin') {
			// Claude Code takes PNG, JPEG, GIF and WebP; iPhone photos are HEIC.
			const jpeg = file.replace(/(\.heic)?$/i, '.jpg');
			try {
				await run('sips', ['-s', 'format', 'jpeg', file, '--out', jpeg], { timeout: 30_000 });
				await fs.rm(file);
				file = jpeg;
				kind = 'image/jpeg';
				size = (await fs.stat(file)).size;
			} catch {}
		}
		return { id, name: path.basename(file).slice(id.length + 1), type: kind, size, path: file };
	}

	/** The file of an upload; 404 once it's gone (swept, or never existed). */
	async path(id) {
		if (typeof id !== 'string' || !ID.test(id)) throw new HttpError(400, 'invalid upload id');
		let days = [];
		try {
			days = (await fs.readdir(this.dir)).sort().reverse();
		} catch {}
		for (const day of days) {
			let names = [];
			try {
				names = await fs.readdir(path.join(this.dir, day));
			} catch {}
			const hit = names.find((n) => n.startsWith(`${id}-`));
			if (hit) return path.join(this.dir, day, hit);
		}
		throw new HttpError(404, 'no such upload (they are kept for 7 days)');
	}

	/**
	 * Keeps bytes the agent found itself (an image in a transcript) as an upload, named by their
	 * content so the same image read again is the same upload. Resolves `{ id, type }`.
	 */
	async keep(bytes, type) {
		const hash = createHash('sha256').update(bytes).digest('hex');
		const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
		const existing = await this.path(id).catch(() => null);
		if (existing) {
			// Read again: it stays as long as a fresh upload would.
			const now = new Date(this.now());
			await fs.utimes(existing, now, now).catch(() => {});
			return { id, type };
		}
		const day = new Date(this.now()).toISOString().slice(0, 10);
		await fs.mkdir(path.join(this.dir, day), { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(this.dir, day, `${id}-image${IMAGE_EXTENSIONS[type] ?? ''}`), bytes, { mode: 0o600 });
		return { id, type };
	}

	/** Deletes uploads older than a week. */
	async sweep() {
		let days = [];
		try {
			days = await fs.readdir(this.dir);
		} catch {
			return;
		}
		const cutoff = this.now() - KEEP;
		for (const day of days) {
			const dir = path.join(this.dir, day);
			let names = [];
			try {
				names = await fs.readdir(dir);
			} catch {
				continue;
			}
			for (const n of names) {
				const file = path.join(dir, n);
				const stat = await fs.stat(file).catch(() => null);
				if (stat && stat.mtimeMs < cutoff) await fs.rm(file, { force: true });
			}
			if (!(await fs.readdir(dir).catch(() => [])).length) await fs.rm(dir, { recursive: true, force: true });
		}
	}
}
