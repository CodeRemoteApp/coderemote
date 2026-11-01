// Searching the shared folder, like an editor's "Find in Files": the lines of files that match a
// query, plus the files whose name does. ripgrep does the work when it is installed; otherwise
// files are listed by git (so .gitignore applies) or by walking the folder, and read here.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { findExecutable } from './platform.js';
import { HttpError } from './sandbox.js';

// Never searched, whatever the ignore files say (an editor's default excludes).
const ALWAYS_SKIPPED = new Set(['.git', 'node_modules']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_QUERY = 1000;
const MAX_LINE = 240; // characters of a matching line sent back, around its first match
const LEAD = 40; // characters kept before the first match when a line is clipped
const MAX_RANGES = 20;
const NAME_LIMIT = 100;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const PER_FILE = 100;
const TIMEOUT_MS = 15_000;

let rgPath;
/** ripgrep's path, looked up once; null when it isn't installed. */
function ripgrep() {
	if (rgPath === undefined) rgPath = findExecutable('rg');
	return rgPath;
}

/** The query as a regex, as typed or literal, whole words or anywhere, matching case or not. */
export function queryRegex(query, { caseSensitive = false, wholeWord = false, regex = false } = {}, global = false) {
	let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	if (wholeWord) source = `\\b(?:${source})\\b`;
	try {
		return new RegExp(source, `${global ? 'g' : ''}${caseSensitive ? '' : 'i'}`);
	} catch (e) {
		throw new HttpError(400, `invalid regular expression: ${e.message}`);
	}
}

function globSource(glob) {
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*' && glob[i + 1] === '*') {
			// `**/` is any number of folders, none included.
			if (glob[i + 2] === '/') {
				out += '(?:.*/)?';
				i += 2;
			} else {
				out += '.*';
				i += 1;
			}
		} else if (c === '*') out += '[^/]*';
		else if (c === '?') out += '[^/]';
		else if (c === '{') out += '(?:';
		else if (c === '}') out += ')';
		else if (c === ',') out += '|';
		else out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
	}
	return out;
}

/**
 * Whether a path (relative to the root, `/`-separated) passes the filter: one of the `include`
 * patterns matches it (or there are none), and none of `exclude`'s. Patterns are comma-separated.
 * One without wildcards matches any path containing it (`src/`, `Server`); a glob matches the
 * path or one of its folders, anywhere unless it starts with `/` (`*.js`, `src/*.ts`, `{a,b}/*.md`).
 */
export function pathFilter(include = '', exclude = '') {
	const matchers = (list) =>
		splitPatterns(list).map((raw) => {
			let p = raw.replace(/\\/g, '/').replace(/^\.\//, '');
			if (!/[*?{]/.test(p)) {
				if (p.startsWith('/')) {
					// From the root: that file or folder.
					const head = p.slice(1).replace(/\/$/, '').toLowerCase();
					return (rel) => {
						const r = rel.toLowerCase();
						return r === head || r.startsWith(`${head}/`);
					};
				}
				const needle = p.toLowerCase();
				return (rel) => rel.toLowerCase().includes(needle);
			}
			if (p.startsWith('/')) p = p.slice(1);
			else if (!p.startsWith('**/')) p = `**/${p}`;
			const re = new RegExp(`^${globSource(p.replace(/\/$/, ''))}(?:/.*)?$`, 'i');
			return (rel) => re.test(rel);
		});
	const inc = matchers(include);
	const exc = matchers(exclude);
	return (rel) => (!inc.length || inc.some((m) => m(rel))) && !exc.some((m) => m(rel));
}

/** Comma-separated patterns, keeping the commas inside `{a,b}`. */
function splitPatterns(list) {
	const out = [];
	let depth = 0;
	let cur = '';
	for (const c of list) {
		if (c === '{') depth++;
		if (c === '}') depth = Math.max(0, depth - 1);
		if (c === ',' && depth === 0) {
			out.push(cur);
			cur = '';
		} else cur += c;
	}
	out.push(cur);
	return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * A matching line as sent back: without its indentation, clipped around its first match when
 * long, and where each match is in it ([start, end) in UTF-16 code units).
 */
export function preview(line, re) {
	const all = [];
	re.lastIndex = 0;
	for (let m; all.length < MAX_RANGES && (m = re.exec(line)); ) {
		if (m[0].length === 0) {
			re.lastIndex++;
			continue;
		}
		all.push([m.index, m.index + m[0].length]);
	}
	const indent = line.length - line.trimStart().length;
	let start = indent;
	if (all.length && line.length - start > MAX_LINE) start = Math.max(indent, all[0][0] - LEAD);
	const end = Math.min(line.length, start + MAX_LINE);
	const ranges = all
		.filter(([s, e]) => e > start && s < end)
		.map(([s, e]) => [Math.max(s, start) - start, Math.min(e, end) - start]);
	return { text: line.slice(start, end).trimEnd(), ranges, clipped: start > indent || end < line.length };
}

function runGit(cwd, args) {
	return new Promise((resolve) => {
		execFile('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, out) =>
			resolve(err ? null : out),
		);
	});
}

async function exists(p) {
	try {
		await fs.lstat(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Every file under `root` worth searching, relative and `/`-separated. Inside a repository git
 * lists them, so its ignore rules apply; elsewhere the folder is walked.
 */
export async function listFiles(root, signal) {
	const files = [];
	const skipped = (rel) => rel.split('/').some((part) => ALWAYS_SKIPPED.has(part));
	const join = (prefix, name) => (prefix ? `${prefix}/${name}` : name);

	async function fromGit(dir, prefix) {
		// Tracked files with their modes (a submodule is 160000: walk into it), then untracked ones
		// not ignored (a repository inside shows as `name/`).
		const [tracked, untracked] = await Promise.all([
			runGit(dir, ['ls-files', '-z', '-s']),
			runGit(dir, ['ls-files', '-z', '-o', '--exclude-standard']),
		]);
		if (tracked === null || untracked === null) return false;
		const subdirs = [];
		const seen = new Set();
		for (const entry of tracked.split('\0')) {
			if (!entry) continue;
			const tab = entry.indexOf('\t');
			const mode = entry.slice(0, entry.indexOf(' '));
			const rel = entry.slice(tab + 1);
			if (seen.has(rel)) continue; // one entry per conflict stage
			seen.add(rel);
			if (skipped(rel)) continue;
			if (mode === '160000') subdirs.push(rel);
			else if (mode !== '120000') files.push(join(prefix, rel));
		}
		for (const rel of untracked.split('\0')) {
			if (!rel || skipped(rel)) continue;
			if (rel.endsWith('/')) subdirs.push(rel.slice(0, -1));
			else files.push(join(prefix, rel));
		}
		for (const rel of subdirs) await visit(path.join(dir, rel), join(prefix, rel));
		return true;
	}

	async function visit(dir, prefix) {
		if (signal?.aborted) return;
		if ((await exists(path.join(dir, '.git'))) && (await fromGit(dir, prefix))) return;
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (ALWAYS_SKIPPED.has(e.name)) continue;
			// Links aren't followed: one could lead out of the shared folder.
			if (e.isDirectory()) await visit(path.join(dir, e.name), join(prefix, e.name));
			else if (e.isFile()) files.push(join(prefix, e.name));
		}
	}

	await visit(root, '');
	return files;
}

/** Collects matches, grouped by file, until `limit` of them. */
class Results {
	constructor(limit) {
		this.limit = limit;
		this.count = 0;
		this.byFile = new Map();
		this.truncated = false;
	}

	get full() {
		return this.count >= this.limit;
	}

	/** Whether a match came past the limit: there are more than it, so searching can stop. */
	get done() {
		return this.full && this.truncated;
	}

	add(rel, line, match) {
		if (this.full) {
			this.truncated = true;
			return;
		}
		let file = this.byFile.get(rel);
		if (!file) this.byFile.set(rel, (file = []));
		if (file.length >= PER_FILE) {
			this.truncated = true;
			return;
		}
		file.push({ line, ...match });
		this.count++;
	}
}

async function searchFile(root, rel, test, re, results) {
	const abs = path.join(root, ...rel.split('/'));
	let stat;
	try {
		stat = await fs.lstat(abs);
	} catch {
		return;
	}
	if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size === 0) return;
	let buf;
	try {
		buf = await fs.readFile(abs);
	} catch {
		return;
	}
	if (buf.subarray(0, 8000).includes(0)) return; // binary
	const text = buf.toString('utf8');
	// One pass over the whole file first: most files don't match at all.
	if (!new RegExp(test.source, `${test.flags}m`).test(text)) return;
	const lines = text.split('\n');
	for (let i = 0; i < lines.length && !results.done; i++) {
		const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
		if (test.test(line)) results.add(rel, i + 1, preview(line, re));
	}
}

/** Content search done here, reading each file. */
async function searchHere(root, files, test, re, results, signal) {
	let next = 0;
	const worker = async () => {
		while (next < files.length && !results.done && !signal?.aborted) {
			await searchFile(root, files[next++], test, re, results);
		}
	};
	await Promise.all(Array.from({ length: 16 }, worker));
}

/** Runs ripgrep with `args` in `root`, handing each output line to `onLine` until it returns false. */
function runRipgrep(rg, root, args, onLine, signal) {
	return new Promise((resolve, reject) => {
		const child = spawn(rg, ['--no-config', '--no-messages', '--hidden', '--glob', '!.git', '--glob', '!node_modules', ...args], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stderr = '';
		let stopped = false;
		const stop = () => {
			stopped = true;
			child.kill();
		};
		signal?.addEventListener('abort', stop, { once: true });
		child.stderr.on('data', (d) => (stderr += d));
		const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
		lines.on('line', (line) => {
			if (!stopped && onLine(line) === false) stop();
		});
		child.on('error', reject);
		child.on('close', (code) => {
			signal?.removeEventListener('abort', stop);
			// 1: nothing matched. 2: some file couldn't be read, or the pattern is wrong.
			if (code === 2 && /regex/i.test(stderr)) return reject(new HttpError(400, stderr.trim().split('\n').pop()));
			resolve();
		});
	});
}

/** `./a/b` as ripgrep prints it, as `a/b`. */
const relOf = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Searches the files under `root` for `query`.
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} [opts.query]  text to find; empty lists the files `include` lets through
 * @param {boolean} [opts.caseSensitive]
 * @param {boolean} [opts.wholeWord]
 * @param {boolean} [opts.regex]  the query is a regular expression
 * @param {string} [opts.include]  comma-separated patterns of files to search (see pathFilter)
 * @param {string} [opts.exclude]  comma-separated patterns of files to skip
 * @param {number} [opts.limit]  the most matching lines to return
 * @param {'auto'|'rg'|'node'} [opts.engine]
 * @param {AbortSignal} [opts.signal]  stops the search (the client went away)
 * @returns {Promise<{ names: { path: string }[], files: { path: string, matches: object[] }[], truncated: boolean }>}
 *          paths relative to `root`, `/`-separated
 */
export async function search({
	root,
	query = '',
	caseSensitive = false,
	wholeWord = false,
	regex = false,
	include = '',
	exclude = '',
	limit = DEFAULT_LIMIT,
	engine = 'auto',
	signal,
}) {
	if (query.length > MAX_QUERY) throw new HttpError(400, 'query is too long');
	if (!query && !include.trim()) throw new HttpError(400, 'missing query');
	limit = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_LIMIT), MAX_LIMIT);
	const options = { caseSensitive, wholeWord, regex };
	const re = query ? queryRegex(query, options, true) : null;
	const test = query ? queryRegex(query, options) : null;
	const keep = pathFilter(include, exclude);
	const rg = engine === 'node' ? null : ripgrep();
	if (engine === 'rg' && !rg) throw new HttpError(500, 'ripgrep is not installed');

	// Past the time limit, whatever was found so far is the answer.
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
	const stop = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
	const results = new Results(limit);
	const names = [];
	let namesTruncated = false;
	const nameLimit = query ? NAME_LIMIT : limit;
	const addName = (rel) => {
		if (!keep(rel)) return true;
		const base = rel.slice(rel.lastIndexOf('/') + 1);
		if (test && !test.test(base)) return true;
		if (names.length >= nameLimit) {
			namesTruncated = true;
			return false;
		}
		names.push(rel);
		return true;
	};

	try {
		if (rg) {
			const listing = runRipgrep(rg, root, ['--files', './'], (line) => addName(relOf(line)), stop);
			const flags = [
				'--json',
				'--max-filesize',
				String(MAX_FILE_BYTES),
				'--max-count',
				String(PER_FILE),
				...(regex ? [] : ['--fixed-strings']),
				...(caseSensitive ? ['--case-sensitive'] : ['--ignore-case']),
				...(wholeWord ? ['--word-regexp'] : []),
			];
			const content = query
				? runRipgrep(
						rg,
						root,
						[...flags, '--regexp', query, '--', './'],
						(line) => {
							let msg;
							try {
								msg = JSON.parse(line);
							} catch {
								return true;
							}
							if (msg.type !== 'match' || msg.data.path.text === undefined || msg.data.lines.text === undefined) return true;
							const rel = relOf(msg.data.path.text);
							if (!keep(rel)) return true;
							const text = msg.data.lines.text.replace(/\r?\n$/, '');
							results.add(rel, msg.data.line_number, preview(text, re));
							return !results.done;
						},
						stop,
					)
				: null;
			await Promise.all([listing, content]);
			if (stop.aborted && !signal?.aborted) results.truncated = true;
		} else {
			const files = (await listFiles(root, stop)).filter(keep);
			for (const rel of files) if (!addName(rel)) break;
			if (query) await searchHere(root, files, test, re, results, stop);
		}
	} finally {
		clearTimeout(timer);
	}
	if (timeout.signal.aborted) results.truncated = true;

	const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
	return {
		names: names.sort(byPath).map((p) => ({ path: p })),
		files: [...results.byFile.entries()].sort(([a], [b]) => byPath(a, b)).map(([p, matches]) => ({ path: p, matches })),
		truncated: results.truncated || namesTruncated,
	};
}
