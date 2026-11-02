// Drafting a commit message with the coding agent installed on the computer (Claude Code, else
// Codex), so it runs on the user's own plan and needs no API key here.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './git.js';
import { isWindows, spawnCommand, terminalCommand } from './platform.js';
import { HttpError } from './sandbox.js';

/** How much of the diff the model sees; the stat above it still lists every file. */
export const MAX_DIFF_CHARS = 24_000;
const TIMEOUT_MS = 120_000;

// Generated or vendored files: their diffs are noise to a summary (the stat still lists them).
const EXCLUDE = [
	'*.lock',
	'package-lock.json',
	'npm-shrinkwrap.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'Cargo.lock',
	'Gemfile.lock',
	'poetry.lock',
	'composer.lock',
	'go.sum',
	'Package.resolved',
	'*.min.js',
	'*.min.css',
	'*.map',
	'*.snap',
	'*.pbxproj',
].map((p) => `:(exclude,glob)**/${p}`);

/**
 * What would be committed: the staged changes, or, with nothing staged, every change (untracked
 * files by name). `staged` says which.
 */
export async function pendingChanges(repo) {
	const staged = (await git(repo, ['diff', '--cached', '--quiet'], { okCodes: [0, 1] })).code === 1;
	const base = staged ? ['--cached'] : (await hasHead(repo)) ? ['HEAD'] : ['--cached'];
	const [stat, patch, untracked] = await Promise.all([
		git(repo, ['diff', '--no-color', '--stat=120', ...base]).then((r) => r.stdout),
		git(repo, ['diff', '--no-color', '--no-ext-diff', ...base, '--', '.', ...EXCLUDE]).then((r) => r.stdout),
		staged ? '' : git(repo, ['ls-files', '--others', '--exclude-standard']).then((r) => r.stdout),
	]);
	if (!stat.trim() && !untracked.trim()) throw new HttpError(409, 'nothing to commit');
	const diff = patch.length > MAX_DIFF_CHARS ? `${patch.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]\n` : patch;
	return { staged, stat, diff, untracked: untracked.split('\n').filter(Boolean) };
}

async function hasHead(repo) {
	return (await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1, 128] })).code === 0;
}

/** The prompt: the repository's recent subjects for its style, then the changes. */
export function buildPrompt({ stat, diff, untracked }, recentSubjects) {
	return [
		'Write a git commit message for the changes below.',
		'Match the style of this repository\'s recent commits (language, tense, prefixes, capitalisation).',
		'First line: a summary of at most 72 characters.',
		'Then a blank line and a body of 1 to 4 short lines saying what changed and why, as "- " bullets',
		'when there is more than one point. Do not list file names or restate the diff line by line.',
		'Reply with the commit message only: no preamble, no quotes, no code fences.',
		'',
		'Recent commits:',
		...(recentSubjects.length ? recentSubjects.map((s) => `- ${s}`) : ['(none yet)']),
		'',
		'Files changed:',
		stat.trim(),
		...(untracked.length ? ['', 'New files:', ...untracked.slice(0, 100)] : []),
		'',
		'Diff:',
		diff.trim(),
	].join('\n');
}

/** Strips what models add despite being told not to: fences, quotes, a "Commit message:" label. */
export function cleanMessage(text) {
	let s = String(text).replace(/\r\n/g, '\n').trim();
	s = s.replace(/^```[\w-]*\n([\s\S]*?)\n```$/, '$1').trim();
	s = s.replace(/^(?:commit message|message)\s*:\s*\n?/i, '').trim();
	if (/^(["'`]).*\1$/s.test(s)) s = s.slice(1, -1).trim();
	return s;
}

// Replaces Claude Code's own system prompt, written for a coding agent with tools: a long prompt
// that only slows a one-shot answer down.
const SYSTEM_PROMPT = 'You write git commit messages. Reply with the commit message only: no preamble, no quotes, no code fences.';

/**
 * The command line that drafts the message, the prompt arriving on stdin. Neither saves a
 * session, and CODEREMOTE_NO_HOOK keeps the Code Remote plugin's hooks from reporting the run
 * to the app as a session. Claude Code starts without the user's MCP servers and with a short
 * system prompt, which takes seconds off the draft.
 */
export function draftCommand(agent, { claudeCommand = 'claude', codexCommand = 'codex', outFile, model = null } = {}) {
	if (agent === 'claude') {
		// cmd.exe can't be handed a quote, so Windows relies on CODEREMOTE_NO_HOOK alone.
		const quoted = isWindows ? [] : ['--settings', '{"disableAllHooks":true}', '--system-prompt', SYSTEM_PROMPT];
		return [claudeCommand, '-p', '--model', model || 'haiku', '--tools', '', '--no-session-persistence', '--strict-mcp-config', ...quoted];
	}
	// The user's MCP servers would only slow the start down (and may need a sign-in).
	return [
		codexCommand, 'exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only',
		...(model ? ['-m', model] : []),
		'-c', 'model_reasoning_effort="low"', '-c', 'mcp_servers={}', '-o', outFile, '-',
	];
}

/** Runs `argv` in `cwd` the way a terminal would, writing `input` to its stdin; its stdout. */
export function runWithInput(argv, { cwd, input, timeout = TIMEOUT_MS, env = {} }) {
	return new Promise((resolve, reject) => {
		const options = { cwd, env: { ...process.env, CODEREMOTE_NO_HOOK: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] };
		let child;
		if (isWindows) child = spawnCommand(argv, options);
		else {
			const { file, args } = terminalCommand(argv);
			child = spawn(file, args, options);
		}
		let out = '';
		let err = '';
		const timer = setTimeout(() => child.kill(), timeout);
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (err += d));
		child.on('error', (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			if (code === 0) return resolve(out);
			const why = signal ? 'timed out' : (err || out).trim().split('\n').slice(-3).join('\n') || `exited with ${code}`;
			reject(new HttpError(signal ? 504 : 502, why));
		});
		child.stdin.on('error', () => {});
		child.stdin.end(input);
	});
}

/**
 * Drafts a message for `repo`'s pending changes with `agent` ('claude' or 'codex') and `model`
 * (Claude Code's default here is Haiku; Codex's is the one in its config).
 * @returns {Promise<{ message: string, agent: string, staged: boolean }>}
 */
export async function draftCommitMessage(repo, agent, { claudeCommand, codexCommand, model = null, run = runWithInput } = {}) {
	const changes = await pendingChanges(repo);
	const recent = (await hasHead(repo))
		? (await git(repo, ['log', '-n12', '--no-merges', '--format=%s'])).stdout.split('\n').filter(Boolean)
		: [];
	const input = buildPrompt(changes, recent);
	let text;
	if (agent === 'codex') {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coderemote-commit-'));
		const outFile = path.join(dir, 'message.txt');
		try {
			await run(draftCommand('codex', { codexCommand, outFile, model }), { cwd: repo, input });
			text = await fs.readFile(outFile, 'utf8');
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	} else {
		// Everything it needs is in the prompt: run outside the repository so Claude Code doesn't
		// load its CLAUDE.md and project settings too.
		text = await run(draftCommand('claude', { claudeCommand, model }), { cwd: os.tmpdir(), input });
	}
	const message = cleanMessage(text);
	if (!message) throw new HttpError(502, 'the agent returned no message');
	return { message, agent, staged: changes.staged };
}
