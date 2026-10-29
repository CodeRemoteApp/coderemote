import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PreviewTunnel } from '../src/preview.js';

function preview({ leftover, devtunnel }) {
	const remembered = [];
	const calls = [];
	const p = new PreviewTunnel({
		devtunnel: async (...args) => (calls.push(args), devtunnel(...args)),
		command: () => 'devtunnel',
		description: 'coderemote preview test',
		leftover,
		remember: (id) => remembered.push(id),
		mintToken: async () => ({ token: 't', expiresAt: Date.now() + 86_400_000 }),
	});
	return { p, calls, remembered };
}

test('closing deletes the last run’s preview tunnel and forgets it', async () => {
	const { p, calls, remembered } = preview({ leftover: 'old.asse', devtunnel: async () => ({ ok: true, out: '' }) });
	await p.close();
	assert.deepEqual(calls, [['delete', 'old.asse', '-f']]);
	assert.deepEqual(remembered, [null]);
});

test('closing forgets a tunnel that is already gone, and keeps one it could not delete', async () => {
	const gone = preview({ leftover: 'old.asse', devtunnel: async () => ({ ok: false, out: 'Tunnel not found' }) });
	await gone.p.close();
	assert.deepEqual(gone.remembered, [null]);

	const offline = preview({ leftover: 'old.asse', devtunnel: async () => ({ ok: false, out: 'network unreachable' }) });
	await offline.p.close();
	assert.deepEqual(offline.remembered, []);
});

test('closing with no preview tunnel runs nothing', async () => {
	const { p, calls } = preview({ leftover: undefined, devtunnel: async () => ({ ok: true, out: '' }) });
	await p.close();
	assert.deepEqual(calls, []);
});
