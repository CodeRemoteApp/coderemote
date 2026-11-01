// Running agents announce themselves in ~/.coderemote/agents/<port>.json so other
// `coderemote` invocations can find, inspect and stop them.
import fs from 'node:fs';
import path from 'node:path';

export class AgentRegistry {
	constructor(dir) {
		this.dir = dir;
	}

	register({ port, root, url }) {
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const file = this.#file(port);
		// Registering again (the tunnel connected later) keeps when this agent started.
		let startedAt = Date.now();
		try {
			const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (previous.pid === process.pid) startedAt = previous.startedAt;
		} catch {}
		fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, root, url, startedAt }), { mode: 0o600 });
		const cleanup = () => {
			try {
				if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file);
			} catch {}
		};
		if (!this.cleanups) this.cleanups = new Set();
		if (!this.cleanups.has(file)) {
			this.cleanups.add(file);
			process.on('exit', cleanup);
		}
		return cleanup;
	}

	/** Live agents; entries left behind by crashed processes are removed. */
	list() {
		let names = [];
		try {
			names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
		} catch {
			return [];
		}
		const agents = [];
		for (const name of names) {
			const file = path.join(this.dir, name);
			try {
				const agent = JSON.parse(fs.readFileSync(file, 'utf8'));
				process.kill(agent.pid, 0);
				agents.push(agent);
			} catch {
				fs.rmSync(file, { force: true });
			}
		}
		return agents.sort((a, b) => a.port - b.port);
	}

	#file(port) {
		return path.join(this.dir, `${port}.json`);
	}
}
