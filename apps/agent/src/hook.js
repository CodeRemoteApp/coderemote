// `coderemote hook`: run by Claude Code for each hook event (via the Code Remote plugin). It
// hands the event to the agent sharing the session's folder and, for a PermissionRequest,
// prints the decision the phone made. It must never get in Claude Code's way: whatever goes
// wrong, it prints nothing and exits 0, which leaves Claude Code as if no hook ran.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { HOOK_SECRET_HEADER } from '@vsremote/protocol';

const CONNECT_TIMEOUT = 1000;
// Everything but a PermissionRequest answers right away; don't linger if an agent hangs.
const EVENT_TIMEOUT = 5000;

/** The machine-local secret hook deliveries carry, created on first use (readable only by us). */
export function ensureHookSecret(dir) {
	const file = path.join(dir, 'hook-secret');
	try {
		const secret = fs.readFileSync(file, 'utf8').trim();
		if (secret) return secret;
	} catch {}
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const secret = randomBytes(32).toString('base64url');
	fs.writeFileSync(file, secret, { mode: 0o600 });
	return secret;
}

/**
 * Writes `<dir>/bin/hook`, which runs this CLI's `hook` with this Node. Codex gives plugin hooks
 * a bare environment (no CODEREMOTE_* variables, its own PATH), so its plugin finds the CLI here.
 * Windows can't run that shell script; the plugin's Node script there reads `<dir>/bin/hook.json`.
 */
export function writeHookLauncher(dir, { node = process.execPath, script }) {
	const bin = path.join(dir, 'bin');
	fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
	const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
	const file = path.join(bin, 'hook');
	fs.writeFileSync(file, `#!/bin/sh\nexec ${quote(node)} ${quote(script)} hook "$@"\n`, { mode: 0o755 });
	fs.chmodSync(file, 0o755);
	fs.writeFileSync(path.join(bin, 'hook.json'), JSON.stringify({ node, script }), { mode: 0o600 });
	return file;
}

export function readHookSecret(dir) {
	try {
		return fs.readFileSync(path.join(dir, 'hook-secret'), 'utf8').trim() || null;
	} catch {
		return null;
	}
}

function real(p) {
	try {
		// Native, so both sides lose Windows 8.3 short names (C:\Users\JOHNSM~1) and match.
		return fs.realpathSync.native(p);
	} catch {
		return path.resolve(p);
	}
}

const within = (dir, root) => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * Which running agent takes an event: the one whose terminal the session runs in, else the one
 * whose shared folder holds the session's working directory most closely, else none.
 * @returns {{ port: number, terminal: string | null } | null}
 */
export function hookTarget(agents, cwd, env = process.env) {
	const port = parseInt(env.CODEREMOTE_AGENT_PORT, 10);
	if (port && agents.some((a) => a.port === port)) return { port, terminal: env.CODEREMOTE_TERM_ID || null };
	if (typeof cwd !== 'string' || !cwd) return null;
	const dir = real(cwd);
	const match = agents
		.map((a) => ({ ...a, real: real(a.root) }))
		.filter((a) => within(dir, a.real))
		.sort((a, b) => b.real.length - a.real.length)[0];
	return match ? { port: match.port, terminal: null } : null;
}

// Events that tell the agent which app a session runs in: enough to know it before anything is
// pushed about the session, without walking the process tree for every tool call.
const HOST_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PermissionRequest']);

/**
 * The app bundle among `pid`'s ancestors in `ps -A -o pid=,ppid=,comm=` output: the outermost
 * `.app` of the first ancestor inside one (`/Applications/Visual Studio Code.app` for its helpers).
 */
export function hostAppFrom(psOutput, pid) {
	const parents = new Map();
	for (const line of psOutput.split('\n')) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
		if (m) parents.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
	}
	for (let seen = 0, p = parents.get(pid); p && seen < 64; seen++, p = parents.get(p.ppid)) {
		const at = p.comm.indexOf('.app/');
		if (at > 0) return p.comm.slice(0, at + 4);
		if (p.ppid <= 1) break;
	}
	return null;
}

/** The macOS app this hook's coding agent runs in (iTerm, VS Code…); null elsewhere or unknown. */
function hostApp() {
	if (process.platform !== 'darwin') return Promise.resolve(null);
	return new Promise((resolve) => {
		execFile('ps', ['-A', '-o', 'pid=,ppid=,comm='], { timeout: 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
			resolve(err ? null : hostAppFrom(stdout, process.ppid));
		});
	});
}

/** POSTs the event to the agent; resolves with the response body, or '' on any failure. */
export function deliverHook({ port, terminal, app = null, agent, secret, body, wait }) {
	return new Promise((resolve) => {
		const query = new URLSearchParams({ agent });
		if (terminal) query.set('terminal', terminal);
		if (app) query.set('app', app);
		const req = http.request({
			host: '127.0.0.1',
			port,
			method: 'POST',
			path: `/api/agents/hook?${query}`,
			headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), [HOOK_SECRET_HEADER]: secret },
		});
		const fail = () => {
			req.destroy();
			resolve('');
		};
		const connect = setTimeout(fail, CONNECT_TIMEOUT);
		const overall = wait ? null : setTimeout(fail, EVENT_TIMEOUT);
		req.on('socket', (socket) => socket.once('connect', () => clearTimeout(connect)));
		req.on('error', () => resolve(''));
		req.on('response', (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => {
				clearTimeout(overall);
				resolve(res.statusCode === 200 ? Buffer.concat(chunks).toString('utf8') : '');
			});
			res.on('error', () => resolve(''));
		});
		req.end(body);
	});
}

/** The whole hook: what to print for Claude Code (usually nothing). */
export async function runHook({ input, agents, secret, agent = 'claude', env = process.env, findApp = hostApp }) {
	if (!secret) return '';
	let event;
	try {
		event = JSON.parse(input);
	} catch {
		return '';
	}
	const target = hookTarget(agents, event?.cwd, env);
	if (!target) return '';
	const wait = event.hook_event_name === 'PermissionRequest';
	// Sessions in the agent's own terminals are only seen on clients; the app matters elsewhere.
	const app = !target.terminal && HOST_EVENTS.has(event.hook_event_name) ? await findApp() : null;
	const out = await deliverHook({ ...target, app, agent, secret, body: input, wait });
	// Only a PermissionRequest decides anything; other events' `{}` would just be noise.
	return wait ? out.trim() : '';
}
