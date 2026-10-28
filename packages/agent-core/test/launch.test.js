// Starting and resuming Claude Code sessions from the phone, with a stand-in `claude`.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { HOOK_SECRET_HEADER } from '@vsremote/protocol';
import { AgentHub, createAgentServer } from '../src/index.js';

const token = 'test-token';
const hookSecret = 'hook-secret';
let tmp;
let root;
let uploads;
let fakeClaude;
let server;
let hub;
let baseUrl;

before(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vsremote-launch-'));
	root = path.join(tmp, 'share');
	uploads = path.join(tmp, 'uploads');
	await fs.mkdir(path.join(root, `it's a "project"`), { recursive: true });
	// Records where and how it was started, then stays up like Claude Code would.
	fakeClaude = path.join(tmp, 'fake claude');
	await fs.writeFile(fakeClaude, `#!/bin/sh\n{ pwd; echo "classic=$CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"; for a in "$@"; do echo "$a"; done; } > "${tmp}/launched-$$"\nexec sleep 30\n`, { mode: 0o755 });
	hub = new AgentHub({ startTimeout: 300, transcript: async () => [] });
	server = createAgentServer({ token, root, hookSecret, uploadsDir: uploads, claudeCommand: fakeClaude, pluginInstalled: async () => true, agents: hub });
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	server.killAllSessions();
	server.close();
	await fs.rm(tmp, { recursive: true, force: true });
});

async function launch(body) {
	const res = await fetch(`${baseUrl}/api/agents/sessions`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json() };
}

const hook = (event, terminal) =>
	fetch(`${baseUrl}/api/agents/hook?agent=claude${terminal ? `&terminal=${terminal}` : ''}`, {
		method: 'POST',
		headers: { [HOOK_SECRET_HEADER]: hookSecret },
		body: JSON.stringify(event),
	});

async function launchedArgs() {
	for (let i = 0; i < 100; i++) {
		const files = (await fs.readdir(tmp)).filter((f) => f.startsWith('launched-'));
		for (const f of files) {
			const text = await fs.readFile(path.join(tmp, f), 'utf8');
			if (text.endsWith('\n')) {
				await fs.rm(path.join(tmp, f));
				return text.trimEnd().split('\n');
			}
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error('the stand-in claude never ran');
}

const until = async (check) => {
	for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 30));
	return check();
};

test('starts Claude Code in a folder of the share, quoted safely, with its own session id', async () => {
	const dir = path.join(root, `it's a "project"`);
	const { status, body } = await launch({ cwd: dir, model: 'sonnet', permissionMode: 'acceptEdits' });
	assert.equal(status, 200);
	const [cwd, classic, ...args] = await launchedArgs();
	assert.equal(await fs.realpath(cwd), await fs.realpath(dir));
	assert.equal(classic, 'classic=1');
	assert.deepEqual(args, ['--session-id', body.session.id, '--model', 'sonnet', '--permission-mode', 'acceptEdits', '--add-dir', uploads]);
	assert.deepEqual([body.session.state, body.session.starting, body.session.terminal], ['running', true, body.terminal]);
	assert.ok((await fs.stat(uploads)).isDirectory());

	// Its first hook event, from that terminal, settles it.
	await hook({ session_id: body.session.id, cwd: dir, transcript_path: '/x', hook_event_name: 'SessionStart', source: 'startup' }, body.terminal);
	assert.equal(hub.session(body.session.id).starting, false);
	assert.equal(hub.session(body.session.id).terminal, body.terminal);
});

test('refuses folders outside the share and bad options', async () => {
	assert.equal((await launch({ cwd: os.tmpdir() })).status, 400);
	assert.equal((await launch({ cwd: path.join(root, 'missing') })).status, 400);
	assert.equal((await launch({ permissionMode: 'bypassPermissions' })).status, 400);
	assert.equal((await launch({ model: 'x; rm -rf ~' })).status, 400);
	assert.equal((await launch({ resume: '../../etc' })).status, 400);
});

test('resumes only sessions no process runs any more', async () => {
	const id = '0f0e0d0c-1111-2222-3333-444455556666';
	await hook({ session_id: id, cwd: root, transcript_path: '/x', hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
	const open = await launch({ resume: id });
	assert.equal(open.status, 409);
	await hook({ session_id: id, cwd: root, transcript_path: '/x', hook_event_name: 'SessionEnd', reason: 'other' });
	const { status, body } = await launch({ resume: id });
	assert.equal(status, 200);
	const [, , ...args] = await launchedArgs();
	assert.deepEqual(args.slice(0, 2), ['--resume', id]);
	assert.equal(body.session.id, id);
	assert.equal(hub.session(id).state, 'running');
});

test('a resume that comes back under a new id replaces its placeholder', async () => {
	const old = '1a1a1a1a-1111-2222-3333-444455556666';
	await hook({ session_id: old, cwd: root, transcript_path: '/x', hook_event_name: 'SessionEnd' });
	const removed = [];
	hub.on('message', (m) => m.type === 'session_removed' && removed.push(m.session));
	const { body } = await launch({ resume: old });
	await launchedArgs();
	await hook({ session_id: 'new-id-2222', cwd: root, transcript_path: '/x', hook_event_name: 'SessionStart', source: 'resume' }, body.terminal);
	assert.deepEqual(removed, [old]);
	assert.equal(hub.session(old), null);
	assert.equal(hub.session('new-id-2222').terminal, body.terminal);
});

test('a session that never reports ends with an error, and ends with its terminal', async () => {
	const { body } = await launch({});
	await launchedArgs();
	assert.ok(await until(() => hub.session(body.session.id).state === 'ended'));
	assert.match(hub.session(body.session.id).error, /didn't report back/);

	const second = (await launch({})).body;
	await launchedArgs();
	await fetch(`${baseUrl}/api/term?id=${second.terminal}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
	assert.ok(await until(() => hub.session(second.session.id).state === 'ended'));
	assert.match(hub.session(second.session.id).error, /exited before it started/);
});

test('says when Claude Code is not installed', async () => {
	const other = createAgentServer({ token, root, hookSecret, claudeCommand: path.join(tmp, 'no-such-claude') });
	await new Promise((r) => other.listen(0, '127.0.0.1', r));
	const res = await fetch(`http://127.0.0.1:${other.address().port}/api/agents/sessions`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}` },
		body: '{}',
	});
	const body = await res.json();
	other.close();
	assert.equal(res.status, 400);
	assert.equal(body.code, 'ENOCLAUDE');
});

test('without the plugin, says how to set it up instead of starting a session that never shows', async () => {
	let checks = 0;
	const other = createAgentServer({ token, root, hookSecret, claudeCommand: fakeClaude, pluginInstalled: async () => (checks++, false) });
	await new Promise((r) => other.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${other.address().port}`;
	const auth = { authorization: `Bearer ${token}` };
	const res = await fetch(`${url}/api/agents/sessions`, { method: 'POST', headers: auth, body: '{}' });
	const body = await res.json();
	assert.equal(res.status, 400);
	assert.equal(body.code, 'ENOPLUGIN');
	assert.match(body.error, /coderemote setup claude/);
	assert.deepEqual(await (await fetch(`${url}/api/agents/setup`, { headers: auth })).json(), { claude: true, plugin: false });
	assert.equal(checks, 1, 'the answer is kept a while');

	// A hook event proves the plugin is there.
	await fetch(`${url}/api/agents/hook`, {
		method: 'POST',
		headers: { [HOOK_SECRET_HEADER]: hookSecret },
		body: JSON.stringify({ session_id: 's', cwd: root, transcript_path: '/x', hook_event_name: 'SessionStart' }),
	});
	assert.deepEqual(await (await fetch(`${url}/api/agents/setup`, { headers: auth })).json(), { claude: true, plugin: true });
	other.close();
});
