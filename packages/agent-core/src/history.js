// Earlier conversations of a coding agent in a folder, for a client to pick one to resume: read
// from the agent's own session files, which are undocumented, so anything unexpected is skipped.
// See PROTOCOL.md, "History".
import fs from 'node:fs/promises';
import path from 'node:path';

const LIMIT = 50;
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_TITLE = 80;

/** `length` bytes of `file` from `position` (negative: from the end), as text. */
async function slice(file, position, length) {
	let handle;
	try {
		handle = await fs.open(file, 'r');
		const { size } = await handle.stat();
		const start = position < 0 ? Math.max(0, size + position) : position;
		const { buffer, bytesRead } = await handle.read(Buffer.alloc(Math.min(length, size)), 0, Math.min(length, size), start);
		return buffer.subarray(0, bytesRead).toString('utf8');
	} catch {
		return '';
	} finally {
		await handle?.close();
	}
}

/** The JSON records among `text`'s lines; a line cut off at either end is skipped. */
function records(text) {
	const out = [];
	for (const line of text.split('\n')) {
		try {
			out.push(JSON.parse(line));
		} catch {}
	}
	return out;
}

function titleOf(text) {
	const line = String(text).trim().split('\n')[0].trim();
	return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

/** A prompt typed by the user, not a record Claude Code adds around slash commands. */
function typedPrompt(record) {
	if (record.type !== 'user' || record.isMeta || record.isSidechain) return null;
	const content = record.message?.content;
	const text = typeof content === 'string' ? content : Array.isArray(content) ? content.find((c) => c?.type === 'text')?.text : null;
	if (typeof text !== 'string') return null;
	const t = text.trim();
	return t && !t.startsWith('<') && !t.startsWith('[Request interrupted') ? t : null;
}

/** Claude Code keeps a folder's conversations in `~/.claude/projects/<folder, non-alphanumerics as ->`. */
async function claudeHistory(home, cwd) {
	const dir = path.join(home, '.claude', 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
	let names = [];
	try {
		names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl'));
	} catch {
		return [];
	}
	const files = [];
	for (const name of names) {
		try {
			const { mtimeMs, size } = await fs.stat(path.join(dir, name));
			files.push({ id: name.slice(0, -6), file: path.join(dir, name), mtimeMs, size });
		} catch {}
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const out = [];
	for (const f of files) {
		if (out.length >= LIMIT) break;
		const tail = records(await slice(f.file, -TAIL_BYTES, TAIL_BYTES));
		// A name given with /rename wins over the one Claude Code made up.
		const named = tail.findLast((r) => r.type === 'custom-title' && r.customTitle)?.customTitle
			?? tail.findLast((r) => r.type === 'ai-title' && r.aiTitle)?.aiTitle;
		const head = named ? [] : records(await slice(f.file, 0, HEAD_BYTES));
		const prompt = named ? null : head.map(typedPrompt).find(Boolean);
		// Nothing was ever asked in it: not worth resuming.
		if (!named && !prompt) continue;
		out.push({
			id: f.id,
			title: titleOf(named ?? prompt),
			updatedAt: Math.round(f.mtimeMs),
			branch: tail.findLast((r) => typeof r.gitBranch === 'string')?.gitBranch ?? null,
			size: f.size,
		});
	}
	return out;
}

/** Codex keeps rollouts in `~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`, names in `session_index.jsonl`. */
async function codexHistory(codexHome, cwd) {
	const names = new Map();
	try {
		for (const r of records(await fs.readFile(path.join(codexHome, 'session_index.jsonl'), 'utf8'))) {
			if (typeof r.id === 'string' && typeof r.thread_name === 'string') names.set(r.id, r.thread_name);
		}
	} catch {}
	const files = [];
	const walk = async (dir, depth) => {
		let entries = [];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
			else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
				try {
					const { mtimeMs, size } = await fs.stat(p);
					files.push({ file: p, mtimeMs, size });
				} catch {}
			}
		}
	};
	await walk(path.join(codexHome, 'sessions'), 0);
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const want = path.resolve(cwd);
	const out = [];
	for (const f of files) {
		if (out.length >= LIMIT) break;
		const head = await slice(f.file, 0, HEAD_BYTES);
		const meta = records(head.split('\n')[0])[0]?.payload;
		if (!meta || typeof meta.id !== 'string' || typeof meta.cwd !== 'string' || path.resolve(meta.cwd) !== want) continue;
		// The first user message carries AGENTS.md; context blocks come wrapped in tags.
		const prompt = records(head)
			.filter((r) => r.type === 'response_item' && r.payload?.type === 'message' && r.payload.role === 'user')
			.flatMap((r) => (Array.isArray(r.payload.content) ? r.payload.content : []))
			.map((c) => (c?.type === 'input_text' && typeof c.text === 'string' ? c.text.trim() : ''))
			.find((t) => t && !t.startsWith('<') && !t.startsWith('# AGENTS.md'));
		const title = names.get(meta.id) ?? prompt;
		if (!title) continue;
		out.push({
			id: meta.id,
			title: titleOf(title),
			updatedAt: Math.round(f.mtimeMs),
			branch: typeof meta.git?.branch === 'string' ? meta.git.branch : null,
			size: f.size,
		});
	}
	return out;
}

/**
 * Up to 50 earlier conversations of `agent` in `cwd`, most recent first:
 * `{ id, title, updatedAt, branch, size }`, `id` being what launching with `resume` takes.
 */
export async function listHistory({ agent, cwd, home, codexHome = path.join(home, '.codex') }) {
	return agent === 'codex' ? codexHistory(codexHome, cwd) : claudeHistory(home, cwd);
}
