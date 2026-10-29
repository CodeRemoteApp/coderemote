// Checks that an installed coderemote can open a terminal: its node-pty loads and runs a command.
//   node pty-smoke.cjs <installed dist/coderemote.js>
const { createRequire } = require('node:module');

const pty = createRequire(process.argv[2])('node-pty');
const [file, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'echo pty-ok']] : ['/bin/sh', ['-c', 'echo pty-ok']];
const term = pty.spawn(file, args, { cols: 80, rows: 24 });
let out = '';
term.onData((data) => (out += data));
// Exits explicitly: on Windows the conpty agent keeps the process alive.
term.onExit(() => {
	console.log(out.trim());
	process.exit(out.includes('pty-ok') ? 0 : 1);
});
setTimeout(() => {
	console.error(`No exit after 20s. Output so far: ${JSON.stringify(out)}`);
	process.exit(1);
}, 20_000);
