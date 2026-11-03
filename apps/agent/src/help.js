// Help for one command (`coderemote devices --help`), cut from the full usage text so the two never
// disagree: the command's own entries (its subcommands included) and the options that apply to it.

/** Commands that are one another's other half, shown together. */
const RELATED = { requests: ['requests', 'request'], request: ['requests', 'request'], ps: ['status'] };

/** Options that every command acting on this folder's agent takes. */
const FOLDER_OPTIONS = ['--root', '--port'];
const FOLDER_COMMANDS = new Set(['up', 'serve', 'stop', 'devices', 'requests', 'request']);

/** The entries of a usage section: each starts at a two-space indent, wrapped lines indent further. */
function entries(lines) {
	const out = [];
	for (const line of lines) {
		if (/^ {2}\S/.test(line)) out.push([line]);
		else if (out.length && /^ {3,}\S/.test(line)) out.at(-1).push(line);
	}
	return out;
}

/** The help for `cmd`, or null when the usage text has no entry for it. */
export function commandHelp(usage, cmd) {
	const [commandsPart, optionsPart = ''] = usage.split(/\nOptions:\n/);
	const names = RELATED[cmd] ?? [cmd];
	const own = entries(commandsPart.split('\n')).filter((e) => names.includes(e[0].trim().split(/\s+/)[0]));
	if (!own.length) return null;
	const options = entries(optionsPart.split('\n')).filter((e) => {
		const name = e[0].trim().split(/\s+/)[0];
		const text = e.join(' ');
		// An option marked `up:` is for that command; the folder options for every command on an agent.
		const marked = /\s(\w[\w-]*):\s/.exec(text)?.[1];
		if (marked) return names.includes(marked);
		return FOLDER_OPTIONS.includes(name) && names.some((n) => FOLDER_COMMANDS.has(n));
	});
	const parts = [`Usage: ${names.map((n) => `coderemote ${n}`).join(', ')}`, '', ...own.flat()];
	if (options.length) parts.push('', 'Options:', ...options.flat());
	return parts.join('\n');
}
