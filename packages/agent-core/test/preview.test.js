// Preview routes against an in-process agent. A stand-in for the preview tunnel hands out the
// proxy's local address as the "public" URL, so requests to it take the path a relay's would.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createAgentServer } from '../src/index.js';

const token = 'test-token';
const forwarded = new Set();
const shared = new Map();
let failForward = false;
const preview = {
	list: () => [...forwarded].map((port) => ({ port, url: `http://127.0.0.1:${port}`, sharedUntil: shared.get(port) ?? null })),
	forward: async (port) => {
		if (failForward) throw new Error('relay unreachable');
		forwarded.add(port);
	},
	unforward: async (port) => forwarded.delete(port) && shared.delete(port),
	share: async (port, hours) => shared.set(port, hours * 1000),
	unshare: async (port) => shared.delete(port),
	token: async () => (forwarded.size ? { token: 'connect', expiresAt: 1 } : null),
};
let tmpRoot;
const servers = [];

async function listen(server, host = '127.0.0.1') {
	await new Promise((r) => server.listen(0, host, r));
	servers.push(server);
	return server;
}

/** A dev server: echoes requests, gzips /zipped, and speaks WebSocket. */
async function devServer(host) {
	const server = http.createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		if (req.url === '/zipped') {
			res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
			return res.end(zlib.gzipSync(JSON.stringify({ zipped: true })));
		}
		res.writeHead(201, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ host: req.headers.host, got: Buffer.concat(chunks).toString() }));
	});
	const wss = new WebSocketServer({ server });
	wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo ${m}`)));
	return listen(server, host);
}

before(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vsremote-preview-'));
});

after(async () => {
	for (const s of servers) s.close();
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function agent(opts = {}) {
	return listen(createAgentServer({ token, root: tmpRoot, preview, ...opts }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls the agent until the previewed ports are `want`, or fails after `ms`. */
async function previewedPorts(server, want, ms = 3000) {
	const deadline = Date.now() + ms;
	for (;;) {
		const ports = (await api(server, 'GET', '/api/preview')).json.ports.map((p) => p.port);
		if (JSON.stringify(ports) === JSON.stringify(want) || Date.now() > deadline) return ports;
		await sleep(50);
	}
}

async function api(server, method, route, body) {
	const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
		method,
		headers: { authorization: `Bearer ${token}` },
		body: body && JSON.stringify(body),
	});
	return { status: res.status, json: await res.json() };
}

test('forwards a port through a proxy, lists it with a token, and stops forwarding it', async () => {
	const server = await agent();
	const dev = await devServer();
	const port = dev.address().port;
	assert.deepEqual((await api(server, 'GET', '/api/preview')).json, { ports: [], token: null, expiresAt: null });

	const opened = await api(server, 'POST', '/api/preview', { port });
	assert.equal(opened.status, 200);
	const [entry] = opened.json.ports;
	assert.equal(entry.port, port, 'clients see the dev server port, not the proxy');
	assert.notEqual(entry.url, `http://127.0.0.1:${port}`);
	assert.equal(entry.sharedUntil, null);
	assert.equal(opened.json.token, 'connect');

	// The dev server answers through the proxy, addressed as itself.
	const res = await fetch(entry.url);
	assert.deepEqual(await res.json(), { host: `localhost:${port}`, got: '' });

	assert.deepEqual((await api(server, 'DELETE', `/api/preview?port=${port}`)).json.ports, []);
});

test('records requests, bodies and failures', async () => {
	const server = await agent();
	const dev = await devServer('::1');
	const port = dev.address().port;
	const { url } = (await api(server, 'POST', '/api/preview', { port })).json.ports[0];

	const posted = await fetch(`${url}/hook?x=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"event":"push"}' });
	assert.equal(posted.status, 201);
	assert.deepEqual(await (await fetch(`${url}/zipped`)).json(), { zipped: true });

	const { json } = await api(server, 'GET', `/api/preview/requests?port=${port}`);
	assert.deepEqual(
		json.requests.map((r) => [r.method, r.path, r.status, r.contentType]),
		[
			['POST', '/hook?x=1', 201, 'application/json'],
			['GET', '/zipped', 200, 'application/json'],
		],
	);
	assert.ok(json.requests.every((r) => Number.isInteger(r.duration)));
	const [hook, zipped] = json.requests;
	assert.deepEqual((await api(server, 'GET', `/api/preview/requests?port=${port}&after=${hook.id}`)).json.requests.map((r) => r.id), [zipped.id]);

	const hookDetail = (await api(server, 'GET', `/api/preview/request?port=${port}&id=${hook.id}`)).json;
	assert.deepEqual(hookDetail.request.body, { size: 16, truncated: false, text: '{"event":"push"}' });
	assert.equal(hookDetail.request.headers['content-type'], 'application/json');
	assert.match(hookDetail.response.body.text, /"got":"\{\\"event\\":\\"push\\"\}"/);
	const zippedDetail = (await api(server, 'GET', `/api/preview/request?port=${port}&id=${zipped.id}`)).json;
	assert.equal(zippedDetail.response.body.text, '{"zipped":true}', 'gzip bodies are stored decoded');

	// The dev server stops: the proxy answers 502 and says why.
	dev.close();
	dev.closeAllConnections();
	const down = await fetch(`${url}/`);
	assert.equal(down.status, 502);
	const failed = (await api(server, 'GET', `/api/preview/requests?port=${port}&after=${zipped.id}`)).json.requests[0];
	assert.equal(failed.status, 502);
	assert.match(failed.error, new RegExp(`nothing is listening on port ${port}`));

	assert.equal((await api(server, 'GET', `/api/preview/request?port=${port}&id=999999`)).status, 404);
	await api(server, 'DELETE', `/api/preview/requests?port=${port}`);
	assert.deepEqual((await api(server, 'GET', `/api/preview/requests?port=${port}`)).json.requests, []);
	assert.equal((await api(server, 'GET', '/api/preview/requests?port=1')).status, 404);
});

test('WebSockets (hot reload) pass through the proxy', async () => {
	const server = await agent();
	const dev = await devServer();
	const { url } = (await api(server, 'POST', '/api/preview', { port: dev.address().port })).json.ports[0];
	const ws = new WebSocket(url.replace('http', 'ws'));
	await new Promise((r) => ws.on('open', r));
	ws.send('hi');
	const [reply] = await new Promise((r) => ws.once('message', (...a) => r(a)));
	assert.equal(reply.toString(), 'echo hi');
	ws.close();
});

test('shares a previewed port for a while, and makes it private again', async () => {
	const server = await agent();
	const port = (await devServer()).address().port;
	await api(server, 'POST', '/api/preview', { port });
	assert.equal((await api(server, 'POST', '/api/preview/share', { port: 1, hours: 1 })).status, 404);
	assert.equal((await api(server, 'POST', '/api/preview/share', { port, hours: 0 })).status, 400);
	assert.equal((await api(server, 'POST', '/api/preview/share', { port, hours: 721 })).status, 400);

	const sharedRes = await api(server, 'POST', '/api/preview/share', { port, hours: 2 });
	assert.equal(sharedRes.json.ports.find((p) => p.port === port).sharedUntil, 2000);
	const unshared = await api(server, 'DELETE', `/api/preview/share?port=${port}`);
	assert.equal(unshared.json.ports.find((p) => p.port === port).sharedUntil, null);
	await api(server, 'DELETE', `/api/preview?port=${port}`);
});

test('refuses bad ports, the agent itself, and reports tunnel failures', async () => {
	const server = await agent();
	assert.equal((await api(server, 'POST', '/api/preview', { port: 0 })).status, 400);
	assert.equal((await api(server, 'POST', '/api/preview', { port: 'x' })).status, 400);
	assert.equal((await api(server, 'POST', '/api/preview', { port: server.address().port })).status, 400);
	failForward = true;
	const failed = await api(server, 'POST', '/api/preview', { port: 6666 });
	failForward = false;
	assert.equal(failed.status, 502);
	assert.match(failed.json.error, /relay unreachable/);
});

test('reports the tunnel status it is given, and 404 without a tunnel', async () => {
	const status = { account: 'me', tunnel: { id: 't' }, machines: [], previewPorts: 0 };
	const server = await listen(createAgentServer({ token, root: tmpRoot, tunnelStatus: async () => status }));
	assert.deepEqual((await api(server, 'GET', '/api/tunnel')).json, status);
	const bare = await listen(createAgentServer({ token, root: tmpRoot }));
	assert.equal((await api(bare, 'GET', '/api/tunnel')).status, 404);
});

test('agents without a tunnel have no previews', async () => {
	const server = await listen(createAgentServer({ token, root: tmpRoot }));
	assert.equal((await api(server, 'GET', '/api/preview')).status, 404);
	assert.equal((await api(server, 'POST', '/api/preview', { port: 5173 })).status, 404);
	assert.equal((await api(server, 'DELETE', '/api/preview?port=5173')).status, 404);
	assert.equal((await api(server, 'GET', '/api/preview/requests?port=5173')).status, 404);
});

test('stops previewing a dev server that stopped, after a grace period', async () => {
	const server = await agent({ previewSweep: { checkMs: 50, graceMs: 400 } });
	const stopping = await devServer();
	const restarting = await devServer();
	const [gone, back] = [stopping.address().port, restarting.address().port];
	await api(server, 'POST', '/api/preview', { port: gone });
	await api(server, 'POST', '/api/preview', { port: back });

	stopping.close();
	stopping.closeAllConnections();
	// A dev server that restarts itself within the grace period keeps its preview.
	restarting.close();
	restarting.closeAllConnections();
	await sleep(150);
	const again = http.createServer((req, res) => res.end('back'));
	await new Promise((r) => again.listen(back, '127.0.0.1', r));
	servers.push(again);

	assert.deepEqual(await previewedPorts(server, [back]), [back], 'the stopped one goes');
	await sleep(600);
	assert.deepEqual(await previewedPorts(server, [back]), [back], 'the restarted one stays');
	// Its request log outlives the preview, as after Stop Preview.
	assert.equal((await api(server, 'GET', `/api/preview/requests?port=${gone}`)).status, 200);
	await api(server, 'DELETE', `/api/preview?port=${back}`);
});

test('stopping a previewed dev server from the Ports tab ends its preview without the wait', async () => {
	const server = await agent({ previewSweep: { checkMs: 60_000, graceMs: 60_000, killedMs: 100 } });
	const child = spawn(process.execPath, ['-e', "require('http').createServer().listen(0, '127.0.0.1', function () { console.log('PORT=' + this.address().port) })"]);
	let out = '';
	for await (const chunk of child.stdout) if ((out += chunk).includes('\n')) break;
	const port = Number(out.match(/PORT=(\d+)/)[1]);
	try {
		await api(server, 'POST', '/api/preview', { port });
		assert.equal((await api(server, 'POST', '/api/ports/kill', { pid: child.pid })).status, 200);
		assert.deepEqual(await previewedPorts(server, []), []);
	} finally {
		child.kill('SIGKILL');
	}
});
