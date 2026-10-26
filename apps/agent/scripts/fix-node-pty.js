// node-pty's macOS prebuilds ship spawn-helper without the exec bit,
// which makes every spawn fail with "posix_spawnp failed".
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let root;
try {
	root = path.dirname(require.resolve('node-pty/package.json'));
} catch {
	process.exit(0);
}
const prebuilds = path.join(root, 'prebuilds');
if (!fs.existsSync(prebuilds)) process.exit(0);
for (const dir of fs.readdirSync(prebuilds)) {
	const helper = path.join(prebuilds, dir, 'spawn-helper');
	if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}
