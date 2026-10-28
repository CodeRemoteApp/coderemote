import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const bin = new URL('../bin/coderemote.js', import.meta.url).pathname;

/** Runs `coderemote setup codex …` against a stand-in `codex` that logs its arguments. */
function setup(args, { hooks = 'hooks                                stable             true', marketplaces = '' } = {}) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coderemote-codex-'));
	const fakeBin = path.join(home, 'bin');
	fs.mkdirSync(fakeBin);
	fs.mkdirSync(path.join(home, '.codex'));
	const userHooks = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"herdr session"}]}]}}';
	fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), userHooks);
	const log = path.join(home, 'calls');
	fs.writeFileSync(
		path.join(fakeBin, 'codex'),
		`#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  --version) echo "codex-cli 0.165.0" ;;
  "features list") printf '%s\\n' "apps  stable  true" "${hooks}" ;;
  "plugin marketplace list") printf 'MARKETPLACE  ROOT\\n${marketplaces}' ;;
esac
`,
		{ mode: 0o755 },
	);
	const run = spawnSync(process.execPath, [bin, 'setup', 'codex', ...args], {
		env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` },
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
		'plugin add coderemote-codex@coderemote',
	]);
	assert.ok(userHooksKept);
	assert.match(out, /\/hooks/);
});

test('turns hooks on when they are off, and refreshes a marketplace already added', () => {
	const { status, calls } = setup(['--marketplace', '/src/coderemote'], {
		hooks: 'hooks                                stable             false',
		marketplaces: 'coderemote   /src/coderemote\\n',
	});
	assert.equal(status, 0);
	assert.deepEqual(calls.slice(2), [
		'features enable hooks',
		'plugin marketplace list',
		'plugin marketplace remove coderemote',
		'plugin marketplace add /src/coderemote',
		'plugin add coderemote-codex@coderemote',
	]);
	// Without --marketplace, the one already added is refreshed.
	const again = setup([], { marketplaces: 'coderemote   /src/coderemote\\n' });
	assert.deepEqual(again.calls.slice(3), ['plugin marketplace upgrade coderemote', 'plugin add coderemote-codex@coderemote']);
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
	assert.deepEqual(calls.slice(2), ['plugin remove coderemote-codex@coderemote', 'plugin marketplace remove coderemote']);
	assert.ok(userHooksKept);
});
