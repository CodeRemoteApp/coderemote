// Build routes against an in-process agent, with a stand-in xcodebuild and preview tunnel.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { BuildRunner } from '../src/builds.js';
import { createAgentServer } from '../src/index.js';
import { isWindows } from '../src/platform.js';

const token = 'test-token';
let tmp;
let root;
let server;
let plain;
let base;
let plainBase;
let failNext;

const forwarded = new Map();
const preview = {
	list: () => [...forwarded.values()],
	forward: async (port) => {
		forwarded.set(port, { port, url: `http://127.0.0.1:${port}`, sharedUntil: null });
		return forwarded.get(port);
	},
	share: async (port) => {
		forwarded.get(port).sharedUntil = 3_600_000;
	},
	unshare: async (port) => {
		if (forwarded.has(port)) forwarded.get(port).sharedUntil = null;
	},
	unforward: async (port) => forwarded.delete(port),
	token: async () => null,
};

before(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vsremote-builds-'));
	root = path.join(tmp, 'share');
	await fs.mkdir(path.join(root, 'app', 'Demo.xcodeproj'), { recursive: true });
	failNext = path.join(tmp, 'fail-next');
	const xcodebuild = path.join(tmp, 'xcodebuild');
	await fs.writeFile(xcodebuild, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
if (args.includes('-list')) {
	console.log(JSON.stringify({ project: { schemes: ['Demo'] } }));
} else if (args.includes('archive')) {
	if (fs.existsSync(${JSON.stringify(failNext)})) {
		fs.unlinkSync(${JSON.stringify(failNext)});
		console.log('/p/A.swift:3:1: error: expected expression');
		process.exit(65);
	}
	for (let i = 0; i < 5; i++) console.log('line ' + i);
	fs.mkdirSync(path.join(at('-archivePath'), 'Products', 'Applications', 'Demo.app'), { recursive: true });
} else if (args.includes('-exportArchive')) {
	fs.mkdirSync(at('-exportPath'), { recursive: true });
	fs.writeFileSync(path.join(at('-exportPath'), 'Demo.ipa'), 'ipa');
}
`, { mode: 0o755 });
	const readInfo = async () => ({ bundleId: 'app.demo', version: '1.0', name: 'Demo' });
	const builds = () => new BuildRunner({ xcodebuild, readInfo, dir: path.join(tmp, `out-${Math.random()}`) });
	server = createAgentServer({ token, root, preview, xcodebuild, builds: builds() });
	plain = createAgentServer({ token, root, xcodebuild, builds: builds() });
	for (const s of [server, plain]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${server.address().port}`;
	plainBase = `http://127.0.0.1:${plain.address().port}`;
});

after(async () => {
	for (const s of [server, plain]) {
		s.closeAllConnections();
		s.close();
	}
	await fs.rm(tmp, { recursive: true, force: true });
});

async function call(method, route, body, at = base) {
	const res = await fetch(`${at}${route}`, {
		method,
		headers: { authorization: `Bearer ${token}` },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: await res.json() };
}

async function finished(at = base) {
	for (let i = 0; i < 200; i++) {
		const { body } = await call('GET', '/api/builds/current', undefined, at);
		if (body.state !== 'running') return body;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error('build never ended');
}

test('builds: schemes, a build and its log, then a one-time install link', { skip: isWindows }, async () => {
	const app = path.join(root, 'app');
	assert.equal((await call('GET', '/api/builds/current')).status, 404);
	assert.deepEqual((await call('GET', `/api/builds/schemes?path=${encodeURIComponent(app)}`)).body, { container: 'Demo.xcodeproj', kind: 'project', schemes: ['Demo'] });
	assert.equal((await call('GET', `/api/builds/schemes?path=${encodeURIComponent(root)}`)).status, 404);
	assert.equal((await call('GET', `/api/builds/schemes?path=${encodeURIComponent(tmp)}`)).status, 403);
	assert.equal((await call('POST', '/api/builds/install')).status, 409);

	const started = await call('POST', '/api/builds', { path: app, scheme: 'Demo' });
	assert.equal(started.status, 200);
	assert.equal(started.body.state, 'running');
	assert.equal((await call('POST', '/api/builds', { path: app, scheme: 'Demo' })).status, 409);
	const build = await finished();
	assert.equal(build.state, 'succeeded');
	assert.ok(build.log.includes('line 4'));
	const paged = (await call('GET', `/api/builds/current?after=${build.next}`)).body;
	assert.deepEqual(paged.log, []);
	assert.equal(paged.next, build.next);
	assert.equal((await call('POST', '/api/builds/cancel')).status, 409);

	const { body: link } = await call('POST', '/api/builds/install');
	const manifestUrl = decodeURIComponent(new URL(link.url).searchParams.get('url'));
	assert.match(await (await fetch(manifestUrl)).text(), /<string>app\.demo<\/string>/);
	assert.equal(await (await fetch(manifestUrl.replace('manifest.plist', 'app.ipa'))).text(), 'ipa');
	await new Promise((r) => setTimeout(r, 50));
	assert.equal((await fetch(manifestUrl)).status, 404);
});

test('builds: a live install link shows among previews, and stopping it there ends it', { skip: isWindows }, async () => {
	if ((await call('GET', '/api/builds/current')).body.state !== 'succeeded') {
		await call('POST', '/api/builds', { path: path.join(root, 'app'), scheme: 'Demo' });
		await finished();
	}
	const { body: link } = await call('POST', '/api/builds/install');
	const manifestUrl = decodeURIComponent(new URL(link.url).searchParams.get('url'));
	const listed = (await call('GET', '/api/preview')).body.ports;
	assert.equal(listed.length, 1);
	assert.equal(listed[0].install, true);
	assert.equal(listed[0].sharedUntil, 3_600_000);
	const stopped = await call('DELETE', `/api/preview?port=${listed[0].port}`);
	assert.equal(stopped.status, 200);
	assert.deepEqual(stopped.body.ports, []);
	assert.equal((await fetch(manifestUrl)).status, 404);
	assert.equal(forwarded.size, 0);
});

test('builds: a failed build reports its error and has nothing to install', { skip: isWindows }, async () => {
	await fs.writeFile(failNext, '');
	await call('POST', '/api/builds', { path: path.join(root, 'app'), scheme: 'Demo' });
	const build = await finished();
	assert.equal(build.state, 'failed');
	assert.equal(build.error, '/p/A.swift:3:1: error: expected expression');
	assert.equal((await call('POST', '/api/builds/install')).status, 409);
});

test('builds: without a tunnel there is no install link', { skip: isWindows }, async () => {
	await call('POST', '/api/builds', { path: path.join(root, 'app'), scheme: 'Demo' }, plainBase);
	assert.equal((await finished(plainBase)).state, 'succeeded');
	const refused = await call('POST', '/api/builds/install', undefined, plainBase);
	assert.equal(refused.status, 409);
	assert.match(refused.body.error, /coderemote up/);
});
