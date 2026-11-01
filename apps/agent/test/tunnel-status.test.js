import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tunnelDelete, tunnelStatus } from '../src/tunnel-status.js';

const tunnels = {
	'own.usw2': {
		tunnelId: 'own.usw2',
		description: 'coderemote Work-Mac.local',
		labels: ['coderemote'],
		hostConnections: 1,
		clientConnections: 2,
		tunnelExpiration: '30 days',
		uploadTotal: '1 MB',
		downloadTotal: '5 MB',
		ports: [{ portNumber: 31580, portUri: 'https://own1-31580.usw2.devtunnels.ms/' }],
	},
	'home.usw2': {
		tunnelId: 'home.usw2',
		description: 'vsremote Home-Mac.local',
		labels: ['coderemote'],
		hostConnections: 0,
		ports: [{ portNumber: 31580, portUri: 'https://home1-31580.usw2.devtunnels.ms/' }],
	},
	// A second agent on the same machine, for another folder.
	'other.usw2': {
		tunnelId: 'other.usw2',
		description: 'coderemote Work-Mac.local :31581',
		labels: ['coderemote'],
		hostConnections: 1,
		ports: [{ portNumber: 31581, portUri: 'https://other1-31581.usw2.devtunnels.ms/' }],
	},
	// A preview tunnel: not a machine, but it takes one of the account's tunnels.
	'preview.usw2': {
		tunnelId: 'preview.usw2',
		description: 'coderemote preview Work-Mac',
		labels: ['coderemote-preview'],
		hostConnections: 1,
	},
	// VS Code's `code tunnel`, on the same account.
	'code.usw2': {
		tunnelId: 'code.usw2',
		labels: ['work-mac', 'protocolv6', 'vscode-server-launcher'],
		hostConnections: 0,
	},
};

function fakeDevtunnel() {
	const calls = [];
	const devtunnel = async (...args) => {
		calls.push(args.join(' '));
		if (args[0] === 'list') return { ok: true, out: `Found 5\n${JSON.stringify({ tunnels: Object.values(tunnels) })}` };
		if (args[0] === 'show') return { ok: true, out: JSON.stringify({ tunnel: tunnels[args[1]] }) };
		return { ok: false, out: 'unexpected' };
	};
	return { devtunnel, calls };
}

test('reports the tunnel and the account’s other machines, cached for a while', async () => {
	const { devtunnel, calls } = fakeDevtunnel();
	const status = tunnelStatus({
		devtunnel,
		tunnelId: () => 'own.usw2',
		account: () => 'me (GitHub)',
		anonymous: false,
		preview: { list: () => [{ port: 5173 }] },
	});
	const value = await status();
	assert.deepEqual(value, {
		provider: 'devtunnels',
		account: 'me (GitHub)',
		tunnel: {
			id: 'own.usw2',
			url: 'https://own1-31580.usw2.devtunnels.ms',
			access: 'private',
			expiration: '30 days',
			connections: 2,
			uploaded: '1 MB',
			downloaded: '5 MB',
		},
		machines: [
			{ id: 'own.usw2', name: 'Work-Mac', url: 'https://own1-31580.usw2.devtunnels.ms', online: true, current: true },
			{ id: 'home.usw2', name: 'Home-Mac', url: 'https://home1-31580.usw2.devtunnels.ms', online: false, current: false },
			{ id: 'other.usw2', name: 'Work-Mac :31581', url: 'https://other1-31581.usw2.devtunnels.ms', online: true, current: false },
		],
		others: [
			{ id: 'preview.usw2', kind: 'preview', name: 'Work-Mac', online: true },
			{ id: 'code.usw2', kind: 'vscode', name: null, online: false },
		],
		quota: { used: 5, limit: 10 },
		previewPorts: 1,
	});
	assert.ok(calls.includes('list --limit 100 --json'));

	const before = calls.length;
	await status();
	assert.equal(calls.length, before, 'a second look within 15s reuses the first');
});

test('nothing before the tunnel exists', async () => {
	const { devtunnel } = fakeDevtunnel();
	const status = tunnelStatus({ devtunnel, tunnelId: () => undefined, account: () => undefined, anonymous: true, preview: null });
	assert.equal(await status(), null);
});

function deleter({ user = 'Logged in as me using GitHub.', fail } = {}) {
	const calls = [];
	const deletedIds = [];
	const devtunnel = async (...args) => {
		calls.push(args.join(' '));
		if (args[0] === 'user') return { ok: true, out: user };
		if (args[0] === 'list') return { ok: true, out: JSON.stringify({ tunnels: Object.values(tunnels) }) };
		if (args[0] === 'delete') return fail ? { ok: false, out: fail } : { ok: true, out: 'Deleted' };
		return { ok: false, out: 'unexpected' };
	};
	const remove = tunnelDelete({ devtunnel, tunnelId: () => 'own.usw2', deleted: (id) => deletedIds.push(id) });
	return { remove, calls, deletedIds };
}

const rejects = (promise, status, code) => assert.rejects(promise, (e) => e.status === status && e.code === code);

test('deletes an idle tunnel of the account the app showed', async () => {
	const { remove, calls, deletedIds } = deleter();
	assert.deepEqual(await remove({ id: 'home', account: 'me (GitHub)' }), { deleted: 'home.usw2' });
	assert.ok(calls.includes('delete home.usw2 -f'));
	assert.deepEqual(deletedIds, ['home.usw2']);
});

test('refuses when the computer’s sign-in expired or is another account', async () => {
	await rejects(deleter({ user: 'Login token expired.' }).remove({ id: 'home', account: 'me (GitHub)' }), 403, 'ELOGIN');
	const other = deleter({ user: 'Logged in as you using Microsoft.' });
	await rejects(other.remove({ id: 'home', account: 'me (GitHub)' }), 409, 'EACCOUNT');
	assert.ok(!other.calls.some((c) => c.startsWith('delete')));
});

test('keeps the agent’s own tunnel, and a served one unless forced', async () => {
	const { remove, calls } = deleter();
	await rejects(remove({ id: 'own.usw2', account: 'me (GitHub)', force: true }), 409, 'EOWN');
	await rejects(remove({ id: 'other', account: 'me (GitHub)' }), 409, 'EONLINE');
	assert.ok(!calls.some((c) => c.startsWith('delete')));
	assert.deepEqual(await remove({ id: 'other', account: 'me (GitHub)', force: true }), { deleted: 'other.usw2' });
});

test('reports unknown tunnels, bad requests and devtunnel failures', async () => {
	await rejects(deleter().remove({ id: 'gone', account: 'me (GitHub)' }), 404, 'ENOTUNNEL');
	await rejects(deleter().remove({ account: 'me (GitHub)' }), 400, 'EINVAL');
	await rejects(deleter().remove({ id: 'home' }), 400, 'EINVAL');
	await rejects(deleter({ fail: 'boom' }).remove({ id: 'home', account: 'me (GitHub)' }), 502, 'EDEVTUNNEL');
});
