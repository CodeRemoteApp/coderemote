// Coding-agent sessions of one agent (one port), in ~/.coderemote/agent-sessions/<port>.json, so
// the list in the app survives a restart (see AgentHub.snapshot and restore).
import fs from 'node:fs';
import path from 'node:path';

export function sessionStore(dir, port) {
	const file = path.join(dir, `${port}.json`);
	return {
		load() {
			try {
				const sessions = JSON.parse(fs.readFileSync(file, 'utf8'));
				return Array.isArray(sessions) ? sessions : [];
			} catch {
				return [];
			}
		},
		save(sessions) {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			// Written aside and renamed, so a crash mid-write never leaves half a file.
			const tmp = `${file}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(sessions), { mode: 0o600 });
			fs.renameSync(tmp, file);
		},
	};
}
