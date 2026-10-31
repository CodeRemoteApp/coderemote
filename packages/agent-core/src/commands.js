// The slash commands (and, for Codex, `$` skill mentions) a session's coding agent accepts, read
// from the same files the agent reads. Only names and frontmatter leave the computer, never the
// files' bodies. See PROTOCOL.md, "Commands".
import fs from 'node:fs/promises';
import path from 'node:path';

const HEAD_BYTES = 4096;
const MAX_DESCRIPTION = 300;
const MAX_DEPTH = 3;

// [name, description, interactive, argumentHint]. Interactive ones open a menu or dialog in the
// terminal that takes keys beyond typing. Taken from Claude Code 2.1.314 (its `init` message plus
// the TUI-only commands); account-gated and internal ones are left out.
const CLAUDE = [
	['/add-dir', 'Add a working directory', false, '<path>'],
	['/agents', 'Manage agent configurations', true],
	['/batch', 'Run a task across many files in parallel', false, '<task>'],
	['/claude-api', 'Build with the Claude API and Anthropic SDK', false],
	['/clear', 'Start a new session with empty context', false],
	['/code-review', 'Review the current diff for bugs', false, '[level] [target]'],
	['/color', 'Set the prompt bar color for this session', true],
	['/compact', 'Clear history but keep a summary in context', false, '[instructions]'],
	['/config', 'Open settings', true],
	['/context', 'Show context usage', false],
	['/debug', 'Debug this session', false, '[issue]'],
	['/doctor', 'Check the installation and settings', true],
	['/effort', 'Set the reasoning effort', true, '[level]'],
	['/exit', 'Exit Claude Code', false],
	['/export', 'Export the conversation', true],
	['/fast', 'Toggle fast mode', false],
	['/feedback', 'Send feedback about Claude Code', true],
	['/fewer-permission-prompts', 'Allowlist common read-only commands', false],
	['/goal', 'Set or view the goal for this session', false, '[goal]'],
	['/help', 'Show help and available commands', true],
	['/hooks', 'Manage hook configurations', true],
	['/ide', 'Manage IDE integrations', true],
	['/init', 'Create a CLAUDE.md with codebase documentation', false],
	['/insights', 'Report on your Claude Code sessions', false],
	['/login', 'Sign in to your Anthropic account', true],
	['/logout', 'Sign out of your Anthropic account', false],
	['/loop', 'Run a prompt on a recurring interval', false, '[interval] <prompt>'],
	['/mcp', 'Manage MCP servers', true],
	['/memory', 'Edit memory files', true],
	['/model', 'Set the model', true, '[model]'],
	['/output-style', 'Set the output style', true],
	['/permissions', 'Manage tool permission rules', true],
	['/plugin', 'Manage plugins', true],
	['/recap', 'Summarize this session so far', false],
	['/release-notes', 'Show release notes', false],
	['/reload-plugins', 'Reload plugins', false],
	['/reload-skills', 'Reload skills', false],
	['/rename', 'Rename this session', false, '<name>'],
	['/resume', 'Resume a conversation', true],
	['/rewind', 'Restore code or conversation to an earlier point', true],
	['/schedule', 'Create or manage scheduled cloud agents', false, '[task]'],
	['/security-review', 'Security review of the pending changes', false],
	['/simplify', 'Review changed code for cleanups and apply them', false],
	['/status', 'Show version, model and account status', true],
	['/statusline', 'Set up the status line', false],
	['/terminal-setup', 'Set up terminal key bindings', false],
	['/theme', 'Change the color theme', true],
	['/ultrareview', 'Deep multi-agent review in the cloud', false],
	['/update-config', 'Configure Claude Code settings', false, '<change>'],
	['/usage', 'Show plan usage limits', true],
];

// Taken from Codex 0.166's `/` popup.
const CODEX = [
	['/agents', 'open the agent command center', true],
	['/app', 'continue this session in the Desktop app', false],
	['/approve', 'approve one retry of a recent auto-review denial', false],
	['/archive', 'archive this session', false],
	['/cd', 'change the current working directory', false, '<path>'],
	['/clear', 'clear the terminal and start a new chat', false],
	['/compact', 'summarize conversation to prevent hitting the context limit', false],
	['/config', 'configure Codex preferences', true],
	['/copy', 'copy the last response or part of it', true],
	['/debug-config', 'show config layers and requirement sources for debugging', false],
	['/delete', 'permanently delete this session', true],
	['/diff', 'show git diff (including untracked files)', false],
	['/exit', 'exit Codex', false],
	['/experimental', 'toggle experimental features', true],
	['/feedback', 'send logs to maintainers', true],
	['/fork', 'fork the current chat', false],
	['/goal', 'set or view the goal for a long-running task', false, '[goal]'],
	['/hooks', 'view and manage lifecycle hooks', true],
	['/ide', 'include current selection, open files, and other context from your IDE', false],
	['/import', 'import setup, this project, and recent chats from Claude Code', true],
	['/init', 'create an AGENTS.md file with instructions for Codex', false],
	['/keymap', 'remap TUI shortcuts', true],
	['/logout', 'log out of Codex', false],
	['/mcp', 'list MCP tools; use /mcp verbose or /mcp login <name>', false, '[verbose | login <name>]'],
	['/mention', 'mention a file', true],
	['/model', 'choose what model and reasoning effort to use', true],
	['/new', 'start a new chat during a conversation', false],
	['/permissions', 'choose what Codex is allowed to do', true],
	['/pets', 'choose or hide the terminal pet', true],
	['/plan', 'switch to Plan mode', false],
	['/plugins', 'browse plugins', true],
	['/presets', 'run or save reusable prompts and slash commands', true],
	['/ps', 'list background terminals', false],
	['/pwd', 'show the current working directory', false],
	['/raw', 'toggle raw scrollback mode for copy-friendly terminal selection', false],
	['/recap', 'summarize the current conversation now', false],
	['/rename', 'rename the current thread', false, '<name>'],
	['/resume', 'resume a saved chat', true],
	['/review', 'review my current changes and find issues', true],
	['/side', 'start a side conversation in an ephemeral fork', false],
	['/skills', 'use skills to improve how Codex performs specific tasks', true],
	['/status', 'show current session configuration and token usage', false],
	['/statusline', 'configure which items appear in the status line', true],
	['/stop', 'stop all background terminals', false],
	['/subagents', "switch between this session's subagents", true],
	['/theme', 'choose a syntax highlighting theme', true],
	['/title', 'configure which items appear in the terminal title', true],
	['/tui', 'choose the TUI mode for the next launch', true],
	['/usage', 'view account usage or use a usage limit reset', true],
	['/vim', 'toggle Vim mode for the composer', false],
	['/voice', 'start or stop voice; use /voice settings to choose a voice', false],
	['/warnings', 'view retained warnings and diagnostic details', true],
	['/worktree', 'start or continue a conversation in a new worktree', true],
];

export const BUILTINS = { claude: CLAUDE, codex: CODEX };

function builtin([name, description, interactive, argumentHint = '']) {
	return { name, kind: 'command', description, argumentHint, source: 'builtin', interactive };
}

function unquote(v) {
	const t = v.trim();
	if (/^".*"$/.test(t)) return t.slice(1, -1).replace(/\\(["\\])/g, '$1');
	if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
	return t;
}

/**
 * The `key: value` pairs of a Markdown file's frontmatter: flat keys only, with `>`/`|` block values
 * folded onto one line. `null` when the text has no frontmatter, or it doesn't close in time.
 */
export function frontmatter(text) {
	const lines = text.replace(/^﻿/, '').split(/\r?\n/);
	if (lines[0].trim() !== '---') return null;
	const end = lines.indexOf('---', 1);
	if (end < 0) return null;
	const out = {};
	let block = null;
	for (const line of lines.slice(1, end)) {
		const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (m) {
			block = ['>', '|', '>-', '|-', ''].includes(m[2].trim()) ? m[1] : null;
			out[m[1]] = block ? '' : unquote(m[2]);
		} else if (block && /^\s+\S/.test(line)) {
			out[block] = `${out[block]} ${line.trim()}`.trim();
		}
	}
	return out;
}

/** The frontmatter of the file at `file`, read no further than its first 4 KB; `{}` if there is none. */
async function readHead(file) {
	let handle;
	try {
		handle = await fs.open(file, 'r');
		const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0);
		return frontmatter(buffer.subarray(0, bytesRead).toString('utf8')) ?? {};
	} catch {
		return {};
	} finally {
		await handle?.close();
	}
}

async function entries(dir) {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

async function readJson(file) {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8'));
	} catch {
		return null;
	}
}

function entry(name, kind, head, source) {
	return {
		name,
		kind,
		description: String(head.description ?? '').slice(0, MAX_DESCRIPTION),
		argumentHint: kind === 'command' ? String(head['argument-hint'] ?? '') : '',
		source,
		interactive: false,
	};
}

/** Commands in `dir` (`a/b.md` → `/<prefix>a:b`). */
async function commandFiles(dir, prefix, source, depth = 0, parts = []) {
	const out = [];
	for (const e of await entries(dir)) {
		if (e.name.startsWith('.')) continue;
		const file = path.join(dir, e.name);
		if (e.isDirectory() && depth < MAX_DEPTH) {
			out.push(...(await commandFiles(file, prefix, source, depth + 1, [...parts, e.name])));
		} else if (e.isFile() && e.name.endsWith('.md')) {
			const name = `/${prefix}${[...parts, e.name.slice(0, -3)].join(':')}`;
			out.push(entry(name, 'command', await readHead(file), source));
		}
	}
	return out;
}

/** Skills in `dir` (`<folder>/SKILL.md`), named by `${sigil}${prefix}<name>`. */
async function skillFiles(dir, { sigil = '/', prefix = '', source, kind = 'command' }) {
	const out = [];
	for (const e of await entries(dir)) {
		if (!e.isDirectory() || e.name.startsWith('.')) continue;
		const file = path.join(dir, e.name, 'SKILL.md');
		try {
			await fs.access(file);
		} catch {
			continue;
		}
		const head = await readHead(file);
		if (String(head['user-invocable']).toLowerCase() === 'false') continue;
		const name = /^[\w.:-]+$/.test(head.name ?? '') ? head.name : e.name;
		out.push(entry(`${sigil}${prefix}${name}`, kind, head, source));
	}
	return out;
}

/** Plugins Claude Code has enabled: `{ name, root }`, by `enabledPlugins` (project settings win). */
async function claudePlugins(home, cwd) {
	const installed = (await readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json')))?.plugins ?? {};
	const enabled = {};
	for (const file of [
		path.join(home, '.claude', 'settings.json'),
		path.join(cwd, '.claude', 'settings.json'),
		path.join(cwd, '.claude', 'settings.local.json'),
	]) {
		Object.assign(enabled, (await readJson(file))?.enabledPlugins ?? {});
	}
	const out = [];
	for (const [key, installs] of Object.entries(installed)) {
		if (enabled[key] !== true || !Array.isArray(installs)) continue;
		const install = installs.find((i) => !i.projectPath || path.resolve(i.projectPath) === path.resolve(cwd));
		if (install?.installPath) out.push({ name: key.split('@')[0], root: install.installPath });
	}
	return out;
}

async function claudeCommands(home, cwd) {
	const user = path.join(home, '.claude');
	const project = path.join(cwd, '.claude');
	const found = [
		...(await commandFiles(path.join(user, 'commands'), '', 'user')),
		...(await skillFiles(path.join(user, 'skills'), { source: 'user' })),
	];
	for (const e of await entries(path.join(user, 'skills', 'synced'))) {
		if (e.isDirectory() && !e.name.startsWith('.')) {
			found.push(...(await skillFiles(path.join(user, 'skills', 'synced', e.name), { prefix: 'anthropic-skills:', source: 'user' })));
		}
	}
	if (path.resolve(project) !== path.resolve(user)) {
		found.push(
			...(await commandFiles(path.join(project, 'commands'), '', 'project')),
			...(await skillFiles(path.join(project, 'skills'), { source: 'project' })),
		);
	}
	for (const plugin of await claudePlugins(home, cwd)) {
		found.push(
			...(await commandFiles(path.join(plugin.root, 'commands'), `${plugin.name}:`, 'plugin')),
			...(await skillFiles(path.join(plugin.root, 'skills'), { prefix: `${plugin.name}:`, source: 'plugin' })),
		);
	}
	return found;
}

/** `<plugin>@<marketplace>` keys that Codex's config.toml turns off. */
async function codexDisabled(codexHome) {
	const off = new Set();
	let text = '';
	try {
		text = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
	} catch {}
	let section = null;
	for (const line of text.split(/\r?\n/)) {
		const header = /^\s*\[plugins\."([^"]+)"\]\s*$/.exec(line);
		if (header) section = header[1];
		else if (/^\s*\[/.test(line)) section = null;
		else if (section && /^\s*enabled\s*=\s*false\b/.test(line)) off.add(section);
	}
	return off;
}

/** The most recently modified version folder of a cached Codex plugin. */
async function latestVersion(dir) {
	let best = null;
	for (const e of await entries(dir)) {
		if (!e.isDirectory() || e.name.startsWith('.')) continue;
		const { mtimeMs } = await fs.stat(path.join(dir, e.name));
		if (!best || mtimeMs > best.mtimeMs) best = { dir: path.join(dir, e.name), mtimeMs };
	}
	return best?.dir ?? null;
}

/** `cwd` and its parents up to the first one holding `.git`, never reaching `home` or the root. */
async function projectDirs(cwd, home) {
	const dirs = [];
	for (let dir = path.resolve(cwd); dir !== path.resolve(home) && dir !== path.dirname(dir); dir = path.dirname(dir)) {
		dirs.push(dir);
		try {
			await fs.access(path.join(dir, '.git'));
			break;
		} catch {}
	}
	return dirs;
}

async function codexMentions(home, codexHome, cwd) {
	const mention = { sigil: '$', kind: 'mention' };
	const skills = path.join(codexHome, 'skills');
	const found = [
		...(await skillFiles(skills, { ...mention, source: 'user' })),
		...(await skillFiles(path.join(skills, '.system'), { ...mention, source: 'user' })),
	];
	for (const dir of await projectDirs(cwd, home)) {
		found.push(...(await skillFiles(path.join(dir, '.agents', 'skills'), { ...mention, source: 'project' })));
	}
	const off = await codexDisabled(codexHome);
	const cache = path.join(codexHome, 'plugins', 'cache');
	for (const market of await entries(cache)) {
		if (!market.isDirectory()) continue;
		for (const plugin of await entries(path.join(cache, market.name))) {
			if (!plugin.isDirectory() || off.has(`${plugin.name}@${market.name}`)) continue;
			const root = await latestVersion(path.join(cache, market.name, plugin.name));
			if (root) found.push(...(await skillFiles(path.join(root, 'skills'), { ...mention, prefix: `${plugin.name}:`, source: 'plugin' })));
		}
	}
	return found;
}

/**
 * What a session of `agent` in `cwd` accepts: `{ name, kind, description, argumentHint, source,
 * interactive }`, built-ins first, then the rest by name. Of two entries with the same name the
 * later source wins (built-in, then user, then project).
 */
export async function listCommands({ agent, cwd, home, codexHome = path.join(home, '.codex') }) {
	const builtins = (BUILTINS[agent] ?? BUILTINS.claude).map(builtin);
	const found = agent === 'codex' ? await codexMentions(home, codexHome, cwd) : await claudeCommands(home, cwd);
	const byName = new Map(builtins.map((c) => [c.name, c]));
	for (const c of found) byName.set(c.name, c);
	const rest = [...byName.values()].filter((c) => c.source !== 'builtin').sort((a, b) => a.name.localeCompare(b.name));
	return [...byName.values()].filter((c) => c.source === 'builtin').concat(rest);
}
