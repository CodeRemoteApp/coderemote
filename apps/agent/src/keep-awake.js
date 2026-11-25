// Keeps the computer from sleeping while `coderemote up` shares a folder: asleep, its network is
// off, so phones lose the tunnel and the local route until someone wakes it. Only idle sleep is
// held off; the display still turns off, and a closed laptop lid still sleeps where the OS says so.
import { spawn } from 'node:child_process';
import { spawnTied } from './tied.js';

/**
 * Windows: SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) holds for as long as the
 * thread that set it lives, so this PowerShell keeps running until the agent (`$args[0]`) is gone.
 */
export const WINDOWS_SCRIPT = [
	"$t = Add-Type -Name P -Namespace CodeRemote -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
	'[void]$t::SetThreadExecutionState([uint32]2147483649)',
	'while (Get-Process -Id $args[0] -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }',
].join('; ');

/** The command that holds off idle sleep on `platform` until `pid` exits, or null where there is none. */
export function keepAwakeCommand(platform = process.platform, pid = process.pid) {
	switch (platform) {
		case 'darwin':
			// -i: no idle sleep (the display may still sleep); -w: ends with the agent by itself.
			return { command: 'caffeinate', args: ['-i', '-w', String(pid)], tied: false };
		case 'win32':
			return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `& { ${WINDOWS_SCRIPT} } ${pid}`], tied: false };
		case 'linux':
			// Holds a logind inhibitor lock for as long as `sleep` runs; tied, so it ends with the agent.
			return {
				command: 'systemd-inhibit',
				args: ['--what=idle:sleep', '--who=coderemote', '--why=Sharing a folder with coderemote up', '--mode=block', 'sleep', 'infinity'],
				tied: true,
			};
		default:
			return null;
	}
}

/**
 * Starts holding off sleep. Returns `{ stop() }`, or null where the platform has no way (or the
 * tool is missing: a failed spawn is silent, sleeping is then just as before).
 */
export function keepAwake({ platform = process.platform, pid = process.pid, spawnFn = spawn } = {}) {
	const how = keepAwakeCommand(platform, pid);
	if (!how) return null;
	let child;
	try {
		child = how.tied
			? spawnTied(how.command, how.args, { platform, spawnFn })
			: spawnFn(how.command, how.args, { stdio: 'ignore', windowsHide: true });
	} catch {
		return null;
	}
	child.on('error', () => {});
	child.unref?.();
	return {
		stop() {
			try {
				child.kill();
			} catch {}
		},
	};
}
