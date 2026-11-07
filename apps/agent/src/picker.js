// A small multi-select list for the terminal: ↑/↓ move, space ticks, enter confirms. Used by
// `coderemote tunnels delete` with no ids, so nobody has to copy tunnel ids around.

const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const cyan = (s) => `\x1b[36m${s}\x1b[39m`;
const yellow = (s) => `\x1b[33m${s}\x1b[39m`;

/** Key presses as the reducer knows them, from what raw-mode stdin delivers. */
export function keyOf(data) {
	switch (data) {
		case '\x1b[A': case '\x1bOA': case 'k': return 'up';
		case '\x1b[B': case '\x1bOB': case 'j': return 'down';
		case ' ': return 'toggle';
		case 'a': return 'all';
		case '\r': case '\n': return 'enter';
		case '\x1b': case 'q': case '\x03': return 'cancel';
		default: return null;
	}
}

/**
 * The picker's next state after `key`. `done` is 'confirm' or 'cancel' once it ends; enter with
 * nothing ticked doesn't end it (it says so instead), so it never confirms an empty choice.
 * @param {{ cursor: number, selected: Set<number>, count: number, done?: string, hint?: string }} state
 */
export function step(state, key) {
	const { cursor, selected, count } = state;
	const next = { ...state, hint: null };
	switch (key) {
		case 'up': next.cursor = (cursor - 1 + count) % count; break;
		case 'down': next.cursor = (cursor + 1) % count; break;
		case 'toggle': {
			next.selected = new Set(selected);
			if (selected.has(cursor)) next.selected.delete(cursor);
			else next.selected.add(cursor);
			break;
		}
		case 'all':
			next.selected = selected.size === count ? new Set() : new Set(Array.from({ length: count }, (_, i) => i));
			break;
		case 'enter':
			if (selected.size) next.done = 'confirm';
			else next.hint = 'Nothing chosen: press space on a tunnel first.';
			break;
		case 'cancel': next.done = 'cancel'; break;
	}
	return next;
}

const fit = (s, width) => (s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s);

/**
 * The picker as lines. Each item is `{ label, note?, warn? }`: `warn` marks one whose deletion
 * costs something, so it stands out before it's ticked.
 */
export function render({ title, items, state, columns = 80 }) {
	const lines = [title];
	items.forEach((item, i) => {
		const here = i === state.cursor;
		const box = state.selected.has(i) ? '◉' : '◯';
		const text = fit(`${box} ${item.label}${item.note ? `  ${item.note}` : ''}`, columns - 4);
		const styled = item.warn ? yellow(text) : text;
		lines.push(here ? `${cyan('❯')} ${item.warn ? styled : cyan(styled)}` : `  ${styled}`);
	});
	const n = state.selected.size;
	lines.push(state.hint ? yellow(state.hint) : dim(`↑/↓ move · space choose · a all · enter delete${n ? ` (${n})` : ''} · esc cancel`));
	return lines;
}

/**
 * Lets the user tick items; resolves with the ticked indices in list order, or null when they
 * cancelled. Needs a terminal on both ends (check `isTTY` first).
 */
export function pick({ title, items, input = process.stdin, output = process.stderr }) {
	return new Promise((resolve) => {
		let state = { cursor: 0, selected: new Set(), count: items.length };
		let drawn = 0;
		const draw = () => {
			const lines = render({ title, items, state, columns: output.columns || 80 });
			if (drawn) output.write(`\x1b[${drawn}A\r\x1b[0J`);
			output.write(`${lines.join('\n')}\n`);
			drawn = lines.length;
		};
		const finish = (result) => {
			input.off('data', onData);
			input.setRawMode(false);
			input.pause();
			output.write('\x1b[?25h');
			resolve(result);
		};
		const onData = (buf) => {
			const key = keyOf(buf.toString());
			if (!key) return;
			state = step(state, key);
			draw();
			if (state.done === 'confirm') finish([...state.selected].sort((a, b) => a - b));
			else if (state.done === 'cancel') finish(null);
		};
		output.write('\x1b[?25l');
		input.setRawMode(true);
		input.resume();
		input.on('data', onData);
		draw();
	});
}

/** A yes/no question on the terminal; anything but y/yes is no. */
export function confirm(question, { input = process.stdin, output = process.stderr } = {}) {
	return new Promise((resolve) => {
		output.write(`${question} [y/N] `);
		input.setEncoding('utf8');
		input.resume();
		input.once('data', (answer) => {
			input.pause();
			resolve(/^y(es)?$/i.test(String(answer).trim()));
		});
	});
}
