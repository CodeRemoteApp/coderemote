// What differs between Windows and the POSIX systems (macOS, Linux): the shell a terminal runs,
// and how a command is found and started. POSIX goes through the user's login shell, for the
// PATH their shell setup gives; Windows has no login shell and its environment carries PATH.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const isWindows = process.platform === 'win32';

/** One POSIX shell word for `arg`, whatever it contains. */
export function shellQuote(arg) {
	return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function runnable(file) {
	try {
		// X_OK means nothing on Windows, where what runs is told by the extension.
		if (!isWindows) fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * The file `name` runs: a path as given, else the first match on PATH. On Windows a name without
 * an extension also matches with each of PATHEXT's (.exe, .cmd, ...), as cmd.exe looks them up.
 * Checked on disk rather than by running anything. Null when there's none.
 */
export function findExecutable(name, env = process.env) {
	const exts = isWindows && !path.extname(name) ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
	const match = (base) => exts.map((e) => base + e).find(runnable) ?? null;
	if (name.includes('/') || name.includes(path.sep)) return match(path.resolve(name));
	for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
		const found = dir && match(path.join(dir.replace(/^"(.*)"$/, '$1'), name));
		if (found) return found;
	}
	return null;
}

/** The interactive shell a new terminal runs: the user's login shell, PowerShell on Windows. */
export function interactiveShell() {
	if (!isWindows) return { file: process.env.SHELL || '/bin/sh', args: ['-l'] };
	return { file: findExecutable('pwsh') ?? 'powershell.exe', args: ['-NoLogo'] };
}

/**
 * One cmd.exe word. Inside quotes cmd takes & | < > ^ literally, but nothing can stop it
 * expanding %VAR%, and a quote would end the word, so those are refused. Trailing backslashes
 * are doubled: the program behind the batch file reads `\"` as an escaped quote.
 */
function cmdQuote(arg) {
	const s = String(arg);
	if (/["%\r\n]/.test(s)) throw new Error(`${JSON.stringify(s)} can't be passed through cmd.exe`);
	return `"${s.replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * How to start `argv` without a shell. Windows can only start a batch file (npm's `claude.cmd`,
 * `code.cmd`) through cmd.exe; `verbatim` says `args` is that command line, to pass unquoted.
 * Elsewhere this is `argv` itself.
 * @returns {{ file: string, args: string[], verbatim: boolean }}
 */
export function resolveCommand(argv) {
	const [name, ...rest] = argv;
	if (!isWindows) return { file: name, args: rest, verbatim: false };
	// Not found: starting it fails as it would elsewhere, with ENOENT.
	const file = findExecutable(name) ?? name;
	if (!/\.(bat|cmd)$/i.test(file)) return { file, args: rest, verbatim: false };
	// /d skips AutoRun commands, /v:off keeps ! literal, /s strips just the outer quotes.
	const line = [file, ...rest].map(cmdQuote).join(' ');
	return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/v:off', '/s', '/c', `"${line}"`], verbatim: true };
}

/**
 * How a terminal runs `argv` in place of a shell, ending when it exits: through a login shell on
 * POSIX, so it finds what the user's own terminals would. The args are a string when they are a
 * raw Windows command line (node-pty passes those through as they are).
 * @returns {{ file: string, args: string[] | string }}
 */
export function terminalCommand(argv) {
	if (!isWindows) return { file: interactiveShell().file, args: ['-l', '-c', `exec ${argv.map(shellQuote).join(' ')}`] };
	const { file, args, verbatim } = resolveCommand(argv);
	return { file, args: verbatim ? args.join(' ') : args };
}

/** `child_process.spawn` for `argv`, batch files included (see resolveCommand). */
export function spawnCommand(argv, options = {}) {
	const { file, args, verbatim } = resolveCommand(argv);
	return spawn(file, args, { ...options, windowsVerbatimArguments: verbatim });
}

/**
 * `child_process.execFile` for `argv`, promisified like util.promisify does it (the error carries
 * stdout and stderr), batch files included (see resolveCommand).
 */
export function execCommand(argv, options = {}) {
	return new Promise((resolve, reject) => {
		const { file, args, verbatim } = resolveCommand(argv);
		execFile(file, args, { ...options, windowsVerbatimArguments: verbatim }, (err, stdout, stderr) =>
			err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr }),
		);
	});
}

/** Runs a script in the user's login shell (POSIX only); its output, or null when it fails. */
function loginShell(script, timeout) {
	return new Promise((resolve) => {
		execFile(interactiveShell().file, ['-l', '-c', script], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, out) =>
			resolve(err ? null : out),
		);
	});
}

/**
 * The output of `argv`, run to the end the way a terminal would start it (see terminalCommand);
 * null when it can't be found, fails or times out.
 */
export async function capture(argv, { timeout = 20_000 } = {}) {
	if (!isWindows) return loginShell(argv.map(shellQuote).join(' '), timeout);
	try {
		return (await execCommand(argv, { timeout, maxBuffer: 16 * 1024 * 1024 })).stdout;
	} catch {
		return null;
	}
}

/** Whether `command` runs here, looked up the way a terminal would start it. */
export async function commandExists(command) {
	if (isWindows) return findExecutable(command) !== null;
	return Boolean((await loginShell(`command -v ${shellQuote(command)}`, 20_000))?.trim());
}
