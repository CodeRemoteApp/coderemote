import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createAgentServer } from '@vsremote/agent-core';
import { pairingUrl } from '@vsremote/protocol';
import { ensureHookSecret, hookTarget, readHookSecret, runHook } from '../src/hook.js';

let dir;
let project;
let server;
let secret;

before(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coderemote-hook-'));
	project = path.join(dir, 'project');
	fs.mkdirSync(path.join(project, 'apps', 'web'), { recursive: true });
	secret = ensureHookSecret(path.join(dir, 'config'));
	server = createAgentServer({ token: 'pair-token', root: project, hookSecret: secret });
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
});

after(() => {
	server.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

const agents = () => [{ port: server.address().port, root: project }];
const event = (fields) => JSON.stringify({ session_id: 's', transcript_path: '/nope', cwd: path.join(project, 'apps', 'web'), ...fields });

test('the hook secret is private to the user and stays off the pairing link', () => {
	const config = path.join(dir, 'config');
	assert.equal(fs.statSync(path.join(config, 'hook-secret')).mode & 0o777, 0o600);
	assert.equal(ensureHookSecret(config), secret);
	assert.equal(readHookSecret(config), secret);
	assert.equal(readHookSecret(path.join(dir, 'missing')), null);
	assert.ok(!pairingUrl({ url: 'https://x.devtunnels.ms', token: 'pair-token' }).includes(secret));
});

test('routes by the terminal the session runs in, else by folder', () => {
	const list = [
		{ port: 31580, root: '/Users/me' },
		{ port: 31581, root: '/Users/me/project' },
	];
	assert.deepEqual(hookTarget(list, '/Users/me/project/src', {}), { port: 31581, terminal: null });
	assert.deepEqual(hookTarget(list, '/Users/me/other', {}), { port: 31580, terminal: null });
	assert.equal(hookTarget(list, '/Users/me-too', {}), null);
	assert.equal(hookTarget(list, '/opt/elsewhere', {}), null);
	assert.deepEqual(hookTarget(list, '/opt/elsewhere', { CODEREMOTE_AGENT_PORT: '31580', CODEREMOTE_TERM_ID: 't1' }), { port: 31580, terminal: 't1' });
	// A terminal of an agent that has since stopped falls back to the folder.
	assert.deepEqual(hookTarget(list, '/Users/me/project', { CODEREMOTE_AGENT_PORT: '40000' }), { port: 31581, terminal: null });
});

test('delivers events and prints nothing for them', async () => {
	const out = await runHook({ input: event({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' }), agents: agents(), secret, env: {} });
	assert.equal(out, '');
	assert.equal(server.agents.session('s').title, 'hello');
});

test('prints the phone’s decision for a PermissionRequest', async () => {
	const opened = new Promise((r) => server.agents.on('message', (m) => m.type === 'request' && r(m.request)));
	const out = runHook({ input: event({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }), agents: agents(), secret, env: {} });
	server.agents.answer({ request: (await opened).id, behavior: 'deny', message: 'not now' });
	assert.deepEqual(JSON.parse(await out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'not now' } } });
});

test('fails open: no agent, a folder nobody shares, a wrong secret, bad input', async () => {
	const started = Date.now();
	const down = [{ port: 1, root: project }];
	assert.equal(await runHook({ input: event({ hook_event_name: 'PermissionRequest' }), agents: down, secret, env: {} }), '');
	assert.ok(Date.now() - started < 2000);
	assert.equal(await runHook({ input: event({ hook_event_name: 'Stop', cwd: os.homedir() }), agents: agents(), secret, env: {} }), '');
	assert.equal(await runHook({ input: event({ hook_event_name: 'PermissionRequest' }), agents: agents(), secret: 'wrong', env: {} }), '');
	assert.equal(await runHook({ input: event({ hook_event_name: 'Stop' }), agents: agents(), secret: null, env: {} }), '');
	assert.equal(await runHook({ input: 'not json', agents: agents(), secret, env: {} }), '');
});

test('the hook launcher runs this CLI with this Node, whatever the PATH', async () => {
	const { writeHookLauncher } = await import('../src/hook.js');
	const { execFileSync } = await import('node:child_process');
	const script = path.join(dir, "it's cli.js");
	fs.writeFileSync(script, 'console.log(process.argv.slice(2).join(" "))');
	const launcher = writeHookLauncher(path.join(dir, 'launch'), { script });
	assert.equal(fs.statSync(launcher).mode & 0o777, 0o755);
	const out = execFileSync(launcher, ['--agent', 'codex'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
	assert.equal(out.trim(), 'hook --agent codex');
});
