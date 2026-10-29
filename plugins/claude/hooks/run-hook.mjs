// Runs `coderemote hook` for each Claude Code hook event. hooks.json starts it as `node` plus this
// file (exec form), which no shell reads: a shell-form command would meet sh on macOS and Linux
// but PowerShell on Windows without Git Bash. It never fails the hook: without an agent there's
// nothing to tell.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const failOpen = () => process.exit(0);
process.on('uncaughtException', failOpen);
process.on('unhandledRejection', failOpen);

// Terminals of the app name the CLI of the agent that started them, so the session reports
// through that version whatever is on PATH. It runs in this process, saving a second Node start.
const bin = process.env.CODEREMOTE_HOOK_BIN;
if (bin && fs.existsSync(bin)) {
	process.argv = [process.execPath, bin, 'hook'];
	await import(pathToFileURL(bin).href);
} else {
	// Through a shell: on Windows `coderemote` is npm's batch file. Not installed: nothing happens.
	spawnSync('coderemote hook', { stdio: ['inherit', 'inherit', 'ignore'], shell: true });
}
