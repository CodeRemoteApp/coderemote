// Listening TCP ports of the agent's user, so a phone can see what dev servers are up and stop them.
// lsof covers macOS and most Linux installs; Linux without it falls back to `ss` and /proc.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { HttpError } from './sandbox.js';

function run(cmd, args) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
			// lsof exits 1 both when nothing matches and when some sockets can't be read; the
			// output it did print is still good.
			if (err?.code === 'ENOENT') reject(err);
			else resolve(stdout || '');
		});
	});
}

/** "127.0.0.1:3000", "*:3000", "[::1]:3000" -> { address, port } */
function splitHostPort(name) {
	const i = name.lastIndexOf(':');
	const port = parseInt(name.slice(i + 1), 10);
	if (i < 0 || !Number.isInteger(port)) return null;
	return { address: name.slice(0, i).replace(/^\[|\]$/g, ''), port };
}

/** @returns {Promise<{pid: number, name: string, address: string, port: number}[]>} */
async function listeningSockets() {
	try {
		const out = await run('lsof', ['-nP', '-a', '-u', String(os.userInfo().uid), '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']);
		const sockets = [];
		let pid;
		let name;
		for (const line of out.split('\n')) {
			const field = line.slice(1);
			if (line[0] === 'p') pid = parseInt(field, 10);
			else if (line[0] === 'c') name = field;
			else if (line[0] === 'n') {
				const hp = splitHostPort(field);
				if (hp) sockets.push({ pid, name, ...hp });
			}
		}
		return sockets;
	} catch (e) {
		if (e.code !== 'ENOENT' || os.platform() !== 'linux') throw e;
	}
	// Without root, ss names the process only for sockets this user owns, which is the filter we want.
	const out = await run('ss', ['-Hltnp']);
	const sockets = [];
	for (const line of out.split('\n')) {
		const cols = line.trim().split(/\s+/);
		const hp = cols[3] && splitHostPort(cols[3]);
		if (!hp) continue;
		for (const m of line.matchAll(/\("([^"]*)",pid=(\d+)/g)) sockets.push({ pid: parseInt(m[2], 10), name: m[1], ...hp });
	}
	return sockets;
}

/** pid -> { ppid, command } for every process. */
async function processTable() {
	const out = await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command=']);
	const table = new Map();
	for (const line of out.split('\n')) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
		if (m) table.set(parseInt(m[1], 10), { ppid: parseInt(m[2], 10), command: m[3] });
	}
	return table;
}

async function workingDirs(pids) {
	const dirs = new Map();
	if (!pids.length) return dirs;
	if (os.platform() === 'linux') {
		await Promise.all(pids.map(async (pid) => dirs.set(pid, await fs.readlink(`/proc/${pid}/cwd`).catch(() => null))));
		return dirs;
	}
	const out = await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-F', 'pn']).catch(() => '');
	let pid;
	for (const line of out.split('\n')) {
		if (line[0] === 'p') pid = parseInt(line.slice(1), 10);
		else if (line[0] === 'n') dirs.set(pid, line.slice(1));
	}
	return dirs;
}

// Any coderemote agent, this one or another (`coderemote up`, `node .../coderemote.js up`), so
// clients can warn before stopping one: that cuts the phone off from the folder it shares.
const AGENT_COMMAND = /(^|[\/\s])coderemote(\.js)?\s+up(\s|$)/;

/**
 * @param {Map<number, string>} shells  terminal session shell pid -> session id
 * @returns {Promise<object[]>} one entry per (pid, port), sorted by port
 */
export async function listPorts(shells = new Map()) {
	const [sockets, table] = await Promise.all([listeningSockets(), processTable()]);
	const byKey = new Map();
	for (const s of sockets) {
		const key = `${s.pid}:${s.port}`;
		const entry = byKey.get(key);
		if (entry) {
			if (!entry.addresses.includes(s.address)) entry.addresses.push(s.address);
			continue;
		}
		byKey.set(key, {
			port: s.port,
			addresses: [s.address],
			pid: s.pid,
			name: s.name,
			command: table.get(s.pid)?.command ?? s.name,
			cwd: null,
			session: sessionOf(s.pid, table, shells),
			self: s.pid === process.pid,
			agent: s.pid === process.pid || AGENT_COMMAND.test(table.get(s.pid)?.command ?? ''),
		});
	}
	const entries = [...byKey.values()];
	const dirs = await workingDirs([...new Set(entries.map((e) => e.pid))]);
	for (const e of entries) e.cwd = dirs.get(e.pid) ?? null;
	return entries.sort((a, b) => a.port - b.port || a.pid - b.pid);
}

/** The terminal session whose shell `pid` descends from, or null. */
function sessionOf(pid, table, shells) {
	for (let p = pid, depth = 0; p > 1 && depth < 64; p = table.get(p)?.ppid, depth++) {
		if (shells.has(p)) return shells.get(p);
	}
	return null;
}

/** Stops a process that is listening on a port right now; anything else is refused. */
export async function killListener(pid, { force = false, shells } = {}) {
	if (!Number.isInteger(pid) || pid <= 1) throw new HttpError(400, 'pid must be a process id');
	if (pid === process.pid) throw new HttpError(403, 'the agent cannot stop itself');
	const ports = await listPorts(shells);
	if (!ports.some((p) => p.pid === pid)) throw new HttpError(404, 'no listening process with that pid');
	try {
		process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
	} catch (e) {
		if (e.code === 'ESRCH') throw new HttpError(404, 'no listening process with that pid');
		throw e;
	}
}
