// Best-effort history for a session the agent first hears about mid-way (the agent restarted, or
// a conversation was resumed): the tail of Claude Code's transcript, as timeline entries. The
// transcript format is Claude Code's own and undocumented, so anything unexpected is skipped.
import fs from 'node:fs/promises';

const TAIL_BYTES = 2 * 1024 * 1024;

function textOf(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((c) => c?.type === 'text' && typeof c.text === 'string')
		.map((c) => c.text)
		.join('\n');
}

/** Prompts typed by the user, not the slash-command and interruption records Claude Code adds. */
function isTyped(text) {
	const t = text.trim();
	return t && !t.startsWith('<command-') && !t.startsWith('<local-command') && !t.startsWith('[Request interrupted');
}

/** Timeline fields (without seq) from one transcript record. */
function* entriesOf(record) {
	// Claude Code names the conversation itself; the Claude apps show that name.
	if (record?.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) {
		yield { time: 0, kind: 'title', text: record.aiTitle.trim() };
		return;
	}
	if (!record || record.isSidechain || record.isMeta) return;
	const time = Date.parse(record.timestamp) || 0;
	const content = record.message?.content;
	if (record.type === 'user') {
		if (typeof content === 'string') {
			if (isTyped(content)) yield { time, kind: 'prompt', text: content };
			return;
		}
		if (!Array.isArray(content)) return;
		for (const c of content) {
			if (c?.type === 'tool_result') {
				yield { time, kind: 'tool_result', toolUseId: c.tool_use_id ?? null, name: null, output: textOf(c.content), error: c.is_error === true, truncated: false, duration: null };
			}
		}
		const text = textOf(content);
		if (content.some((c) => c?.type === 'tool_result')) return;
		// Images pasted with the prompt, which its text names `[Image #N]`; the hub keeps them as uploads.
		const images = content
			.filter((c) => c?.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string')
			.map((c) => ({ type: c.source.media_type ?? 'image/png', data: c.source.data }));
		if (isTyped(text) || (images.length && !text.trim())) yield { time, kind: 'prompt', text, ...(images.length ? { images } : {}) };
	} else if (record.type === 'assistant' && Array.isArray(content)) {
		// The model that answered, which `/model` may have changed (`<synthetic>`: Claude Code's own notes).
		const model = record.message?.model;
		if (typeof model === 'string' && model && model !== '<synthetic>') yield { time, kind: 'model', model };
		for (const c of content) {
			if (c?.type === 'text' && c.text?.trim()) yield { time, kind: 'assistant', text: c.text.trimEnd() };
			// Thinking the model shows (private thinking is stored empty): what it says between
			// tool calls, which the Claude apps show as part of the reply. No hook reports it.
			else if (c?.type === 'thinking' && c.thinking?.trim()) yield { time, kind: 'assistant', text: c.thinking.trimEnd(), thinking: true };
			else if (c?.type === 'tool_use') yield { time, kind: 'tool', toolUseId: c.id ?? null, name: c.name ?? null, input: c.input ?? null };
		}
	}
}

function parse(text) {
	const entries = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			entries.push(...entriesOf(JSON.parse(line)));
		} catch {}
	}
	return entries;
}

/**
 * The last `limit` timeline entries of a transcript; [] when it can't be read. `end` on the array
 * is the byte offset read up to, for `readTranscriptSince`.
 */
export async function readTranscript(file, limit = 500) {
	let text;
	let end = 0;
	try {
		const handle = await fs.open(file, 'r');
		try {
			const { size } = await handle.stat();
			end = size;
			const start = Math.max(0, size - TAIL_BYTES);
			const buf = Buffer.alloc(size - start);
			await handle.read(buf, 0, buf.length, start);
			text = buf.toString('utf8');
			// Starting mid-file lands inside a record; drop it.
			if (start > 0) text = text.slice(text.indexOf('\n') + 1);
		} finally {
			await handle.close();
		}
	} catch {
		return [];
	}
	// A title only matters as the latest one, which may lie before the entries kept.
	const all = parse(text);
	// So does the model, which answers the next turn too.
	const title = all.findLast((e) => e.kind === 'title');
	const model = all.findLast((e) => e.kind === 'model');
	const entries = all.filter((e) => e.kind !== 'title' && e.kind !== 'model').slice(-limit);
	if (model) entries.unshift(model);
	if (title) entries.unshift(title);
	entries.end = end;
	return entries;
}

/**
 * Entries of the records written to a transcript since byte `offset` (whole lines only), and
 * the offset to read from next; null when it can't be read.
 */
export async function readTranscriptSince(file, offset) {
	try {
		const handle = await fs.open(file, 'r');
		try {
			const { size } = await handle.stat();
			if (size < offset) return { entries: [], end: size };
			const buf = Buffer.alloc(Math.min(size - offset, TAIL_BYTES));
			await handle.read(buf, 0, buf.length, offset);
			const last = buf.lastIndexOf(0x0a);
			if (last < 0) return { entries: [], end: offset };
			return { entries: parse(buf.subarray(0, last + 1).toString('utf8')), end: offset + last + 1 };
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}
