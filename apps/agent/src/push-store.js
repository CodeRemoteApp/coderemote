// Push registrations of one agent (one port), in ~/.coderemote/push/<port>.json. Each agent has
// its own file so agents for different folders never overwrite each other's.
import fs from 'node:fs';
import path from 'node:path';

export function pushStore(dir, port) {
	const file = path.join(dir, `${port}.json`);
	return {
		load() {
			try {
				const devices = JSON.parse(fs.readFileSync(file, 'utf8'));
				return Array.isArray(devices) ? devices : [];
			} catch {
				return [];
			}
		},
		save(devices) {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			fs.writeFileSync(file, JSON.stringify(devices, null, 2), { mode: 0o600 });
		},
	};
}
