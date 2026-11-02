// Drafting a commit message with the computer's coding agent.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AgentHub, createAgentServer } from '../src/index.js';
import { buildPrompt, cleanMessage, draftCommand, pendingChanges } from '../src/commit-message.js';
import { isWindows } from '../src/platform.js';

const token = 'test-token';
let tmp;
let repo;
let fake;
let server;
let baseUrl;

const sh = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

before(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vsremote-commitmsg-')));
	repo = path.join(tmp, 'repo');
	await fs.mkdir(repo);
	sh('init', '-q');
	await fs.writeFile(path.join(repo, 'a.txt'), 'one\n');
	await fs.writeFile(path.join(repo, 'package-lock.json'), '{}\n');
	sh('add', '.');
	sh('commit', '-q', '-m', 'Add the first file');
	// Records its stdin, arguments and environment, and answers like a chatty model would.
	fake = path.join(tmp, 'claude');
	if (isWindows) {
		const script = path.join(tmp, 'fake-claude.mjs');
		await fs.writeFile(
			script,
			`import fs from 'node:fs';\nconst input = fs.readFileSync(0, 'utf8');\nfs.writeFileSync(${JSON.stringify(tmp)} + '/stdin', input);\nfs.writeFileSync(${JSON.stringify(tmp)} + '/env', process.env.CODEREMOTE_NO_HOOK || '');\nprocess.stdout.write('\`\`\`\\nChange a.txt\\n\`\`\`\\n');\n`,
		);
		fake += '.cmd';
		await fs.writeFile(fake, `@"${process.execPath}" "${script}" %*\r\n`);
	} else {
		await fs.writeFile(
			fake,
			`#!/bin/sh\ncat > "${tmp}/stdin"\nprintf '%s\\n' "$@" > "${tmp}/args"\nprintf '%s' "$CODEREMOTE_NO_HOOK" > "${tmp}/env"\nprintf '\`\`\`\\nChange a.txt\\n\`\`\`\\n'\n`,
			{ mode: 0o755 },
		);
	}
	server = createAgentServer({ token, root: tmp, claudeCommand: fake, codexCommand: path.join(tmp, 'no-codex'), home: tmp, agents: new AgentHub({ transcript: async () => [] }) });
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	server.close();
	await fs.rm(tmp, { recursive: true, force: true });
});

async function post(route, body) {
	const res = await fetch(`${baseUrl}${route}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json() };
}

test('cleanMessage strips fences, labels and quotes', () => {
	assert.equal(cleanMessage('```\nFix it\n\nBody\n```'), 'Fix it\n\nBody');
	assert.equal(cleanMessage('Commit message:\nFix it'), 'Fix it');
	assert.equal(cleanMessage('"Fix it"'), 'Fix it');
	assert.equal(cleanMessage('  Fix it \r\n'), 'Fix it');
});

test('buildPrompt carries the recent subjects, stat, new files and diff', () => {
	const prompt = buildPrompt({ stat: ' a | 1 +', diff: '+x', untracked: ['new.txt'] }, ['Add a']);
	for (const part of ['- Add a', 'a | 1 +', 'new.txt', '+x']) assert.ok(prompt.includes(part), part);
});

test('draftCommand runs without tools, sessions or hooks', () => {
	const claude = draftCommand('claude');
	for (const flag of ['-p', '--no-session-persistence', '--tools', '--strict-mcp-config']) assert.ok(claude.includes(flag), flag);
	const codex = draftCommand('codex', { outFile: '/x' });
	for (const flag of ['exec', '--ephemeral', '-o', '-']) assert.ok(codex.includes(flag), flag);
});

test('pendingChanges takes everything when nothing is staged, and leaves lockfiles out of the diff', async () => {
	await fs.writeFile(path.join(repo, 'a.txt'), 'two\n');
	await fs.writeFile(path.join(repo, 'package-lock.json'), '{"x":1}\n');
	await fs.writeFile(path.join(repo, 'new.txt'), 'new\n');
	const all = await pendingChanges(repo);
	assert.equal(all.staged, false);
	assert.match(all.stat, /package-lock\.json/);
	assert.match(all.diff, /\+two/);
	assert.doesNotMatch(all.diff, /"x":1/);
	assert.deepEqual(all.untracked, ['new.txt']);

	sh('add', 'a.txt');
	const staged = await pendingChanges(repo);
	assert.equal(staged.staged, true);
	assert.doesNotMatch(staged.stat, /package-lock/);
	assert.deepEqual(staged.untracked, []);
});

test('POST /api/git/commit-message drafts with Claude Code and commits nothing', async () => {
	const head = sh('rev-parse', 'HEAD').toString();
	const { status, body } = await post('/api/git/commit-message', { repo });
	assert.equal(status, 200, JSON.stringify(body));
	assert.deepEqual(body, { message: 'Change a.txt', agent: 'claude', staged: true });
	const input = await fs.readFile(path.join(tmp, 'stdin'), 'utf8');
	assert.match(input, /Add the first file/);
	assert.match(input, /\+two/);
	assert.equal(await fs.readFile(path.join(tmp, 'env'), 'utf8'), '1');
	if (!isWindows) assert.match(await fs.readFile(path.join(tmp, 'args'), 'utf8'), /--model\nhaiku/);
	assert.equal(sh('rev-parse', 'HEAD').toString(), head);

	const opus = await post('/api/git/commit-message', { repo, agent: 'claude', model: 'opus' });
	assert.equal(opus.status, 200, JSON.stringify(opus.body));
	if (!isWindows) assert.match(await fs.readFile(path.join(tmp, 'args'), 'utf8'), /--model\nopus/);
});

test('POST /api/git/commit-message refuses a missing agent and a clean tree', async () => {
	const codex = await post('/api/git/commit-message', { repo, agent: 'codex' });
	assert.equal(codex.status, 409);
	assert.equal(codex.body.code, 'ENOAGENT');
	assert.equal((await post('/api/git/commit-message', { repo, agent: 'gpt' })).status, 400);
	assert.equal((await post('/api/git/commit-message', { repo, agent: 'claude', model: 'x; rm -rf /' })).status, 400);

	sh('add', '.');
	sh('commit', '-q', '-m', 'Second');
	const clean = await post('/api/git/commit-message', { repo });
	assert.equal(clean.status, 409);
	assert.match(clean.body.error, /nothing to commit/);
});
