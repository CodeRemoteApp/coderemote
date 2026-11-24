// Finding, downloading and running cloudflared, with a fake fetch and a fake spawn.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CLOUDFLARED_VERSION, ensureCloudflared, runConnector } from '../../../src/providers/cloud/cloudflared.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cloudflared-'));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const answer = (buf) => async () => new Response(buf, { headers: { 'content-length': String(buf.length) } });
const noPath = () => null;

test('the override wins, and one that is not executable is a clear error', async () => {
	const env = { CODEREMOTE_CLOUDFLARED: '/opt/cf' };
	assert.equal(await ensureCloudflared({ dir: tmpDir(), env, find: (n) => (n === '/opt/cf' ? '/opt/cf' : '/usr/bin/cloudflared') }), '/opt/cf');
	await assert.rejects(ensureCloudflared({ dir: tmpDir(), env, find: noPath }), /CODEREMOTE_CLOUDFLARED=\/opt\/cf isn't an executable file/);
});

test('cloudflared on PATH is used without downloading', async () => {
	const fetchFn = () => assert.fail('no download');
	assert.equal(await ensureCloudflared({ dir: tmpDir(), env: {}, fetchFn, find: (n) => (n === 'cloudflared' ? '/opt/homebrew/bin/cloudflared' : null) }), '/opt/homebrew/bin/cloudflared');
});

test('a plain binary download matching the pin is installed, versioned, and reused', async () => {
	const dir = tmpDir();
	const body = Buffer.from('#!/bin/sh\necho cloudflared\n');
	const builds = { 'linux-x64': { asset: 'cloudflared-linux-amd64', sha256: sha(body) } };
	let fetched = 0;
	const fetchFn = async (url) => {
		fetched++;
		assert.equal(url, `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`);
		return answer(body)();
	};
	fs.writeFileSync(path.join(dir, 'cloudflared-2020.1.1'), 'old');
	const opts = { dir, env: {}, platform: 'linux', arch: 'x64', builds, fetchFn, find: noPath };
	const bin = await ensureCloudflared(opts);
	assert.equal(bin, path.join(dir, `cloudflared-${CLOUDFLARED_VERSION}`));
	assert.deepEqual(fs.readFileSync(bin), body);
	assert.equal(fs.statSync(bin).mode & 0o777, 0o755);
	assert.deepEqual(fs.readdirSync(dir), [`cloudflared-${CLOUDFLARED_VERSION}`], 'the old version is removed');
	assert.equal(await ensureCloudflared(opts), bin);
	assert.equal(fetched, 1);
});

test('a hash mismatch is refused and leaves no file behind', async () => {
	const dir = tmpDir();
	const builds = { 'linux-x64': { asset: 'cloudflared-linux-amd64', sha256: '0'.repeat(64) } };
	await assert.rejects(
		ensureCloudflared({ dir, env: {}, platform: 'linux', arch: 'x64', builds, fetchFn: answer(Buffer.from('tampered')), find: noPath }),
		/doesn't match the pinned SHA-256/,
	);
	assert.deepEqual(fs.readdirSync(dir), []);
});

test('a .tgz is unpacked and its binary signature-checked before install', async () => {
	const dir = tmpDir();
	const src = tmpDir();
	fs.writeFileSync(path.join(src, 'cloudflared'), 'binary');
	const tgz = path.join(tmpDir(), 'c.tgz');
	execFileSync('tar', ['-czf', tgz, '-C', src, 'cloudflared']);
	const body = fs.readFileSync(tgz);
	const builds = { 'darwin-arm64': { asset: 'cloudflared-darwin-arm64.tgz', sha256: sha(body) } };
	const checked = [];
	const opts = { dir, env: {}, platform: 'darwin', arch: 'arm64', builds, fetchFn: answer(body), find: noPath };
	const bin = await ensureCloudflared({ ...opts, verifySignature: async (f) => checked.push(fs.readFileSync(f, 'utf8')) });
	assert.equal(fs.readFileSync(bin, 'utf8'), 'binary');
	assert.deepEqual(checked, ['binary']);

	const dir2 = tmpDir();
	await assert.rejects(
		ensureCloudflared({ ...opts, dir: dir2, verifySignature: async () => { throw new Error('cloudflared download failed its signature check: not signed by Cloudflare'); } }),
		/signature check/,
	);
	assert.deepEqual(fs.readdirSync(dir2), [], 'nothing left after a failed signature');
});

test('no build for this platform says how to install it', async () => {
	await assert.rejects(ensureCloudflared({ dir: tmpDir(), env: {}, platform: 'freebsd', arch: 'x64', find: noPath }), /No cloudflared build for freebsd-x64/);
});

/** A fake spawnTied: records the call, returns a child whose stderr the test writes. */
function fakeSpawn() {
	const calls = [];
	const children = [];
	const spawnHost = (command, args, opts) => {
		calls.push({ command, args, opts });
		const child = new EventEmitter();
		child.stderr = new PassThrough();
		child.killed = false;
		child.kill = () => {
			child.killed = true;
			child.emit('exit', null, 'SIGTERM');
		};
		children.push(child);
		return child;
	};
	return { spawnHost, calls, children };
}

test('the token is passed in the environment, never in the arguments; ready on the registration line', async () => {
	const f = fakeSpawn();
	const running = runConnector('/bin/cloudflared', 'SECRET-TOKEN', { spawnHost: f.spawnHost, env: { PATH: '/bin' } });
	const [{ command, args, opts }] = f.calls;
	assert.equal(command, '/bin/cloudflared');
	assert.deepEqual(args, ['tunnel', '--no-autoupdate', 'run']);
	assert.ok(!JSON.stringify(args).includes('SECRET-TOKEN'));
	assert.equal(opts.env.TUNNEL_TOKEN, 'SECRET-TOKEN');
	assert.equal(opts.env.PATH, '/bin');
	let settled = false;
	running.then(() => (settled = true));
	f.children[0].stderr.write('INF Starting tunnel tunnelID=x\n');
	await new Promise((r) => setImmediate(r));
	assert.equal(settled, false, 'not ready before registration');
	f.children[0].stderr.write('INF Registered tunnel connection connIndex=0 connection=abc event=0 ip=198.41.200.13 location=sin01 protocol=quic\n');
	assert.equal(await running, f.children[0]);
});

test('an early exit rejects with the last log lines', async () => {
	const f = fakeSpawn();
	const running = runConnector('/bin/cloudflared', 't', { spawnHost: f.spawnHost });
	f.children[0].stderr.write('INF Starting tunnel\nERR Provided Tunnel token is not valid.\n');
	await new Promise((r) => setImmediate(r));
	f.children[0].emit('exit', 1, null);
	await assert.rejects(running, /cloudflared exited \(1\):\n[\s\S]*Provided Tunnel token is not valid/);
});

test('a connector that does not register in time is ended', async () => {
	const f = fakeSpawn();
	await assert.rejects(runConnector('/bin/cloudflared', 't', { spawnHost: f.spawnHost, timeoutMs: 20 }), /didn't connect within 0.02s/);
	assert.equal(f.children[0].killed, true);
});
