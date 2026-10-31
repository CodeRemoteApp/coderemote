import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BUILTINS, frontmatter, listCommands } from '../src/commands.js';

async function tree(files) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-'));
	for (const [file, text] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await fs.writeFile(path.join(root, file), text);
	}
	return root;
}

const md = (fields, body = 'Body text that must never be sent.') =>
	`---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;

const byName = (list) => Object.fromEntries(list.map((c) => [c.name, c]));

test('frontmatter: flat keys, quotes and folded blocks', () => {
	assert.deepEqual(frontmatter('---\ndescription: "Ship it"\nargument-hint: [env]\n---\nbody'), {
		description: 'Ship it',
		'argument-hint': '[env]',
	});
	assert.deepEqual(frontmatter("---\nname: 'x'\ndescription: >\n  one\n  two\n---\n"), { name: 'x', description: 'one two' });
	assert.deepEqual(frontmatter('---\ndescription: "say \\"hi\\" \\\\ ok"\nb: \'it\'\'s\'\n---\n'), { description: 'say "hi" \\ ok', b: "it's" });
	assert.equal(frontmatter('no frontmatter'), null);
	assert.equal(frontmatter('---\ndescription: never closed\n'), null);
});

test('only the first 4 KB of a file is read', async () => {
	const home = await tree({
		'.claude/commands/short.md': md({ description: 'Short' }),
		'.claude/commands/long.md': `---\nname: long\n${'x: y\n'.repeat(1200)}description: Too far\n---\n`,
	});
	const c = byName(await listCommands({ agent: 'claude', cwd: home, home }));
	assert.equal(c['/short'].description, 'Short');
	assert.equal(c['/long'].description, '');
});

test('built-in tables are well formed', () => {
	for (const [agent, rows] of Object.entries(BUILTINS)) {
		const names = rows.map((r) => r[0]);
		assert.equal(new Set(names).size, names.length, `${agent} has duplicates`);
		for (const [name, description, interactive] of rows) {
			assert.match(name, /^\/[a-z][a-z0-9-]*$/, name);
			assert.ok(description, name);
			assert.equal(typeof interactive, 'boolean', name);
		}
	}
});

test('Claude Code: built-ins, user and project commands, skills, synced skills', async () => {
	const home = await tree({
		'.claude/commands/git/sync.md': md({ description: 'Sync' }),
		'.claude/commands/deploy.md': md({ description: 'User deploy' }),
		'.claude/skills/redact-media/SKILL.md': md({ name: 'redact-media', description: 'Redact things' }),
		'.claude/skills/hidden/SKILL.md': md({ name: 'hidden', 'user-invocable': 'false' }),
		'.claude/skills/no-skill-file/README.md': 'x',
		'.claude/skills/synced/bucket-1/pdf/SKILL.md': md({ name: 'pdf', description: 'PDFs' }),
		'.claude/commands/broken.md': '---\ndescription: [never closed\n',
	});
	const cwd = await tree({
		'.claude/commands/deploy.md': md({ description: 'Ship it', 'argument-hint': '[env]' }),
		'.claude/skills/spike/SKILL.md': md({ description: 'Spike skill' }),
	});
	const list = await listCommands({ agent: 'claude', cwd, home });
	const c = byName(list);

	assert.equal(list[0].source, 'builtin');
	assert.equal(c['/clear'].source, 'builtin');
	assert.equal(c['/config'].interactive, true);
	assert.equal(c['/compact'].interactive, false);
	assert.deepEqual(c['/deploy'], { name: '/deploy', kind: 'command', description: 'Ship it', argumentHint: '[env]', source: 'project', interactive: false });
	assert.equal(c['/git:sync'].source, 'user');
	assert.equal(c['/redact-media'].description, 'Redact things');
	assert.equal(c['/spike'].source, 'project');
	assert.equal(c['/anthropic-skills:pdf'].description, 'PDFs');
	assert.equal(c['/broken'].description, '');
	assert.equal(c['/hidden'], undefined);
	assert.equal(c['/no-skill-file'], undefined);
	assert.ok(!JSON.stringify(list).includes('never be sent'));
});

test('Claude Code: only enabled plugins, project settings win', async () => {
	const home = await tree({
		'plugins/on/1.0.0/commands/hello.md': md({ description: 'Hello' }),
		'plugins/on/1.0.0/skills/glass/SKILL.md': md({ name: 'glass', description: 'Glass' }),
		'plugins/off/1.0.0/commands/nope.md': md({ description: 'Nope' }),
		'plugins/proj/1.0.0/commands/here.md': md({ description: 'Here' }),
		'.claude/settings.json': JSON.stringify({ enabledPlugins: { 'on@m': true, 'off@m': true, 'proj@m': false } }),
	});
	const cwd = await tree({ '.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'off@m': false, 'proj@m': true } }) });
	const install = (name) => [{ scope: 'user', installPath: path.join(home, 'plugins', name, '1.0.0') }];
	await fs.mkdir(path.join(home, '.claude', 'plugins'), { recursive: true });
	await fs.writeFile(
		path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
		JSON.stringify({ version: 2, plugins: { 'on@m': install('on'), 'off@m': install('off'), 'proj@m': install('proj') } }),
	);
	const c = byName(await listCommands({ agent: 'claude', cwd, home }));
	assert.equal(c['/on:hello'].source, 'plugin');
	assert.equal(c['/on:glass'].description, 'Glass');
	assert.equal(c['/proj:here'].source, 'plugin');
	assert.equal(c['/off:nope'], undefined);
});

test('missing folders leave only the built-ins', async () => {
	const home = await tree({});
	for (const agent of ['claude', 'codex']) {
		const list = await listCommands({ agent, cwd: path.join(home, 'nowhere'), home });
		assert.equal(list.length, BUILTINS[agent].length);
		assert.ok(list.every((c) => c.source === 'builtin'));
	}
});

test('Codex: built-in commands plus skill mentions', async () => {
	const home = await tree({
		'.agents/skills/find-skills/SKILL.md': md({ name: 'find-skills' }),
		'.codex/prompts/openspec-apply.md': md({ description: 'Old custom prompt' }),
		'.codex/skills/fix-pr-review/SKILL.md': md({ name: 'fix-pr-review', description: 'Fix PR review' }),
		'.codex/skills/.system/openai-docs/SKILL.md': md({ name: 'openai-docs', description: 'Docs' }),
		'.codex/plugins/cache/remote/swiftui-expert/5.1.0/skills/swiftui-expert-skill/SKILL.md': md({ name: 'swiftui-expert-skill', description: 'Old' }),
		'.codex/plugins/cache/curated/superpowers/abc/skills/brainstorming/SKILL.md': md({ name: 'brainstorming' }),
		'.codex/config.toml': '[plugins."superpowers@curated"]\nenabled = false\n\n[features]\nenabled = true\n',
		'repo/.git/HEAD': 'ref: refs/heads/main\n',
		'repo/.agents/skills/openspec-propose/SKILL.md': md({ name: 'openspec-propose', description: 'Propose' }),
		'repo/app/.agents/skills/app-skill/SKILL.md': md({ name: 'app-skill' }),
	});
	// The newest version folder of a plugin wins.
	const newer = path.join(home, '.codex/plugins/cache/remote/swiftui-expert/5.2.0/skills/swiftui-expert-skill/SKILL.md');
	await fs.mkdir(path.dirname(newer), { recursive: true });
	await fs.writeFile(newer, md({ name: 'swiftui-expert-skill', description: 'New' }));
	const later = new Date(Date.now() + 60_000);
	await fs.utimes(path.join(home, '.codex/plugins/cache/remote/swiftui-expert/5.2.0'), later, later);

	const list = await listCommands({ agent: 'codex', cwd: path.join(home, 'repo', 'app'), home });
	const c = byName(list);
	assert.equal(c['/review'].source, 'builtin');
	assert.equal(c['/fork'].kind, 'command');
	assert.equal(c['/context'], undefined);
	assert.equal(c['/prompts:openspec-apply'], undefined);
	assert.deepEqual(c['$openspec-propose'], {
		name: '$openspec-propose',
		kind: 'mention',
		description: 'Propose',
		argumentHint: '',
		source: 'project',
		interactive: false,
	});
	assert.equal(c['$app-skill'].source, 'project');
	assert.equal(c['$fix-pr-review'].source, 'user');
	assert.equal(c['$openai-docs'].description, 'Docs');
	assert.equal(c['$swiftui-expert:swiftui-expert-skill'].description, 'New');
	assert.equal(c['$swiftui-expert:swiftui-expert-skill'].source, 'plugin');
	assert.equal(c['$superpowers:brainstorming'], undefined);
	assert.equal(c['$find-skills'], undefined);
});
