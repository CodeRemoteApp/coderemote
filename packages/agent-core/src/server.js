import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { pipeline } from 'node:stream/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
	AGENTS_WS_PATH,
	AgentsClientMessage,
	E2E_HANDSHAKE_PATH,
	E2E_REQUEST_PATH,
	E2E_VERSION,
	HOOK_SECRET_HEADER,
	PROTOCOL_VERSION,
	MIN_CLIENT_PROTOCOL,
	PAIRING_SCHEME,
	Routes,
	TERMINAL_WS_PATH,
	TUNNEL_AUTH_CALLBACK_HOST,
	TUNNEL_HANDOFF_PATH,
} from '@vsremote/protocol';
import { WebSocketServer } from 'ws';
import { AgentHub, PERMISSION_MODES } from './agents.js';
import { listCommands } from './commands.js';
import { BuildRunner, listSchemes } from './builds.js';
import { listHistory } from './history.js';
import { InstallLinks } from './install-links.js';
import * as Git from './git.js';
import { b64u } from './e2e.js';
import { createSealedGateway } from './e2e-http.js';
import { acceptSealedSocket, SealedClose } from './e2e-socket.js';
import { draftCommitMessage } from './commit-message.js';
import { TunnelHandoff } from './handoff.js';
import { LANDING_HTML } from './landing.js';
import { lanAddresses as defaultLanAddresses } from './lan.js';
import { isListening, killListener, listPorts } from './ports.js';
import { PushSender, userActiveHere } from './push.js';
import { detail, InspectingProxy } from './inspector.js';
import { capture, commandExists, interactiveShell, isWindows } from './platform.js';
import { HttpError, Sandbox } from './sandbox.js';
import { search } from './search.js';
import { SessionManager } from './sessions.js';
import { UploadStore, imageType } from './uploads.js';

/** Marks the sockets that came in through the LAN listener. */
const OVER_LAN = Symbol('overLan');

/**
 * Not served over LAN. Through the tunnel these also need the owner's sign-in at the relay;
 * over LAN the bearer token alone would mint tunnel connect tokens (the handoff, renewals,
 * previews), change the account's tunnels, or make a port public (previews, install links).
 * Hooks only come from this computer.
 */
function tunnelOnly(method, pathname) {
	return (
		pathname === TUNNEL_HANDOFF_PATH ||
		pathname === '/api/tunnel' ||
		pathname.startsWith('/api/tunnel/') ||
		pathname === '/api/preview' ||
		pathname.startsWith('/api/preview/') ||
		`${method} ${pathname}` === Routes.buildsInstall ||
		`${method} ${pathname}` === Routes.agentsHook
	);
}

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

// Types players need to recognize a file by (anything else is served as octet-stream).
const MEDIA_TYPES = {
	'.mp4': 'video/mp4',
	'.m4v': 'video/x-m4v',
	'.mov': 'video/quicktime',
	'.webm': 'video/webm',
	'.mp3': 'audio/mpeg',
	'.m4a': 'audio/mp4',
	'.aac': 'audio/aac',
	'.wav': 'audio/wav',
	'.caf': 'audio/x-caf',
};

/**
 * The single byte range a `Range` header asks for, as `{ start, end }` (inclusive), null to send
 * the whole file (no header, several ranges, or one this doesn't parse), or `'unsatisfiable'`.
 */
export function byteRange(header, size) {
	const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
	if (!m || (m[1] === '' && m[2] === '')) return null;
	let start;
	let end;
	if (m[1] === '') {
		// The last N bytes.
		const n = Number(m[2]);
		if (n === 0) return 'unsatisfiable';
		start = Math.max(0, size - n);
		end = size - 1;
	} else {
		start = Number(m[1]);
		end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
	}
	if (start >= size || start > end) return 'unsatisfiable';
	return { start, end };
}

/** Text without control characters (an ESC could end the paste early), newlines and tabs kept. */
function typeable(text) {
	return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// Permission modes a session started from the phone may begin in; skipping prompts entirely is
// for the computer to choose.
const LAUNCH_MODES = ['manual', 'acceptEdits', 'plan', 'auto'];
// How long Claude Code's footer takes to show the next permission mode after Shift+Tab.
const MODE_TIMEOUT = 2000;
const MODE_NAMES = {
	manual: 'Manual mode',
	acceptEdits: 'Accept edits',
	plan: 'Plan mode',
	auto: 'Auto mode',
	bypassPermissions: 'Bypass permissions',
	dontAsk: "Don't ask",
};

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
 * @param {(req: object) => Promise<object>} [opts.tunnelDelete]  deletes one of the account's
 *        tunnels, for `DELETE /api/tunnel`; absent without a tunnel
 * @param {string | null} [opts.hookSecret]  authenticates `coderemote hook` deliveries; without
 *        one the agent takes no hook events
 * @param {string | null} [opts.hookBin]  the CLI that runs `hook`, handed to terminals so a coding
 *        agent started in one reports through this agent's own version, whatever is on PATH
 * @param {string | null} [opts.uploadsDir]  where files sent from the phone go; sessions started
 *        here may read it without asking
 * @param {string} [opts.claudeCommand]  the Claude Code executable that sessions started here run
 * @param {string} [opts.codexCommand]  the Codex executable that sessions started here run
 * @param {string} [opts.codexHome]  Codex's own folder, where it caches the models it offers
 * @param {string} [opts.home]  the user's home folder, where the coding agents keep their commands
 * @param {BuildRunner} [opts.builds]  builds of Xcode projects in the shared folder (one is made when absent)
 * @param {string} [opts.xcodebuild]  the xcodebuild that builds and `GET /api/builds/schemes` run
 * @param {(agent: string) => Promise<boolean>} [opts.pluginInstalled]  whether that coding agent
 *        has the Code Remote plugin (default: asks its `plugin list`)
 * @param {AgentHub} [opts.agents]  coding-agent sessions (one is made when absent)
 * @param {{ load: () => object[], save: (devices: object[]) => void } | null} [opts.pushStore]
 *        keeps push registrations across restarts; without it they last until the agent stops
 * @param {object} [opts.pushOptions]  passed to PushSender (tests stub the relay and presence)
 * @param {string | null} [opts.version]  the CLI's version, reported in `/api/info`
 * @param {{ key: string, cert: string, fingerprint: string } | null} [opts.lan]  the certificate
 *        `listenLan()` serves devices on the local network with; without one there is no LAN listener
 * @param {() => string[]} [opts.lanAddresses]  where devices on the network reach this computer
 * @param {{ publicKey: Buffer, privateKey: object } | null} [opts.e2e]  the identity key that end-to-end
 *        encryption is offered with; without one `/api/info` reports `e2e: null`
 * @param {object} [opts.e2eOptions]  limits of the sealed sessions and tickets (tests shorten them)
 * @param {string | null} [opts.agentId]  this agent's lasting identity, reported in `/api/info`
 * @param {() => string | null} [opts.tunnelUrl]  the tunnel's public URL while it is hosted
 * @param {{ checkMs?: number, graceMs?: number, killedMs?: number }} [opts.previewSweep]  how often
 *        previews are checked for a dev server that stopped, and how long one may stay silent
 *        (after a stop from the Ports tab: how long until it is checked)
 */
export function createAgentServer({
	token,
	root,
	tunnelToken = async () => null,
	preview = null,
	tunnelStatus = null,
	tunnelDelete = null,
	hookSecret = null,
	hookBin = null,
	uploadsDir = null,
	claudeCommand = 'claude',
	codexCommand = 'codex',
	codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
	home = os.homedir(),
	xcodebuild = 'xcodebuild',
	builds = new BuildRunner({ xcodebuild }),
	pluginInstalled = null,
	agents = new AgentHub(),
	pushStore = null,
	sessionStore = null,
	pushOptions = {},
	previewSweep = {},
	version = null,
	lan = null,
	lanAddresses = defaultLanAddresses,
	e2e = null,
	e2eOptions = {},
	agentId = null,
	tunnelUrl = () => null,
}) {
	const handoff = new TunnelHandoff({ token, mint: tunnelToken });
	const sandbox = new Sandbox(root);
	const sessions = new SessionManager({
		onExit: (id) => agents.terminalExited(id),
		onOutput: (id, buf) => agents.terminalOutput(id, buf),
	});
	const expected = Buffer.from(`Bearer ${token}`);
	// Sealed requests re-enter this server over loopback, so they reach the routes unchanged.
	const sealed = e2e ? createSealedGateway({ identity: e2e, port: () => server.address().port, options: e2eOptions }) : null;
	const uploads = uploadsDir ? new UploadStore(uploadsDir) : null;
	// Images in transcripts become uploads, which clients fetch like the files they attached.
	if (uploads && !agents.keepImage) agents.keepImage = (bytes, type) => uploads.keep(bytes, type);
	agents.uploadsDir ??= uploadsDir;
	agents.fileType ??= (name) => imageType(name) ?? MEDIA_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
	// The session list outlives the agent: a restart brings it back (see AgentHub.restore).
	let saveTimer = null;
	const saveSessions = () => {
		clearTimeout(saveTimer);
		saveTimer = null;
		try {
			sessionStore?.save(agents.snapshot());
		} catch {}
	};
	if (sessionStore) {
		agents.restore(sessionStore.load());
		agents.on('message', () => {
			saveTimer ??= setTimeout(saveSessions, 1000);
			saveTimer.unref?.();
		});
	}
	const sweep = setInterval(() => {
		agents.sweep();
		if (sessionStore) saveSessions();
		uploads?.sweep().catch(() => {});
	}, 10 * 60 * 1000);
	sweep.unref();
	// What each client last said it shows of this machine, and when; it counts for 30 seconds.
	// `all`: an app from before presence named a session shows everything, as far as we know.
	const presences = new Map();
	const freshPresences = () => [...presences.values()].filter((p) => Date.now() - p.at < 30_000);
	const clientInForeground = () => freshPresences().length > 0;
	const clientShows = ({ session = null, builds = false }) =>
		freshPresences().some((p) => p.all || (session ? p.session === session : builds && p.builds));
	const push = new PushSender({ hub: agents, store: pushStore, shows: clientShows, ...pushOptions });
	builds.on('ended', (build) => push.buildEnded(build).catch(() => {}));
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

	/**
	 * Presses Shift+Tab until the session's footer shows `mode`. Claude Code has no way to pick a
	 * mode directly, and which modes the cycle holds depends on its settings (auto may be off,
	 * bypass needs a launch flag), so a mode that doesn't come round within one cycle isn't there.
	 */
	async function setMode(id, mode) {
		if (!PERMISSION_MODES.includes(mode)) throw new HttpError(400, `mode must be one of ${PERMISSION_MODES.join(', ')}`);
		const { term } = typingTarget(id, { whileWaiting: false });
		for (let i = 0; i <= PERMISSION_MODES.length; i++) {
			if (agents.session(id)?.permissionMode === mode) return agents.session(id);
			const shown = agents.waitForMode(id, MODE_TIMEOUT);
			term.write(KEYS.cycle_mode);
			if (!(await shown)) break;
		}
		throw new HttpError(409, `${MODE_NAMES[mode]} isn't available in this session`);
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

	// Install links go out through the preview tunnel, so agents without one can't make them.
	const installs = preview ? new InstallLinks({ preview }) : null;

	/** The commands and skill mentions `session`'s coding agent accepts (see commands.js). */
	function sessionCommands(session) {
		return listCommands({ agent: session.agent, cwd: session.cwd || sandbox.root, home, codexHome });
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
		// Install links of a build, shared while they live; stopping it ends them.
		const install = installs?.sharing ? forwarded.get(installs.port) : null;
		if (install) ports.push({ ...install, install: true });
		return { ports, token: issued?.token ?? null, expiresAt: issued?.expiresAt ?? null };
	}

	// A preview whose dev server stopped (killed from the Ports tab, its terminal closed, Ctrl+C,
	// a crash) still holds one of the preview tunnel's 10 ports, and a public link to whatever
	// listens there next. Once nothing has listened on it for graceMs it stops being previewed;
	// the wait lets a dev server that restarts itself keep its preview. The proxy and its request
	// log stay, as after Stop Preview.
	const { checkMs = 5_000, graceMs = 30_000, killedMs = 1_500 } = previewSweep;
	/** Dev server port -> when it was first found not listening. */
	const silentSince = new Map();
	let sweeping = false;

	/** Stops previewing `ports` that nothing listens on, at once (`now`) or after graceMs. */
	async function sweepPreviews(ports = [...proxies.keys()], now = false) {
		const forwarded = new Set(preview.list().map((p) => p.port));
		for (const port of ports) {
			const proxy = proxies.get(port);
			if (!proxy || !forwarded.has(proxy.port) || (await isListening(port))) {
				silentSince.delete(port);
				continue;
			}
			if (!silentSince.has(port)) silentSince.set(port, Date.now());
			if (!now && Date.now() - silentSince.get(port) < graceMs) continue;
			silentSince.delete(port);
			try {
				await preview.unforward(proxy.port);
			} catch {}
		}
	}

	const previewTimer =
		preview &&
		setInterval(async () => {
			if (sweeping || !proxies.size) return;
			sweeping = true;
			try {
				await sweepPreviews();
			} finally {
				sweeping = false;
			}
		}, checkMs);
	previewTimer?.unref();

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
		[Routes.info]: async (url, req) => ({
			...lanInfo(),
			// The key goes only to a client on the LAN listener, whose certificate it pinned: through the
			// tunnel a relay could swap it, so there a client takes it from the pairing link alone.
			e2e: sealed
				? { version: E2E_VERSION, ...(req.socket[OVER_LAN] === true ? { publicKey: b64u(e2e.publicKey) } : {}) }
				: null,
			protocol: PROTOCOL_VERSION,
			minClientProtocol: MIN_CLIENT_PROTOCOL,
			version,
			hostname: os.hostname(),
			platform: os.platform(),
			root: sandbox.root,
			user: os.userInfo().username,
			// On Windows, terminals run PowerShell whatever $SHELL (Git Bash sets one) says.
			shell: isWindows ? interactiveShell().file : process.env.SHELL || null,
			agentId,
			// Null until the tunnel is hosted (an agent started offline connects it later).
			tunnel: tunnelUrl() ? { url: tunnelUrl() } : null,
		}),

		[Routes.e2eTicket]: async (url, req) => {
			if (!sealed) throw new HttpError(404, 'not found');
			const { scope } = await readJson(req);
			if (scope !== 'read' && scope !== 'upload') throw new HttpError(400, 'scope must be read or upload');
			return sealed.tickets.mint(scope);
		},

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
			const type = MEDIA_TYPES[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
			// One byte range, so a video plays while it downloads and can be scrubbed.
			const range = byteRange(req.headers.range, stat.size);
			if (range === 'unsatisfiable') {
				res.writeHead(416, { 'content-range': `bytes */${stat.size}`, 'accept-ranges': 'bytes' });
				res.end();
				return;
			}
			if (range) {
				res.writeHead(206, {
					'content-type': type,
					'content-length': range.end - range.start + 1,
					'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
					'accept-ranges': 'bytes',
				});
				await pipeline(createReadStream(p, range), res);
				return;
			}
			res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes' });
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

		[Routes.fsSearch]: async (url, req, res) => {
			const q = url.searchParams;
			const flag = (name) => q.get(name) === '1';
			// Typing a new query drops the request for the last one; its search stops with it.
			const gone = new AbortController();
			res.on('close', () => {
				if (!res.writableFinished) gone.abort();
			});
			const found = await search({
				root: sandbox.root,
				query: q.get('q') ?? '',
				caseSensitive: flag('case'),
				wholeWord: flag('word'),
				regex: flag('regex'),
				include: q.get('include') ?? '',
				exclude: q.get('exclude') ?? '',
				limit: Number(q.get('limit')) || undefined,
				signal: gone.signal,
			});
			if (gone.signal.aborted) return undefined;
			return { root: sandbox.root, ...found };
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

		[Routes.gitCommitMessage]: async (url, req) => {
			const { repo: r, agent: wanted, model: chosen } = await readJson(req);
			const repo = await repoOf(r);
			if (wanted !== undefined && wanted !== null && !(wanted in launchers)) throw new HttpError(400, 'unknown agent');
			if (chosen !== undefined && chosen !== null && (typeof chosen !== 'string' || !/^[\w.:\[\]-]{1,100}$/.test(chosen))) {
				throw new HttpError(400, 'invalid model');
			}
			let agent = null;
			for (const a of wanted ? [wanted] : ['claude', 'codex']) {
				if (await installed(a)) {
					agent = a;
					break;
				}
			}
			if (!agent) {
				const name = wanted ? launchers[wanted].name : 'Claude Code or Codex';
				throw Object.assign(new HttpError(409, `Drafting a commit message needs ${name} installed on the computer.`), {
					code: 'ENOAGENT',
				});
			}
			// Without a model, Codex takes the first it lists (its fastest): the user's configured
			// one may be slow, or one their plan doesn't offer.
			const model = (wanted && chosen) || (agent === 'codex' ? ((await codexModels())[0]?.id ?? null) : null);
			return draftCommitMessage(repo, agent, { claudeCommand, codexCommand, model });
		},

		[Routes.gitLog]: async (url) => ({
			commits: await Git.log(await repoOf(url.searchParams.get('repo')), parseInt(url.searchParams.get('limit'), 10) || 50),
		}),

		[Routes.gitShow]: async (url) => Git.show(await repoOf(url.searchParams.get('repo')), url.searchParams.get('commit')),

		[Routes.gitPull]: async (url, req) => ({ output: await Git.pull(await repoOf((await readJson(req)).repo)) }),

		[Routes.gitPush]: async (url, req) => ({ output: await Git.push(await repoOf((await readJson(req)).repo)) }),

		[Routes.gitFetch]: async (url, req) => ({ output: await Git.fetch(await repoOf((await readJson(req)).repo)) }),

		[Routes.gitBranches]: async (url) => ({ branches: await Git.branches(await repoOf(url.searchParams.get('repo'))) }),

		[Routes.gitCheckout]: async (url, req) => {
			const { repo, branch, create } = await readJson(req);
			return Git.checkout(await repoOf(repo), branch, { create: create === true });
		},

		[Routes.gitStashes]: async (url) => ({ stashes: await Git.stashes(await repoOf(url.searchParams.get('repo'))) }),

		[Routes.gitStash]: async (url, req) => {
			const { repo, message, untracked } = await readJson(req);
			return Git.stash(await repoOf(repo), { message, untracked: untracked !== false });
		},

		[Routes.gitStashApply]: async (url, req) => {
			const { repo, index, pop } = await readJson(req);
			return Git.stashApply(await repoOf(repo), index, { pop: pop === true });
		},

		[Routes.gitStashDrop]: async (url, req) => {
			const { repo, index } = await readJson(req);
			return Git.stashDrop(await repoOf(repo), index);
		},

		[Routes.termList]: async () => ({ sessions: sessions.list() }),

		[Routes.portsList]: async () => ({ ports: await listPorts(shellPids()) }),

		[Routes.portsKill]: async (url, req) => {
			const { pid, force } = await readJson(req);
			const ports = await killListener(pid, { force: force === true, shells: shellPids() });
			// Stopped on purpose, so no restart to wait for: once it has gone, so does its preview.
			if (preview) setTimeout(() => sweepPreviews(ports, true).catch(() => {}), killedMs).unref();
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
			if (installs && port === installs.port) {
				await installs.stop();
				return previews();
			}
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
			const asked = previewPort(url.searchParams.get('port'), server.address()?.port);
			if (installs && asked === installs.port) {
				await installs.stop();
				return previews();
			}
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

		[Routes.tunnelDelete]: async (url, req) => {
			if (!tunnelDelete) throw new HttpError(404, 'this agent runs without a tunnel');
			const { id, account, force } = await readJson(req);
			return tunnelDelete({ id, account, force: force === true });
		},

		[Routes.tunnelToken]: async () => {
			const issued = await handoff.issue();
			if (!issued) throw new HttpError(404, 'this tunnel is anonymous');
			return issued;
		},

		[Routes.agentsSessions]: async () => ({ sessions: agents.sessions() }),

		[Routes.agentsTimeline]: async (url) => {
			// A session brought back after a restart reads its history first.
			await agents.ready(url.searchParams.get('session'));
			const int = (name) => Math.max(0, parseInt(url.searchParams.get(name), 10) || 0);
			return agents.timeline(url.searchParams.get('session'), int('after'), { limit: int('limit'), before: int('before') });
		},

		[Routes.agentsSetup]: async () => {
			const [claude, codex] = await Promise.all([installed('claude'), installed('codex')]);
			const [plugin, codexPlugin] = await Promise.all([claude && hasPlugin('claude'), codex && hasPlugin('codex')]);
			return { claude, plugin: Boolean(plugin), codex, codexPlugin: Boolean(codexPlugin), codexModels: codex ? await codexModels() : [] };
		},

		[Routes.agentsCommands]: async (url) => {
			const session = agents.session(url.searchParams.get('session') ?? '');
			if (!session) throw new HttpError(404, 'no such session');
			return { commands: await sessionCommands(session) };
		},

		[Routes.agentsHistory]: async (url) => {
			const session = agents.session(url.searchParams.get('session') ?? '');
			if (!session) throw new HttpError(404, 'no such session');
			const found = await listHistory({ agent: session.agent, cwd: session.cwd || sandbox.root, home, codexHome });
			return { sessions: found.filter((h) => h.id !== session.id) };
		},

		[Routes.buildsSchemes]: async (url) => listSchemes(await sandbox.resolve(url.searchParams.get('path')), { xcodebuild }),

		[Routes.buildsStart]: async (url, req) => {
			const { path: folder, scheme, configuration } = await readJson(req);
			return builds.start({ folder: await sandbox.resolve(folder), scheme, configuration });
		},

		[Routes.buildsCurrent]: async (url) => {
			const build = builds.current(parseInt(url.searchParams.get('after'), 10) || 0);
			if (!build) throw new HttpError(404, 'no build yet');
			return build;
		},

		[Routes.buildsCancel]: async () => {
			builds.cancel();
			return {};
		},

		[Routes.buildsInstall]: async () => {
			if (!installs) throw new HttpError(409, 'installing needs the tunnel: start the agent with `coderemote up`');
			const artifact = builds.artifact();
			if (!artifact) throw new HttpError(409, 'there is no successful build to install');
			try {
				return await installs.create(artifact);
			} catch (e) {
				throw e instanceof HttpError ? e : new HttpError(502, e.message);
			}
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
			// Shown with the prompt once Claude Code reports it; other files stay paths in its text.
			const images = paths.map((p, i) => ({ id: attachments[i], type: imageType(p) })).filter((i) => i.type);
			agents.prompted(id, { id: prompt, text: typed, paths, images });
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

		[Routes.agentsUploadFile]: async (url, req, res) => {
			const file = await uploadPath(url.searchParams.get('id'));
			const stat = await fs.stat(file).catch(() => null);
			if (!stat?.isFile()) throw new HttpError(404, 'no such upload (they are kept for 7 days)');
			const type = imageType(file) ?? MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
			// Named by id, an upload never changes.
			res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'private, max-age=604800, immutable' });
			await pipeline(createReadStream(file), res);
		},

		[Routes.agentsKeys]: async (url, req) => {
			const { session: id, action, command, args, mode } = await readJson(req);
			const allowed = agents.session(typeof id === 'string' ? id : '')?.capabilities?.keys;
			if (action !== 'command' && allowed && !allowed.includes(action)) {
				throw new HttpError(400, `this session takes ${allowed.join(', ')}`);
			}
			if (action === 'command') {
				if (typeof command !== 'string') throw new HttpError(400, 'command must be a string');
				if (args !== undefined && (typeof args !== 'string' || args.length > 100_000)) throw new HttpError(400, 'args must be a string');
				const { session, term } = typingTarget(id, { whileWaiting: false });
				// The fixed commands of `capabilities.keys` stay valid for apps that predate the list.
				const listed = (await sessionCommands(session)).some((c) => c.kind === 'command' && c.name === command);
				if (!listed && !session.capabilities?.keys?.includes(command)) {
					throw new HttpError(400, `${command} is not a command this session takes`);
				}
				await typeInto(term, typeable(args?.trim() ? `${command} ${args.trim()}` : command));
				// The transcript names the full model once it answers; until then, what was asked for.
				if (command === '/model' && args?.trim()) agents.modelChosen(id, args.trim());
			} else if (action === 'set_mode') {
				return { session: await setMode(id, mode) };
			} else if (Object.hasOwn(KEYS, action)) {
				typingTarget(id, { whileWaiting: true }).term.write(KEYS[action]);
				if (action === 'interrupt') agents.interrupted(id);
			} else {
				throw new HttpError(400, `action must be one of ${[...Object.keys(KEYS), 'set_mode', 'command'].join(', ')}`);
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
		if (req.socket[OVER_LAN] === true && tunnelOnly(req.method, url.pathname)) {
			return sendJson(res, 404, { error: 'not found' });
		}
		if (url.pathname === E2E_HANDSHAKE_PATH || url.pathname === E2E_REQUEST_PATH) {
			// Over LAN the pinned certificate is the protection; without a key there is nothing to offer.
			if (!sealed || req.socket[OVER_LAN] === true) return sendJson(res, 404, { error: 'not found' });
			if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
			return (url.pathname === E2E_HANDSHAKE_PATH ? sealed.handshake : sealed.request)(req, res).catch(() => res.destroy());
		}
		if (req.method === 'GET' && url.pathname === TUNNEL_HANDOFF_PATH) return handoffRedirect(url, res);
		if (`${req.method} ${url.pathname}` === Routes.agentsHook) return hookDelivery(url, req, res);
		if (!authorized(req) && !sealed?.ticketOk(req, url.pathname)) return sendJson(res, 401, { error: 'unauthorized' });
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

	/** The terminal session `{ id, cols, rows, cwd }` asks for: `{ session }`, or `{ status }` on failure. */
	async function terminalFor({ id, cols, rows, cwd }) {
		if (id) {
			const session = sessions.get(id);
			return session ? { session } : { status: 404 };
		}
		try {
			return {
				session: sessions.create({
					cols: parseInt(cols, 10) || 80,
					rows: parseInt(rows, 10) || 24,
					// New shells start in the shared folder unless a subfolder is asked for.
					cwd: await sandbox.resolve(cwd || sandbox.root),
					env: terminalEnv(),
				}),
			};
		} catch (e) {
			return { status: e.status || (e.code === 'ENOENT' ? 404 : 500) };
		}
	}

	/** An upgrade that names a sealed session (`?e2e=`): the open frame carries the rest. */
	function sealedUpgrade(url, req, socket, head) {
		const kind = url.pathname === AGENTS_WS_PATH ? 'agents' : 'term';
		const session = sealed.sessions.get(url.searchParams.get('e2e') ?? '');
		if (!session) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
		if (!sealed.sessions.claim(session, 'ws')) return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
		wss.handleUpgrade(req, socket, head, (ws) => {
			acceptSealedSocket(
				ws,
				session,
				async (msg, sealedWs) => {
					if (msg.kind !== kind) return SealedClose.badFrame;
					const got = Buffer.from(`Bearer ${msg.token}`);
					if (got.length !== expected.length || !timingSafeEqual(got, expected)) return SealedClose.unauthorized;
					if (kind === 'agents') {
						watchAgents(sealedWs);
						return true;
					}
					const found = await terminalFor(msg);
					if (!found.session) return found.status === 404 ? SealedClose.notFound : SealedClose.failed;
					found.session.attach(sealedWs);
					return true;
				},
				e2eOptions.socket,
			);
			ws.on('close', () => sealed.sessions.delete(session.id));
		});
	}

	server.on('upgrade', async (req, socket, head) => {
		const url = new URL(req.url, 'http://localhost');
		if (
			url.searchParams.has('e2e') &&
			(url.pathname === AGENTS_WS_PATH || url.pathname === TERMINAL_WS_PATH) &&
			sealed &&
			req.socket[OVER_LAN] !== true
		) {
			return sealedUpgrade(url, req, socket, head);
		}
		if (url.pathname === AGENTS_WS_PATH && authorized(req)) {
			wss.handleUpgrade(req, socket, head, watchAgents);
			return;
		}
		if (url.pathname !== TERMINAL_WS_PATH || !authorized(req)) {
			socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
			return;
		}
		const found = await terminalFor({
			id: url.searchParams.get('id'),
			cols: url.searchParams.get('cols'),
			rows: url.searchParams.get('rows'),
			cwd: url.searchParams.get('cwd'),
		});
		if (!found.session) {
			socket.end(`HTTP/1.1 ${found.status} ${found.status === 404 ? 'Not Found' : 'Error'}\r\n\r\n`);
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => found.session.attach(ws));
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
			if (msg.type !== AgentsClientMessage.presence) return;
			if (msg.foreground !== true) return presences.delete(ws);
			presences.set(ws, {
				at: Date.now(),
				all: msg.session === undefined && msg.builds === undefined,
				session: typeof msg.session === 'string' ? msg.session : null,
				builds: msg.builds === true,
			});
		});
		ws.on('close', () => {
			agents.off('message', send);
			presences.delete(ws);
		});
	}

	// LAN listener: TLS in front of this same server, so every route and socket works unchanged.
	let lanServer = null;
	function lanInfo() {
		const port = lanServer?.listening ? lanServer.address().port : null;
		return { lan: port ? { port, addresses: lanAddresses(), fingerprint: lan.fingerprint } : null };
	}

	/**
	 * Accepts devices on the local network on `port` (0: any free one) over TLS with `opts.lan`'s
	 * certificate, on every interface. Resolves the TLS server; rejects when it can't listen.
	 */
	server.listenLan = (port, host = '::') => {
		if (!lan) return Promise.reject(new Error('no LAN certificate'));
		const tlsServer = tls.createServer({ key: lan.key, cert: lan.cert, minVersion: 'TLSv1.2' }, (socket) => {
			socket[OVER_LAN] = true;
			server.emit('connection', socket);
		});
		// A device that gives up mid-handshake (a probe, a rejected pin) is nothing to report.
		tlsServer.on('tlsClientError', () => {});
		return new Promise((resolve, reject) => {
			tlsServer.once('error', (e) => {
				// No IPv6 on this computer: IPv4 only.
				if (host === '::' && (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL')) {
					return resolve(server.listenLan(port, '0.0.0.0'));
				}
				reject(e);
			});
			tlsServer.listen(port, host, () => {
				tlsServer.removeAllListeners('error');
				tlsServer.on('error', () => {});
				lanServer = tlsServer;
				resolve(tlsServer);
			});
		});
	};

	server.on('close', () => {
		sealed?.end();
		lanServer?.close();
		installs?.close();
		clearInterval(sweep);
		clearInterval(previewTimer);
		if (saveTimer) saveSessions();
		sessions.killAll();
		for (const proxy of proxies.values()) proxy.close();
	});
	// server.close() waits for open sockets; callers shutting down kill shells right away.
	server.killAllSessions = () => sessions.killAll();
	// Ends every sealed session and ticket now (the identity key was replaced).
	server.endSealedSessions = () => sealed?.end();
	server.sealed = sealed;
	server.agents = agents;
	// Whether a client showed this machine in the last 30 seconds, and what of it.
	server.clientInForeground = clientInForeground;
	server.clientShows = clientShows;
	server.push = push;
	server.agentsUploadPath = (id) => uploadPath(id);
	// Writes the session list now, for a shutdown that exits before the next timed save.
	server.saveAgentSessions = () => sessionStore && saveSessions();
	return server;
}
