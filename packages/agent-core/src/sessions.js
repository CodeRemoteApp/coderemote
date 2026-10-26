import { randomUUID } from 'node:crypto';
import os from 'node:os';
import pty from 'node-pty';

// Keep enough scrollback to repaint a screen after a mobile reconnect.
const SCROLLBACK_LIMIT = 256 * 1024;

class TerminalSession {
	constructor({ cols, rows, cwd }) {
		this.id = randomUUID();
		this.createdAt = Date.now();
		this.chunks = [];
		this.bufferedBytes = 0;
		this.clients = new Set();
		this.exitCode = null;

		const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/sh');
		this.shell = shell;
		this.pty = pty.spawn(shell, ['-l'], {
			name: 'xterm-256color',
			cols,
			rows,
			cwd: cwd || os.homedir(),
			env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
		});
		this.pty.onData((data) => this.#output(Buffer.from(data, 'utf8')));
		this.pty.onExit(({ exitCode }) => {
			this.exitCode = exitCode;
			for (const ws of this.clients) {
				ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
				ws.close(1000, 'session exited');
			}
			this.onExit?.();
		});
	}

	#output(buf) {
		this.chunks.push(buf);
		this.bufferedBytes += buf.length;
		while (this.bufferedBytes > SCROLLBACK_LIMIT && this.chunks.length > 1) {
			this.bufferedBytes -= this.chunks.shift().length;
		}
		for (const ws of this.clients) ws.send(buf, { binary: true });
	}

	attach(ws) {
		this.clients.add(ws);
		// The scrollback replay is announced so clients can tell it from live output: it holds
		// old terminal queries (device attributes, version, size) that must not be answered again.
		const replay = Buffer.concat(this.chunks);
		ws.send(JSON.stringify({ type: 'session', id: this.id, shell: this.shell, replay: replay.length }));
		if (replay.length) ws.send(replay, { binary: true });

		ws.on('message', (data, isBinary) => {
			if (isBinary) {
				this.pty.write(data.toString('utf8'));
				return;
			}
			let msg;
			try {
				msg = JSON.parse(data.toString('utf8'));
			} catch {
				return;
			}
			if (msg.type === 'input' && typeof msg.data === 'string') this.pty.write(msg.data);
			else if (msg.type === 'resize') this.resize(msg.cols, msg.rows);
		});
		ws.on('close', () => this.clients.delete(ws));
	}

	resize(cols, rows) {
		if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
			this.pty.resize(cols, rows);
		}
	}

	kill() {
		this.pty.kill();
	}

	toJSON() {
		return {
			id: this.id,
			shell: this.shell,
			pid: this.pty.pid,
			title: this.pty.process,
			createdAt: this.createdAt,
			attached: this.clients.size,
		};
	}
}

export class SessionManager {
	#sessions = new Map();

	create(opts) {
		const session = new TerminalSession(opts);
		session.onExit = () => this.#sessions.delete(session.id);
		this.#sessions.set(session.id, session);
		return session;
	}

	get(id) {
		return this.#sessions.get(id);
	}

	list() {
		return [...this.#sessions.values()].map((s) => s.toJSON());
	}

	killAll() {
		for (const s of this.#sessions.values()) s.kill();
	}
}
