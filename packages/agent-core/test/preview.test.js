// Preview routes against an in-process agent with a stand-in for the preview tunnel.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createAgentServer } from '../src/index.js';

const token = 'test-token';
const forwarded = new Map();
const shared = new Map();
const preview = {
	list: () => [...forwarded].map(([port, url]) => ({ port, url, sharedUntil: shared.get(port) ?? null })),
	forward: async (port) => {
		if (port === 6666) throw new Error('relay unreachable');
		forwarded.set(port, `https://abc-${port}.usw2.devtunnels.ms`);
	},
	unforward: async (port) => forwarded.delete(port) && shared.delete(port),
	share: async (port, hours) => shared.set(port, hours * 1000),
	unshare: async (port) => shared.delete(port),
	token: async () => (forwarded.size ? { token: 'connect', expiresAt: 1 } : null),
};
let tmpRoot;
const servers = [];

async function start(opts) {
	const server = createAgentServer({ token, root: tmpRoot, ...opts });
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	servers.push(server);
	return server;
}

before(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vsremote-preview-'));
});

after(async () => {
	for (const s of servers) s.close();
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function api(server, method, route, body) {
	const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
		method,
		headers: { authorization: `Bearer ${token}` },
		body: body && JSON.stringify(body),
	});
	return { status: res.status, json: await res.json() };
}

test('forwards a port, lists it with a token, and stops forwarding it', async () => {
	const server = await start({ preview });
	assert.deepEqual((await api(server, 'GET', '/api/preview')).json, { ports: [], token: null, expiresAt: null });

	const opened = await api(server, 'POST', '/api/preview', { port: 5173 });
	assert.equal(opened.status, 200);
	assert.deepEqual(opened.json, {
		ports: [{ port: 5173, url: 'https://abc-5173.usw2.devtunnels.ms', sharedUntil: null }],
		token: 'connect',
		expiresAt: 1,
	});

	const closed = await api(server, 'DELETE', '/api/preview?port=5173');
	assert.deepEqual(closed.json.ports, []);
});

test('shares a previewed port for a while, and makes it private again', async () => {
	const server = await start({ preview });
	await api(server, 'POST', '/api/preview', { port: 3000 });
	assert.equal((await api(server, 'POST', '/api/preview/share', { port: 3001, hours: 1 })).status, 404);
	assert.equal((await api(server, 'POST', '/api/preview/share', { port: 3000, hours: 0 })).status, 400);
	assert.equal((await api(server, 'POST', '/api/preview/share', { port: 3000, hours: 721 })).status, 400);

	const sharedRes = await api(server, 'POST', '/api/preview/share', { port: 3000, hours: 2 });
	assert.equal(sharedRes.json.ports.find((p) => p.port === 3000).sharedUntil, 2000);
	const unshared = await api(server, 'DELETE', '/api/preview/share?port=3000');
	assert.equal(unshared.json.ports.find((p) => p.port === 3000).sharedUntil, null);
	await api(server, 'DELETE', '/api/preview?port=3000');
});

test('refuses bad ports, the agent itself, and reports tunnel failures', async () => {
	const server = await start({ preview });
	assert.equal((await api(server, 'POST', '/api/preview', { port: 0 })).status, 400);
	assert.equal((await api(server, 'POST', '/api/preview', { port: 'x' })).status, 400);
	assert.equal((await api(server, 'POST', '/api/preview', { port: server.address().port })).status, 400);
	const failed = await api(server, 'POST', '/api/preview', { port: 6666 });
	assert.equal(failed.status, 502);
	assert.match(failed.json.error, /relay unreachable/);
});

test('agents without a tunnel have no previews', async () => {
	const server = await start({});
	assert.equal((await api(server, 'GET', '/api/preview')).status, 404);
	assert.equal((await api(server, 'POST', '/api/preview', { port: 5173 })).status, 404);
	assert.equal((await api(server, 'DELETE', '/api/preview?port=5173')).status, 404);
});
