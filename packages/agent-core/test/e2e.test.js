// Exercises the agent over HTTP + WebSocket.
// Runs against an in-process server by default; set VSREMOTE_URL and VSREMOTE_TOKEN
// to run the same checks through a live dev tunnel.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { TERMINAL_WS_PATH } from '@vsremote/protocol';
import WebSocket from 'ws';
import { createAgentServer } from '../src/index.js';
import { isWindows } from '../src/platform.js';

let baseUrl = process.env.VSREMOTE_URL;
let token = process.env.VSREMOTE_TOKEN;
let server;
let tmpRoot;
let root;
let workdir;

before(async () => {
	if (!baseUrl) {
		token = 'test-token';
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vsremote-root-'));
		server = createAgentServer({ token, root: tmpRoot });
		await new Promise((r) => server.listen(0, '127.0.0.1', r));
		baseUrl = `http://127.0.0.1:${server.address().port}`;
	}
	// Work in a scratch folder inside whatever the agent shares, so a live agent is left untouched.
	root = (await api('GET', '/api/info')).root;
	workdir = path.join(root, `vsremote-e2e-${process.pid}-${Date.now()}`);
	await api('POST', '/api/fs/mkdir', { query: { path: workdir } });
});

after(async () => {
	// Windows won't delete a folder a terminal still runs in.
	await server?.killAllSessions();
	await api('DELETE', '/api/fs', { query: { path: workdir } }).catch(() => {});
	if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
	server?.close();
});

const headers = () => ({
	authorization: `Bearer ${token}`,
	// Dev tunnels serves an interstitial page to anonymous clients unless told to skip it.
	'x-tunnel-skip-antiphishing-page': 'true',
});

async function api(method, route, { query, body, raw } = {}) {
	const url = new URL(route, baseUrl);
	for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
	const res = await fetch(url, { method, headers: headers(), body });
	if (raw) return res;
	const json = await res.json();
	if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status });
	return json;
}

function openTerminal(params = {}) {
	const url = new URL(TERMINAL_WS_PATH, baseUrl.replace(/^http/, 'ws'));
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const ws = new WebSocket(url, { headers: headers() });
	let output = '';
	const waiters = [];
	const session = new Promise((resolve, reject) => {
		ws.on('message', (data, isBinary) => {
			if (isBinary) {
				output += data.toString('utf8');
				for (const w of [...waiters]) if (w.re.test(output)) w.resolve(output);
			} else {
				const msg = JSON.parse(data.toString('utf8'));
				if (msg.type === 'session') resolve(msg.id);
			}
		});
		ws.on('error', reject);
		ws.on('unexpected-response', (_, res) => reject(new Error(`ws ${res.statusCode}`)));
	});
	const waitFor = (re, ms = 10000) =>
		new Promise((resolve, reject) => {
			if (re.test(output)) return resolve(output);
			const w = { re, resolve };
			waiters.push(w);
			setTimeout(() => reject(new Error(`timeout waiting for ${re}; got:\n${output}`)), ms);
		});
	return { ws, session, waitFor };
}

test('rejects requests without the token', async () => {
	const res = await fetch(new URL('/api/info', baseUrl), {
		headers: { 'x-tunnel-skip-antiphishing-page': 'true' },
	});
	assert.equal(res.status, 401);
});

test('landing page is public and carries no machine details', async () => {
	const res = await fetch(new URL('/', baseUrl), { headers: { 'x-tunnel-skip-antiphishing-page': 'true' } });
	assert.equal(res.status, 200);
	assert.match(res.headers.get('content-type'), /text\/html/);
	const html = await res.text();
	assert.match(html, /vsremote:\/\/pair/);
	assert.ok(!html.includes(root), 'the shared folder is not revealed');
	assert.ok(!html.includes(os.hostname()), 'the hostname is not revealed');
});

test('info', async () => {
	const info = await api('GET', '/api/info');
	assert.equal(info.protocol, 4);
	assert.equal(info.root, root);
	assert.equal(info.home, undefined, 'the home folder is not exposed');
});

test('file explorer round trip', async () => {
	const dir = path.join(workdir, 'a/b');
	await api('POST', '/api/fs/mkdir', { query: { path: dir } });

	const file = path.join(dir, 'hello.txt');
	await api('PUT', '/api/fs/write', { query: { path: file }, body: 'xin chào' });

	const listing = await api('GET', '/api/fs/list', { query: { path: dir } });
	assert.deepEqual(listing.entries.map((e) => [e.name, e.type]), [['hello.txt', 'file']]);

	const read = await api('GET', '/api/fs/read', { query: { path: file }, raw: true });
	assert.equal(await read.text(), 'xin chào');

	const renamed = path.join(dir, 'renamed.txt');
	await api('POST', '/api/fs/rename', { body: JSON.stringify({ from: file, to: renamed }) });
	const stat = await api('GET', '/api/fs/stat', { query: { path: renamed } });
	assert.equal(stat.size, Buffer.byteLength('xin chào'));

	await api('DELETE', '/api/fs', { query: { path: path.join(workdir, 'a') } });
	await assert.rejects(api('GET', '/api/fs/stat', { query: { path: renamed } }), { status: 404 });
});

test('relative paths resolve inside the shared folder', async () => {
	const listing = await api('GET', '/api/fs/list', { query: { path: '.' } });
	assert.equal(listing.path, root);
});

test('nothing outside the shared folder is reachable', async () => {
	const forbidden = { status: 403 };
	await assert.rejects(api('GET', '/api/fs/list', { query: { path: '/etc' } }), forbidden);
	await assert.rejects(api('GET', '/api/fs/list', { query: { path: path.dirname(root) } }), forbidden);
	await assert.rejects(api('GET', '/api/fs/list', { query: { path: `${workdir}/../..` } }), forbidden);
	await assert.rejects(api('GET', '/api/fs/list', { query: { path: '../' } }), forbidden);
	// Missing paths outside answer 403 too, so their existence can't be probed.
	await assert.rejects(api('GET', '/api/fs/stat', { query: { path: '/no/such/vsremote/path' } }), forbidden);
	await assert.rejects(api('PUT', '/api/fs/write', { query: { path: '/tmp/vsremote-escape' }, body: 'x' }), forbidden);
	await assert.rejects(api('POST', '/api/fs/mkdir', { query: { path: path.join(path.dirname(root), 'vsremote-escape') } }), forbidden);
	await assert.rejects(
		api('POST', '/api/fs/rename', { body: JSON.stringify({ from: workdir, to: '/tmp/vsremote-escape' }) }),
		forbidden,
	);
	await assert.rejects(api('DELETE', '/api/fs', { query: { path: root } }), forbidden);
	await assert.rejects(api('DELETE', '/api/fs', { query: { path: '.' } }), forbidden);
});

test('symlinks cannot be used to escape', async () => {
	const link = path.join(workdir, 'escape');
	// A junction on Windows: the link anyone can make there without being an administrator.
	await fs.symlink(os.tmpdir(), link, 'junction');
	const listing = await api('GET', '/api/fs/list', { query: { path: workdir } });
	assert.ok(listing.entries.some((e) => e.name === 'escape' && e.type === 'symlink'), 'the link itself is listed');
	const forbidden = { status: 403 };
	await assert.rejects(api('GET', '/api/fs/list', { query: { path: link } }), forbidden);
	await assert.rejects(api('PUT', '/api/fs/write', { query: { path: `${link}/x.txt` }, body: 'x' }), forbidden);
	await assert.rejects(api('POST', '/api/fs/mkdir', { query: { path: `${link}/a/b` } }), forbidden);
});

// Terminals run PowerShell on Windows.
const SIZE = isWindows ? 'echo "$([Console]::WindowHeight) $([Console]::WindowWidth)"' : 'stty size';

test('terminal is a real PTY and survives reconnect', async () => {
	const t1 = openTerminal({ cols: 100, rows: 30, cwd: workdir });
	const id = await t1.session;
	const mark = isWindows ? 'echo "MARK=$(40+2)"' : 'tty; echo "MARK=$((40+2))"';
	t1.ws.send(JSON.stringify({ type: 'input', data: `${mark}; ${SIZE}\r` }));
	await t1.waitFor(/MARK=42/);
	await t1.waitFor(/30 100/);
	if (!isWindows) assert.match(await t1.waitFor(/\/dev\/(ttys|pts)/), /\/dev\/(ttys|pts)/);
	t1.ws.close();

	// Reattach: scrollback is replayed, then the session keeps working.
	const t2 = openTerminal({ id });
	assert.equal(await t2.session, id);
	await t2.waitFor(/MARK=42/);
	t2.ws.send(JSON.stringify({ type: 'resize', cols: 50, rows: 10 }));
	t2.ws.send(Buffer.from(`${SIZE}\r`), { binary: true });
	await t2.waitFor(/10 50/);

	const { sessions } = await api('GET', '/api/term');
	assert.ok(sessions.some((s) => s.id === id));

	const closed = new Promise((r) => t2.ws.on('close', r));
	await api('DELETE', '/api/term', { query: { id } });
	await closed;
});

test('new terminals start in the shared folder and refuse a cwd outside it', async () => {
	const t = openTerminal();
	const id = await t.session;
	const pwd = isWindows ? 'echo "CWD=$((Get-Location).ProviderPath)"' : 'echo "CWD=$(pwd -P)"';
	t.ws.send(JSON.stringify({ type: 'input', data: `${pwd}\r` }));
	const realRoot = await fs.realpath(root);
	await t.waitFor(new RegExp(`CWD=${realRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`));
	await api('DELETE', '/api/term', { query: { id } });

	await assert.rejects(openTerminal({ cwd: '/etc' }).session, /ws 403/);
});

test('names with reserved URL characters round-trip', async () => {
	// Windows file names can't hold a `?`.
	const dir = path.join(workdir, isWindows ? 'Commit+ a&b=c#d%f' : 'Commit+ a&b=c#d?e%f');
	await api('POST', '/api/fs/mkdir', { query: { path: dir } });
	await api('PUT', '/api/fs/write', { query: { path: path.join(dir, 'x+y.txt') }, body: 'ok' });
	const listing = await api('GET', '/api/fs/list', { query: { path: dir } });
	assert.equal(listing.path, dir);
	assert.deepEqual(listing.entries.map((e) => e.name), ['x+y.txt']);
});

test('reattach announces the scrollback replay and sends it as one frame', async () => {
	const t = openTerminal();
	const id = await t.session;
	t.ws.send(JSON.stringify({ type: 'input', data: 'echo REPLAY-ME\r' }));
	await t.waitFor(/REPLAY-ME\s/);
	t.ws.close();

	const url = new URL(TERMINAL_WS_PATH, baseUrl.replace(/^http/, 'ws'));
	url.searchParams.set('id', id);
	const ws = new WebSocket(url, { headers: headers() });
	const [announced, firstFrame] = await new Promise((resolve, reject) => {
		let replay;
		ws.on('message', (data, isBinary) => {
			if (!isBinary) replay = JSON.parse(data.toString('utf8')).replay;
			else resolve([replay, data]);
		});
		ws.on('error', reject);
	});
	assert.ok(announced > 0);
	assert.equal(firstFrame.length, announced);
	assert.match(firstFrame.toString('utf8'), /REPLAY-ME/);
	ws.close();
	await api('DELETE', '/api/term', { query: { id } });
});

test('git: finds repos, stages, commits and reads history', async () => {
	const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
	const parent = path.join(workdir, 'projects');
	const app = path.join(parent, 'app');
	const lib = path.join(parent, 'libs', 'core');
	for (const repo of [app, lib]) {
		await fs.mkdir(repo, { recursive: true });
		gitIn(repo, 'init', '-q', '-b', 'main');
		gitIn(repo, 'config', 'user.email', 'test@example.com');
		gitIn(repo, 'config', 'user.name', 'Test');
		// Git for Windows turns this on by default, which would rewrite the line endings checked below.
		gitIn(repo, 'config', 'core.autocrlf', 'false');
	}
	await fs.mkdir(path.join(parent, 'node_modules', 'dep', '.git'), { recursive: true });

	const { repos } = await api('GET', '/api/git/repos');
	const found = repos.map((r) => r.path);
	assert.ok(found.includes(app) && found.includes(lib), 'both repos are found');
	assert.ok(!found.some((p) => p.includes('node_modules')), 'node_modules is skipped');
	assert.equal(repos.find((r) => r.path === lib).name, path.relative(root, lib));

	await fs.writeFile(path.join(app, 'a.txt'), 'one\n');
	await fs.writeFile(path.join(app, 'b c+.txt'), 'two\n');
	let st = await api('GET', '/api/git/status', { query: { repo: app } });
	assert.equal(st.branch, 'main');
	assert.deepEqual(st.files.map((f) => [f.path, f.index, f.worktree]).sort(), [['a.txt', '.', '?'], ['b c+.txt', '.', '?']]);

	const untrackedDiff = await api('GET', '/api/git/diff', { query: { repo: app, path: 'a.txt', untracked: '1' } });
	assert.match(untrackedDiff.text, /\+one/);

	const post = (route, body) => api('POST', route, { body: JSON.stringify(body) });
	st = await post('/api/git/stage', { repo: app, files: ['a.txt', 'b c+.txt'] });
	assert.ok(st.files.every((f) => f.index === 'A'));
	st = await post('/api/git/unstage', { repo: app, files: ['b c+.txt'] });
	assert.equal(st.files.find((f) => f.path === 'b c+.txt').worktree, '?', 'unstage works before the first commit');

	const commit = await post('/api/git/commit', { repo: app, message: 'first commit' });
	assert.equal(commit.subject, 'first commit');

	await fs.writeFile(path.join(app, 'a.txt'), 'one\nmore\n');
	const wd = await api('GET', '/api/git/diff', { query: { repo: app, path: 'a.txt' } });
	assert.match(wd.text, /\+more/);

	const { commits } = await api('GET', '/api/git/log', { query: { repo: app } });
	assert.equal(commits.length, 1);
	assert.ok(commits[0].refs.some((r) => r.includes('main')));
	const shown = await api('GET', '/api/git/show', { query: { repo: app, commit: commits[0].short } });
	assert.match(shown.text, /first commit/);

	st = await post('/api/git/discard', { repo: app, files: ['a.txt', 'b c+.txt'] });
	assert.deepEqual(st.files, [], 'tracked edits restored and untracked file removed');
	assert.equal(await fs.readFile(path.join(app, 'a.txt'), 'utf8'), 'one\n');

	await assert.rejects(post('/api/git/commit', { repo: app, message: '  ' }), { status: 400 });
	await assert.rejects(post('/api/git/stage', { repo: app, files: ['../libs/core/x'] }), { status: 403 });
	await assert.rejects(post('/api/git/stage', { repo: app, files: ['/etc/hosts'] }), { status: 400 });
	await assert.rejects(api('GET', '/api/git/status', { query: { repo: parent } }), { status: 400 });
	await assert.rejects(api('GET', '/api/git/status', { query: { repo: '/tmp' } }), { status: 403 });
	await assert.rejects(api('GET', '/api/git/show', { query: { repo: app, commit: '--output=/tmp/x' } }), { status: 400 });
});
