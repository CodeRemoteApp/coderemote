#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { createAgentServer, execCommand, isWindows, lanAddresses, DeviceRegistry, PRESENCE_WINDOWS, lanCertificate, loadIdentity, loadLocalSecret, qrAddresses, spawnCommand } from '@vsremote/agent-core';
import { ensureHookSecret, readHookSecret, runHook, writeHookLauncher } from '../src/hook.js';
import { pushStore } from '../src/push-store.js';
import { sessionStore } from '../src/session-store.js';
import { AgentRegistry } from '../src/registry.js';
import { ensureAgentId, rememberTunnelUrl } from '../src/agent-identity.js';
import { CloudError } from '../src/providers/cloud/api.js';
import { chooseProvider, providers, rememberProvider } from '../src/providers/index.js';
import { createTunnelSession } from '../src/tunnel-session.js';
import { availableUpdate, fetchLatest, installCommand, isNewer } from '../src/update.js';
import pkg from '../package.json' with { type: 'json' };
import { Redactor, filterRequests, formatDetail, formatList, redactDetail } from '../src/requests.js';
import { Spinner } from '../src/spinner.js';
import { commandHelp } from '../src/help.js';
import { sweepStrayAdvertisers } from '../src/bonjour.js';
import { spawnTied } from '../src/tied.js';
import { keepAwake } from '../src/keep-awake.js';
import { codeTunnelLogin, codeTunnelSignedIn, findCode, hostCodeTunnel } from '../src/vscode-tunnel.js';
import { firewallAdvice, firewallReport, lanAdapters } from '../src/windows-firewall.js';
import { LAN_SERVICE_TYPE, PROTOCOL_VERSION, pairingUrl, webUrl } from '@vsremote/protocol';

const CONFIG_DIR = path.join(os.homedir(), '.coderemote');
// Releases before the rename kept their token and tunnel here; moving them keeps every pairing.
const LEGACY_CONFIG_DIR = path.join(os.homedir(), '.vsremote');
if (!fs.existsSync(CONFIG_DIR) && fs.existsSync(LEGACY_CONFIG_DIR)) fs.renameSync(LEGACY_CONFIG_DIR, CONFIG_DIR);
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
// Phones registered for notifications, per agent port; `rotate-token` deletes them all.
const PUSH_DIR = path.join(CONFIG_DIR, 'push');
const AGENT_SESSIONS_DIR = path.join(CONFIG_DIR, 'agent-sessions');
// Photos and files sent from the phone to coding-agent sessions.
const UPLOADS_DIR = path.join(CONFIG_DIR, 'uploads');
// The certificate of the LAN listener, which paired phones pin; `rotate-token` replaces it.
const LAN_DIR = path.join(CONFIG_DIR, 'lan');
// The identity key of end-to-end encryption, which paired phones pin (`pk` in the pairing link);
// `rotate-token` replaces it.
const E2E_DIR = path.join(CONFIG_DIR, 'e2e');
// The phones enrolled with each agent (one file per agent port) and their presence policy;
// `rotate-token` deletes them all.
const DEVICES_DIR = path.join(CONFIG_DIR, 'devices');
// What this CLI sends to a running agent on loopback instead of the pairing token.
const LOCAL_SECRET_FILE = path.join(CONFIG_DIR, 'local-secret');
// A folder's LAN listener starts looking for a port this far above its agent's.
const LAN_PORT_OFFSET = 1000;
const DEFAULT_PORT = 31580;
// Bundled into the published dist/coderemote.js, whose package.json the release workflow stamps
// with the tag's version. A source checkout has no real version, so it never checks for updates.
const VERSION = pkg.version;
const PACKAGED = path.basename(path.dirname(fileURLToPath(import.meta.url))) === 'dist';
const spinner = new Spinner();

function loadConfig() {
	let cfg = {};
	let text = null;
	try {
		text = fs.readFileSync(CONFIG_FILE, 'utf8');
	} catch {}
	if (text !== null) {
		try {
			cfg = JSON.parse(text);
		} catch (e) {
			// Never start over (a new token unpairs every device) because of a file we can't read.
			console.error(`${CONFIG_FILE} isn't valid JSON (${e.message}). Fix or remove it, then try again.`);
			process.exit(1);
		}
	}
	if (!cfg.token) {
		cfg.token = randomBytes(32).toString('base64url');
		saveConfig(cfg);
		// Devices registered for notifications were paired devices too, and sent these files.
		fs.rmSync(PUSH_DIR, { recursive: true, force: true });
		fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
		fs.rmSync(LAN_DIR, { recursive: true, force: true });
		// Every enrolled phone goes, and the local secret is replaced.
		fs.rmSync(DEVICES_DIR, { recursive: true, force: true });
		fs.rmSync(LOCAL_SECRET_FILE, { force: true });
		// The same for the end-to-end identity key: devices pinned the old one.
		fs.rmSync(E2E_DIR, { recursive: true, force: true });
	}
	// Older releases kept one tunnel per machine, made for the default port.
	if (cfg.tunnelId && !cfg.tunnels) {
		cfg.tunnels = { [DEFAULT_PORT]: cfg.tunnelId };
		saveConfig(cfg);
	}
	return cfg;
}

/**
 * Stops a running agent. Windows has no SIGTERM for it to clean up on, so the agent is ended
 * along with everything it started (its tunnel host, terminals), which would outlive it.
 */
function stopAgent(pid) {
	if (!isWindows) return process.kill(pid, 'SIGTERM');
	try {
		execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
	} catch {}
}

/**
 * Applies `change` to a fresh read of the config, saves it, and applies it to `cfg` too. For writes
 * from a running agent: agents of other folders change the same file, and saving the copy read at
 * start would undo what they wrote since. `change` returns false to save nothing.
 */
function updateConfig(cfg, change) {
	const fresh = loadConfig();
	if (change(fresh) === false) return;
	saveConfig(fresh);
	change(cfg);
}

/** Runs a provider command; a Code Remote Cloud error is reported as its message, without a stack. */
async function cloudCommand(run) {
	try {
		await run();
	} catch (e) {
		if (!(e instanceof CloudError)) throw e;
		console.error(e.message);
		process.exit(1);
	}
}

function saveConfig(cfg) {
	fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	// Written whole, then renamed over: agents of other folders read and write it too, and a reader
	// that saw a half-written file would start over with a new token.
	const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, CONFIG_FILE);
}

/** Whether nothing listens on 127.0.0.1:port. */
function portFree(port) {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.once('error', () => resolve(false));
		probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
	});
}

function listen(token, port, root, tunnelToken, preview, status, remover, lan, agentId, tunnelUrl, e2e, tunnelProvider) {
	const hookSecret = ensureHookSecret(CONFIG_DIR);
	writeHookLauncher(CONFIG_DIR, { script: fs.realpathSync(process.argv[1]) });
	const server = createAgentServer({
		token,
		root,
		tunnelToken,
		preview,
		tunnelStatus: status,
		tunnelDelete: remover,
		hookSecret,
		// This very CLI, so coding agents in the app's terminals report through the same version.
		hookBin: fs.realpathSync(process.argv[1]),
		pushStore: pushStore(PUSH_DIR, port),
		sessionStore: sessionStore(AGENT_SESSIONS_DIR, port),
		uploadsDir: UPLOADS_DIR,
		version: VERSION,
		lan,
		e2e,
		// Device keys only matter where the tunnel (end-to-end encryption) is.
		devices: e2e ? new DeviceRegistry(path.join(DEVICES_DIR, `${port}.json`)) : null,
		localSecret: loadLocalSecret(LOCAL_SECRET_FILE).secret ?? null,
		onDeviceEnrolled: (d) => console.log(`\n  Device enrolled: ${d.name} (${d.id}). Revoke it with \`coderemote devices revoke ${d.id}\`.`),
		agentId,
		tunnelUrl,
		tunnelProvider,
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		// Loopback only: remote access goes exclusively through the tunnel.
		server.listen(port, '127.0.0.1', () => resolve(server));
	});
}

/**
 * Opens the agent's LAN listener on the port this folder had, or else the first free one from
 * the agent's port + LAN_PORT_OFFSET that no other folder claimed. Resolves the port, or
 * `{ error }`: the agent then runs without it.
 */
async function openLan(server, agentPort) {
	const remembered = cfg.lanPorts?.[root];
	const claimed = new Set(Object.entries(cfg.lanPorts ?? {}).filter(([r]) => r !== root).map(([, p]) => p));
	const busy = new Set(registry.list().map((a) => a.port));
	let candidate = remembered ?? agentPort + LAN_PORT_OFFSET;
	for (let tries = 0; tries < 50; tries++, candidate++) {
		if (candidate !== remembered && (claimed.has(candidate) || busy.has(candidate))) continue;
		try {
			const lanPort = (await server.listenLan(candidate)).address().port;
			if (lanPort !== remembered) {
				updateConfig(cfg, (c) => {
					c.lanPorts = { ...c.lanPorts, [root]: lanPort };
				});
			}
			return { port: lanPort };
		} catch (e) {
			if (e.code !== 'EADDRINUSE') return { error: e.message };
		}
	}
	return { error: 'no free port' };
}

/**
 * Advertises the LAN listener over Bonjour (macOS only: `dns-sd` ships with it), so the app
 * finds this agent even when the relay is out of reach. The advertisement ends with the agent,
 * even one killed outright (see tied.js). Returns the advertiser, or null.
 */
async function advertiseLan(lanPort, fingerprint, agentPort) {
	if (process.platform !== 'darwin') return null;
	// Ones an earlier agent left behind would point phones at a dead port.
	await sweepStrayAdvertisers(LAN_SERVICE_TYPE);
	const host = os.hostname().replace(/\.local$/, '');
	const name = agentPort === DEFAULT_PORT ? host : `${host} :${agentPort}`;
	try {
		const child = spawnTied('dns-sd', ['-R', name, LAN_SERVICE_TYPE, 'local', String(lanPort), `fp=${fingerprint.slice(0, 16)}`, `proto=${PROTOCOL_VERSION}`]);
		child.on('error', () => {});
		return child;
	} catch {
		return null;
	}
}

/**
 * `url`: the tunnel's address, or null for an agent that never had one and started offline.
 * `link`: `{ agentId, lan }` with a LAN listener; `lan` (what lets the app pin the agent and reach
 * it on this network straight from the QR) only while the tunnel isn't up.
 * `publicKey`: the identity key of end-to-end encryption, when the agent has one.
 */
function printPairing(url, token, access, vscodeUrl, link, publicKey) {
	const pair = pairingUrl({ url, token, agentId: link?.agentId, lan: link?.lan, publicKey });
	if (access) console.log(`  Access:  ${access}`);
	// Labels line up whether or not the VS Code row is there.
	const label = (name) => `${name}:`.padEnd(vscodeUrl ? 9 : 4);
	console.log('');
	if (vscodeUrl) console.log(`  ${label('VS Code')}  ${vscodeUrl}`);
	// A browser can't pin the LAN certificate: the web link needs the tunnel.
	if (url) console.log(`  ${label('Web')}  ${webUrl({ url, token })}  (through the relay: prefer the QR code)`);
	console.log(`  ${label('App')}  ${pair}\n`);
	if (!url) console.log('  No tunnel yet: pair the Code Remote app on this Wi-Fi (an app too old for that calls this link invalid).\n');
	if (vscodeUrl) console.log('  VS Code opens in the browser after signing in with the account of `code tunnel`.');
	console.log(`  Scan with the iPhone Camera, or open ${url ? 'either link' : 'the link'} on the phone:\n`);
	qrcode.generate(pair, { small: true });
	console.log(
		anonymous
			? '\n  The links contain your access token. Anyone with them can use this machine.'
			: url
				? '\n  The links contain your access token; the phone or browser must also sign in as you.'
				: '\n  The link contains your access token; away from this network the phone must also sign in as you.',
	);
	console.log('  Run `coderemote rotate-token` to revoke every paired device.\n');
}

/**
 * `up --web`: starts `code tunnel` and returns its vscode.dev link for this folder, or null
 * after explaining what went wrong. The phone pairing works either way, so this never fails `up`.
 */
async function startVSCodeTunnel() {
	const code = findCode();
	if (!code) {
		console.error("--web needs VS Code's `code` command on PATH (in VS Code: Shell Command: Install 'code' command in PATH).");
		return null;
	}
	if (!(await codeTunnelSignedIn(code))) {
		if (!process.stdin.isTTY) {
			console.error('--web: VS Code tunnel is not signed in. Run `code tunnel user login`, then try again.');
			return null;
		}
		console.error('Signing in to VS Code tunnels with GitHub...\n');
		if ((await codeTunnelLogin(code)) !== 0) {
			console.error('\n--web: sign-in failed. Run `code tunnel user login`, then try again.');
			return null;
		}
	}
	spinner.start('Starting VS Code tunnel');
	try {
		const { child, url } = await hostCodeTunnel(code, root);
		spinner.succeed();
		process.on('exit', () => child.kill());
		return url;
	} catch (e) {
		spinner.fail();
		console.error(`${e.message.trim()}\n`);
		console.error('--web: run `code tunnel` once in a terminal (license, machine name), then try again.');
		return null;
	}
}

const USAGE = `Usage: coderemote <command> [options]
       coderemote <command> --help   (just that command and its subcommands)

  up                   share this folder through a dev tunnel and print the pairing QR;
                       the phone or browser must sign in with your dev tunnels account.
                       Without internet it serves the local network only and connects
                       the tunnel once it can
  serve                share this folder on 127.0.0.1 only (no tunnel)
  status               list running agents and their terminal sessions
  kill <id>... | --all kill terminal sessions (an id prefix is enough)
  stop [--all]         stop the agent for this folder (or every agent)
  devices              list the phones enrolled with this folder's agent and its Face ID policy
  devices revoke <id>  stop one phone from connecting (its sessions end at once)
  devices policy <level> [--window 5m|30m|1h]
                       Face ID level: none, terminal (default) or terminal+writes, and how long
                       one Face ID check lasts
  rotate-token         revoke every paired device and stop running agents
  tunnels              list your dev tunnels account's tunnels (it may keep 10)
  tunnels delete       choose tunnels to delete from a list (↑/↓, space, enter)
  tunnels delete <id>...  delete these; one that is online or is this computer's
                       needs --force (its URL changes, its phones unpair)
  update               install the latest coderemote (up says when there's one)
  requests [PORT]      list the requests that reached a previewed port, oldest first;
                       --grep TEXT, --failed (errors, 4xx and 5xx), --limit N (default 50)
  requests clear [PORT]  forget the recorded requests
  request <ID> [PORT]  headers and bodies of one request (bodies up to 64 KB are kept);
                       auth headers, cookies and token-like fields are masked unless
                       --show-secrets is given; --json on either for machine-readable output
  setup claude         let the app follow Claude Code sessions and answer their prompts
                       (installs the Code Remote plugin into Claude Code); --remove undoes it
  setup codex          the same for Codex (then trust its hooks once with /hooks in Codex)
  version              print this coderemote's version (also --version, -v)
  login                sign in to Microsoft Dev Tunnels with GitHub (up does this when needed);
                       --microsoft for a Microsoft account, --device-code without a browser

Options:
  --root DIR           folder to share (default: current folder)
  --port N             local port (default: the first free one from ${DEFAULT_PORT}; each port
                       keeps its own tunnel URL, so a folder pairs once per port)
  --allow-anonymous    up: skip the sign-in, the pairing token alone grants access
                       (alias --no-auth)
  --web                up: also run \`code tunnel\` and print a vscode.dev link that opens
                       this folder in VS Code in the browser (needs VS Code's \`code\`)
  --allow-sleep        up: let the computer sleep when idle (by default it stays awake while
                       sharing, so phones can reach it; the display still sleeps).
                       "keepAwake": false in ~/.coderemote/config.json makes it the default
  --no-lan             up: don't let phones on the same network connect directly (over TLS,
                       still with the token); they use the tunnel. "lan": false in
                       ~/.coderemote/config.json makes it the default, --lan overrides that`;

const HELP_FLAGS = ['help', '--help', '-help', '-h'];
const argv = process.argv.slice(2);
// Bare `coderemote` or `--help` anywhere shows usage rather than sharing a folder by accident.
// With a command (`coderemote devices --help`, `coderemote help devices`) only that command's help.
const helpFor = HELP_FLAGS.includes(argv[0]) ? argv[1] : argv[0];
const [cmd, ...rest] =
	argv.length === 0 || argv.some((a) => HELP_FLAGS.includes(a))
		? ['help', ...(helpFor && !HELP_FLAGS.includes(helpFor) ? [helpFor] : [])]
		: argv.some((a) => a === '--version' || a === '-v')
			? ['version']
			: argv;
const flag = (name) => {
	const i = rest.indexOf(name);
	return i >= 0 ? rest[i + 1] : undefined;
};
const anonymous = rest.includes('--allow-anonymous') || rest.includes('--no-auth');
// Without --port, `start` moves up from the default to the first port no agent or program holds.
let port = flag('--port') ? parseInt(flag('--port'), 10) : DEFAULT_PORT;
// The shared folder: files outside it are invisible to paired devices.
const root = path.resolve(flag('--root') ?? process.cwd());
const cfg = loadConfig();
const registry = new AgentRegistry(path.join(CONFIG_DIR, 'agents'));

/** A tunnel provider (src/providers) for this run. */
function tunnelProvider(name) {
	return providers[name].create({ configDir: CONFIG_DIR, spinner, cfg, saveConfig, loadConfig, defaultPort: DEFAULT_PORT });
}

/** `--tunnel <name>`, checked against the providers; exits on an unknown one. */
function providerFor(p) {
	try {
		return chooseProvider({ flag: flag('--tunnel') ?? (rest.includes('--tunnel') ? '' : undefined), remembered: cfg.tunnelProviders?.[p] });
	} catch (e) {
		console.error(e.message);
		process.exit(1);
	}
}

async function start({ tunnel }) {
	const agents = registry.list();
	if (flag('--port')) {
		const running = agents.find((a) => a.port === port);
		if (running) {
			console.error(`An agent already runs on port ${port} for ${running.root} (pid ${running.pid}).`);
			console.error('Stop it with `coderemote stop --all`, or pick another port with --port.');
			process.exit(1);
		}
	} else {
		const sharing = agents.find((a) => a.root === root);
		if (sharing) {
			console.error(`${root} is already shared on port ${sharing.port} (pid ${sharing.pid}).`);
			console.error('Stop it with `coderemote stop`, or start another one with --port.');
			process.exit(1);
		}
		// A folder keeps the port it had, so it comes back on the same tunnel URL its devices paired
		// with. A new folder takes the first port no other folder has claimed.
		const taken = async (p) => agents.some((a) => a.port === p) || !(await portFree(p));
		const remembered = cfg.folderPorts?.[root];
		if (remembered && !(await taken(remembered))) port = remembered;
		else {
			const claimed = new Set(Object.values(cfg.folderPorts ?? {}));
			while (claimed.has(port) || (await taken(port))) port++;
		}
		if (port !== remembered) {
			updateConfig(cfg, (c) => {
				c.folderPorts = { ...c.folderPorts, [root]: port };
			});
		}
	}
	let server;
	const providerName = tunnel ? providerFor(port) : null;
	if (providerName === 'cloud' && anonymous) {
		console.error('--allow-anonymous: a Code Remote Cloud tunnel always admits only its owner. Drop the flag, or use --tunnel devtunnels.');
		process.exit(1);
	}
	// Reported in /api/info while hosted; an agent started offline sets it once it connects.
	const session = tunnel
		? createTunnelSession({
				provider: tunnelProvider(providerName),
				port,
				anonymous,
				spinner,
				// Offline later, the QR still names it (its URL can't be worked out from the tunnel id).
				onUrl: (hosted) => {
					// Remembered only once it's up, so a failed first try doesn't switch the folder.
					updateConfig(cfg, (c) => {
						const urlChanged = rememberTunnelUrl(c, port, hosted);
						return rememberProvider(c, port, providerName) || urlChanged;
					});
				},
			})
		: null;
	const { preview = null, status = null, remover = null } = session?.services ?? {};
	// Devices on the same network connect directly, unless turned off (`up --no-lan`, `"lan": false`).
	const lanWanted = tunnel && (rest.includes('--no-lan') ? false : rest.includes('--lan') || cfg.lan !== false);
	let lanCert = null;
	let lan = { off: true };
	if (lanWanted) {
		const got = await lanCertificate(LAN_DIR);
		if (got.error) lan = { error: got.error };
		else lanCert = got;
	}
	// Phones reaching the agent through the tunnel encrypt end to end with this key (see SECURITY.md).
	let e2eKey = null;
	if (tunnel) {
		const got = loadIdentity(E2E_DIR);
		if (got.error) console.error(`End-to-end encryption is off (${got.error.message}); the tunnel relay can read tunnel traffic.`);
		else e2eKey = got;
	}
	const hadAgentId = cfg.agentIds?.[port];
	let agentId = ensureAgentId(cfg, port);
	if (agentId !== hadAgentId) {
		// Another agent may have given this port an ID meanwhile: keep the one saved.
		agentId = loadConfig().agentIds?.[port] ?? agentId;
		updateConfig(cfg, (c) => {
			c.agentIds = { ...c.agentIds, [port]: agentId };
		});
	}
	spinner.start('Starting agent');
	try {
		server = await listen(cfg.token, port, root, session?.tunnelToken ?? undefined, preview, status, remover, lanCert, agentId, () => session?.hostedUrl() ?? null, e2eKey, session?.provider.name ?? null);
	} catch (e) {
		spinner.fail();
		if (e.code !== 'EADDRINUSE') throw e;
		// Not in the registry: an agent from an older coderemote, or an unrelated program.
		console.error(`Port ${port} is already in use by another process.`);
		console.error(`See what holds it with: ${isWindows ? `netstat -ano | findstr :${port}` : `lsof -nP -iTCP:${port} -sTCP:LISTEN`}`);
		console.error('Stop that process, or pick another port with --port.');
		process.exit(1);
	}
	let advertiser = null;
	// Windows only: what its firewall makes of phones reaching the LAN port. Looked up while the
	// rest starts, never waited for.
	let firewall = null;
	if (lanCert) {
		lan = await openLan(server, port);
		if (lan.port) advertiser = await advertiseLan(lan.port, lanCert.fingerprint, port);
		if (lan.port && isWindows) {
			const lanPort = lan.port;
			firewall = firewallReport().then((report) => firewallAdvice(report, { lanPort, adapters: lanAdapters(os.networkInterfaces()) }));
		}
	}
	let access;
	let url = `http://127.0.0.1:${port}`;
	const connectTunnel = async (opts) => {
		({ url, access } = await session.connect(opts));
		return url;
	};

	let offline = false;
	// A provider's own refusal (signed out, no access, full): said once; the LAN keeps working.
	let tunnelError = null;
	if (tunnel) {
		spinner.succeed();
		// Without internet the agent still serves the local network, and connects its tunnel later.
		if (lan.port) {
			spinner.start('Checking the internet');
			offline = !(await session.provider.reachable());
		}
		if (!offline) {
			try {
				await connectTunnel({ interactive: true });
			} catch (e) {
				spinner.fail();
				if (e instanceof CloudError || e.code === 'ENOTSIGNEDIN') {
					// Never another provider by itself: say what to do, and keep serving the LAN.
					console.error(`\n${e.message}`);
					if (!lan.port) process.exit(1);
					tunnelError = e;
					url = null;
				} else {
					if (e.code !== 'ETUNNELLIMIT') throw e;
					const { provider } = session;
					if (!process.stdin.isTTY || !process.stderr.isTTY || !e.tunnels || !provider.resolveLimit) {
						console.error(`\n${e.message}`);
						process.exit(1);
					}
					if (!(await provider.resolveLimit(e))) process.exit(1);
					spinner.start(provider.text.connecting);
					await connectTunnel({ interactive: false });
				}
			}
		} else {
			spinner.fail();
			url = cfg.tunnelUrls?.[port] ?? null;
			session.connectLater().then((connected) => {
				registry.register({ port, root, url: connected });
				console.log(`\n  Tunnel connected: ${connected}`);
				console.log(`  Web:  ${webUrl({ url: connected, token: cfg.token })}  (through the relay: prefer the QR code)`);
				console.log('  Phones paired on this network pick it up on their own; sign in on them to use it away from here.\n');
			});
		}
	}
	spinner.succeed();
	registry.register({ port, root, url: url ?? `http://127.0.0.1:${port}` });
	const shutdown = async () => {
		session?.stop();
		advertiser?.kill();
		// Previews get a new tunnel every run, so this one would only take up a slot of the account's 10.
		await preview?.close();
		server.saveAgentSessions();
		await server.killAllSessions();
		server.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
	// Closing the terminal window sends SIGHUP; without this the tunnel host would outlive us.
	process.on('SIGHUP', shutdown);
	// Last resort for any other way out (an uncaught error): never leave the tunnel host behind.
	process.on('exit', () => {
		session?.stop();
		advertiser?.kill();
		preview?.stop();
	});
	// With the tunnel up the app learns the LAN route from /api/info: the QR stays small. Offline,
	// even with a remembered tunnel URL it can't reach yet, the QR is the phone's only way in.
	const lanLink = lan.port
		? {
				agentId,
				lan: offline || tunnelError ? { port: lan.port, addresses: qrAddresses(lanAddresses()), fingerprint: lanCert.fingerprint } : null,
			}
		: null;
	return { url, access, lan, offline, tunnelError, providerName, lanLink, firewall, publicKey: e2eKey?.publicKey ?? null };
}

// The plugin's marketplace is this repository; --marketplace points at a checkout to try changes.
const PLUGIN = 'coderemote@coderemote';

async function claudeCli(...args) {
	try {
		return (await execCommand(['claude', ...args], { timeout: 120_000 })).stdout.trim();
	} catch (e) {
		if (e.code === 'ENOENT') return null;
		throw new Error((e.stderr || e.stdout || e.message).trim());
	}
}

async function setupClaude() {
	const version = await claudeCli('--version');
	if (version === null) {
		console.error('Claude Code is required: install it from https://claude.com/claude-code, then run this again.');
		process.exit(1);
	}
	if (rest.includes('--remove')) {
		await claudeCli('plugin', 'uninstall', PLUGIN).catch((e) => console.error(e.message));
		await claudeCli('plugin', 'marketplace', 'remove', 'coderemote').catch(() => {});
		console.log('Removed the Code Remote plugin. New Claude Code sessions no longer reach the app.');
		return;
	}
	const source = flag('--marketplace') ?? 'CodeRemoteApp/coderemote';
	spinner.start(`Installing the Code Remote plugin into ${version}`);
	try {
		// Adding it again when it is already there succeeds; refreshing then picks up the latest plugin.
		await claudeCli('plugin', 'marketplace', 'add', source);
		await claudeCli('plugin', 'marketplace', 'update', 'coderemote').catch(() => {});
		await claudeCli('plugin', 'install', PLUGIN);
		// Installing over an installed plugin keeps the old copy; this brings it to the latest.
		await claudeCli('plugin', 'update', PLUGIN).catch(() => {});
	} catch (e) {
		spinner.fail();
		console.error(e.message);
		process.exit(1);
	}
	spinner.succeed();
	console.log('\n  New Claude Code sessions in a folder shared with `coderemote up` now show in the');
	console.log('  app’s Agents tab, where you can answer their permission prompts and questions.');
	console.log('  Sessions already running pick it up after a restart. Undo: coderemote setup claude --remove\n');
}

const CODEX_PLUGIN = 'coderemote@coderemote';

async function codexCli(...args) {
	try {
		return (await execCommand(['codex', ...args], { timeout: 120_000 })).stdout.trim();
	} catch (e) {
		if (e.code === 'ENOENT') return null;
		throw new Error((e.stderr || e.stdout || e.message).trim());
	}
}

async function setupCodex() {
	const version = await codexCli('--version');
	if (version === null) {
		console.error('Codex is required: install it (npm install -g @openai/codex), then run this again.');
		process.exit(1);
	}
	// The `hooks` feature arrived in Codex 0.139; older ones can't report sessions.
	const hooks = (await codexCli('features', 'list')).split('\n').find((line) => /^hooks\s/.test(line));
	if (!hooks) {
		console.error(`${version} has no hooks. Update Codex to 0.139 or later (codex update), then run this again.`);
		process.exit(1);
	}
	if (rest.includes('--remove')) {
		await codexCli('plugin', 'remove', CODEX_PLUGIN).catch((e) => console.error(e.message));
		await codexCli('plugin', 'marketplace', 'remove', 'coderemote').catch(() => {});
		console.log('Removed the Code Remote plugin. New Codex sessions no longer reach the app.');
		return;
	}
	const given = flag('--marketplace');
	const source = given ?? 'CodeRemoteApp/coderemote';
	spinner.start(`Installing the Code Remote plugin into ${version}`);
	try {
		if (/\bfalse\s*$/.test(hooks)) await codexCli('features', 'enable', 'hooks');
		const known = /^coderemote\s/m.test(await codexCli('plugin', 'marketplace', 'list'));
		if (known && given) {
			// A source given explicitly replaces whatever the marketplace pointed at before.
			await codexCli('plugin', 'marketplace', 'remove', 'coderemote').catch(() => {});
			await codexCli('plugin', 'marketplace', 'add', source);
		} else if (known) {
			await codexCli('plugin', 'marketplace', 'upgrade', 'coderemote').catch(() => {});
		} else {
			await codexCli('plugin', 'marketplace', 'add', source);
		}
		await codexCli('plugin', 'add', CODEX_PLUGIN);
	} catch (e) {
		spinner.fail();
		console.error(e.message);
		if (/not found in marketplace/.test(e.message) && !given) {
			console.error('Your coderemote may be newer than the published plugin; point at a checkout with --marketplace <dir>.');
		}
		process.exit(1);
	}
	spinner.succeed();
	console.log('\n  One more step, once: open Codex, type /hooks and trust the Code Remote hooks.');
	console.log('  Codex runs a plugin\'s hooks only after you have reviewed them.');
	console.log('  Then new Codex sessions in a folder shared with `coderemote up` show in the app.');
	console.log('  Undo: coderemote setup codex --remove\n');
}

/** Calls a running agent's local API. */
async function agentApi(agent, method, route, query = {}, payload = undefined) {
	const url = new URL(route, `http://127.0.0.1:${agent.port}`);
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
	const call = (authorization) =>
		fetch(url, {
			method,
			headers: { authorization, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
			body: payload === undefined ? undefined : JSON.stringify(payload),
		});
	// The local secret is how this CLI is let in once phones are enrolled; an agent from before
	// device keys doesn't know it and still takes the pairing token.
	const local = loadLocalSecret(LOCAL_SECRET_FILE).secret;
	let res = local ? await call(`Local ${local}`) : null;
	if (!res || res.status === 401) res = await call(`Bearer ${cfg.token}`);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
	return body;
}

async function sessionsOf(agent) {
	try {
		return (await agentApi(agent, 'GET', '/api/term')).sessions;
	} catch (e) {
		console.error(`  could not reach agent on port ${agent.port}: ${e.message}`);
		return [];
	}
}

/** The agent sharing the current folder (or one above it), else the only one running. */
function currentAgent() {
	const agents = registry.list();
	if (flag('--port')) return agents.find((a) => a.port === port);
	const here = process.cwd();
	const containing = agents
		.filter((a) => here === a.root || here.startsWith(a.root + path.sep))
		.sort((a, b) => b.root.length - a.root.length);
	return containing[0] ?? (agents.length === 1 ? agents[0] : undefined);
}

/** The ports to read: the one given, else every port being previewed now. */
async function previewPorts(agent, given) {
	if (given) return [given];
	let ports = [];
	try {
		ports = (await agentApi(agent, 'GET', '/api/preview')).ports.map((p) => p.port);
	} catch {}
	if (!ports.length) {
		console.error('No port is being previewed. Open a preview from the app, or name the port (a closed preview keeps its log).');
		process.exit(1);
	}
	return ports;
}

function ago(ms) {
	const s = Math.round((Date.now() - ms) / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return `${Math.round(s / 86400)}d`;
}

switch (cmd) {
	case 'hook': {
		// Claude Code waits on this; print only a decision, and never fail.
		let out = '';
		try {
			const chunks = [];
			for await (const c of process.stdin) chunks.push(c);
			out = await runHook({
				input: Buffer.concat(chunks).toString('utf8'),
				agents: registry.list(),
				secret: readHookSecret(CONFIG_DIR),
				agent: flag('--agent') ?? 'claude',
			});
		} catch {}
		if (out) process.stdout.write(`${out}\n`);
		process.exit(0);
	}
	case 'setup': {
		if (rest[0] === 'claude') await setupClaude();
		else if (rest[0] === 'codex') await setupCodex();
		else {
			console.error(commandHelp(USAGE, 'setup'));
			process.exit(1);
		}
		break;
	}
	case 'serve': {
		await start({ tunnel: false });
		console.log(`coderemote agent on http://127.0.0.1:${port}\nSharing: ${root}\nToken: ${cfg.token}`);
		break;
	}
	case 'up': {
		// Asked alongside the tunnel setup, which takes longer, so it never delays the QR code.
		const update =
			PACKAGED && !process.env.CODEREMOTE_NO_UPDATE_CHECK
				? availableUpdate({ current: VERSION, dir: CONFIG_DIR }).catch(() => null)
				: null;
		let started;
		try {
			started = await start({ tunnel: true });
		} catch (e) {
			spinner.fail();
			throw e;
		}
		const { url, access, lan, offline, tunnelError, providerName, lanLink, firewall, publicKey } = started;
		// Asleep, the computer drops off the network: phones lose it until someone wakes it.
		const awake = rest.includes('--allow-sleep') || cfg.keepAwake === false ? null : keepAwake();
		if (awake) process.on('exit', () => awake.stop());
		const vscodeUrl = rest.includes('--web') && !offline ? await startVSCodeTunnel() : null;
		console.log(`\n  Sharing: ${root}`);
		if (offline) console.log('  Tunnel:  not connected (no internet); phones on this network can pair and connect. It connects on its own once the internet is back.');
		if (tunnelError) console.log('  Tunnel:  not connected (see above); phones on this network can pair and connect.');
		if (lan.port) {
			console.log(`  LAN:     on (port ${lan.port}); phones on this network connect directly`);
			if (process.platform === 'darwin') console.log('           If macOS asks whether node may accept incoming connections, choose Allow.');
			if (isWindows) console.log('           If Windows asks whether node may accept incoming connections, choose Allow (Private networks).');
		} else if (lan.error) console.log(`  LAN:     off (${lan.error}); phones connect through the tunnel`);
		if (awake) console.log('  Sleep:   kept awake while sharing (the display can still sleep); --allow-sleep to turn off');
		// Shown with the rest when it's in by now, else as soon as it is.
		const showFirewall = (lines) => {
			if (lines.length) console.log(`\n${lines.map((l) => `  ${l}`).join('\n')}\n`);
		};
		let firewallLines = null;
		firewall?.then((lines) => (firewallLines = lines));
		await new Promise((r) => setImmediate(r));
		if (firewallLines) showFirewall(firewallLines);
		else firewall?.then(showFirewall);
		printPairing(url, cfg.token, access, vscodeUrl, lanLink, publicKey);
		if (providerName === 'cloud' && url) {
			console.log('  Cloud tunnels need Code Remote for iOS with Code Remote Cloud sign-in; on this Wi-Fi you can also pair over the LAN.\n');
		}
		const newer = await update;
		if (newer) {
			const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
			console.log(`  ${c('1;33', '⬆ Update available:')} ${c('2', VERSION)} → ${c('1;32', newer)}. Run ${c('36', 'coderemote update')} to install it.\n`);
		}
		break;
	}
	case 'status':
	case 'ps': {
		const agents = registry.list();
		if (!agents.length) {
			console.log('No agent is running. Start one with `coderemote up`.');
			break;
		}
		for (const agent of agents) {
			console.log(`${agent.root}  (pid ${agent.pid}, port ${agent.port}, up ${ago(agent.startedAt)})`);
			if (agent.url) console.log(`  ${agent.url}`);
			const sessions = await sessionsOf(agent);
			if (!sessions.length) console.log('  no terminal sessions');
			for (const s of sessions) {
				const attached = s.attached ? `${s.attached} attached` : 'detached';
				console.log(`  ${s.id.slice(0, 8)}  ${s.title.padEnd(12)} pid ${String(s.pid).padEnd(7)} ${ago(s.createdAt).padEnd(4)} ${attached}`);
			}
		}
		break;
	}
	case 'kill': {
		const all = rest.includes('--all');
		const ids = rest.filter((a) => !a.startsWith('--'));
		if (!all && !ids.length) {
			console.error('Usage: coderemote kill <session-id>... | --all');
			process.exit(1);
		}
		let killed = 0;
		const matched = new Set();
		for (const agent of registry.list()) {
			for (const s of await sessionsOf(agent)) {
				const hit = ids.find((id) => s.id.startsWith(id));
				if (!all && !hit) continue;
				if (hit) matched.add(hit);
				await agentApi(agent, 'DELETE', '/api/term', { id: s.id });
				console.log(`killed ${s.id.slice(0, 8)} (${s.title}) in ${agent.root}`);
				killed++;
			}
		}
		for (const id of ids.filter((id) => !matched.has(id))) console.error(`no session matches ${id}`);
		if (all && !killed) console.log('No terminal sessions to kill.');
		if (ids.length && matched.size < ids.length) process.exit(1);
		break;
	}
	case 'stop': {
		const agents = registry.list();
		const targets = rest.includes('--all') ? agents : agents.filter((a) => a.root === root);
		if (!targets.length) {
			console.log(agents.length ? `No agent is sharing ${root}. Use \`coderemote stop --all\`.` : 'No agent is running.');
			break;
		}
		for (const agent of targets) {
			stopAgent(agent.pid);
			console.log(`stopped agent for ${agent.root} (pid ${agent.pid})`);
		}
		break;
	}
	case 'devices': {
		const agent = currentAgent();
		if (!agent) {
			console.error('No running agent for this folder. Start one with `coderemote up`, or pass --port.');
			process.exit(1);
		}
		const args = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--window' && rest[i - 1] !== '--port');
		const sub = args[0];
		const windowName = (seconds) => Object.entries(PRESENCE_WINDOWS).find(([, s]) => s === seconds)?.[0];
		try {
			if (sub === 'revoke') {
				const { devices } = await agentApi(agent, 'GET', '/api/devices');
				const matches = devices.filter((d) => args[1] && d.id.startsWith(args[1]));
				if (matches.length !== 1) {
					console.error(args[1] ? `${matches.length ? 'More than one' : 'No'} device matches ${args[1]}.` : 'Usage: coderemote devices revoke <id>');
					process.exit(1);
				}
				await agentApi(agent, 'DELETE', '/api/devices', { id: matches[0].id });
				console.log(`Revoked ${matches[0].name} (${matches[0].id}).`);
			} else if (sub === 'policy') {
				const level = args[1];
				const windowFlag = flag('--window');
				const change = {};
				if (level) change.level = level;
				if (windowFlag) {
					if (!PRESENCE_WINDOWS[windowFlag]) {
						console.error('--window is 5m, 30m or 1h.');
						process.exit(1);
					}
					change.window = PRESENCE_WINDOWS[windowFlag];
				}
				if (!level && !windowFlag) {
					console.error('Usage: coderemote devices policy <none|terminal|terminal+writes> [--window 5m|30m|1h]');
					process.exit(1);
				}
				const now = await agentApi(agent, 'PUT', '/api/device/policy', {}, change);
				console.log(`Face ID: ${now.level}, one check lasts ${windowName(now.window)}.`);
			} else if (sub === undefined) {
				const { devices } = await agentApi(agent, 'GET', '/api/devices');
				const info = await agentApi(agent, 'GET', '/api/info');
				if (!info.devices) {
					console.log('This agent has no device keys (it was started without a tunnel).');
					break;
				}
				console.log(`Sharing ${agent.root}`);
				console.log(`Face ID: ${info.devices.presence}, one check lasts ${windowName(info.devices.presenceWindow)}${info.devices.strict ? '' : ' (applies once a phone is enrolled)'}`);
				if (!devices.length) console.log('No phones enrolled yet: the app enrolls one when it pairs.');
				for (const d of devices) {
					const seen = d.lastSeen ? new Date(d.lastSeen).toLocaleString() : 'never';
					console.log(`  ${d.id}  ${d.name}${d.presence ? '' : '  (no Face ID key)'}  enrolled ${new Date(d.enrolledAt).toLocaleDateString()}, last seen ${seen}`);
				}
			} else {
				console.error(`Unknown subcommand: devices ${sub}\n\n${commandHelp(USAGE, 'devices')}`);
				process.exit(1);
			}
		} catch (e) {
			console.error(`coderemote devices: ${e.message}`);
			process.exit(1);
		}
		break;
	}
	case 'rotate-token': {
		cfg.token = randomBytes(32).toString('base64url');
		saveConfig(cfg);
		// Paired phones pinned the LAN certificate; a new one makes them learn it again.
		fs.rmSync(LAN_DIR, { recursive: true, force: true });
		// Running agents hold the old token in memory and would keep honoring it, so stop them all.
		const agents = registry.list();
		for (const agent of agents) {
			stopAgent(agent.pid);
			console.log(`stopped agent for ${agent.root} (pid ${agent.pid})`);
		}
		console.log('Token rotated. Re-pair your devices.');
		if (agents.length) console.log('Run `coderemote up` again in each folder above; each keeps its tunnel URL.');
		break;
	}
	case 'tunnels': {
		// The folder's own provider, unless asked: `--cloud`, or Cloud's `--delete <host>`.
		const folderPort = cfg.folderPorts?.[root] ?? DEFAULT_PORT;
		const name = rest.includes('--cloud') || rest.includes('--delete') ? 'cloud' : providerFor(folderPort);
		await cloudCommand(() => tunnelProvider(name).commands.tunnels(rest.filter((a) => a !== '--cloud')));
		break;
	}
	case 'login': {
		await cloudCommand(() => tunnelProvider(rest.includes('--cloud') ? 'cloud' : 'devtunnels').commands.login(rest.filter((a) => a !== '--cloud')));
		break;
	}
	case 'logout': {
		if (!rest.includes('--cloud')) {
			console.error('Usage: coderemote logout --cloud  (dev tunnels: `devtunnel user logout`)');
			process.exit(1);
		}
		await cloudCommand(() => tunnelProvider('cloud').commands.logout());
		break;
	}
	case 'update': {
		if (!PACKAGED) {
			console.log('This coderemote runs from a source checkout: update it with `git pull`.');
			break;
		}
		const latest = await fetchLatest({ timeoutMs: 10_000 });
		if (!latest) {
			console.error("Couldn't reach the npm registry. Try again, or run `npm install -g coderemote@latest`.");
			process.exit(1);
		}
		if (!isNewer(latest, VERSION)) {
			console.log(`coderemote ${VERSION} is the latest version.`);
			break;
		}
		const [command, args] = installCommand(fs.realpathSync(process.argv[1]));
		console.log(`Updating coderemote ${VERSION} → ${latest}: ${command} ${args.join(' ')}\n`);
		const code = await new Promise((resolve) => {
			spawnCommand([command, ...args], { stdio: 'inherit' })
				.on('exit', resolve)
				.on('error', () => resolve(127));
		});
		if (code !== 0) {
			console.error(`\nThe update failed (${command} exited with ${code}).`);
			if (!isWindows && command === 'npm') console.error(`If it was a permission error (EACCES), run it with sudo: sudo ${command} ${args.join(' ')}`);
			process.exit(code || 1);
		}
		const running = registry.list();
		console.log(`\nUpdated to coderemote ${latest}.`);
		if (running.length) {
			console.log(`${running.length === 1 ? 'An agent is' : `${running.length} agents are`} still running the previous version.`);
			console.log('Restart: `coderemote stop --all`, then `coderemote up` in each shared folder.');
		}
		break;
	}
	case 'requests':
	case 'request': {
		const agent = currentAgent();
		if (!agent) {
			const running = registry.list();
			console.error(
				flag('--port')
					? `No agent is running on port ${port}.`
					: running.length
					? `Several agents are running; run this inside a shared folder or pick one with --port (${running.map((a) => a.port).join(', ')}).`
					: 'No agent is running. Start one with `coderemote up`.',
			);
			process.exit(1);
		}
		const valued = new Set(['--grep', '--limit', '--port']);
		const words = rest.filter((a, i) => !a.startsWith('--') && !valued.has(rest[i - 1]));
		const json = rest.includes('--json');
		const redactor = new Redactor({ show: rest.includes('--show-secrets') });
		const hint = () => {
			if (redactor.hidden && !json) console.error(`\n(${redactor.hidden} secret value${redactor.hidden === 1 ? '' : 's'} masked; add --show-secrets to print them)`);
		};

		if (cmd === 'request') {
			const id = parseInt(words[0], 10);
			if (!id) {
				console.error('Usage: coderemote request <ID> [PORT] [--show-secrets] [--json]');
				process.exit(1);
			}
			// Ids are unique across ports, so without a port each previewed one is tried.
			let found;
			for (const p of await previewPorts(agent, words[1])) {
				try {
					found = await agentApi(agent, 'GET', '/api/preview/request', { port: p, id });
					break;
				} catch {}
			}
			if (!found) {
				console.error(`No request #${id} (only the latest 200 per port are kept).`);
				process.exit(1);
			}
			console.log(json ? JSON.stringify(redactDetail(found, redactor), null, 2) : formatDetail(found, redactor));
			hint();
			break;
		}

		if (words[0] === 'clear') {
			for (const p of await previewPorts(agent, words[1])) {
				await agentApi(agent, 'DELETE', '/api/preview/requests', { port: p });
				console.log(`cleared the requests to port ${p}`);
			}
			break;
		}

		const ports = await previewPorts(agent, words[0]);
		let requests = [];
		for (const p of ports) {
			const { requests: list } = await agentApi(agent, 'GET', '/api/preview/requests', { port: p });
			requests.push(...list.map((r) => ({ ...r, port: Number(p) })));
		}
		requests.sort((a, b) => a.id - b.id);
		requests = filterRequests(requests, { grep: flag('--grep'), failed: rest.includes('--failed') });
		const limit = parseInt(flag('--limit'), 10) || 50;
		const total = requests.length;
		requests = requests.slice(-limit);
		if (json) {
			console.log(JSON.stringify(requests.map((r) => ({ ...r, path: redactor.path(r.path) })), null, 2));
			break;
		}
		if (!total) {
			console.log('No matching requests.');
			break;
		}
		console.log(formatList(requests, redactor, { showPort: ports.length > 1 }));
		if (total > requests.length) console.error(`\n(${total - requests.length} older not shown; raise --limit)`);
		console.error('\nDetails: coderemote request <ID>');
		hint();
		break;
	}
	case 'version':
		console.log(VERSION);
		break;
	case 'help': {
		if (!rest[0]) {
			console.log(USAGE);
			break;
		}
		const help = commandHelp(USAGE, rest[0]);
		if (!help) {
			console.error(`Unknown command: ${rest[0]}\n\n${USAGE}`);
			process.exit(1);
		}
		console.log(help);
		break;
	}
	default:
		console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
		process.exit(1);
}
