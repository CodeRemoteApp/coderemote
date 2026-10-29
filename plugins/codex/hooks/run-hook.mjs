// The Windows side of run-hook (hooks.json's commandWindows): Windows runs no shell script, so
// this finds the CLI the running agent recorded in ~/.coderemote/bin/hook.json, else
// `coderemote` on PATH. Like run-hook it never fails Codex's hook: without an agent there's
// nothing to tell.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const failOpen = () => process.exit(0);
process.on('uncaughtException', failOpen);
process.on('unhandledRejection', failOpen);

let script;
try {
	({ script } = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.coderemote', 'bin', 'hook.json'), 'utf8')));
} catch {}
if (script && fs.existsSync(script)) {
	// Run in this process, saving a second Node start.
	process.argv = [process.execPath, script, 'hook', '--agent', 'codex'];
	await import(pathToFileURL(script).href);
} else {
	// Through a shell: on Windows `coderemote` is npm's batch file. Not installed: nothing happens.
	spawnSync('coderemote hook --agent codex', { stdio: ['inherit', 'inherit', 'ignore'], shell: true });
}
