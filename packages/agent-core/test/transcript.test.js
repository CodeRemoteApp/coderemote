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
