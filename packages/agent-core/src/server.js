import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
	AGENTS_WS_PATH,
	AgentsClientMessage,
	HOOK_SECRET_HEADER,
	PROTOCOL_VERSION,
	PAIRING_SCHEME,
	Routes,
	TERMINAL_WS_PATH,
	TUNNEL_AUTH_CALLBACK_HOST,
	TUNNEL_HANDOFF_PATH,
} from '@vsremote/protocol';
import { WebSocketServer } from 'ws';
import { AgentHub } from './agents.js';
import * as Git from './git.js';
import { TunnelHandoff } from './handoff.js';
import { LANDING_HTML } from './landing.js';
import { killListener, listPorts } from './ports.js';
import { PushSender, userActiveHere } from './push.js';
import { detail, InspectingProxy } from './inspector.js';
import { capture, commandExists, interactiveShell, isWindows } from './platform.js';
import { HttpError, Sandbox } from './sandbox.js';
import { SessionManager } from './sessions.js';
import { UploadStore } from './uploads.js';

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

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
// Keystrokes a client may send to a session, by name; anything else goes through the terminal.
const KEYS = { interrupt: '\x1b', cycle_mode: '\x1b[Z' };
const COMMANDS = ['/compact', '/clear', '/model'];

/** Text without control characters (an ESC could end the paste early), newlines and tabs kept. */
function typeable(text) {
	return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// Permission modes a session started from the phone may begin in; skipping prompts entirely is
// for the computer to choose.
const LAUNCH_MODES = ['manual', 'acceptEdits', 'plan', 'auto'];

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
 * @param {object | null} [opts.preview]  forwards local ports to a tunnel for previews
 *        (`list()`, `forward(port)`, `unforward(port)`, `share(port, hours)`, `unshare(port)`,
 *        `token()`); absent without a tunnel
 * @param {() => Promise<object | null>} [opts.tunnelStatus]  the tunnel and the account's other
 *        machines, for `GET /api/tunnel`; absent without a tunnel
 * @param {string | null} [opts.hookSecret]  authenticates `coderemote hook` deliveries; without
 *        one the agent takes no hook events
 * @param {string | null} [opts.hookBin]  the CLI that runs `hook`, handed to terminals so a coding
 *        agent started in one reports through this agent's own version, whatever is on PATH
 * @param {string | null} [opts.uploadsDir]  where files sent from the phone go; sessions started
 *        here may read it without asking
 * @param {string} [opts.claudeCommand]  the Claude Code executable that sessions started here run
 * @param {string} [opts.codexCommand]  the Codex executable that sessions started here run
 * @param {string} [opts.codexHome]  Codex's own folder, where it caches the models it offers
 * @param {(agent: string) => Promise<boolean>} [opts.pluginInstalled]  whether that coding agent
 *        has the Code Remote plugin (default: asks its `plugin list`)
 * @param {AgentHub} [opts.agents]  coding-agent sessions (one is made when absent)
 * @param {{ load: () => object[], save: (devices: object[]) => void } | null} [opts.pushStore]
 *        keeps push registrations across restarts; without it they last until the agent stops
 * @param {object} [opts.pushOptions]  passed to PushSender (tests stub the relay and presence)
 */
export function createAgentServer({
	token,
	root,
	tunnelToken = async () => null,
	preview = null,
	tunnelStatus = null,
	hookSecret = null,
	hookBin = null,
	uploadsDir = null,
	claudeCommand = 'claude',
	codexCommand = 'codex',
	codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
	pluginInstalled = null,
	agents = new AgentHub(),
	pushStore = null,
	pushOptions = {},
}) {
	const handoff = new TunnelHandoff({ token, mint: tunnelToken });
	const sandbox = new Sandbox(root);
	const sessions = new SessionManager({ onExit: (id) => agents.terminalExited(id) });
	const expected = Buffer.from(`Bearer ${token}`);
	const uploads = uploadsDir ? new UploadStore(uploadsDir) : null;
	const sweep = setInterval(() => {
		agents.sweep();
		uploads?.sweep().catch(() => {});
	}, 10 * 60 * 1000);
	sweep.unref();
	// When a client last said it shows this machine; pushes wait while that is recent.
	let foregroundAt = 0;
	const clientInForeground = () => Date.now() - foregroundAt < 30_000;
	const push = new PushSender({ hub: agents, store: pushStore, foreground: clientInForeground, ...pushOptions });
	// Agents whose approvals block the terminal (Codex) ask there while someone uses the computer,
	// unless a client shows this machine: then the person is on the phone and answers there.
	if (!agents.presenceSet) {
		agents.present = async () => !clientInForeground() && (await (pushOptions.userActive ?? userActiveHere)());
	}

	function authorized(req) {
		const got = Buffer.from(req.headers.authorization || '');
		return got.length === expected.length && timingSafeEqual(got, expected);
	}

	/** What terminals add to the environment, so coding agents in them reach this agent. */
	function terminalEnv() {
		return {
			CODEREMOTE_AGENT_PORT: String(server.address()?.port ?? ''),
			...(hookBin ? { CODEREMOTE_HOOK_BIN: hookBin } : {}),
		};
	}

	/**
	 * The terminal a session runs in, to type into. 404 for an unknown session, 409 when it has no
	 * terminal here (started elsewhere), has ended, or (unless `whileWaiting`) waits on a request,
	 * whose dialog would take the keystrokes.
	 */
	function typingTarget(id, { whileWaiting }) {
		const session = typeof id === 'string' ? agents.session(id) : null;
		// (The keys a session takes depend on its agent; see `capabilities.keys`.)
		if (!session) throw new HttpError(404, 'no such session');
		const term = session.terminal && session.state !== 'ended' ? sessions.get(session.terminal) : null;
		if (!term) throw new HttpError(409, 'this session runs outside Code Remote; it can be followed but not typed into');
		if (!whileWaiting && session.state === 'waiting') throw new HttpError(409, 'answer the pending request first');
		return { session, term };
	}

	/** Pastes `text` as one block, then presses Enter once the TUI has taken the paste in. */
	async function typeInto(term, text) {
		term.write(`${PASTE_START}${text}${PASTE_END}`);
		await new Promise((r) => setTimeout(r, 300));
		term.write('\r');
	}

	function uploadPath(id) {
		if (!uploads) throw new HttpError(400, 'this agent takes no uploads');
		return uploads.path(id);
	}

	/** Absolute paths of uploaded files, by upload id (see Uploads). */
	async function attachmentPaths(ids) {
		if (ids === undefined) return [];
		if (!Array.isArray(ids) || ids.some((a) => typeof a !== 'string')) throw new HttpError(400, 'attachments must be upload ids');
		return Promise.all(ids.map((a) => uploadPath(a)));
	}

	/**
	 * How to start each coding agent, and how to tell its plugin is installed. Claude Code takes the
	 * session id up front; Codex reports its own, which replaces the placeholder.
	 */
	const launchers = {
		claude: {
			command: claudeCommand,
			name: 'Claude Code',
			args: ({ id, resume, model, permissionMode }) => [
				...(resume ? ['--resume', resume] : ['--session-id', id]),
				...(model ? ['--model', model] : []),
				...(permissionMode ? ['--permission-mode', permissionMode] : []),
				...(uploadsDir ? ['--add-dir', uploadsDir] : []),
			],
			// Fullscreen rendering can fail to start while no client is attached to answer the
			// terminal's queries; the classic renderer doesn't need them.
			env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' },
			async plugin() {
				const list = JSON.parse((await capture([claudeCommand, 'plugin', 'list', '--json'])) ?? '[]');
				return list.some((p) => p.id === 'coderemote@coderemote' && p.enabled !== false);
			},
			missingPlugin: 'Claude Code needs the Code Remote plugin first: run `coderemote setup claude` once on the computer.',
		},
		codex: {
			command: codexCommand,
			name: 'Codex',
			// Codex's sandbox reads anywhere already; --add-dir would make the uploads writable.
			// Without -a, recent Codex rejects every escalation outright ("granular" policy), so a
			// session started here asks, and its requests reach the phone or the terminal.
			args: ({ resume, model, approvalPolicy }) => [
				...(resume ? ['resume', resume] : []),
				...(model ? ['-m', model] : []),
				...(approvalPolicy ? ['-a', approvalPolicy] : []),
			],
			env: {},
			async plugin() {
				// Plugin listings run long (Codex's lists every marketplace's plugins without a filter).
				const list = JSON.parse((await capture([codexCommand, 'plugin', 'list', '--marketplace', 'coderemote', '--json'])) ?? '{}');
				return (list.installed ?? []).some((p) => p.pluginId === 'coderemote@coderemote' && p.enabled !== false);
			},
			missingPlugin: 'Codex needs the Code Remote plugin first: run `coderemote setup codex` once on the computer, then trust its hooks with `/hooks` in Codex.',
		},
	};

	/** Whether that agent's command runs here, looked up the way the session will start it. */
	function installed(agent) {
		return commandExists(launchers[agent].command);
	}

	// Whether each agent has the plugin; asking takes a second or two, so the answer is kept a
	// while. Any hook event from that agent proves it.
	const plugins = {};
	async function hasPlugin(agent) {
		const known = plugins[agent];
		if (known && Date.now() - known.checkedAt < 30_000) return known.installed;
		let found = false;
		try {
			found = pluginInstalled ? await pluginInstalled(agent) : await launchers[agent].plugin();
		} catch {}
		plugins[agent] = { installed: found, checkedAt: Date.now() };
		return found;
	}

	/** The models Codex's own picker lists, from the cache it keeps of them; empty when there is none. */
	async function codexModels() {
		try {
			const { models } = JSON.parse(await fs.readFile(path.join(codexHome, 'models_cache.json'), 'utf8'));
			return models
				.filter((m) => m.visibility === 'list' && typeof m.slug === 'string')
				.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
				.map((m) => ({ id: m.slug, name: m.display_name || m.slug, description: m.description ?? '' }));
		} catch {
			return [];
		}
	}

	function hookAuthorized(req) {
		if (!hookSecret) return false;
		const got = Buffer.from(String(req.headers[HOOK_SECRET_HEADER] || ''));
		const want = Buffer.from(hookSecret);
		return got.length === want.length && timingSafeEqual(got, want);
	}

	function previewPort(value, ownPort) {
		if (!preview) throw new HttpError(404, 'previews need a tunnel');
		const port = Number(value);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'port must be 1-65535');
		if (port === ownPort) throw new HttpError(400, "the agent's own port is already on its tunnel");
		if ([...proxies.values()].some((p) => p.port === port)) throw new HttpError(400, 'that port is a preview proxy');
		return port;
	}

	// Dev server port -> the proxy that records its traffic. The preview tunnel forwards the
	// proxy's port; clients only ever see the dev server's.
	const proxies = new Map();

	/** The proxy of a port that is being previewed right now. */
	function previewed(port) {
		const proxy = proxies.get(port);
		if (!proxy || !preview.list().some((p) => p.port === proxy.port)) {
			throw new HttpError(404, 'that port is not being previewed');
		}
		return proxy;
	}

	/** The proxy of a port previewed at some point since the agent started (its log outlives it). */
	function inspected(value) {
		const proxy = proxies.get(previewPort(value, server.address()?.port));
		if (!proxy) throw new HttpError(404, 'that port has not been previewed');
		return proxy;
	}

	/** Forwarded ports plus the connect token that opens them (null before the first one). */
	async function previews() {
		const issued = await preview.token();
		const forwarded = new Map(preview.list().map((p) => [p.port, p]));
		const ports = [];
		for (const [port, proxy] of proxies) {
			const p = forwarded.get(proxy.port);
			if (p) ports.push({ ...p, port });
		}
		ports.sort((a, b) => a.port - b.port);
		return { ports, token: issued?.token ?? null, expiresAt: issued?.expiresAt ?? null };
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
			// On Windows, terminals run PowerShell whatever $SHELL (Git Bash sets one) says.
			shell: isWindows ? interactiveShell().file : process.env.SHELL || null,
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

		[Routes.previewList]: async () => {
			if (!preview) throw new HttpError(404, 'previews need a tunnel');
			return previews();
		},

		[Routes.previewOpen]: async (url, req) => {
			const port = previewPort((await readJson(req)).port, server.address()?.port);
			let proxy = proxies.get(port);
			if (!proxy) {
				proxy = new InspectingProxy(port);
				await proxy.listen();
				proxies.set(port, proxy);
			}
			try {
				await preview.forward(proxy.port);
			} catch (e) {
				throw new HttpError(502, e.message);
			}
			return previews();
		},

		[Routes.previewClose]: async (url) => {
			const port = previewPort(url.searchParams.get('port'), server.address()?.port);
			const proxy = proxies.get(port);
			// The proxy keeps running so its log can still be read; the tunnel no longer reaches it.
			if (proxy) await preview.unforward(proxy.port);
			return previews();
		},

		[Routes.previewShare]: async (url, req) => {
			const { port: value, hours } = await readJson(req);
			const proxy = previewed(previewPort(value, server.address()?.port));
			// Dev tunnels access entries last 1 hour to 30 days.
			if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new HttpError(400, 'hours must be 1-720');
			try {
				await preview.share(proxy.port, hours);
			} catch (e) {
				throw new HttpError(502, e.message);
			}
			return previews();
		},

		[Routes.previewUnshare]: async (url) => {
			const proxy = proxies.get(previewPort(url.searchParams.get('port'), server.address()?.port));
			try {
				if (proxy) await preview.unshare(proxy.port);
			} catch (e) {
				throw new HttpError(502, e.message);
			}
			return previews();
		},

		[Routes.previewRequests]: async (url) => ({
			requests: inspected(url.searchParams.get('port')).list(parseInt(url.searchParams.get('after'), 10) || 0),
		}),

		[Routes.previewRequest]: async (url) => {
			const entry = inspected(url.searchParams.get('port')).get(parseInt(url.searchParams.get('id'), 10));
			if (!entry) throw new HttpError(404, 'no such request (only the latest 200 are kept)');
			return detail(entry);
		},

		[Routes.previewRequestsClear]: async (url) => {
			inspected(url.searchParams.get('port')).clear();
			return {};
		},

		[Routes.tunnelStatus]: async () => {
			const status = await tunnelStatus?.();
			if (!status) throw new HttpError(404, 'this agent runs without a tunnel');
			return status;
		},

		[Routes.tunnelToken]: async () => {
			const issued = await handoff.issue();
			if (!issued) throw new HttpError(404, 'this tunnel is anonymous');
			return issued;
		},

		[Routes.agentsSessions]: async () => ({ sessions: agents.sessions() }),

		[Routes.agentsTimeline]: async (url) =>
			agents.timeline(url.searchParams.get('session'), parseInt(url.searchParams.get('after'), 10) || 0),

		[Routes.agentsSetup]: async () => {
			const [claude, codex] = await Promise.all([installed('claude'), installed('codex')]);
			const [plugin, codexPlugin] = await Promise.all([claude && hasPlugin('claude'), codex && hasPlugin('codex')]);
			return { claude, plugin: Boolean(plugin), codex, codexPlugin: Boolean(codexPlugin), codexModels: codex ? await codexModels() : [] };
		},

		[Routes.agentsLaunch]: async (url, req) => {
			const { agent = 'claude', cwd, model, permissionMode, approvalPolicy, resume, cols, rows } = await readJson(req);
			if (approvalPolicy !== undefined && !['on-request', 'never'].includes(approvalPolicy)) {
				throw new HttpError(400, 'approvalPolicy must be on-request or never');
			}
			if (!Object.hasOwn(launchers, agent)) throw new HttpError(400, `agent must be one of ${Object.keys(launchers).join(', ')}`);
			const launcher = launchers[agent];
			let dir;
			try {
				dir = await sandbox.resolve(cwd || sandbox.root);
			} catch (e) {
				throw new HttpError(400, e.message);
			}
			if (!(await fs.stat(dir)).isDirectory()) throw new HttpError(400, 'cwd must be a folder');
			if (model !== undefined && (typeof model !== 'string' || !/^[A-Za-z0-9._[\]-]{1,80}$/.test(model))) {
				throw new HttpError(400, 'invalid model');
			}
			if (permissionMode !== undefined && !LAUNCH_MODES.includes(permissionMode)) {
				throw new HttpError(400, `permissionMode must be one of ${LAUNCH_MODES.join(', ')}`);
			}
			if (resume !== undefined && (typeof resume !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(resume))) {
				throw new HttpError(400, 'resume must be a session id');
			}
			if (resume && !agents.canResume(resume)) {
				throw new HttpError(409, 'that session is still open; continue it where it runs, or end it first');
			}
			if (!(await installed(agent))) {
				throw Object.assign(new HttpError(400, `${launcher.name} is not installed on this computer (no \`${launcher.command}\` command).`), {
					code: agent === 'claude' ? 'ENOCLAUDE' : 'ENOAGENT',
				});
			}
			// Without the plugin the session would run but never show up here.
			if (!(await hasPlugin(agent))) {
				throw Object.assign(new HttpError(400, launcher.missingPlugin), { code: 'ENOPLUGIN' });
			}
			const id = resume ?? randomUUID();
			if (uploadsDir) await fs.mkdir(uploadsDir, { recursive: true, mode: 0o700 });
			const argv = [
				launcher.command,
				...launcher.args({
					id,
					resume,
					model,
					permissionMode: agent === 'claude' ? permissionMode : undefined,
					approvalPolicy: agent === 'codex' ? (approvalPolicy ?? 'on-request') : undefined,
				}),
			];
			const term = sessions.create({
				cols: Number.isInteger(cols) && cols > 0 ? cols : 80,
				rows: Number.isInteger(rows) && rows > 0 ? rows : 24,
				cwd: dir,
				env: { ...terminalEnv(), ...launcher.env },
				command: argv,
			});
			return { terminal: term.id, session: agents.launched({ id, terminal: term.id, cwd: dir, agent }) };
		},

		[Routes.agentsPrompt]: async (url, req) => {
			const { session: id, text, attachments } = await readJson(req);
			if (typeof text !== 'string' || !text.trim() || text.length > 100_000) {
				throw new HttpError(400, 'text must be a non-empty string');
			}
			const { term } = typingTarget(id, { whileWaiting: false });
			const paths = await attachmentPaths(attachments);
			const typed = typeable([text.trim(), ...paths].join('\n'));
			const prompt = randomUUID();
			agents.prompted(id, { id: prompt, text: typed, paths });
			await typeInto(term, typed);
			return { prompt };
		},

		[Routes.agentsUpload]: async (url, req) => {
			if (!uploads) throw new HttpError(404, 'this agent takes no uploads');
			let name = req.headers['x-filename'];
			try {
				name = decodeURIComponent(name ?? '');
			} catch {}
			const { id, name: saved, type, size } = await uploads.save(req, {
				name,
				type: req.headers['content-type'],
				length: req.headers['content-length'],
			});
			return { id, name: saved, type, size };
		},

		[Routes.agentsKeys]: async (url, req) => {
			const { session: id, action, command } = await readJson(req);
			const allowed = agents.session(typeof id === 'string' ? id : '')?.capabilities?.keys;
			if (allowed && !allowed.includes(action === 'command' ? command : action)) {
				throw new HttpError(400, `this session takes ${allowed.join(', ')}`);
			}
			if (action === 'command') {
				if (!COMMANDS.includes(command)) throw new HttpError(400, `command must be one of ${COMMANDS.join(', ')}`);
				await typeInto(typingTarget(id, { whileWaiting: false }).term, command);
			} else if (Object.hasOwn(KEYS, action)) {
				typingTarget(id, { whileWaiting: true }).term.write(KEYS[action]);
			} else {
				throw new HttpError(400, `action must be one of ${[...Object.keys(KEYS), 'command'].join(', ')}`);
			}
			return {};
		},

		[Routes.agentsStop]: async (url, req) => {
			const { session: id } = await readJson(req);
			const { term } = typingTarget(id, { whileWaiting: true });
			// Closing the terminal hangs up on the agent; one that ignores it is killed.
			term.kill();
			setTimeout(() => {
				if (term.exitCode === null) term.kill('SIGKILL');
			}, 3000).unref();
			return {};
		},

		[Routes.agentsForget]: async (url, req) => {
			const { session: id } = await readJson(req);
			const session = typeof id === 'string' ? agents.session(id) : null;
			if (!session) throw new HttpError(404, 'no such session');
			if (session.state !== 'ended' && session.terminal && sessions.get(session.terminal)) {
				throw new HttpError(409, 'this session still runs here; stop it first');
			}
			agents.forget(id);
			return {};
		},

		[Routes.agentsAnswer]: async (url, req) => {
			agents.answer(await readJson(req));
			return {};
		},

		[Routes.pushDeviceSet]: async (url, req) => {
			push.register(await readJson(req));
			return {};
		},

		[Routes.pushDeviceDelete]: async (url) => {
			push.unregister(url.searchParams.get('token') ?? '');
			return {};
		},

		[Routes.pushTest]: async (url, req) => {
			await push.test((await readJson(req)).token);
			return {};
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
		if (`${req.method} ${url.pathname}` === Routes.agentsHook) return hookDelivery(url, req, res);
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

	/** A hook event from `coderemote hook`; a PermissionRequest is held open until it resolves. */
	async function hookDelivery(url, req, res) {
		if (!hookAuthorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
		plugins[url.searchParams.get('agent') || 'claude'] = { installed: true, checkedAt: Date.now() };
		const terminal = url.searchParams.get('terminal');
		// The hook is killed when the computer answers first, which closes this connection.
		const closed = new AbortController();
		res.on('close', () => {
			if (!res.writableFinished) closed.abort();
		});
		try {
			const output = await agents.handle(await readJson(req), {
				agent: url.searchParams.get('agent') || 'claude',
				terminal: terminal && sessions.get(terminal) ? terminal : null,
				signal: closed.signal,
			});
			if (res.destroyed) return;
			if (output) return sendJson(res, 200, output);
			// No decision: the computer's own prompt answers.
			res.writeHead(200, { 'content-length': 0 });
			res.end();
		} catch (e) {
			if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
		}
	}

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
		if (url.pathname === AGENTS_WS_PATH && authorized(req)) {
			wss.handleUpgrade(req, socket, head, watchAgents);
			return;
		}
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
					env: terminalEnv(),
				});
			} catch (e) {
				socket.end(`HTTP/1.1 ${e.status || (e.code === 'ENOENT' ? 404 : 500)} Error\r\n\r\n`);
				return;
			}
		}
		wss.handleUpgrade(req, socket, head, (ws) => session.attach(ws));
	});

	// Agents socket: a snapshot, then every change as it happens.
	function watchAgents(ws) {
		const send = (msg) => ws.send(JSON.stringify(msg));
		send({ type: 'snapshot', sessions: agents.sessions(), requests: agents.requests() });
		agents.on('message', send);
		ws.on('message', (data, isBinary) => {
			if (isBinary) return;
			let msg;
			try {
				msg = JSON.parse(data.toString('utf8'));
			} catch {
				return;
			}
			if (msg.type === AgentsClientMessage.presence) foregroundAt = msg.foreground === true ? Date.now() : 0;
		});
		ws.on('close', () => agents.off('message', send));
	}

	server.on('close', () => {
		clearInterval(sweep);
		sessions.killAll();
		for (const proxy of proxies.values()) proxy.close();
	});
	// server.close() waits for open sockets; callers shutting down kill shells right away.
	server.killAllSessions = () => sessions.killAll();
	server.agents = agents;
	// Whether a client showed this machine in the last 30 seconds.
	server.clientInForeground = clientInForeground;
	server.push = push;
	server.agentsUploadPath = (id) => uploadPath(id);
	return server;
}
