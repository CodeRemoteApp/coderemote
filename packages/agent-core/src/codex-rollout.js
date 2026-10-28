// Codex's hooks report the prompt, tools and final reply, but not what Codex says in between or
// what a patch did. Its rollout file (the hook's `transcript_path`) has both, as `item_completed`
// events. The format is Codex's own and undocumented, so this follows only those items and
// ignores anything else.
import fs from 'node:fs/promises';

const POLL = 1000;

/** The timeline fields an `item_completed` item stands for, or null. */
export function codexItem(item) {
	if (!item || typeof item !== 'object') return null;
	if (item.type === 'AgentMessage') {
		const text = (item.content ?? []).filter((c) => typeof c?.text === 'string').map((c) => c.text).join('\n').trim();
		return text ? { kind: 'assistant', text } : null;
	}
	if (item.type === 'FileChange' && item.changes && typeof item.changes === 'object') {
		const verbs = { add: 'Added', update: 'Updated', delete: 'Deleted' };
		const lines = Object.entries(item.changes).map(([file, change]) => `${verbs[change?.type] ?? 'Changed'} ${file}`);
		return { kind: 'tool_result', toolUseId: item.id ?? null, output: lines.join('\n'), error: false };
	}
	// Commands report their output under one of these, depending on the Codex version.
	const output = item.aggregated_output ?? item.aggregatedOutput ?? item.output;
	if (typeof item.id === 'string' && typeof output === 'string') {
		const code = item.exit_code ?? item.exitCode;
		return { kind: 'tool_result', toolUseId: item.id, output, error: typeof code === 'number' && code !== 0 };
	}
	return null;
}

/** Follows a rollout file from its current end, calling `onItem` with each completed item. */
export class RolloutTail {
	#file;
	#offset = null;
	#partial = '';
	#timer = null;
	#onItem;

	constructor(file, onItem) {
		this.#file = file;
		this.#onItem = onItem;
		this.#timer = setInterval(() => this.poll().catch(() => {}), POLL);
		this.#timer.unref?.();
	}

	async poll() {
		const handle = await fs.open(this.#file, 'r');
		try {
			const { size } = await handle.stat();
			// The first look only notes where the file ends: what came before is history.
			if (this.#offset === null || size < this.#offset) {
				this.#offset = size;
				return;
			}
			if (size === this.#offset) return;
			const buf = Buffer.alloc(size - this.#offset);
			await handle.read(buf, 0, buf.length, this.#offset);
			this.#offset = size;
			const lines = (this.#partial + buf.toString('utf8')).split('\n');
			this.#partial = lines.pop();
			for (const line of lines) {
				let record;
				try {
					record = JSON.parse(line);
				} catch {
					continue;
				}
				if (record?.type === 'event_msg' && record.payload?.type === 'item_completed') this.#onItem(record.payload.item);
			}
		} finally {
			await handle.close();
		}
	}

	stop() {
		clearInterval(this.#timer);
	}
}
