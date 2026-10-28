// Typing prompts and keys into sessions, and the uploads they carry.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { HOOK_SECRET_HEADER } from '@vsremote/protocol';
import { AgentHub, createAgentServer } from '../src/index.js';
import { UploadStore, safeName } from '../src/uploads.js';

const token = 'test-token';
const hookSecret = 'hook-secret';
let tmp;
let root;
let uploads;
let server;
let hub;
let baseUrl;

before(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vsremote-prompt-'));
	root = path.join(tmp, 'share');
	uploads = path.join(tmp, 'uploads');
	await fs.mkdir(root);
	// Takes the terminal raw and records every byte typed into it.
	const fake = path.join(tmp, 'claude');
	await fs.writeFile(fake, `#!/bin/sh\nstty raw -echo\nexec cat > "${tmp}/typed-$$"\n`, { mode: 0o755 });
	hub = new AgentHub({ transcript: async () => [] });
	server = createAgentServer({ token, root, hookSecret, uploadsDir: uploads, claudeCommand: fake, pluginInstalled: async () => true, agents: hub });
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	server.killAllSessions();
	// Held hook requests and the deliberately unfinished upload would keep it open.
	server.closeAllConnections();
	server.close();
	await fs.rm(tmp, { recursive: true, force: true });
});

async function post(route, body, headers = {}) {
	const res = await fetch(`${baseUrl}${route}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, ...headers },
		body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
	});
	return { status: res.status, body: await res.json() };
}

const hook = (event, terminal) =>
	fetch(`${baseUrl}/api/agents/hook${terminal ? `?terminal=${terminal}` : ''}`, {
		method: 'POST',
		headers: { [HOOK_SECRET_HEADER]: hookSecret },
		body: JSON.stringify({ cwd: root, transcript_path: '/x', ...event }),
	});

/** Starts a stand-in session; returns its id and a reader of what was typed into it. */
async function session() {
	const before = new Set(await fs.readdir(tmp));
	const { body } = await post('/api/agents/sessions', {});
	await hook({ session_id: body.session.id, hook_event_name: 'SessionStart', source: 'startup' }, body.terminal);
	let file;
	for (let i = 0; i < 100 && !file; i++) {
		file = (await fs.readdir(tmp)).find((f) => f.startsWith('typed-') && !before.has(f));
		if (!file) await new Promise((r) => setTimeout(r, 30));
	}
	// Give `stty raw` time to take effect before anything is typed.
	await new Promise((r) => setTimeout(r, 300));
	const typed = async (want) => {
		let text = '';
		for (let i = 0; i < 100; i++) {
			text = await fs.readFile(path.join(tmp, file), 'latin1');
			if (text.length >= want) break;
			await new Promise((r) => setTimeout(r, 30));
		}
		return text;
	};
	return { id: body.session.id, terminal: body.terminal, typed };
}

test('a prompt is pasted as one block, then Enter, without control characters', async () => {
	const s = await session();
	const { status, body } = await post('/api/agents/prompt', { session: s.id, text: '  Fix the login\nthen run tests\u001b[201~x\r\n' });
	assert.equal(status, 200);
	assert.match(body.prompt, /^[0-9a-f-]{36}$/);
	const want = '\x1b[200~Fix the login\nthen run tests[201~x\x1b[201~\r';
	assert.equal(await s.typed(want.length), want);
});

test('attachments are pasted as their paths; Claude Code reporting the prompt confirms it', async () => {
	const s = await session();
	const up = await post('/api/agents/uploads', new Uint8Array([137, 80, 78, 71]), { 'content-type': 'image/png', 'x-filename': encodeURIComponent('Screen Shot 1.png') });
	assert.equal(up.status, 200);
	assert.deepEqual([up.body.name, up.body.type, up.body.size], ['Screen Shot 1.png', 'image/png', 4]);
	const file = await server.agentsUploadPath(up.body.id);
	assert.ok(file.startsWith(uploads + path.sep));

	const confirmed = new Promise((r) => hub.on('message', (m) => m.type === 'prompt_confirmed' && r(m)));
	const { body } = await post('/api/agents/prompt', { session: s.id, text: 'Why is this misaligned?', attachments: [up.body.id] });
	const want = `\x1b[200~Why is this misaligned?\n${file}\x1b[201~\r`;
	assert.equal(await s.typed(want.length), want);
	// Claude Code turns the image path into [Image #1].
	await hook({ session_id: s.id, hook_event_name: 'UserPromptSubmit', prompt: '[Image #1]Why is this misaligned?' }, s.terminal);
	assert.deepEqual(await confirmed, { type: 'prompt_confirmed', session: s.id, prompt: body.prompt });

	assert.equal((await post('/api/agents/prompt', { session: s.id, text: 'x', attachments: ['0f0e0d0c-1111-2222-3333-444455556666'] })).status, 404);
});

test('prompts only reach sessions running in a terminal here, and not while a dialog is up', async () => {
	assert.equal((await post('/api/agents/prompt', { session: 'nope', text: 'hi' })).status, 404);
	await hook({ session_id: 'elsewhere', hook_event_name: 'SessionStart' });
	assert.equal((await post('/api/agents/prompt', { session: 'elsewhere', text: 'hi' })).status, 409);

	const s = await session();
	assert.equal((await post('/api/agents/prompt', { session: s.id, text: '   ' })).status, 400);
	// Held open until the end; closing it then is expected.
	hook({ session_id: s.id, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, s.terminal).catch(() => {});
	for (let i = 0; i < 50 && hub.session(s.id).state !== 'waiting'; i++) await new Promise((r) => setTimeout(r, 20));
	const refused = await post('/api/agents/prompt', { session: s.id, text: 'hi' });
	assert.equal(refused.status, 409);
	assert.match(refused.body.error, /pending request/);
	// Esc still gets through, to back out of the dialog.
	assert.equal((await post('/api/agents/keys', { session: s.id, action: 'interrupt' })).status, 200);
	assert.equal(await s.typed(1), '\x1b');
});

test('keys: each action types exactly its bytes; anything else is refused', async () => {
	const s = await session();
	await post('/api/agents/keys', { session: s.id, action: 'interrupt' });
	await post('/api/agents/keys', { session: s.id, action: 'cycle_mode' });
	await post('/api/agents/keys', { session: s.id, action: 'command', command: '/compact' });
	const want = '\x1b\x1b[Z\x1b[200~/compact\x1b[201~\r';
	assert.equal(await s.typed(want.length), want);
	assert.equal((await post('/api/agents/keys', { session: s.id, action: 'command', command: '/exit' })).status, 400);
	assert.equal((await post('/api/agents/keys', { session: s.id, action: 'rm -rf' })).status, 400);
});

test('uploads: names cannot leave the folder; oversized files are refused', async () => {
	const evil = await post('/api/agents/uploads', 'x', { 'x-filename': '../../.ssh/authorized_keys' });
	assert.equal(evil.body.name, 'authorized_keys');
	assert.ok((await server.agentsUploadPath(evil.body.id)).startsWith(uploads + path.sep));
	assert.equal(safeName('..\\..\\win.ini'), 'win.ini');
	assert.equal(safeName('.hidden'), 'hidden');
	assert.equal(safeName(''), 'file');

	const status = await new Promise((resolve, reject) => {
		const req = http.request(`${baseUrl}/api/agents/uploads`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-length': String(200 * 1024 * 1024) },
		});
		req.on('response', (res) => {
			req.destroy();
			resolve(res.statusCode);
		});
		req.on('error', reject);
		req.write('x');
	});
	assert.equal(status, 413);
});

test('uploads are kept a week', async () => {
	let now = Date.parse('2026-10-01T10:00:00Z');
	const dir = path.join(tmp, 'sweep');
	const store = new UploadStore(dir, { now: () => now });
	const { Readable } = await import('node:stream');
	const saved = await store.save(Readable.from([Buffer.from('hi')]), { name: 'a.txt', type: 'text/plain' });
	assert.equal(await store.path(saved.id), saved.path);
	// Age the file: sweeping goes by modification time.
	const old = new Date(now - 8 * 24 * 3600_000);
	await fs.utimes(saved.path, old, old);
	await store.sweep();
	await assert.rejects(store.path(saved.id), { status: 404 });
	await assert.rejects(store.path('../x'), { status: 400 });
});
