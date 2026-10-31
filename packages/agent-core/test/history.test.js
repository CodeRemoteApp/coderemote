import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listHistory } from '../src/history.js';

const jsonl = (...rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

async function write(file, text, mtime) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, text);
	if (mtime) await fs.utimes(file, mtime / 1000, mtime / 1000);
}

test('Claude Code: conversations of the folder, newest first, titled by the agent', async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), 'history-'));
	const cwd = '/Users/me/My Project+1';
	const dir = path.join(home, '.claude', 'projects', '-Users-me-My-Project-1');
	const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, gitBranch: 'main', ...extra });
	await write(path.join(dir, 'a.jsonl'), jsonl(
		user('<local-command-caveat>x</local-command-caveat>', { isMeta: true }),
		user('Fix the login crash\nmore'),
		{ type: 'ai-title', aiTitle: 'Old title' },
		{ type: 'ai-title', aiTitle: 'Login crash' },
		{ type: 'assistant', gitBranch: 'fix/login' },
	), 2_000_000);
	await write(path.join(dir, 'b.jsonl'), jsonl(user([{ type: 'text', text: 'Add dark mode' }]), { type: 'custom-title', customTitle: 'Dark mode' }, { type: 'ai-title', aiTitle: 'Theme' }), 3_000_000);
	await write(path.join(dir, 'c.jsonl'), jsonl(user('Untitled prompt')), 1_000_000);
	await write(path.join(dir, 'empty.jsonl'), jsonl({ type: 'system' }, user('<command-name>/clear</command-name>')), 4_000_000);
	await write(path.join(home, '.claude', 'projects', '-Users-me-other', 'x.jsonl'), jsonl(user('elsewhere')));

	const list = await listHistory({ agent: 'claude', cwd, home });
	assert.deepEqual(list.map((h) => [h.id, h.title, h.branch, h.updatedAt]), [
		['b', 'Dark mode', 'main', 3_000_000],
		['a', 'Login crash', 'fix/login', 2_000_000],
		['c', 'Untitled prompt', 'main', 1_000_000],
	]);
	assert.ok(list[0].size > 0);
	assert.deepEqual(await listHistory({ agent: 'claude', cwd: '/nowhere', home }), []);
});

test('Codex: rollouts of the folder, named from the session index or the first prompt', async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), 'history-'));
	const codexHome = path.join(home, '.codex');
	const meta = (id, cwd, git = {}) => ({ type: 'session_meta', payload: { id, cwd, git, base_instructions: 'x'.repeat(30_000) } });
	const said = (text) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
	const day = path.join(codexHome, 'sessions', '2026', '10', '31');
	await write(path.join(day, 'rollout-2026-10-31T10-00-00-c1.jsonl'), jsonl(meta('c1', '/p', { branch: 'main' }), said('# AGENTS.md instructions\n...'), said('<environment_context/>'), said('Ship the release')), 2_000_000);
	await write(path.join(day, 'rollout-2026-10-31T11-00-00-c2.jsonl'), jsonl(meta('c2', '/p'), said('Named elsewhere')), 3_000_000);
	await write(path.join(day, 'rollout-2026-10-31T12-00-00-c3.jsonl'), jsonl(meta('c3', '/p')), 4_000_000);
	await write(path.join(day, 'rollout-2026-10-31T13-00-00-c4.jsonl'), jsonl(meta('c4', '/other'), said('Not here')), 5_000_000);
	await write(path.join(codexHome, 'session_index.jsonl'), jsonl({ id: 'c2', thread_name: 'Old' }, { id: 'c2', thread_name: 'Index name' }));

	const list = await listHistory({ agent: 'codex', cwd: '/p', home, codexHome });
	assert.deepEqual(list.map((h) => [h.id, h.title, h.branch]), [
		['c2', 'Index name', null],
		['c1', 'Ship the release', 'main'],
	]);
});
