// Codex sessions, from hook payloads recorded with Codex 0.165 (paths shortened).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentHub } from '../src/agents.js';

const common = {
	session_id: '01a180e0-ec32-7dc2-a3d1-f0494c08ed5d',
	transcript_path: '/Users/me/.codex/sessions/2026/10/28/rollout-2026-10-28T11-59-46-01a180e0.jsonl',
	cwd: '/Users/me/project',
	model: 'gpt-5.6-luna',
	permission_mode: 'default',
};
const turn = { turn_id: '01a180e1-1983-71a3-91e8-36fce13ff043' };
const ev = {
	start: { ...common, hook_event_name: 'SessionStart', source: 'startup' },
	prompt: { ...common, ...turn, hook_event_name: 'UserPromptSubmit', prompt: 'Run the shell command touch spike.txt' },
	pre: { ...common, ...turn, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'touch spike.txt' }, tool_use_id: 'exec-d76a6a2e' },
	permission: {
		...common,
		...turn,
		hook_event_name: 'PermissionRequest',
		tool_name: 'Bash',
		tool_input: { command: 'touch spike.txt', description: 'May I create spike.txt in the requested folder?' },
	},
	post: { ...common, ...turn, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'touch spike.txt' }, tool_response: '', tool_use_id: 'exec-d76a6a2e' },
	stop: { ...common, ...turn, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: null },
};

function hub(opts) {
	return new AgentHub({ transcript: async () => [], ...opts });
}

const opened = (h) =>
	new Promise((resolve) => {
		const on = (m) => m.type === 'request' && (h.off('message', on), resolve(m.request));
		h.on('message', on);
	});

test('a Codex turn becomes a session with its timeline and capabilities', async () => {
	const h = hub();
	for (const e of [ev.start, ev.prompt, ev.pre, ev.post, ev.stop]) await h.handle(e, { agent: 'codex' });
	const s = h.session(common.session_id);
	assert.deepEqual([s.agent, s.title, s.state], ['codex', 'Run the shell command touch spike.txt', 'idle']);
	assert.deepEqual(s.capabilities, { approvals: 'presence', alwaysAllow: false, keys: ['interrupt', '/compact', '/model'] });
	assert.deepEqual(
		h.timeline(s.id).entries.map((e) => [e.kind, e.name ?? e.text ?? null]),
		[['prompt', 'Run the shell command touch spike.txt'], ['tool', 'Bash'], ['tool_result', 'Bash'], ['turn_end', null]],
	);
	assert.equal(h.timeline(s.id).entries[2].output, '');
	// Claude's stay as they were.
	await h.handle({ ...ev.start, session_id: 'c1' });
	assert.deepEqual([h.session('c1').capabilities.approvals, h.session('c1').capabilities.alwaysAllow], ['parallel', true]);
});

test('someone at the computer: the request is recorded and left to the terminal at once', async () => {
	const h = hub({ present: async () => true });
	const messages = [];
	h.on('message', (m) => messages.push(m));
	const output = await h.handle(ev.permission, { agent: 'codex' });
	assert.equal(output, null);
	assert.equal(h.requests().length, 0);
	const resolved = messages.find((m) => m.type === 'request_resolved');
	assert.deepEqual([resolved.outcome, resolved.by], ['deferred', 'agent']);
	assert.deepEqual(h.timeline(common.session_id).entries.map((e) => e.kind), ['request', 'request_resolved']);
});

test('nobody at the computer: held for the phone, answered with Codex’s decision shape', async () => {
	const h = hub({ present: async () => false });
	const request = opened(h);
	const output = h.handle(ev.permission, { agent: 'codex' });
	const r = await request;
	assert.equal(r.input.command, 'touch spike.txt');
	assert.throws(() => h.answer({ request: r.id, behavior: 'allow', suggestion: 0 }), { status: 400 });
	h.answer({ request: r.id, behavior: 'deny', message: 'not on main' });
	assert.deepEqual(await output, {
		hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'not on main' } },
	});
});

test('a held Codex request goes back to the terminal sooner than a Claude one', async () => {
	const h = hub({ present: async () => false, sequentialTtl: 20, requestTtl: 60_000 });
	const keepAlive = setTimeout(() => {}, 1000);
	assert.equal(await h.handle(ev.permission, { agent: 'codex' }), null);
	clearTimeout(keepAlive);
	assert.equal(h.timeline(common.session_id).entries.at(-1).outcome, 'expired');
});

test('apply_patch input reads like a command; unknown agents are refused', async () => {
	const h = hub();
	await h.handle({ ...ev.pre, tool_name: 'apply_patch', tool_input: '*** Begin Patch\n*** End Patch' }, { agent: 'codex' });
	assert.equal(h.timeline(common.session_id).entries[0].input.command, '*** Begin Patch\n*** End Patch');
	await assert.rejects(h.handle(ev.start, { agent: 'gemini' }), { status: 400 });
});

test('a prompt typed into a Codex placeholder is confirmed under the session Codex reports', async () => {
	const h = hub();
	const messages = [];
	h.on('message', (m) => messages.push(m));
	const placeholder = h.launched({ id: 'ph-1', terminal: 't-1', cwd: '/Users/me/project', agent: 'codex' });
	assert.deepEqual([placeholder.state, placeholder.starting], ['idle', true]);
	h.prompted('ph-1', { id: 'p-1', text: 'Run the shell command touch spike.txt' });
	await h.handle(ev.start, { agent: 'codex', terminal: 't-1' });
	await h.handle(ev.prompt, { agent: 'codex', terminal: 't-1' });
	assert.ok(messages.some((m) => m.type === 'session_removed' && m.session === 'ph-1' && m.replacedBy === common.session_id));
	assert.ok(messages.some((m) => m.type === 'prompt_confirmed' && m.session === common.session_id && m.prompt === 'p-1'));
	assert.equal(h.session('ph-1'), null);
});

test('without a terminal from the hook, the only Codex placeholder in that folder is the one', async () => {
	const h = hub();
	const removed = [];
	h.on('message', (m) => m.type === 'session_removed' && removed.push(m));
	h.launched({ id: 'ph-a', terminal: 't-a', cwd: '/Users/me/project', agent: 'codex' });
	h.launched({ id: 'ph-b', terminal: 't-b', cwd: '/Users/me/other', agent: 'codex' });
	h.launched({ id: 'ph-c', terminal: 't-c', cwd: '/Users/me/project', agent: 'claude' });
	await h.handle(ev.start, { agent: 'codex' });
	assert.deepEqual(removed.map((m) => [m.session, m.replacedBy]), [['ph-a', common.session_id]]);
	assert.equal(h.session(common.session_id).terminal, 't-a');
	assert.ok(h.session('ph-b') && h.session('ph-c'));

	// Two candidates: no guessing.
	const g = hub();
	g.launched({ id: 'x1', terminal: 't-1', cwd: '/Users/me/project', agent: 'codex' });
	g.launched({ id: 'x2', terminal: 't-2', cwd: '/Users/me/project', agent: 'codex' });
	await g.handle(ev.start, { agent: 'codex' });
	assert.equal(g.session(common.session_id).terminal, null);
	assert.ok(g.session('x1') && g.session('x2'));
});

test('what Codex says between tools and what its patches did come from the rollout', async () => {
	let feed;
	const h = hub({ rolloutTail: (file, onItem) => ((feed = onItem), { poll: async () => {}, stop() {} }) });
	await h.handle(ev.start, { agent: 'codex' });
	await h.handle(ev.prompt, { agent: 'codex' });
	feed({ type: 'Reasoning', id: 'rs_1' });
	feed({ type: 'AgentMessage', content: [{ type: 'Text', text: 'I will ask to write a.txt.' }] });
	const patch = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: a.txt\n+message\n*** End Patch\nPATCH";
	await h.handle({ ...ev.pre, tool_input: { command: patch }, tool_use_id: 'exec-1' }, { agent: 'codex' });
	feed({ type: 'FileChange', id: 'exec-1', changes: { '/Users/me/project/a.txt': { type: 'add', content: 'message\n' } } });
	feed({ type: 'FileChange', id: 'exec-1', changes: {} });
	feed({ type: 'AgentMessage', content: [{ type: 'Text', text: 'Done.' }] });
	await h.handle({ ...ev.stop, last_assistant_message: 'Done.' }, { agent: 'codex' });
	const entries = h.timeline(common.session_id).entries;
	assert.deepEqual(
		entries.map((e) => [e.kind, e.text ?? e.output ?? e.name]),
		[
			['prompt', 'Run the shell command touch spike.txt'],
			['assistant', 'I will ask to write a.txt.'],
			['tool', 'Bash'],
			['tool_result', 'Added /Users/me/project/a.txt'],
			['assistant', 'Done.'],
			['turn_end', undefined],
		],
	);
	assert.equal(entries[3].name, 'Bash');
});

test('the rollout is followed from where it ended, across partly written lines', async () => {
	const { RolloutTail } = await import('../src/codex-rollout.js');
	const fs = await import('node:fs/promises');
	const os = await import('node:os');
	const path = await import('node:path');
	const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rollout-')), 'r.jsonl');
	const line = (text) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text }] } } });
	await fs.writeFile(file, `${line('old history')}\n`);
	const seen = [];
	const tail = new RolloutTail(file, (item) => seen.push(item.content[0].text));
	await tail.poll();
	const next = line('new');
	await fs.appendFile(file, `${next.slice(0, 20)}`);
	await tail.poll();
	await fs.appendFile(file, `${next.slice(20)}\n{"type":"session_meta"}\nnot json\n`);
	await tail.poll();
	tail.stop();
	assert.deepEqual(seen, ['new']);
});
