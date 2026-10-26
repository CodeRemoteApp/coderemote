// Bundles the CLI with the workspace packages it uses (@vsremote/agent-core, @vsremote/protocol)
// into one file, so `npm install -g coderemote` needs nothing from this monorepo. Runtime
// dependencies with native code or their own files stay external.
import { build } from 'esbuild';

await build({
	entryPoints: [new URL('../bin/coderemote.js', import.meta.url).pathname],
	outfile: new URL('../dist/coderemote.js', import.meta.url).pathname,
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	packages: 'external',
	alias: {
		'@vsremote/agent-core': new URL('../../../packages/agent-core/src/index.js', import.meta.url).pathname,
		'@vsremote/protocol': new URL('../../../packages/protocol/index.js', import.meta.url).pathname,
	},
	logLevel: 'warning',
});
