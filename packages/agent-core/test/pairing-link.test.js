// The pairing link: tunnel-only (as before), LAN-only (an agent offline), or both.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pairingUrl } from '@vsremote/protocol';

const lan = { agentId: 'a'.repeat(32), port: 32580, addresses: ['192.168.1.5', '2001:db8::5'], fingerprint: 'ab'.repeat(32) };
const parse = (link) => Object.fromEntries(new URL(link).searchParams);

test('a tunnel-only link reads exactly as links from older agents', () => {
	const token = 'tok+/=en';
	const link = pairingUrl({ url: 'https://x-31580.asse.devtunnels.ms', token });
	assert.equal(link, `vsremote://pair?url=${encodeURIComponent('https://x-31580.asse.devtunnels.ms')}&token=${encodeURIComponent(token)}`);
});

test('LAN parameters round-trip, with or without a tunnel URL', () => {
	const both = parse(pairingUrl({ url: 'https://x-31580.asse.devtunnels.ms', token: 't', lan }));
	assert.deepEqual(both, {
		url: 'https://x-31580.asse.devtunnels.ms',
		token: 't',
		id: lan.agentId,
		lan: '32580',
		addr: '192.168.1.5,2001:db8::5',
		fp: lan.fingerprint,
	});
	const offline = parse(pairingUrl({ token: 't', lan }));
	assert.equal(offline.url, undefined);
	assert.equal(offline.fp, lan.fingerprint);
});

test('a link needs a tunnel URL or the LAN listener', () => {
	assert.throws(() => pairingUrl({ token: 't' }), /tunnel URL or the LAN listener/);
});
