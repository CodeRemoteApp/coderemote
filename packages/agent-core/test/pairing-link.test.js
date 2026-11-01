// The pairing link: tunnel-only (as before), LAN-only (an agent offline), or both.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pairingUrl } from '@vsremote/protocol';
import { lanAddresses, qrAddresses } from '../src/lan.js';

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

test("the QR's addr starts with the Wi-Fi address on a Windows computer full of virtual adapters", () => {
	const v4 = (address) => ({ address, family: 'IPv4', internal: false });
	const v6 = (address) => ({ address, family: 'IPv6', internal: false });
	const addresses = lanAddresses({
		'VirtualBox Host-Only Network': [v4('192.168.56.1')],
		'VMware Network Adapter VMnet1': [v4('192.168.17.1')],
		'Ethernet 2': [v4('100.80.1.2')],
		'Wi-Fi': [v6('2001:db8::7'), v6('2001:db8::8'), v4('192.168.1.20')],
	});
	const link = parse(pairingUrl({ token: 't', lan: { ...lan, addresses: qrAddresses(addresses) } }));
	assert.equal(link.addr, '192.168.1.20,100.80.1.2,2001:db8::7');
});

test('the QR keeps at most 3 addresses, one of them IPv6 at most, in the order given', () => {
	assert.deepEqual(qrAddresses(['10.0.0.2', '2001:db8::1', '2001:db8::2', '192.168.1.3', '172.16.0.4']), ['10.0.0.2', '2001:db8::1', '192.168.1.3']);
});
