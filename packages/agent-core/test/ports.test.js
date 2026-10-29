// Ports routes against an in-process agent: the listeners it reports are processes on this machine.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { TERMINAL_WS_PATH } from '@vsremote/protocol';
import WebSocket from 'ws';
import { createAgentServer } from '../src/index.js';
import { isWindows } from '../src/platform.js';

const token = 'test-token';
const LISTEN = "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log('PORT='+s.address().port))";
let server;
let baseUrl;
let tmpRoot;
const children = [];

before(async () => {
	tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vsremote-ports-')));
	server = createAgentServer({ token, root: tmpRoot });
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	for (const c of children) c.kill('SIGKILL');
	await server.killAllSessions();
	server.close();
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function api(method, route, body) {
	const res = await fetch(new URL(route, baseUrl), {
		method,
		headers: { authorization: `Bearer ${token}` },
		body: body && JSON.stringify(body),
	});
	return { status: res.status, json: await res.json() };
}

/** Starts a node process listening on a free port; resolves once it is listening. */
async function listener() {
	// detached: its own session, so no controlling terminal whatever runs the tests.
	const child = spawn(process.execPath, ['-e', LISTEN], { cwd: tmpRoot, detached: true });
	children.push(child);
	let out = '';
	for await (const chunk of child.stdout) {
		out += chunk;
		const m = out.match(/PORT=(\d+)/);
		if (m) return { child, port: parseInt(m[1], 10) };
	}
	throw new Error('listener exited before listening');
}

test('lists listening ports with their process, folder and the agent itself', async () => {
	const { child, port } = await listener();
	const { status, json } = await api('GET', '/api/ports');
	assert.equal(status, 200);
	const entry = json.ports.find((p) => p.port === port);
	assert.ok(entry, `port ${port} is listed`);
	assert.equal(entry.pid, child.pid);
	assert.deepEqual(entry.addresses, ['127.0.0.1']);
	assert.match(entry.command, /node/);
	// Windows keeps working directories out of reach, and has no controlling terminals: anything
	// below the shell running these tests counts as started from a terminal.
	assert.equal(entry.cwd, isWindows ? null : tmpRoot);
	assert.equal(entry.session, null);
	if (!isWindows) assert.equal(entry.terminal, false);
	assert.equal(entry.self, false);
	assert.equal(entry.agent, false);
	const own = json.ports.find((p) => p.port === server.address().port);
	assert.equal(own?.self, true);
	assert.equal(own?.agent, true);
});

test('a listener started in a terminal names its session', async () => {
	const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}${TERMINAL_WS_PATH}`, { headers: { authorization: `Bearer ${token}` } });
	let id;
	let out = '';
	const port = await new Promise((resolve, reject) => {
		ws.on('error', reject);
		ws.on('message', (data, isBinary) => {
			if (!isBinary) {
				const msg = JSON.parse(data.toString('utf8'));
				if (msg.type === 'session') {
					id = msg.id;
					// PowerShell runs a quoted path only after its call operator.
					const run = `${isWindows ? '& ' : ''}'${process.execPath}' -e "${LISTEN}"`;
					ws.send(JSON.stringify({ type: 'input', data: `${run}\r` }));
				}
				return;
			}
			out += data.toString('utf8');
			const m = out.match(/PORT=(\d+)/);
			if (m) resolve(parseInt(m[1], 10));
		});
	});
	const { json } = await api('GET', '/api/ports');
	const entry = json.ports.find((p) => p.port === port);
	assert.equal(entry?.session, id);
	assert.equal(entry?.terminal, true);
	ws.close();
});

test('stops a listener, and refuses anything else', async () => {
	const { child } = await listener();
	const exited = once(child, 'exit');
	assert.equal((await api('POST', '/api/ports/kill', { pid: child.pid })).status, 200);
	// Windows has no signals: the process is ended outright, with exit code 1.
	assert.deepEqual(await exited, isWindows ? [1, null] : [null, 'SIGTERM']);

	const idle = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)']);
	children.push(idle);
	assert.equal((await api('POST', '/api/ports/kill', { pid: idle.pid })).status, 404);
	assert.equal((await api('POST', '/api/ports/kill', { pid: process.pid })).status, 403);
	assert.equal((await api('POST', '/api/ports/kill', { pid: 'x' })).status, 400);
	assert.equal(idle.exitCode, null);
});
