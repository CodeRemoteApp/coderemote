// Per-command help (`coderemote devices --help`), with the real CLI as a child process.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandHelp } from '../src/help.js';

const BIN = fileURLToPath(new URL('../bin/coderemote.js', import.meta.url));
const run = (...args) => execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

const USAGE = `Usage: x

  up                   share
                       more about up
  devices              list
  devices revoke <id>  revoke one
  request <ID>         one request
  requests             all requests

Options:
  --root DIR           folder
  --web                up: also vscode.dev`;

test('a command shows its own entries, wrapped lines included, and the options for it', () => {
	const help = commandHelp(USAGE, 'devices');
	assert.match(help, /devices revoke <id>/);
	assert.doesNotMatch(help, /share/);
	assert.match(help, /--root/);
	assert.doesNotMatch(help, /--web/);
	assert.match(commandHelp(USAGE, 'up'), /more about up[\s\S]*--web/);
	assert.match(commandHelp(USAGE, 'request'), /requests {13}all requests/);
	assert.equal(commandHelp(USAGE, 'nope'), null);
});

test('every way of asking for one command gives the same help', () => {
	const help = run('devices', '--help');
	assert.match(help, /^Usage: coderemote devices\n/);
	assert.match(help, /devices policy <level>/);
	assert.doesNotMatch(help, /tunnels delete/);
	for (const args of [['devices', 'help'], ['devices', '-h'], ['help', 'devices'], ['--help', 'devices']]) assert.equal(run(...args), help, args.join(' '));
});

test('bare help still lists everything, and an unknown command fails with it', () => {
	assert.match(run('--help'), /devices revoke[\s\S]*tunnels delete/);
	const unknown = spawnSync(process.execPath, [BIN, 'nope', '--help'], { encoding: 'utf8' });
	assert.equal(unknown.status, 1);
	assert.match(unknown.stderr, /^Unknown command: nope\n/);
});
