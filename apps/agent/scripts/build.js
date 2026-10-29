// Bundles the CLI with the workspace packages it uses (@vsremote/agent-core, @vsremote/protocol)
// into one file, so `npm install -g coderemote` needs nothing from this monorepo. Runtime
// dependencies with native code or their own files stay external.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

await build({
	entryPoints: [here('../bin/coderemote.js')],
	outfile: here('../dist/coderemote.js'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	packages: 'external',
	alias: {
		'@vsremote/agent-core': here('../../../packages/agent-core/src/index.js'),
		'@vsremote/protocol': here('../../../packages/protocol/index.js'),
	},
	logLevel: 'warning',
});
