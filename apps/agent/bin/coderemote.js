#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import qrcode from 'qrcode-terminal';
import { createAgentServer } from '@vsremote/agent-core';
import { ensureDevtunnel } from '../src/devtunnel.js';
import { PreviewTunnel } from '../src/preview.js';
import { AgentRegistry } from '../src/registry.js';
import { Spinner } from '../src/spinner.js';
import { codeTunnelLogin, codeTunnelSignedIn, findCode, hostCodeTunnel } from '../src/vscode-tunnel.js';
import { pairingUrl, webUrl } from '@vsremote/protocol';

const run = promisify(execFile);
const CONFIG_DIR = path.join(os.homedir(), '.coderemote');
// Releases before the rename kept their token and tunnel here; moving them keeps every pairing.
const LEGACY_CONFIG_DIR = path.join(os.homedir(), '.vsremote');
if (!fs.existsSync(CONFIG_DIR) && fs.existsSync(LEGACY_CONFIG_DIR)) fs.renameSync(LEGACY_CONFIG_DIR, CONFIG_DIR);
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_PORT = 31580;
const spinner = new Spinner();

function loadConfig() {
	let cfg = {};
	try {
		cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
	} catch {}
	if (!cfg.token) {
		cfg.token = randomBytes(32).toString('base64url');
		saveConfig(cfg);
	}
	return cfg;
}

function saveConfig(cfg) {
	fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function listen(token, port, root, tunnelToken, preview) {
	const server = createAgentServer({ token, root, tunnelToken, preview });
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		// Loopback only: remote access goes exclusively through the tunnel.
		server.listen(port, '127.0.0.1', () => resolve(server));
	});
}

// The Dev Tunnels CLI: the one on PATH, or a copy downloaded into ~/.coderemote/bin on first use.
let DEVTUNNEL = 'devtunnel';

async function resolveDevtunnel() {
	let installing = false;
	DEVTUNNEL = await ensureDevtunnel({
		dir: path.join(CONFIG_DIR, 'bin'),
		progress: (detail) => {
			if (!installing) {
				installing = true;
				spinner.start('Installing devtunnel (Microsoft Dev Tunnels CLI, one time)');
			}
			spinner.update(detail);
		},
	});
	if (installing) spinner.succeed();
}

async function devtunnel(...args) {
	try {
		const { stdout } = await run(DEVTUNNEL, args);
		return { ok: true, out: stdout };
	} catch (e) {
		return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` || e.message };
	}
}

/** `devtunnel user login` arguments: GitHub by default, as `coderemote login` documents. */
function loginArgs(opts = rest) {
	const args = ['user', 'login'];
	if (!opts.includes('--microsoft')) args.push('-g');
	if (opts.includes('--device-code')) args.push('-d');
	return args;
}

function interactiveLogin(args) {
	return new Promise((resolve) => {
		spawn(DEVTUNNEL, args, { stdio: 'inherit' }).on('exit', resolve);
	});
}

// `devtunnel user show` exits 0 even when the login has expired, so match the text.
const LOGIN_NEEDED = /not logged in|login token expired|login required|please log ?in/i;

/** Runs `devtunnel user login` in this terminal (it opens the browser), or explains how to. */
async function login(reason) {
	spinner.stop();
	console.error(`Dev tunnels: ${reason.trim()}`);
	if (!process.stdin.isTTY) {
		console.error('Run `coderemote login` (--microsoft for a Microsoft account), then try again.');
		process.exit(1);
	}
	console.error('Signing in with GitHub (use `coderemote login --microsoft` for a Microsoft account)...\n');
	if ((await interactiveLogin(loginArgs([]))) !== 0) {
		console.error('\nLogin failed. Run `coderemote login` (--microsoft, --device-code), then try again.');
		process.exit(1);
	}
}

/** The signed-in dev tunnels account, e.g. "thanh (GitHub)", logging in first when needed. */
async function tunnelUser() {
	let who = await devtunnel('user', 'show');
	if (!who.ok || LOGIN_NEEDED.test(who.out)) {
		await login(who.out || 'not logged in');
		who = await devtunnel('user', 'show');
	}
	// "Logged in as thanh using GitHub."
	const m = who.out.match(/Logged in as (\S+) using (\S+?)\.?\s*$/m);
	return m ? `${m[1]} (${m[2]})` : who.out.trim();
}

/**
 * Makes the tunnel private (only the account that owns it, after signing in on the phone or
 * browser) or anonymous (the agent token alone). The tunnel id, and so its URL, never changes.
 */
function applyAccess(tunnelId, anonymous) {
	return anonymous
		? devtunnel('access', 'create', tunnelId, '--anonymous')
		: devtunnel('access', 'reset', tunnelId);
}

async function ensureTunnel(cfg, port, anonymous) {
	if (cfg.tunnelId) {
		// Each devtunnel call takes 1-2s, so run them together. Tunnels expire 30 days after the
		// last update; pushing that back keeps the URL (and every pairing) for good.
		const [updated, access] = await Promise.all([
			devtunnel('update', cfg.tunnelId, '--expiration', '30d'),
			applyAccess(cfg.tunnelId, anonymous),
		]);
		if (updated.ok) {
			if (!access.ok) throw new Error(`devtunnel access failed:\n${access.out}`);
			return cfg.tunnelId;
		}
		// Only a tunnel that's really gone is replaced: a new one changes the URL and unpairs every device.
		if (!/not found/i.test(updated.out)) throw new Error(`devtunnel update failed:\n${updated.out}`);
	}

	// Every request needs the agent's bearer token either way; a private tunnel also needs a sign-in.
	const createArgs = ['create', '--expiration', '30d', '-d', `coderemote ${os.hostname()}`, '--json'];
	if (anonymous) createArgs.push('--allow-anonymous');
	const created = await devtunnel(...createArgs);
	if (!created.ok) throw new Error(`devtunnel create failed:\n${created.out}`);
	const tunnelId = JSON.parse(created.out.slice(created.out.indexOf('{'))).tunnel?.tunnelId;
	if (!tunnelId) throw new Error(`could not parse tunnel id from:\n${created.out}`);

	const portRes = await devtunnel('port', 'create', tunnelId, '-p', String(port), '--protocol', 'http');
	if (!portRes.ok) throw new Error(`devtunnel port create failed:\n${portRes.out}`);

	cfg.tunnelId = tunnelId;
	saveConfig(cfg);
	return tunnelId;
}

/** A dev tunnels connect token (24h) for the app's sign-in handoff and renewals. */
async function connectToken(tunnelId) {
	const res = await devtunnel('token', tunnelId, '--scopes', 'connect', '--json');
	if (!res.ok) throw new Error(res.out.trim());
	const body = JSON.parse(res.out.slice(res.out.indexOf('{')));
	// "2026-10-27 01:52:06 UTC"
	const expiresAt = Date.parse(body.expiration.replace(' UTC', 'Z').replace(' ', 'T'));
	if (!body.token || !Number.isFinite(expiresAt)) throw new Error(`unexpected devtunnel token output:\n${res.out}`);
	return { token: body.token, expiresAt };
}

function hostTunnel(tunnelId, port) {
	return new Promise((resolve, reject) => {
		const child = spawn(DEVTUNNEL, ['host', tunnelId], { stdio: ['ignore', 'pipe', 'pipe'] });
		let log = '';
		const onData = (d) => {
			log += d;
			const m = log.match(new RegExp(`https://\\S*-${port}\\.\\S*devtunnels\\.ms\\S*`));
			if (m) resolve({ child, url: m[0].replace(/\/$/, '') });
		};
		child.stdout.on('data', onData);
		child.stderr.on('data', onData);
		child.on('exit', (code) => reject(new Error(`devtunnel host exited (${code}):\n${log}`)));
	});
}

function printPairing(url, token, access, vscodeUrl) {
	const pair = pairingUrl({ url, token });
	if (access) console.log(`  Access:  ${access}`);
	// Labels line up whether or not the VS Code row is there.
	const label = (name) => `${name}:`.padEnd(vscodeUrl ? 9 : 4);
	console.log('');
	if (vscodeUrl) console.log(`  ${label('VS Code')}  ${vscodeUrl}`);
	console.log(`  ${label('Web')}  ${webUrl({ url, token })}`);
	console.log(`  ${label('App')}  ${pair}\n`);
	if (vscodeUrl) console.log('  VS Code opens in the browser after signing in with the account of `code tunnel`.');
	console.log('  Scan with the iPhone Camera, or open either link on the phone:\n');
	qrcode.generate(pair, { small: true });
	console.log(
		anonymous
			? '\n  The links contain your access token. Anyone with them can use this machine.'
			: '\n  The links contain your access token; the phone or browser must also sign in as you.',
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

  up                   share this folder through a dev tunnel and print the pairing QR;
                       the phone or browser must sign in with your dev tunnels account
  serve                share this folder on 127.0.0.1 only (no tunnel)
  status               list running agents and their terminal sessions
  kill <id>... | --all kill terminal sessions (an id prefix is enough)
  stop [--all]         stop the agent for this folder (or every agent)
  rotate-token         revoke every paired device
  login                sign in to Microsoft Dev Tunnels with GitHub (up does this when needed);
                       --microsoft for a Microsoft account, --device-code without a browser

Options:
  --root DIR           folder to share (default: current folder)
  --port N             local port (default: ${DEFAULT_PORT})
  --allow-anonymous    up: skip the sign-in, the pairing token alone grants access
                       (alias --no-auth)
  --web                up: also run \`code tunnel\` and print a vscode.dev link that opens
                       this folder in VS Code in the browser (needs VS Code's \`code\`)`;

const HELP_FLAGS = ['help', '--help', '-help', '-h'];
const argv = process.argv.slice(2);
// Bare `coderemote` or `--help` anywhere shows usage rather than sharing a folder by accident.
const [cmd, ...rest] = argv.length === 0 || argv.some((a) => HELP_FLAGS.includes(a)) ? ['help'] : argv;
const flag = (name) => {
	const i = rest.indexOf(name);
	return i >= 0 ? rest[i + 1] : undefined;
};
const anonymous = rest.includes('--allow-anonymous') || rest.includes('--no-auth');
const port = flag('--port') ? parseInt(flag('--port'), 10) : DEFAULT_PORT;
// The shared folder: files outside it are invisible to paired devices.
const root = path.resolve(flag('--root') ?? process.cwd());
const cfg = loadConfig();
const registry = new AgentRegistry(path.join(CONFIG_DIR, 'agents'));

async function start({ tunnel }) {
	const running = registry.list().find((a) => a.port === port);
	if (running) {
		console.error(`An agent already runs on port ${port} for ${running.root} (pid ${running.pid}).`);
		console.error('Stop it with `coderemote stop --all`, or pick another port with --port.');
		process.exit(1);
	}
	let server;
	// Set once the tunnel exists; anonymous tunnels hand out nothing.
	let tunnelId;
	const tunnelToken = async () => (tunnel && !anonymous && tunnelId ? connectToken(tunnelId) : null);
	// Created on the first preview; keyed by port so agents for different folders don't share one.
	const preview = tunnel
		? new PreviewTunnel({
				devtunnel,
				command: () => DEVTUNNEL,
				description: `coderemote preview ${os.hostname()}`,
				leftover: cfg.previewTunnels?.[port],
				remember: (id) => {
					cfg.previewTunnels = { ...cfg.previewTunnels, [port]: id };
					saveConfig(cfg);
				},
				mintToken: connectToken,
			})
		: null;
	spinner.start('Starting agent');
	try {
		server = await listen(cfg.token, port, root, tunnelToken, preview);
	} catch (e) {
		spinner.fail();
		if (e.code !== 'EADDRINUSE') throw e;
		// Not in the registry: an agent from an older coderemote, or an unrelated program.
		console.error(`Port ${port} is already in use by another process.`);
		console.error(`See what holds it with: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
		console.error('Stop that process, or pick another port with --port.');
		process.exit(1);
	}
	let child;
	let access;
	let url = `http://127.0.0.1:${port}`;
	if (tunnel) {
		spinner.succeed();
		await resolveDevtunnel();
		spinner.start('Checking dev tunnels sign-in');
		const user = await tunnelUser();
		spinner.succeed();
		// Connecting to the relay is the slow part; update the tunnel's settings meanwhile.
		spinner.start('Connecting to the relay');
		const known = cfg.tunnelId;
		let hosting = known ? hostTunnel(known, port) : null;
		hosting?.catch(() => {});
		tunnelId = await ensureTunnel(cfg, port, anonymous);
		if (tunnelId !== known) {
			// The saved tunnel was gone and a new one was created.
			hosting?.then((h) => h.child.kill(), () => {});
			hosting = hostTunnel(tunnelId, port);
		}
		({ child, url } = await hosting);
		access = anonymous
			? 'anyone with the link (no sign-in, --allow-anonymous)'
			: `sign-in required as ${user}`;
	}
	spinner.succeed();
	registry.register({ port, root, url });
	const shutdown = () => {
		child?.kill();
		preview?.stop();
		server.killAllSessions();
		server.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
	// Closing the terminal window sends SIGHUP; without this the tunnel host would outlive us.
	process.on('SIGHUP', shutdown);
	// Last resort for any other way out (an uncaught error): never leave the tunnel host behind.
	process.on('exit', () => {
		child?.kill();
		preview?.stop();
	});
	return { url, access };
}

/** Calls a running agent's local API. */
async function agentApi(agent, method, route, query = {}) {
	const url = new URL(route, `http://127.0.0.1:${agent.port}`);
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
	const res = await fetch(url, { method, headers: { authorization: `Bearer ${cfg.token}` } });
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

function ago(ms) {
	const s = Math.round((Date.now() - ms) / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return `${Math.round(s / 86400)}d`;
}

switch (cmd) {
	case 'serve': {
		await start({ tunnel: false });
		console.log(`coderemote agent on http://127.0.0.1:${port}\nSharing: ${root}\nToken: ${cfg.token}`);
		break;
	}
	case 'up': {
		let started;
		try {
			started = await start({ tunnel: true });
		} catch (e) {
			spinner.fail();
			throw e;
		}
		const { url, access } = started;
		const vscodeUrl = rest.includes('--web') ? await startVSCodeTunnel() : null;
		console.log(`\n  Sharing: ${root}`);
		printPairing(url, cfg.token, access, vscodeUrl);
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
			process.kill(agent.pid, 'SIGTERM');
			console.log(`stopped agent for ${agent.root} (pid ${agent.pid})`);
		}
		break;
	}
	case 'rotate-token': {
		cfg.token = randomBytes(32).toString('base64url');
		saveConfig(cfg);
		console.log('Token rotated. Re-pair your devices, and restart running agents.');
		break;
	}
	case 'login': {
		await resolveDevtunnel();
		process.exit(await interactiveLogin(loginArgs()));
	}
	case 'help':
		console.log(USAGE);
		break;
	default:
		console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
		process.exit(1);
}
