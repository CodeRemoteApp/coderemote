// The agents routes over HTTP and WebSocket, against an in-process server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AGENTS_WS_PATH, HOOK_SECRET_HEADER, TERMINAL_WS_PATH } from '@vsremote/protocol';
import WebSocket from 'ws';
import { createAgentServer } from '../src/index.js';

const token = 'test-token';
const hookSecret = 'hook-secret';
let server;
let baseUrl;
let root;

before(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'vsremote-agents-'));
	server = createAgentServer({ token, root, hookSecret, hookBin: '/opt/coderemote/bin/coderemote.js' });
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	server.killAllSessions();
	server.close();
	await fs.rm(root, { recursive: true, force: true });
});

const bearer = { authorization: `Bearer ${token}` };

async function api(method, route, { query, body } = {}) {
	const url = new URL(route, baseUrl);
	for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
	const res = await fetch(url, { method, headers: bearer, body: body && JSON.stringify(body) });
	const json = await res.json();
	if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status });
	return json;
}

function hook(event, { query = {}, headers = { [HOOK_SECRET_HEADER]: hookSecret }, signal } = {}) {
	const url = new URL('/api/agents/hook', baseUrl);
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
	return fetch(url, { method: 'POST', headers, body: JSON.stringify(event), signal });
}

const ev = (session_id, hook_event_name, fields = {}) => ({ session_id, cwd: root, transcript_path: '/nope', hook_event_name, ...fields });

/** Collects the agents socket's frames. */
async function watch() {
	const ws = new WebSocket(new URL(AGENTS_WS_PATH, baseUrl.replace(/^http/, 'ws')), { headers: bearer });
	const frames = [];
	const waiters = [];
	ws.on('message', (data) => {
		const msg = JSON.parse(data.toString());
		frames.push(msg);
		for (const w of [...waiters]) if (w.match(msg)) {
			waiters.splice(waiters.indexOf(w), 1);
			w.resolve(msg);
		}
	});
	await new Promise((r, j) => ws.once('open', r).once('error', j));
	const next = (match, ms = 2000) =>
		new Promise((resolve, reject) => {
			const found = frames.find(match);
			if (found) return resolve(found);
			waiters.push({ match, resolve });
			setTimeout(() => reject(new Error('timed out waiting for a frame')), ms).unref();
		});
	return { ws, frames, next };
}

test('hook deliveries need the hook secret, not the bearer token', async () => {
	assert.equal((await hook(ev('a', 'SessionStart'), { headers: {} })).status, 401);
	assert.equal((await hook(ev('a', 'SessionStart'), { headers: bearer })).status, 401);
	assert.equal((await api('GET', '/api/agents/sessions')).sessions.length, 0);
	const res = await hook(ev('a', 'SessionStart'));
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), {});
	assert.equal((await api('GET', '/api/agents/sessions')).sessions[0].id, 'a');
});

test('sessions, timeline and live entries', async () => {
	const { ws, next } = await watch();
	const snapshot = await next((m) => m.type === 'snapshot');
	assert.ok(Array.isArray(snapshot.sessions));
	const sent = Date.now();
	await hook(ev('b', 'UserPromptSubmit', { prompt: 'Run the tests' }));
	await hook(ev('b', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't' }));
	const frame = await next((m) => m.type === 'entry' && m.session === 'b' && m.entry.kind === 'tool');
	assert.ok(Date.now() - sent < 1000);
	assert.equal(frame.entry.input.command, 'npm test');

	const { sessions } = await api('GET', '/api/agents/sessions');
	const b = sessions.find((s) => s.id === 'b');
	assert.deepEqual([b.title, b.state, b.agent], ['Run the tests', 'running', 'claude']);
	const page = await api('GET', '/api/agents/timeline', { query: { session: 'b', after: 1 } });
	assert.deepEqual(page.entries.map((e) => e.kind), ['tool']);
	await assert.rejects(api('GET', '/api/agents/timeline', { query: { session: 'nope' } }), { status: 404 });
	ws.close();
});

test('a permission held by the hook is answered from the phone', async () => {
	const { ws, next } = await watch();
	const held = hook(ev('c', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }));
	const { request } = await next((m) => m.type === 'request' && m.request.session === 'c');
	await api('POST', '/api/agents/answer', { body: { request: request.id, behavior: 'allow' } });
	const res = await held;
	assert.deepEqual(await res.json(), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
	await assert.rejects(api('POST', '/api/agents/answer', { body: { request: request.id, behavior: 'deny' } }), { status: 409 });
	ws.close();
});

test('the hook going away withdraws the request', async () => {
	const { ws, next } = await watch();
	const abort = new AbortController();
	const held = hook(ev('d', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }), { signal: abort.signal });
	const { request } = await next((m) => m.type === 'request' && m.request.session === 'd');
	abort.abort();
	await held.catch(() => {});
	const resolved = await next((m) => m.type === 'request_resolved' && m.request === request.id);
	assert.deepEqual([resolved.outcome, resolved.by], ['withdrawn', 'computer']);
	ws.close();
});

test('presence frames mark a client in the foreground', async () => {
	const { ws } = await watch();
	assert.equal(server.clientInForeground(), false);
	ws.send(JSON.stringify({ type: 'presence', foreground: true }));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(server.clientInForeground(), true);
	ws.send(JSON.stringify({ type: 'presence', foreground: false }));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(server.clientInForeground(), false);
	ws.close();
});

test('terminals tell coding agents where they run, and link sessions to them', async () => {
	const url = new URL(TERMINAL_WS_PATH, baseUrl.replace(/^http/, 'ws'));
	url.searchParams.set('cwd', root);
	const term = new WebSocket(url, { headers: bearer });
	let id;
	let output = '';
	term.on('message', (data, isBinary) => {
		if (isBinary) output += data.toString();
		else if (JSON.parse(data.toString()).type === 'session') id = JSON.parse(data.toString()).id;
	});
	await new Promise((r) => term.once('open', r));
	term.send(JSON.stringify({ type: 'input', data: 'echo "bin=$CODEREMOTE_HOOK_BIN port=$CODEREMOTE_AGENT_PORT term=$CODEREMOTE_TERM_ID"\r' }));
	const deadline = Date.now() + 5000;
	while (!/port=\d+ term=[0-9a-f-]{36}/.test(output) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	const [, port, termId] = output.match(/port=(\d+) term=([0-9a-f-]{36})/);
	assert.match(output, /bin=\/opt\/coderemote\/bin\/coderemote\.js port=/);
	assert.equal(Number(port), server.address().port);
	assert.equal(termId, id);

	await hook(ev('e', 'SessionStart'), { query: { terminal: termId } });
	assert.equal((await api('GET', '/api/agents/sessions')).sessions.find((s) => s.id === 'e').terminal, termId);
	// An unknown terminal id is not trusted.
	await hook(ev('f', 'SessionStart'), { query: { terminal: 'bogus' } });
	assert.equal((await api('GET', '/api/agents/sessions')).sessions.find((s) => s.id === 'f').terminal, null);

	await api('DELETE', '/api/term', { query: { id: termId } });
	const until = Date.now() + 5000;
	while ((await api('GET', '/api/agents/sessions')).sessions.find((s) => s.id === 'e').state !== 'ended' && Date.now() < until) {
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.equal((await api('GET', '/api/agents/sessions')).sessions.find((s) => s.id === 'e').state, 'ended');
	term.close();
});
