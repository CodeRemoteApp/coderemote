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
		if (isTyped(text) && content.every((c) => c?.type !== 'tool_result')) yield { time, kind: 'prompt', text };
	} else if (record.type === 'assistant' && Array.isArray(content)) {
		for (const c of content) {
			if (c?.type === 'text' && c.text?.trim()) yield { time, kind: 'assistant', text: c.text.trimEnd() };
			else if (c?.type === 'tool_use') yield { time, kind: 'tool', toolUseId: c.id ?? null, name: c.name ?? null, input: c.input ?? null };
		}
	}
}

/** The last `limit` timeline entries of a transcript; [] when it can't be read. */
export async function readTranscript(file, limit = 500) {
	let text;
	try {
		const handle = await fs.open(file, 'r');
		try {
			const { size } = await handle.stat();
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
	const entries = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			entries.push(...entriesOf(JSON.parse(line)));
		} catch {}
	}
	return entries.slice(-limit);
}
