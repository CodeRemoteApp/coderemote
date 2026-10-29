import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	PREVIEW_LABEL,
	TUNNEL_LIMIT,
	findTunnel,
	forgetTunnel,
	formatTunnels,
	listTunnels,
	makeRoom,
	ownUse,
	tunnelLimitHelp,
	tunnelsAtLimit,
} from '../src/tunnels.js';

const tunnel = (i, fields = {}) => ({ tunnelId: `tunnel-${i}.asse`, hostConnections: 0, labels: [], description: '', ...fields });
const listing = (tunnels) => ({ ok: true, out: `Welcome to dev tunnels\n${JSON.stringify({ tunnels })}` });
const many = (n) => Array.from({ length: n }, (_, i) => tunnel(i));

test('lists the account, or says why it could not', async () => {
	const calls = [];
	assert.deepEqual(await listTunnels(async (...args) => (calls.push(args), listing([tunnel(0)]))), { tunnels: [tunnel(0)] });
	assert.deepEqual(calls, [['list', '--limit', '100', '--json']]);
	assert.deepEqual(await listTunnels(async () => ({ ok: false, out: 'Not logged in\n' })), { error: 'Not logged in' });
	assert.match((await listTunnels(async () => ({ ok: true, out: 'not json' }))).error, /unexpected/);
});

test('tells a full account from any other failure to create a tunnel', async () => {
	assert.equal((await tunnelsAtLimit(async () => listing(many(TUNNEL_LIMIT)))).length, TUNNEL_LIMIT);
	assert.equal(await tunnelsAtLimit(async () => listing(many(3))), null);
	// Can't tell: the original error is the better report.
	assert.equal(await tunnelsAtLimit(async () => ({ ok: false, out: 'Rate limit exceeded' })), null);
});

test('makes room on a full account by deleting only the preview tunnels no host serves', async () => {
	const account = many(TUNNEL_LIMIT);
	account[1].labels = [PREVIEW_LABEL];
	account[2].labels = [PREVIEW_LABEL];
	account[2].hostConnections = 1;
	account[3].labels = [PREVIEW_LABEL];
	const deleted = [];
	const devtunnel = async (...args) => {
		if (args[0] === 'list') return listing(account);
		deleted.push(args);
		// One deletion fails: it isn't reported as freed.
		return args[1] === 'tunnel-3.asse' ? { ok: false, out: 'Forbidden' } : { ok: true, out: '' };
	};
	assert.deepEqual(await makeRoom(devtunnel), { freed: ['tunnel-1.asse'] });
	assert.deepEqual(deleted, [['delete', 'tunnel-1.asse', '-f'], ['delete', 'tunnel-3.asse', '-f']]);

	// Nothing that may go: the account is reported as it is.
	const agentsOnly = async () => listing(many(TUNNEL_LIMIT));
	assert.equal((await makeRoom(agentsOnly)).full.length, TUNNEL_LIMIT);
	assert.equal(await makeRoom(async () => listing(many(3))), null);
});

test("knows this computer's tunnels, with or without their region suffix", () => {
	const cfg = { tunnelId: 'tunnel-0', tunnels: { 31580: 'tunnel-0', 31581: 'tunnel-1.asse' }, previewTunnels: { 31580: 'tunnel-2.asse' } };
	assert.equal(ownUse(cfg, 'tunnel-0.asse'), 'agent on port 31580');
	assert.equal(ownUse(cfg, 'tunnel-1'), 'agent on port 31581');
	assert.equal(ownUse(cfg, 'tunnel-2.asse'), 'previews on port 31580');
	assert.equal(ownUse(cfg, 'tunnel-3.asse'), null);
	assert.equal(findTunnel(many(3), 'tunnel-1').tunnelId, 'tunnel-1.asse');
	assert.equal(findTunnel(many(3), 'tunnel-9.asse'), null);

	assert.equal(forgetTunnel(cfg, 'tunnel-0.asse'), true);
	assert.deepEqual(cfg, { tunnels: { 31581: 'tunnel-1.asse' }, previewTunnels: { 31580: 'tunnel-2.asse' } });
	assert.equal(forgetTunnel(cfg, 'tunnel-3'), false);
});

test('lists the tunnels with what each is for, and how to delete one', async () => {
	const tunnels = [
		tunnel(0, { description: 'coderemote my-pc', hostConnections: 1 }),
		tunnel(1, { labels: ['coderemote-preview'] }),
		tunnel(2),
	];
	assert.deepEqual(formatTunnels(tunnels, { tunnels: { 31580: 'tunnel-0' } }), [
		"  tunnel-0.asse  online · this computer's agent on port 31580 · coderemote my-pc",
		'  tunnel-1.asse  coderemote-preview',
		'  tunnel-2.asse  (no description)',
	]);
	const help = tunnelLimitHelp(many(TUNNEL_LIMIT));
	assert.match(help, /already has 10 tunnels/);
	assert.match(help, /coderemote tunnels delete <tunnel id>/);
});
