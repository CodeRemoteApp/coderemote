import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AgentHub } from '../src/agents.js';
import { readTranscript } from '../src/transcript.js';

const at = (s) => `2026-10-28T08:00:${String(s).padStart(2, '0')}.000Z`;
const records = [
	{ type: 'permission-mode', permissionMode: 'default', sessionId: 's' },
	{ type: 'user', timestamp: at(1), message: { role: 'user', content: 'Fix the flaky test' } },
	{ type: 'user', timestamp: at(1), isMeta: true, message: { role: 'user', content: 'injected context' } },
	{ type: 'user', timestamp: at(2), message: { role: 'user', content: '<command-name>/clear</command-name>' } },
	{ type: 'assistant', timestamp: at(3), message: { role: 'assistant', content: [{ type: 'text', text: 'Running it.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
	{ type: 'user', timestamp: at(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '1 failing' }], is_error: true }] } },
	{ type: 'assistant', timestamp: at(5), isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } },
	{ type: 'some-future-record', whatever: [1, 2, 3] },
	{ type: 'assistant', timestamp: at(6), message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] } },
];

async function transcriptFile(lines) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vsremote-transcript-'));
	const file = path.join(dir, 's.jsonl');
	await fs.writeFile(file, lines.join('\n') + '\n');
	return file;
}

test('reads prompts, replies and tools, skipping what it does not know', async () => {
	const file = await transcriptFile([...records.map((r) => JSON.stringify(r)), '{not json']);
	const entries = await readTranscript(file);
	assert.deepEqual(
		entries.map((e) => [e.kind, e.text ?? e.name ?? e.output]),
		[
			['prompt', 'Fix the flaky test'],
			['assistant', 'Running it.'],
			['tool', 'Bash'],
			['tool_result', '1 failing'],
			['assistant', 'Fixed.'],
		],
	);
	assert.equal(entries[3].error, true);
	assert.equal(entries[0].time, Date.parse(at(1)));
	assert.deepEqual(await readTranscript('/no/such/file.jsonl'), []);
});

test('a session first seen mid-way gets its history, before the new event', async () => {
	const file = await transcriptFile(records.map((r) => JSON.stringify(r)));
	const hub = new AgentHub();
	await hub.handle({ session_id: 's', cwd: '/p', transcript_path: file, hook_event_name: 'UserPromptSubmit', prompt: 'And the other one' });
	const { entries } = hub.timeline('s');
	assert.deepEqual(entries.map((e) => e.kind), ['prompt', 'assistant', 'tool', 'tool_result', 'assistant', 'prompt']);
	assert.equal(entries[3].name, 'Bash');
	assert.deepEqual(entries.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
	assert.equal(hub.session('s').title, 'Fix the flaky test');
});

test('new sessions do not read a transcript, and a broken reader never throws', async () => {
	let reads = 0;
	const hub = new AgentHub({ transcript: async () => (reads++, []) });
	await hub.handle({ session_id: 'n', cwd: '/p', transcript_path: '/x', hook_event_name: 'SessionStart', source: 'startup' });
	assert.equal(reads, 0);
	const failing = new AgentHub({ transcript: async () => { throw new Error('boom'); } });
	await failing.handle({ session_id: 'r', cwd: '/p', transcript_path: '/x', hook_event_name: 'SessionStart', source: 'resume' });
	assert.equal(failing.timeline('r').entries.length, 0);
});

test('shown thinking reads as the reply, empty thinking does not, and the AI title names the session', async () => {
	const file = await transcriptFile([
		{ type: 'user', timestamp: at(1), message: { role: 'user', content: '<task-notification>\n<status>completed</status>\n</task-notification>' } },
		{ type: 'assistant', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'x' }] } },
		{ type: 'assistant', timestamp: at(3), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Checking the logs first.', signature: 'y' }] } },
		{ type: 'ai-title', aiTitle: 'Push notification triggers', sessionId: 's' },
	].map((r) => JSON.stringify(r)));
	const entries = await readTranscript(file);
	assert.deepEqual(entries.map((e) => [e.kind, e.text]), [
		['title', 'Push notification triggers'],
		['prompt', '<task-notification>\n<status>completed</status>\n</task-notification>'],
		['assistant', 'Checking the logs first.'],
	]);
	const hub = new AgentHub();
	await hub.handle({ session_id: 's', cwd: '/p', transcript_path: file, hook_event_name: 'Notification' });
	assert.equal(hub.session('s').title, 'Push notification triggers');
	assert.ok(!hub.timeline('s').entries.some((e) => e.kind === 'title'));
});

test('a task notification never titles a session', async () => {
	const hub = new AgentHub({ transcript: async () => [] });
	await hub.handle({ session_id: 'n', cwd: '/p/app', transcript_path: '/x', hook_event_name: 'SessionStart', source: 'startup' });
	await hub.handle({ session_id: 'n', cwd: '/p/app', transcript_path: '/x', hook_event_name: 'UserPromptSubmit', prompt: '<task-notification><status>completed</status></task-notification>' });
	assert.equal(hub.session('n').title, 'app');
	await hub.handle({ session_id: 'n', cwd: '/p/app', transcript_path: '/x', hook_event_name: 'UserPromptSubmit', prompt: 'Fix the build' });
	assert.equal(hub.session('n').title, 'Fix the build');
});

test('a live session picks up shown thinking and a new title from what the transcript adds', async () => {
	const file = await transcriptFile([]);
	const append = (...recs) => fs.appendFile(file, recs.map((r) => JSON.stringify(r) + '\n').join(''));
	const hub = new AgentHub();
	const hook = (name, fields = {}) => hub.handle({ session_id: 'l', cwd: '/p', transcript_path: file, hook_event_name: name, ...fields });
	await hook('SessionStart', { source: 'startup' });
	await hook('UserPromptSubmit', { prompt: 'Restart the agent' });
	await append(
		{ type: 'user', timestamp: at(1), message: { role: 'user', content: 'Restart the agent' } },
		{ type: 'assistant', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'This session runs inside the agent.' }] } },
		{ type: 'assistant', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ps' } }] } },
	);
	// Two tools at once must not read the same records twice.
	await Promise.all([
		hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'ps' } }),
		hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'u', tool_input: { command: 'ls' } }),
	]);
	await append({ type: 'ai-title', aiTitle: 'Restarting the agent' });
	// A record still being written (no newline yet) waits for the next look.
	await fs.appendFile(file, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Half');
	await hook('Stop', { last_assistant_message: 'Restarted.' });
	const kinds = hub.timeline('l').entries.map((e) => [e.kind, e.text ?? e.name]);
	assert.deepEqual(kinds, [
		['prompt', 'Restart the agent'],
		['assistant', 'This session runs inside the agent.'],
		['tool', 'Bash'],
		['tool', 'Bash'],
		['assistant', 'Restarted.'],
		['turn_end', undefined],
	]);
	assert.equal(hub.session('l').title, 'Restarting the agent');
});

test('images pasted with a prompt come back as uploads the hub keeps', async () => {
	const png = Buffer.from('fake png').toString('base64');
	const file = await transcriptFile([
		JSON.stringify({ type: 'user', timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: '[Image #1] What is this?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } }),
		JSON.stringify({ type: 'user', timestamp: at(2), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: png } }] } }),
	]);
	const entries = await readTranscript(file);
	assert.deepEqual(entries.map((e) => [e.text, e.images.map((i) => i.type)]), [['[Image #1] What is this?', ['image/png']], ['', ['image/jpeg']]]);

	const kept = [];
	const hub = new AgentHub({ keepImage: async (bytes, type) => (kept.push(bytes.toString()), { id: `img-${kept.length}`, type }) });
	await hub.handle({ session_id: 's', cwd: '/p', transcript_path: file, hook_event_name: 'SessionStart', source: 'resume' });
	assert.deepEqual(hub.timeline('s').entries.map((e) => e.images), [[{ id: 'img-1', type: 'image/png' }], [{ id: 'img-2', type: 'image/jpeg' }]]);
	assert.deepEqual(kept, ['fake png', 'fake png']);
	// Without a place to keep them, the images are left out.
	const bare = new AgentHub();
	await bare.handle({ session_id: 's', cwd: '/p', transcript_path: file, hook_event_name: 'SessionStart', source: 'resume' });
	assert.equal(bare.timeline('s').entries[0].images, undefined);
});

test('the model that answered last names the session model, before and after it starts', async () => {
	const reply = (model, text) => ({ type: 'assistant', timestamp: at(2), message: { role: 'assistant', model, content: [{ type: 'text', text }] } });
	const file = await transcriptFile([reply('claude-sonnet-4-5', 'One.'), reply('claude-opus-4-5', 'Two.'), reply('<synthetic>', 'No response requested.')].map((r) => JSON.stringify(r)));
	const entries = await readTranscript(file);
	assert.deepEqual(entries.filter((e) => e.kind === 'model').map((e) => e.model), ['claude-opus-4-5']);

	const hub = new AgentHub();
	const hook = (name, fields = {}) => hub.handle({ session_id: 'm', cwd: '/p', transcript_path: file, hook_event_name: name, ...fields });
	await hook('Notification');
	assert.equal(hub.session('m').model, 'claude-opus-4-5');
	assert.ok(!hub.timeline('m').entries.some((e) => e.kind === 'model'));
	// `/model haiku`, then a reply.
	await fs.appendFile(file, JSON.stringify(reply('claude-haiku-4-5', 'Three.')) + '\n');
	await hook('Stop', { last_assistant_message: 'Three.' });
	assert.equal(hub.session('m').model, 'claude-haiku-4-5');
});

test('paths of attached files read back from a transcript become the prompt files', async () => {
	const dir = path.join(os.tmpdir(), 'uploads');
	const id = '0f0e0d0c-1111-2222-3333-444455556666';
	const file = await transcriptFile([
		JSON.stringify({ type: 'user', timestamp: at(1), message: { role: 'user', content: `Look at this\n${path.join(dir, '2026-11-02', `${id}-My Video.mov`)}` } }),
	]);
	const hub = new AgentHub({ uploadsDir: dir, fileType: (name) => (name.endsWith('.mov') ? 'video/quicktime' : null) });
	await hub.handle({ session_id: 'f', cwd: '/p', transcript_path: file, hook_event_name: 'Notification' });
	const [prompt] = hub.timeline('f').entries;
	assert.equal(prompt.text, 'Look at this');
	assert.deepEqual(prompt.files, [{ id, name: 'My Video.mov', type: 'video/quicktime' }]);
	// A path elsewhere is just text.
	const other = new AgentHub({ uploadsDir: '/somewhere/else' });
	await other.handle({ session_id: 'f', cwd: '/p', transcript_path: file, hook_event_name: 'Notification' });
	assert.equal(other.timeline('f').entries[0].files, undefined);
});
