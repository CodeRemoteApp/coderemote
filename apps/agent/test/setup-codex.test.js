import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/coderemote.js', import.meta.url));

/** Runs `coderemote setup codex …` against a stand-in `codex` that logs its arguments. */
function setup(args, { hooks = 'hooks                                stable             true', marketplaces = '' } = {}) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coderemote-codex-'));
	const fakeBin = path.join(home, 'bin');
	fs.mkdirSync(fakeBin);
	fs.mkdirSync(path.join(home, '.codex'));
	const userHooks = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"herdr session"}]}]}}';
	fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), userHooks);
	const log = path.join(home, 'calls');
	const script = path.join(home, 'fake-codex.mjs');
	const replies = {
		'--version': 'codex-cli 0.165.0\n',
		'features list': `apps  stable  true\n${hooks}\n`,
		'plugin marketplace list': `MARKETPLACE  ROOT\n${marketplaces}`,
	};
	fs.writeFileSync(
		script,
		`import fs from 'node:fs';
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(log)}, args + '\\n');
process.stdout.write(${JSON.stringify(replies)}[args] ?? '');
`,
	);
	// On Windows a batch file, like npm's codex.cmd.
	if (process.platform === 'win32') fs.writeFileSync(path.join(fakeBin, 'codex.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
	else fs.writeFileSync(path.join(fakeBin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
	const run = spawnSync(process.execPath, [bin, 'setup', 'codex', ...args], {
		// Windows finds the home folder through USERPROFILE.
		env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
		encoding: 'utf8',
	});
	const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
	const hooksAfter = fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8');
	fs.rmSync(home, { recursive: true, force: true });
	return { status: run.status, out: run.stdout + run.stderr, calls, userHooksKept: hooksAfter === userHooks };
}

test('installs the plugin from the marketplace, leaving the user’s own hooks alone', () => {
	const { status, out, calls, userHooksKept } = setup([]);
	assert.equal(status, 0, out);
	assert.deepEqual(calls, [
		'--version',
		'features list',
		'plugin marketplace list',
		'plugin marketplace add CodeRemoteApp/coderemote',
		'plugin add coderemote@coderemote',
	]);
	assert.ok(userHooksKept);
	assert.match(out, /\/hooks/);
});

test('turns hooks on when they are off, and refreshes a marketplace already added', () => {
	const { status, calls } = setup(['--marketplace', '/src/coderemote'], {
		hooks: 'hooks                                stable             false',
		marketplaces: 'coderemote   /src/coderemote\n',
	});
	assert.equal(status, 0);
	assert.deepEqual(calls.slice(2), [
		'features enable hooks',
		'plugin marketplace list',
		'plugin marketplace remove coderemote',
		'plugin marketplace add /src/coderemote',
		'plugin add coderemote@coderemote',
	]);
	// Without --marketplace, the one already added is refreshed.
	const again = setup([], { marketplaces: 'coderemote   /src/coderemote\n' });
	assert.deepEqual(again.calls.slice(3), ['plugin marketplace upgrade coderemote', 'plugin add coderemote@coderemote']);
});

test('a Codex without hooks is refused, naming the version that has them', () => {
	const { status, out, calls } = setup([], { hooks: '' });
	assert.equal(status, 1);
	assert.match(out, /0\.139 or later/);
	assert.deepEqual(calls, ['--version', 'features list']);
});

test('--remove uninstalls the plugin and its marketplace', () => {
	const { status, calls, userHooksKept } = setup(['--remove']);
	assert.equal(status, 0);
	assert.deepEqual(calls.slice(2), ['plugin remove coderemote@coderemote', 'plugin marketplace remove coderemote']);
	assert.ok(userHooksKept);
});
