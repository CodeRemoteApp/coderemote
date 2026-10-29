// Starting and resuming Claude Code sessions from the phone, with a stand-in `claude`.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { HOOK_SECRET_HEADER } from '@vsremote/protocol';
import { AgentHub, createAgentServer } from '../src/index.js';
import { isWindows } from '../src/platform.js';

const token = 'test-token';
const hookSecret = 'hook-secret';
let tmp;
let root;
let uploads;
let fakeClaude;
let server;
let hub;
let baseUrl;
// Quotes can't be in a Windows file name; cmd.exe's metacharacters can.
const PROJECT = isWindows ? "it's a (project) & 100% more" : `it's a "project"`;

before(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vsremote-launch-'));
	root = path.join(tmp, 'share');
	uploads = path.join(tmp, 'uploads');
	await fs.mkdir(path.join(root, PROJECT), { recursive: true });
	// Records where and how it was started, then stays up like Claude Code would.
	fakeClaude = path.join(tmp, 'fake claude');
	if (isWindows) {
		// A batch file, like npm's claude.cmd, in front of a script doing the same.
		const script = path.join(tmp, 'fake-claude.mjs');
		const record = `[process.cwd(), 'classic=' + (process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN ?? ''), ...process.argv.slice(2)].join('\\n') + '\\n'`;
		await fs.writeFile(script, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(tmp)} + '/launched-' + process.pid, ${record});\nsetTimeout(() => {}, 30_000);\n`);
		fakeClaude += '.cmd';
		await fs.writeFile(fakeClaude, `@"${process.execPath}" "${script}" %*\r\n`);
	} else {
		await fs.writeFile(fakeClaude, `#!/bin/sh\n{ pwd; echo "classic=$CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"; for a in "$@"; do echo "$a"; done; } > "${tmp}/launched-$$"\nexec sleep 30\n`, { mode: 0o755 });
	}
	hub = new AgentHub({ startTimeout: 300, transcript: async () => [] });
	server = createAgentServer({ token, root, hookSecret, uploadsDir: uploads, claudeCommand: fakeClaude, pluginInstalled: async () => true, agents: hub });
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	await server.killAllSessions();
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
	const dir = path.join(root, PROJECT);
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
	assert.equal(body.session.id, id);
	assert.equal(hub.session(id).state, 'running');
	const [, , ...args] = await launchedArgs();
	assert.deepEqual(args.slice(0, 2), ['--resume', id]);
});

test('a resume that comes back under a new id replaces its placeholder', async () => {
	const old = '1a1a1a1a-1111-2222-3333-444455556666';
	await hook({ session_id: old, cwd: root, transcript_path: '/x', hook_event_name: 'SessionEnd' });
	const removed = [];
	hub.on('message', (m) => m.type === 'session_removed' && removed.push(m.session));
	const { body } = await launch({ resume: old });
	// Reported at once: a slow machine can take longer than the short start timeout to run the stand-in.
	await hook({ session_id: 'new-id-2222', cwd: root, transcript_path: '/x', hook_event_name: 'SessionStart', source: 'resume' }, body.terminal);
	await launchedArgs();
	assert.deepEqual(removed, [old]);
	assert.equal(hub.session(old), null);
	assert.equal(hub.session('new-id-2222').terminal, body.terminal);
});

test('a session that never reports ends with an error, and ends with its terminal', async () => {
	const { body } = await launch({});
	await launchedArgs();
	assert.ok(await until(() => hub.session(body.session.id).state === 'ended'));
	assert.match(hub.session(body.session.id).error, /Claude Code didn't report back.*setup claude/);

	// A start timeout that can't fire first, however slow the machine is to start and stop the stand-in.
	const patient = new AgentHub({ startTimeout: 60_000, transcript: async () => [] });
	const other = createAgentServer({ token, root, hookSecret, claudeCommand: fakeClaude, pluginInstalled: async () => true, agents: patient });
	await new Promise((r) => other.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${other.address().port}`;
	const auth = { authorization: `Bearer ${token}` };
	const second = await (await fetch(`${url}/api/agents/sessions`, { method: 'POST', headers: auth, body: '{}' })).json();
	await launchedArgs();
	await fetch(`${url}/api/term?id=${second.terminal}`, { method: 'DELETE', headers: auth });
	assert.ok(await until(() => patient.session(second.session.id).state === 'ended'));
	assert.match(patient.session(second.session.id).error, /exited before it started/);
	await other.killAllSessions();
	other.close();
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
	const setup = await (await fetch(`${url}/api/agents/setup`, { headers: auth })).json();
	assert.deepEqual([setup.claude, setup.plugin], [true, false]);
	assert.equal(checks, setup.codex ? 2 : 1, 'one check per agent, kept a while');

	// A hook event proves the plugin is there.
	await fetch(`${url}/api/agents/hook`, {
		method: 'POST',
		headers: { [HOOK_SECRET_HEADER]: hookSecret },
		body: JSON.stringify({ session_id: 's', cwd: root, transcript_path: '/x', hook_event_name: 'SessionStart' }),
	});
	assert.equal((await (await fetch(`${url}/api/agents/setup`, { headers: auth })).json()).plugin, true);
	other.close();
});

test('starts Codex with its own flags; its first event replaces the placeholder', async () => {
	const codex = createAgentServer({ token, root, hookSecret, codexCommand: fakeClaude, pluginInstalled: async () => true, agents: hub });
	await new Promise((r) => codex.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${codex.address().port}`;
	const auth = { authorization: `Bearer ${token}` };
	const res = await fetch(`${url}/api/agents/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ agent: 'codex', model: 'gpt-5.6-luna', permissionMode: 'plan' }) });
	const body = await res.json();
	assert.equal(res.status, 200);
	const [, classic, ...args] = await launchedArgs();
	assert.deepEqual(args, ['-m', 'gpt-5.6-luna', '-a', 'on-request'], 'asks for approval, no Claude-only flags');
	assert.equal(classic, 'classic=');
	assert.equal(body.session.agent, 'codex');

	// Codex reports nothing until its first prompt: no start timeout, ready to be typed into.
	assert.deepEqual([body.session.state, body.session.starting], ['idle', true]);
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(hub.session(body.session.id).error, null);
	const removed = new Promise((r) => hub.on('message', (m) => m.type === 'session_removed' && m.session === body.session.id && r(m)));
	await fetch(`${url}/api/agents/hook?agent=codex&terminal=${body.terminal}`, {
		method: 'POST',
		headers: { [HOOK_SECRET_HEADER]: hookSecret },
		body: JSON.stringify({ session_id: '01a180e0-codex', cwd: root, transcript_path: '/x', hook_event_name: 'SessionStart', source: 'startup' }),
	});
	assert.equal((await removed).replacedBy, '01a180e0-codex');
	const real = hub.session('01a180e0-codex');
	assert.deepEqual([real.agent, real.terminal, real.capabilities.approvals], ['codex', body.terminal, 'presence']);

	// Codex has no Shift+Tab mode cycling or /clear.
	const key = (b) => fetch(`${url}/api/agents/keys`, { method: 'POST', headers: auth, body: JSON.stringify({ session: real.id, ...b }) });
	assert.equal((await key({ action: 'cycle_mode' })).status, 400);
	assert.equal((await key({ action: 'command', command: '/clear' })).status, 400);
	assert.equal((await key({ action: 'interrupt' })).status, 200);
	assert.equal((await fetch(`${url}/api/agents/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ agent: 'gemini' }) })).status, 400);
	await codex.killAllSessions();
	codex.close();
});

test("lists the models Codex's own picker shows, in its order", async () => {
	const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
	await fs.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({
		models: [
			{ slug: 'b', display_name: 'B', description: 'second', visibility: 'list', priority: 9 },
			{ slug: 'hidden', display_name: 'Hidden', visibility: 'hide', priority: 1 },
			{ slug: 'a', display_name: 'A', description: 'first', visibility: 'list', priority: 5 },
		],
	}));
	const other = createAgentServer({ token, root, hookSecret, codexCommand: fakeClaude, codexHome, pluginInstalled: async () => true });
	await new Promise((r) => other.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${other.address().port}`;
	const setup = await (await fetch(`${url}/api/agents/setup`, { headers: { authorization: `Bearer ${token}` } })).json();
	other.close();
	assert.deepEqual(setup.codexModels, [
		{ id: 'a', name: 'A', description: 'first' },
		{ id: 'b', name: 'B', description: 'second' },
	]);
});

const post = (route, body) =>
	fetch(`${baseUrl}/api/agents/${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

test('stops a session by closing its terminal, then forgets it', async () => {
	const { body } = await launch({});
	const id = body.session.id;
	await hook({ session_id: id, cwd: root, transcript_path: '/x', hook_event_name: 'SessionStart', source: 'startup' }, body.terminal);
	await launchedArgs();
	assert.equal((await post('forget', { session: id })).status, 409);
	assert.equal((await post('stop', { session: id })).status, 200);
	assert.ok(await until(() => hub.session(id)?.state === 'ended'));
	assert.equal((await post('stop', { session: id })).status, 409);

	const removed = new Promise((r) => hub.on('message', (m) => m.type === 'session_removed' && m.session === id && r(m)));
	assert.equal((await post('forget', { session: id })).status, 200);
	assert.equal((await removed).replacedBy, null);
	assert.equal(hub.session(id), null);
	assert.equal((await post('forget', { session: id })).status, 404);
});

test('forgets a session started outside Code Remote, which only stops where it runs', async () => {
	const id = '2b2b2b2b-1111-2222-3333-444455556666';
	await hook({ session_id: id, cwd: root, transcript_path: '/x', hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
	assert.equal((await post('stop', { session: id })).status, 409);
	assert.equal((await post('forget', { session: id })).status, 200);
	assert.equal(hub.session(id), null);
});
