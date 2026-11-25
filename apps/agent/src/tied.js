// Child processes that end with the agent, however the agent ends. Signal and `exit` handlers cover a
// normal stop; a `kill -9` or a hard crash runs none of them, and a `devtunnel host` or `dns-sd` left
// behind would go on hosting the tunnel or advertising a dead port under launchd.
import { spawn } from 'node:child_process';

/**
 * Runs the command given after it and mirrors it: exits with its code when it exits, ends it on
 * TERM/INT/HUP, and ends it when stdin closes. The agent holds the other end of that pipe, and the
 * kernel closes it when the agent dies, whatever kills it. (An asynchronous list reads /dev/null
 * unless redirected, hence `<&0` on the reader.)
 */
export const WATCHDOG = [
	'"$@" & p=$!',
	'trap \'kill "$p" 2>/dev/null; exit 143\' TERM INT HUP',
	'(read -r _; kill "$p" 2>/dev/null) <&0 & w=$!',
	'wait "$p"; c=$?',
	'kill "$w" 2>/dev/null',
	'exit "$c"',
].join('\n');

/**
 * Spawns `command` tied to this process. `stdout` and `stderr` are as for `spawn` ('pipe' or
 * 'ignore'). The result is the watchdog's ChildProcess: its output is the command's, `kill()` ends the
 * command and `exit` reports the command's code. On Windows, which has no `sh`, a plain spawn.
 */
export function spawnTied(command, args, { stdout = 'ignore', stderr = 'ignore', platform = process.platform, spawnFn = spawn } = {}) {
	if (platform === 'win32') return spawnFn(command, args, { stdio: ['ignore', stdout, stderr] });
	const child = spawnFn('/bin/sh', ['-c', WATCHDOG, 'sh', command, ...args], { stdio: ['pipe', stdout, stderr] });
	child.stdin.on('error', () => {});
	return child;
}
