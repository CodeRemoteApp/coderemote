import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tunnelStatus } from '../src/tunnel-status.js';

const tunnels = {
	'own.usw2': {
		tunnelId: 'own.usw2',
		description: 'coderemote Work-Mac.local',
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
		hostConnections: 0,
		ports: [{ portNumber: 31580, portUri: 'https://home1-31580.usw2.devtunnels.ms/' }],
	},
};

function fakeDevtunnel() {
	const calls = [];
	const devtunnel = async (...args) => {
		calls.push(args.join(' '));
		if (args[0] === 'list') return { ok: true, out: `Found 2\n${JSON.stringify({ tunnels: Object.values(tunnels) })}` };
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
		],
		previewPorts: 1,
	});
	assert.ok(calls.includes('list --labels coderemote --json'));

	const before = calls.length;
	await status();
	assert.equal(calls.length, before, 'a second look within 15s reuses the first');
});

test('nothing before the tunnel exists', async () => {
	const { devtunnel } = fakeDevtunnel();
	const status = tunnelStatus({ devtunnel, tunnelId: () => undefined, account: () => undefined, anonymous: true, preview: null });
	assert.equal(await status(), null);
});
