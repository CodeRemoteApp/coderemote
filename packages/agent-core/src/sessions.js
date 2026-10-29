import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import pty from 'node-pty';
import { interactiveShell, isWindows, terminalCommand } from './platform.js';

// Keep enough scrollback to repaint a screen after a mobile reconnect.
const SCROLLBACK_LIMIT = 256 * 1024;

// node-pty 1.1 on Windows: kill() forks a helper to list the console's processes, then closes
// the console before the helper can attach, so the helper fails with a stack trace on our stderr
// (and exiting right after can crash us); and a terminal that ends by itself keeps its output
// worker thread until kill(). So Windows terminals are ended by killing their process tree, and
// what node-pty holds is let go when they exit.
//
// Nor does node-pty handle the errors of its pipes: typing into a terminal whose console just
// closed, or the output worker forwarding a console's last output after the terminal closed,
// raise errors it would rethrow here, taking the agent down. A terminal that is gone has nothing
// left to say, so those are dropped.
function guardConpty(term) {
	term._agent?._inSocket?.on?.('error', () => {});
	term._agent?._conoutSocketWorker?._worker?.on?.('error', () => {});
}

function releaseConpty(term) {
	term._agent?._conoutSocketWorker?.dispose?.();
	term._agent?._inSocket?.destroy?.();
}

class TerminalSession {
	/**
	 * `command` (an argv array) runs that program instead of an interactive shell, started as
	 * terminalCommand says; the session ends when it exits.
	 */
	constructor({ cols, rows, cwd, env = {}, command = null }) {
		this.id = randomUUID();
		this.createdAt = Date.now();
		this.chunks = [];
		this.bufferedBytes = 0;
		this.clients = new Set();
		this.exitCode = null;

		const { file, args } = command ? terminalCommand(command) : interactiveShell();
		this.shell = command ? interactiveShell().file : file;
		this.command = command;
		this.pty = pty.spawn(file, args, {
			name: 'xterm-256color',
			cols,
			rows,
			cwd: cwd || os.homedir(),
			// CODEREMOTE_TERM_ID lets `coderemote hook` tell which terminal a coding agent runs in.
			env: { ...process.env, ...env, CODEREMOTE_TERM_ID: this.id, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
		});
		if (isWindows) guardConpty(this.pty);
		this.pty.onData((data) => this.#output(Buffer.from(data, 'utf8')));
		this.pty.onExit(({ exitCode }) => {
			this.exitCode = exitCode;
			if (isWindows) releaseConpty(this.pty);
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
				this.write(data.toString('utf8'));
				return;
			}
			let msg;
			try {
				msg = JSON.parse(data.toString('utf8'));
			} catch {
				return;
			}
			if (msg.type === 'input' && typeof msg.data === 'string') this.write(msg.data);
			else if (msg.type === 'resize') this.resize(msg.cols, msg.rows);
		});
		ws.on('close', () => this.clients.delete(ws));
	}

	resize(cols, rows) {
		if (this.exitCode === null && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
			this.pty.resize(cols, rows);
		}
	}

	/** Ends the session; on Windows, which has no signals, always forcibly (see releaseConpty). */
	kill(signal) {
		if (!isWindows) this.pty.kill(signal);
		// Once it has exited its pid may already be someone else's.
		else if (this.exitCode === null) execFile('taskkill', ['/T', '/F', '/PID', String(this.pty.pid)], () => {});
	}

	/** Types into the session, as a client's keyboard would; nothing once it has exited. */
	write(data) {
		if (this.exitCode === null) this.pty.write(data);
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

	/** @param {{ onExit?: (id: string) => void }} [opts] */
	constructor({ onExit } = {}) {
		this.onExit = onExit;
	}

	create(opts) {
		const session = new TerminalSession(opts);
		session.onExit = () => {
			this.#sessions.delete(session.id);
			this.onExit?.(session.id);
		};
		this.#sessions.set(session.id, session);
		return session;
	}

	get(id) {
		return this.#sessions.get(id);
	}

	list() {
		return [...this.#sessions.values()].map((s) => s.toJSON());
	}

	/**
	 * Ends every session; resolves once they have all exited, or after `timeout` ms. Wait for it
	 * before exiting: on Windows terminals end asynchronously (see releaseConpty), and exiting
	 * while node-pty still holds a console open can crash the process.
	 */
	killAll(timeout = 3000) {
		const exited = [...this.#sessions.values()].map((s) => {
			const done = new Promise((resolve) => s.pty.onExit(resolve));
			s.kill();
			return done;
		});
		let timer;
		const late = new Promise((resolve) => {
			timer = setTimeout(resolve, timeout);
		});
		return Promise.race([Promise.all(exited), late]).finally(() => clearTimeout(timer));
	}
}
