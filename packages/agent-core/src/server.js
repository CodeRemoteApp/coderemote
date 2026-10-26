import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { PROTOCOL_VERSION, PAIRING_SCHEME, Routes, TERMINAL_WS_PATH, TUNNEL_AUTH_CALLBACK_HOST, TUNNEL_HANDOFF_PATH } from '@vsremote/protocol';
import { WebSocketServer } from 'ws';
import * as Git from './git.js';
import { TunnelHandoff } from './handoff.js';
import { LANDING_HTML } from './landing.js';
import { killListener, listPorts } from './ports.js';
import { HttpError, Sandbox } from './sandbox.js';
import { SessionManager } from './sessions.js';

function kindOf(stat) {
	if (stat.isDirectory()) return 'dir';
	if (stat.isFile()) return 'file';
	if (stat.isSymbolicLink()) return 'symlink';
	return 'other';
}

async function describe(fullPath, name) {
	const lst = await fs.lstat(fullPath);
	const entry = { name, type: kindOf(lst), size: lst.size, mtime: lst.mtimeMs };
	if (lst.isSymbolicLink()) {
		// Resolve the target so the client can navigate into linked folders.
		try {
			entry.target = kindOf(await fs.stat(fullPath));
		} catch {
			entry.target = 'broken';
		}
	}
	return entry;
}

function sendJson(res, status, body) {
	const json = JSON.stringify(body);
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
	res.end(json);
}

async function readJson(req) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
	} catch {
		throw new HttpError(400, 'invalid json');
	}
}

/**
 * @param {object} opts
 * @param {string} opts.token  bearer token every request must carry
 * @param {string} opts.root   folder the agent shares; file access never leaves it
 * @param {() => Promise<{token: string, expiresAt: number} | null>} [opts.tunnelToken]
 *        mints a dev tunnels connect token; resolves null (or is absent) for anonymous tunnels
 */
export function createAgentServer({ token, root, tunnelToken = async () => null }) {
	const handoff = new TunnelHandoff({ token, mint: tunnelToken });
	const sandbox = new Sandbox(root);
	const sessions = new SessionManager();
	const expected = Buffer.from(`Bearer ${token}`);

	function authorized(req) {
		const got = Buffer.from(req.headers.authorization || '');
		return got.length === expected.length && timingSafeEqual(got, expected);
	}

	/** Shell pid -> terminal session id, to tell which listeners were started from the app. */
	function shellPids() {
		return new Map(sessions.list().map((s) => [s.pid, s.id]));
	}

	/** A repository inside the shared folder. */
	async function repoOf(p) {
		const repo = await sandbox.resolve(p);
		try {
			await fs.access(path.join(repo, '.git'));
		} catch {
			throw new HttpError(400, 'not a git repository');
		}
		return repo;
	}

	/** Paths relative to `repo`, each checked to stay inside it (deleted files may not exist). */
	async function filesIn(repo, files) {
		if (!Array.isArray(files) || !files.length || files.some((f) => typeof f !== 'string' || !f || path.isAbsolute(f))) {
			throw new HttpError(400, 'files must be a non-empty list of paths relative to the repository');
		}
		return Promise.all(
			files.map(async (f) => {
				const abs = await sandbox.resolve(path.join(repo, f), { allowMissing: true });
				const rel = path.relative(repo, abs);
				if (!rel || rel.startsWith('..')) throw new HttpError(403, 'path is outside the repository');
				return rel;
			}),
		);
	}

	const routes = {
		[Routes.info]: async () => ({
			protocol: PROTOCOL_VERSION,
			hostname: os.hostname(),
			platform: os.platform(),
			root: sandbox.root,
			user: os.userInfo().username,
			shell: process.env.SHELL || null,
		}),

		[Routes.fsList]: async (url) => {
			const dir = await sandbox.resolve(url.searchParams.get('path'));
			const names = await fs.readdir(dir);
			const entries = (
				await Promise.all(names.map((n) => describe(path.join(dir, n), n).catch(() => null)))
			).filter(Boolean);
			return { path: dir, entries };
		},

		[Routes.fsStat]: async (url) => {
			const p = await sandbox.resolve(url.searchParams.get('path'));
			return { path: p, ...(await describe(p, path.basename(p))) };
		},

		[Routes.fsRead]: async (url, req, res) => {
			const p = await sandbox.resolve(url.searchParams.get('path'));
			const stat = await fs.stat(p);
			if (!stat.isFile()) throw new HttpError(400, 'not a file');
			res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': stat.size });
			await pipeline(createReadStream(p), res);
		},

		[Routes.fsWrite]: async (url, req) => {
			const p = await sandbox.resolveChild(url.searchParams.get('path'), { allowMissing: true });
			// Write to a temp file first so a dropped mobile connection never truncates the original.
			const tmp = `${p}.vsremote-${process.pid}-${Date.now()}.tmp`;
			try {
				await pipeline(req, createWriteStream(tmp));
				await fs.rename(tmp, p);
			} catch (e) {
				await fs.rm(tmp, { force: true });
				throw e;
			}
			return describe(p, path.basename(p));
		},

		[Routes.fsMkdir]: async (url) => {
			await fs.mkdir(await sandbox.resolve(url.searchParams.get('path'), { allowMissing: true }), { recursive: true });
			return {};
		},

		[Routes.fsRename]: async (url, req) => {
			const { from, to } = await readJson(req);
			await fs.rename(await sandbox.resolveChild(from), await sandbox.resolveChild(to, { allowMissing: true }));
			return {};
		},

		[Routes.fsDelete]: async (url) => {
			await fs.rm(await sandbox.resolveChild(url.searchParams.get('path')), { recursive: true });
			return {};
		},

		[Routes.gitRepos]: async () => ({ repos: await Git.findRepos(sandbox.root) }),

		[Routes.gitStatus]: async (url) => Git.status(await repoOf(url.searchParams.get('repo'))),

		[Routes.gitDiff]: async (url) => {
			const repo = await repoOf(url.searchParams.get('repo'));
			const [file] = await filesIn(repo, [url.searchParams.get('path')]);
			return Git.diff(repo, file, {
				staged: url.searchParams.get('staged') === '1',
				untracked: url.searchParams.get('untracked') === '1',
			});
		},

		[Routes.gitStage]: async (url, req) => {
			const { repo: r, files } = await readJson(req);
			const repo = await repoOf(r);
			await Git.stage(repo, await filesIn(repo, files));
			return Git.status(repo);
		},

		[Routes.gitUnstage]: async (url, req) => {
			const { repo: r, files } = await readJson(req);
			const repo = await repoOf(r);
			await Git.unstage(repo, await filesIn(repo, files));
			return Git.status(repo);
		},

		[Routes.gitDiscard]: async (url, req) => {
			const { repo: r, files } = await readJson(req);
			const repo = await repoOf(r);
			await Git.discard(repo, await filesIn(repo, files));
			return Git.status(repo);
		},

		[Routes.gitCommit]: async (url, req) => {
			const { repo: r, message } = await readJson(req);
			return Git.commit(await repoOf(r), message);
		},

		[Routes.gitLog]: async (url) => ({
			commits: await Git.log(await repoOf(url.searchParams.get('repo')), parseInt(url.searchParams.get('limit'), 10) || 50),
		}),

		[Routes.gitShow]: async (url) => Git.show(await repoOf(url.searchParams.get('repo')), url.searchParams.get('commit')),

		[Routes.gitPull]: async (url, req) => ({ output: await Git.pull(await repoOf((await readJson(req)).repo)) }),

		[Routes.gitPush]: async (url, req) => ({ output: await Git.push(await repoOf((await readJson(req)).repo)) }),

		[Routes.termList]: async () => ({ sessions: sessions.list() }),

		[Routes.portsList]: async () => ({ ports: await listPorts(shellPids()) }),

		[Routes.portsKill]: async (url, req) => {
			const { pid, force } = await readJson(req);
			await killListener(pid, { force: force === true, shells: shellPids() });
			return {};
		},

		[Routes.tunnelToken]: async () => {
			const issued = await handoff.issue();
			if (!issued) throw new HttpError(404, 'this tunnel is anonymous');
			return issued;
		},

		[Routes.termKill]: async (url) => {
			const s = sessions.get(url.searchParams.get('id'));
			if (!s) throw new HttpError(404, 'no such session');
			s.kill();
			return {};
		},
	};

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, 'http://localhost');
		if (req.method === 'GET' && url.pathname === '/') {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
			});
			return res.end(LANDING_HTML);
		}
		if (req.method === 'GET' && url.pathname === TUNNEL_HANDOFF_PATH) return handoffRedirect(url, res);
		if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
		const handler = routes[`${req.method} ${url.pathname}`];
		if (!handler) return sendJson(res, 404, { error: 'not found' });
		try {
			const body = await handler(url, req, res);
			if (body !== undefined) sendJson(res, 200, body);
		} catch (e) {
			const status = e.status || (e.code === 'ENOENT' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 500);
			if (!res.headersSent) sendJson(res, status, { error: e.message, code: e.code });
			else res.destroy(e);
		}
	});

	/** Reached only after the relay's sign-in; the HMAC proves the caller also has the pairing token. */
	async function handoffRedirect(url, res) {
		const state = url.searchParams.get('state') || '';
		if (!/^[A-Za-z0-9_-]{8,128}$/.test(state) || !handoff.verify(url.searchParams.get('nonce'), url.searchParams.get('sig'))) {
			return sendJson(res, 403, { error: 'invalid or expired sign-in link' });
		}
		let issued;
		try {
			issued = await handoff.issue();
		} catch (e) {
			return sendJson(res, 502, { error: `could not issue a tunnel token: ${e.message}` });
		}
		if (!issued) return sendJson(res, 404, { error: 'this tunnel is anonymous' });
		const target = new URL(`${PAIRING_SCHEME}://${TUNNEL_AUTH_CALLBACK_HOST}`);
		target.searchParams.set('token', issued.token);
		target.searchParams.set('expires', String(issued.expiresAt));
		target.searchParams.set('state', state);
		res.writeHead(302, { location: target.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
		res.end();
	}

	// Terminal: GET TERMINAL_WS_PATH?id=<session>&cols=&rows=&cwd=
	// Omitting id creates a new session; passing one reattaches and replays scrollback.
	const wss = new WebSocketServer({ noServer: true });
	server.on('upgrade', async (req, socket, head) => {
		const url = new URL(req.url, 'http://localhost');
		if (url.pathname !== TERMINAL_WS_PATH || !authorized(req)) {
			socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
			return;
		}
		const id = url.searchParams.get('id');
		let session;
		if (id) {
			session = sessions.get(id);
			if (!session) {
				socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
				return;
			}
		} else {
			try {
				session = sessions.create({
					cols: parseInt(url.searchParams.get('cols'), 10) || 80,
					rows: parseInt(url.searchParams.get('rows'), 10) || 24,
					// New shells start in the shared folder unless a subfolder is asked for.
					cwd: await sandbox.resolve(url.searchParams.get('cwd') || sandbox.root),
				});
			} catch (e) {
				socket.end(`HTTP/1.1 ${e.status || (e.code === 'ENOENT' ? 404 : 500)} Error\r\n\r\n`);
				return;
			}
		}
		wss.handleUpgrade(req, socket, head, (ws) => session.attach(ws));
	});

	server.on('close', () => sessions.killAll());
	// server.close() waits for open sockets; callers shutting down kill shells right away.
	server.killAllSessions = () => sessions.killAll();
	return server;
}
