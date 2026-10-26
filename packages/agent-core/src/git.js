import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './sandbox.js';

// Folders never worth descending into when looking for repositories.
const SKIP_DIRS = new Set(['node_modules', '.build', 'build', 'dist', 'DerivedData', 'Pods', 'vendor', '.venv', 'target']);
const MAX_SCAN_DEPTH = 4;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/** Runs git without a shell. Never prompts: a missing credential fails instead of hanging. */
export function git(cwd, args, { timeout = 30_000, okCodes = [0], maxBuffer = 16 * 1024 * 1024 } = {}) {
	return new Promise((resolve, reject) => {
		execFile(
			'git',
			args,
			{
				cwd,
				timeout,
				maxBuffer,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
			},
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
				if (code !== null && okCodes.includes(code)) return resolve({ stdout, stderr, code });
				const message = (stderr || error?.message || 'git failed').trim().split('\n').slice(-3).join('\n');
				reject(Object.assign(new HttpError(error?.killed ? 504 : 409, message), { code: 'EGIT' }));
			},
		);
	});
}

/** Repositories under `root` (including `root` itself), nearest first. Nested repos are not entered. */
export async function findRepos(root) {
	const repos = [];
	async function walk(dir, depth) {
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		if (entries.some((e) => e.name === '.git')) {
			repos.push(dir);
			return;
		}
		if (depth >= MAX_SCAN_DEPTH) return;
		const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name));
		await Promise.all(subdirs.map((e) => walk(path.join(dir, e.name), depth + 1)));
	}
	await walk(root, 0);
	repos.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
	return Promise.all(
		repos.map(async (repo) => ({
			path: repo,
			name: repo === root ? path.basename(root) : path.relative(root, repo),
			branch: await currentBranch(repo),
		})),
	);
}

async function currentBranch(repo) {
	try {
		const { stdout } = await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { okCodes: [0, 1] });
		if (stdout.trim()) return stdout.trim();
		const { stdout: sha } = await git(repo, ['rev-parse', '--short', 'HEAD'], { okCodes: [0, 128] });
		return sha.trim() ? `(${sha.trim()})` : null;
	} catch {
		return null;
	}
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export async function status(repo) {
	const { stdout } = await git(repo, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
	const result = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
	const records = stdout.split('\0');
	for (let i = 0; i < records.length; i++) {
		const r = records[i];
		if (!r) continue;
		if (r.startsWith('# branch.head ')) {
			const head = r.slice(14);
			result.branch = head === '(detached)' ? null : head;
		} else if (r.startsWith('# branch.upstream ')) {
			result.upstream = r.slice(18);
		} else if (r.startsWith('# branch.ab ')) {
			const [a, b] = r.slice(12).split(' ');
			result.ahead = Math.abs(parseInt(a, 10));
			result.behind = Math.abs(parseInt(b, 10));
		} else if (r.startsWith('1 ')) {
			// 1 XY sub mH mI mW hH hI path
			const parts = r.split(' ');
			result.files.push(entry(parts[1], parts.slice(8).join(' ')));
		} else if (r.startsWith('2 ')) {
			// 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next record
			const parts = r.split(' ');
			result.files.push({ ...entry(parts[1], parts.slice(9).join(' ')), origPath: records[++i] });
		} else if (r.startsWith('u ')) {
			// u XY sub m1 m2 m3 mW h1 h2 h3 path
			const parts = r.split(' ');
			result.files.push({ ...entry(parts[1], parts.slice(10).join(' ')), conflicted: true });
		} else if (r.startsWith('? ')) {
			result.files.push({ path: r.slice(2), index: '.', worktree: '?' });
		}
	}
	return result;
}

function entry(xy, filePath) {
	return { path: filePath, index: xy[0], worktree: xy[1] };
}

/** Unified diff for one file: staged (index vs HEAD), or working tree vs index; untracked files diff against nothing. */
export async function diff(repo, file, { staged = false, untracked = false } = {}) {
	const args = untracked
		? ['diff', '--no-color', '--no-index', '--', '/dev/null', file]
		: ['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', file];
	// --no-index exits 1 when the files differ, which is the expected case.
	const { stdout } = await git(repo, args, { okCodes: [0, 1], maxBuffer: MAX_DIFF_BYTES * 2 });
	return truncate(stdout);
}

export async function stage(repo, files) {
	await git(repo, ['add', '--', ...files]);
}

export async function unstage(repo, files) {
	try {
		await git(repo, ['restore', '--staged', '--', ...files]);
	} catch {
		// No commit yet: there is no HEAD to restore from, so drop the paths from the index.
		await git(repo, ['rm', '--cached', '-r', '-q', '--', ...files]);
	}
}

/** Throws away working-tree changes. Untracked files are deleted. */
export async function discard(repo, files) {
	const { files: changed } = await status(repo);
	const untracked = files.filter((f) => changed.some((c) => c.path === f && c.worktree === '?'));
	const tracked = files.filter((f) => !untracked.includes(f));
	if (tracked.length) await git(repo, ['restore', '--worktree', '--', ...tracked]);
	if (untracked.length) await git(repo, ['clean', '-f', '-q', '--', ...untracked]);
}

export async function commit(repo, message) {
	if (typeof message !== 'string' || !message.trim()) throw new HttpError(400, 'commit message is empty');
	await git(repo, ['commit', '-q', '-m', message]);
	return (await log(repo, 1))[0];
}

export async function log(repo, limit = 50) {
	const { stdout } = await git(repo, ['log', `-n${Math.min(Math.max(limit, 1), 500)}`, '-z', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1f%D'], {
		okCodes: [0, 128], // 128: no commits yet
	});
	return stdout
		.split('\0')
		.filter(Boolean)
		.map((record) => {
			const [hash, short, subject, author, at, refs] = record.split('\x1f');
			return { hash, short, subject, author, date: parseInt(at, 10) * 1000, refs: refs ? refs.split(', ') : [] };
		});
}

export async function show(repo, commitHash) {
	if (!/^[0-9a-f]{4,64}$/i.test(commitHash || '')) throw new HttpError(400, 'invalid commit');
	const { stdout } = await git(repo, ['show', '--no-color', '--stat', '--patch', '--format=fuller', commitHash], {
		maxBuffer: MAX_DIFF_BYTES * 2,
	});
	return truncate(stdout);
}

export async function pull(repo) {
	const { stdout, stderr } = await git(repo, ['pull', '--ff-only'], { timeout: 120_000 });
	return (stdout + stderr).trim();
}

export async function push(repo) {
	const { stdout, stderr } = await git(repo, ['push'], { timeout: 120_000 });
	return (stdout + stderr).trim();
}

function truncate(text) {
	if (Buffer.byteLength(text) <= MAX_DIFF_BYTES) return { text, truncated: false };
	return { text: Buffer.from(text).subarray(0, MAX_DIFF_BYTES).toString('utf8'), truncated: true };
}
