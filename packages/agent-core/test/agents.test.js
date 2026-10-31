import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentHub } from '../src/agents.js';

const base = { session_id: 's1', transcript_path: '/tmp/s1.jsonl', cwd: '/Users/me/project', permission_mode: 'default' };
const ev = (hook_event_name, fields = {}) => ({ ...base, hook_event_name, ...fields });

function hub(opts) {
	let now = 1_000_000;
	const h = new AgentHub({ now: () => now, ...opts });
	const messages = [];
	h.on('message', (m) => messages.push(m));
	return { h, messages, tick: (ms) => (now += ms) };
}

test('follows a session through a turn', async () => {
	const { h, tick } = hub();
	await h.handle(ev('SessionStart', { source: 'startup' }));
	assert.equal(h.session('s1').state, 'idle');
	assert.equal(h.session('s1').title, 'project');

	await h.handle(ev('UserPromptSubmit', { prompt: 'Fix the login crash\nIt happens on iOS 27' }));
	assert.equal(h.session('s1').state, 'running');
	assert.equal(h.session('s1').title, 'Fix the login crash');

	await h.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' }));
	await h.handle(ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1', tool_response: { stdout: 'ok', stderr: '' }, duration_ms: 12 }));
	await h.handle(ev('MessageDisplay', { message_id: 'm1', index: 0, final: false, delta: 'All tests\n' }));
	await h.handle(ev('MessageDisplay', { message_id: 'm1', index: 1, final: true, delta: 'pass.' }));
	tick(90_000);
	await h.handle(ev('Stop', { last_assistant_message: 'All tests\npass.' }));

	assert.equal(h.session('s1').state, 'idle');
	const kinds = h.timeline('s1').entries.map((e) => e.kind);
	// The final text came through MessageDisplay already, so Stop doesn't add it twice.
	assert.deepEqual(kinds, ['prompt', 'tool', 'tool_result', 'assistant', 'turn_end']);
	const { entries } = h.timeline('s1');
	assert.equal(entries[2].output, 'ok');
	assert.equal(entries[3].text, 'All tests\npass.');
	assert.equal(entries[4].duration, 90_000);

	// The title stays the first prompt's.
	await h.handle(ev('UserPromptSubmit', { prompt: 'Now the signup' }));
	assert.equal(h.session('s1').title, 'Fix the login crash');
});

test('Stop supplies the final text when MessageDisplay did not', async () => {
	const { h } = hub();
	await h.handle(ev('UserPromptSubmit', { prompt: 'hi' }));
	await h.handle(ev('Stop', { last_assistant_message: 'Hello!' }));
	assert.deepEqual(
		h.timeline('s1').entries.map((e) => [e.kind, e.text]),
		[['prompt', 'hi'], ['assistant', 'Hello!'], ['turn_end', undefined]],
	);
});

test('long titles, tool output and failures', async () => {
	const { h } = hub();
	await h.handle(ev('UserPromptSubmit', { prompt: 'x'.repeat(200) }));
	assert.equal(h.session('s1').title.length, 80);
	await h.handle(ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 't', tool_response: { stdout: 'é'.repeat(600_000) } }));
	await h.handle(ev('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'u', error: 'Exit code 1' }));
	const [, big, failed] = h.timeline('s1').entries;
	assert.equal(big.truncated, true);
	assert.ok(Buffer.byteLength(big.output) <= 16 * 1024);
	assert.ok(!big.output.endsWith('�'));
	assert.deepEqual([failed.error, failed.output], [true, 'Exit code 1']);
});

test('keeps the latest 500 entries and pages by seq', async () => {
	const { h } = hub();
	for (let i = 0; i < 510; i++) await h.handle(ev('UserPromptSubmit', { prompt: `p${i}` }));
	const { entries, next } = h.timeline('s1');
	assert.equal(entries.length, 500);
	assert.equal(entries[0].text, 'p10');
	assert.equal(next, 510);
	assert.deepEqual(h.timeline('s1', 508).entries.map((e) => e.text), ['p508', 'p509']);
	assert.throws(() => h.timeline('nope'), { status: 404 });
});

test('ended sessions are forgotten a day later', async () => {
	const { h, tick } = hub();
	await h.handle(ev('SessionStart'));
	await h.handle(ev('SessionEnd', { reason: 'other' }));
	assert.equal(h.session('s1').state, 'ended');
	tick(23 * 3600_000);
	h.sweep();
	assert.ok(h.session('s1'));
	tick(2 * 3600_000);
	h.sweep();
	assert.equal(h.session('s1'), null);
});

test('a session ends with its terminal, and links to it', async () => {
	const { h } = hub();
	await h.handle(ev('SessionStart'), { terminal: 'term-1' });
	assert.equal(h.session('s1').terminal, 'term-1');
	h.terminalExited('term-1');
	assert.equal(h.session('s1').state, 'ended');
});

const permission = ev('PermissionRequest', {
	tool_name: 'Bash',
	tool_input: { command: 'curl -s -o out.html https://example.com' },
	permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'curl:*' }], behavior: 'allow', destination: 'localSettings' }],
});

/** Opens a request and returns it with the promise of the hook's output. */
async function open(h, event = permission, opts) {
	const opened = new Promise((resolve) => {
		const on = (m) => m.type === 'request' && (h.off('message', on), resolve(m.request));
		h.on('message', on);
	});
	const output = h.handle(event, opts);
	return { request: await opened, output };
}

test('allow, allow always and deny produce the hook output Claude Code expects', async () => {
	const { h } = hub();
	await h.handle(ev('UserPromptSubmit', { prompt: 'fetch it' }));

	let { request, output } = await open(h);
	assert.equal(h.session('s1').state, 'waiting');
	assert.equal(h.session('s1').pending, 1);
	assert.deepEqual([request.kind, request.tool, request.input.command], ['permission', 'Bash', 'curl -s -o out.html https://example.com']);
	h.answer({ request: request.id, behavior: 'allow' });
	assert.deepEqual(await output, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
	assert.equal(h.session('s1').state, 'running');

	({ request, output } = await open(h));
	h.answer({ request: request.id, behavior: 'allow', suggestion: 0 });
	assert.deepEqual((await output).hookSpecificOutput.decision, { behavior: 'allow', updatedPermissions: [permission.permission_suggestions[0]] });

	({ request, output } = await open(h));
	assert.throws(() => h.answer({ request: request.id, behavior: 'allow', suggestion: 3 }), { status: 400 });
	h.answer({ request: request.id, behavior: 'deny', message: 'use the staging URL instead' });
	assert.deepEqual((await output).hookSpecificOutput.decision, { behavior: 'deny', message: 'use the staging URL instead' });

	const resolved = h.timeline('s1').entries.filter((e) => e.kind === 'request_resolved').map((e) => [e.outcome, e.by]);
	assert.deepEqual(resolved, [['allowed', 'phone'], ['allowed', 'phone'], ['denied', 'phone']]);
});

test('questions are answered through updatedInput', async () => {
	const { h } = hub();
	const questions = [{ question: 'Which color do you prefer?', header: 'Color', options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }], multiSelect: false }];
	const { request, output } = await open(h, ev('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions } }));
	assert.equal(request.kind, 'question');
	assert.deepEqual(request.questions, questions);
	assert.throws(() => h.answer({ request: request.id, behavior: 'allow' }), { status: 400 });
	h.answer({ request: request.id, behavior: 'allow', answers: { 'Which color do you prefer?': 'Green' } });
	assert.deepEqual(await output, {
		hookSpecificOutput: {
			hookEventName: 'PermissionRequest',
			decision: { behavior: 'allow', updatedInput: { questions, answers: { 'Which color do you prefer?': 'Green' } } },
		},
	});
});

test('first answer wins', async () => {
	const { h } = hub();
	const { request, output } = await open(h);
	h.answer({ request: request.id, behavior: 'allow' });
	assert.throws(() => h.answer({ request: request.id, behavior: 'deny' }), { status: 409 });
	assert.throws(() => h.answer({ request: 'unknown', behavior: 'deny' }), { status: 404 });
	await output;
});

test('the computer answering first withdraws the request', async () => {
	const { h, messages } = hub();
	const abort = new AbortController();
	const { request, output } = await open(h, permission, { signal: abort.signal });
	abort.abort();
	assert.equal(await output, null);
	assert.equal(h.requests().length, 0);
	assert.ok(messages.some((m) => m.type === 'request_resolved' && m.outcome === 'withdrawn' && m.by === 'computer'));
	assert.throws(() => h.answer({ request: request.id, behavior: 'allow' }), { status: 409 });
});

test('a request nobody answers expires and leaves it to the computer', async () => {
	const { h } = hub({ requestTtl: 20 });
	const { output } = await open(h);
	// The expiry timer doesn't hold the process open (the server does); hold it here.
	const keepAlive = setTimeout(() => {}, 1000);
	assert.equal(await output, null);
	clearTimeout(keepAlive);
	assert.equal(h.timeline('s1').entries.at(-1).outcome, 'expired');
});

test('a session that ends withdraws its requests', async () => {
	const { h } = hub();
	const { output } = await open(h);
	await h.handle(ev('SessionEnd'));
	assert.equal(await output, null);
	assert.equal(h.session('s1').state, 'ended');
});

test('events without a session id are rejected', async () => {
	const { h } = hub();
	await assert.rejects(h.handle({ hook_event_name: 'Stop' }), { status: 400 });
});

test('message batches that arrive out of order are joined in order, once', async () => {
	const { h } = hub();
	await h.handle(ev('UserPromptSubmit', { prompt: 'go' }));
	await h.handle(ev('MessageDisplay', { message_id: 'm', index: 2, final: true, delta: 'three' }));
	await h.handle(ev('MessageDisplay', { message_id: 'm', index: 0, final: false, delta: 'one\n' }));
	assert.equal(h.timeline('s1').entries.length, 1);
	await h.handle(ev('MessageDisplay', { message_id: 'm', index: 1, final: false, delta: 'two\n' }));
	assert.equal(h.timeline('s1').entries.at(-1).text, 'one\ntwo\nthree');

	// Stop got there before the last message's batches.
	await h.handle(ev('Stop', { last_assistant_message: 'Done.' }));
	await h.handle(ev('MessageDisplay', { message_id: 'n', index: 0, final: true, delta: 'Done.' }));
	assert.deepEqual(h.timeline('s1').entries.map((e) => e.kind), ['prompt', 'assistant', 'assistant', 'turn_end']);
});

test('an interrupted turn becomes idle when Claude Code reports it', async () => {
	const { h } = hub();
	await h.handle(ev('UserPromptSubmit', { prompt: 'go' }));
	await h.handle(ev('Notification', { notification_type: 'permission_prompt', message: 'needs permission' }));
	assert.equal(h.session('s1').state, 'running');
	await h.handle(ev('Notification', { notification_type: 'idle_prompt', message: 'waiting for input' }));
	assert.equal(h.session('s1').state, 'idle');
});

test('a session launched from the app waits for a prompt once it starts', async () => {
	const { h } = hub();
	h.launched({ id: 's1', terminal: 'term-1', cwd: base.cwd });
	assert.equal(h.session('s1').state, 'running', 'starting up');
	await h.handle(ev('SessionStart', { source: 'startup' }), { terminal: 'term-1' });
	assert.equal(h.session('s1').state, 'idle');

	await h.handle(ev('UserPromptSubmit', { prompt: 'hi' }));
	await h.handle(ev('SessionStart', { source: 'compact' }));
	assert.equal(h.session('s1').state, 'running', 'a compaction mid-turn leaves the turn running');
});
