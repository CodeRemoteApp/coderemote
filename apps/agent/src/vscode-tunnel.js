// `coderemote up --web`: runs VS Code's own tunnel (`code tunnel`) next to the agent, so the
// shared folder also opens in the full VS Code UI on vscode.dev. That tunnel is VS Code's,
// separate from ours: it signs in with its own account and serves the whole machine.
// VS Code's `code` is a batch file on Windows (code.cmd), hence spawnCommand and execCommand.
import { execCommand, findExecutable, isWindows, spawnCommand } from '@vsremote/agent-core';

/** The VS Code CLI: $CODEREMOTE_CODE, else `code` on PATH, else null. */
export function findCode() {
	return process.env.CODEREMOTE_CODE || findExecutable('code');
}

/** Whether `code tunnel` is signed in ("logged in with provider GitHub Account"). */
export async function codeTunnelSignedIn(code) {
	try {
		const { stdout } = await execCommand([code, 'tunnel', 'user', 'show']);
		return /^logged in/im.test(stdout);
	} catch {
		return false;
	}
}

/** `code tunnel user login` in this terminal (device code flow); resolves to its exit code. */
export function codeTunnelLogin(code) {
	return new Promise((resolve) => {
		spawnCommand([code, 'tunnel', 'user', 'login', '--provider', 'github'], { stdio: 'inherit' }).on('exit', resolve);
	});
}

/**
 * Starts `code tunnel` and resolves once it prints its vscode.dev link, rewritten to open
 * `root`. If a tunnel already runs on this machine the CLI attaches to it instead, and killing
 * the child leaves that tunnel up. stdin is closed so a first-run prompt (license, machine name)
 * fails fast instead of waiting unseen; the error then carries the log.
 */
export function hostCodeTunnel(code, root, timeoutMs = 60_000) {
	return new Promise((resolve, reject) => {
		const child = spawnCommand([code, 'tunnel'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
		let log = '';
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`code tunnel printed no vscode.dev link within ${timeoutMs / 1000}s:\n${log}`));
		}, timeoutMs);
		const onData = (d) => {
			log +=String(d).replace(/\x1b\[[0-9;]*m/g, '');
			const m = log.match(/https:\/\/vscode\.dev\/tunnel\/([^/\s]+)/);
			if (!m) return;
			clearTimeout(timer);
			// vscode.dev takes a Windows folder as /C:/Users/...
			const folder = isWindows ? `/${root.replaceAll('\\', '/')}` : root;
			resolve({ child, url: `https://vscode.dev/tunnel/${m[1]}${encodeURI(folder)}` });
		};
		child.stdout.on('data', onData);
		child.stderr.on('data', onData);
		child.on('error', (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on('exit', (exitCode) => {
			clearTimeout(timer);
			reject(new Error(`code tunnel exited (${exitCode}):\n${log}`));
		});
	});
}
