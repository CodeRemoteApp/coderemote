// The LAN certificate: generated once (with Node alone), then reused; and the reachable addresses.
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { certFingerprint, lanAddresses, lanCertificate } from '../src/lan.js';
import { isWindows } from '../src/platform.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lan-cert-'));
// A key and certificate made by `openssl req -x509 -newkey ec ...`, as versions before this one
// did. Test-only: nothing trusts it.
const OPENSSL_MADE = fileURLToPath(new URL('./fixtures/lan-openssl', import.meta.url));

test('generates a certificate once and reuses it', async () => {
	const dir = path.join(tmp(), 'lan');
	const first = await lanCertificate(dir);
	assert.equal(first.error, undefined);
	assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
	assert.equal(first.fingerprint, new X509Certificate(first.cert).fingerprint256.replace(/:/g, '').toLowerCase());
	assert.match(first.key, /PRIVATE KEY/);
	if (!isWindows) {
		assert.equal(fs.statSync(path.join(dir, 'key.pem')).mode & 0o777, 0o600);
		assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
	}
	const second = await lanCertificate(dir);
	assert.equal(second.fingerprint, first.fingerprint);
});

test('a new directory gets a new certificate', async () => {
	const a = await lanCertificate(path.join(tmp(), 'lan'));
	const b = await lanCertificate(path.join(tmp(), 'lan'));
	assert.notEqual(a.fingerprint, b.fingerprint);
});

test('a certificate an older version made with openssl is used as it is', async () => {
	const dir = path.join(tmp(), 'lan');
	fs.cpSync(OPENSSL_MADE, dir, { recursive: true });
	const got = await lanCertificate(dir);
	assert.equal(got.cert, fs.readFileSync(path.join(OPENSSL_MADE, 'cert.pem'), 'utf8'));
	assert.equal(got.key, fs.readFileSync(path.join(OPENSSL_MADE, 'key.pem'), 'utf8'));
	assert.equal(got.fingerprint, certFingerprint(got.cert));
});

test('where none can be saved there is no certificate, and nothing is left behind', async () => {
	// A file where the directory should be.
	const blocked = path.join(tmp(), 'lan');
	fs.writeFileSync(blocked, '');
	const got = await lanCertificate(path.join(blocked, 'sub'));
	assert.match(got.error, /could not create a certificate/);
	assert.equal(fs.existsSync(path.join(blocked, 'sub')), false);
});

test('served over TLS, the certificate the client sees has the reported fingerprint', async () => {
	const lan = await lanCertificate(path.join(tmp(), 'lan'));
	const server = tls.createServer({ key: lan.key, cert: lan.cert, minVersion: 'TLSv1.2' }, (s) => s.end());
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	try {
		const raw = await new Promise((resolve, reject) => {
			const socket = tls.connect({ host: '127.0.0.1', port: server.address().port, rejectUnauthorized: false }, () => {
				resolve(socket.getPeerCertificate(true).raw);
				socket.destroy();
			});
			socket.on('error', reject);
		});
		assert.equal(new X509Certificate(raw).fingerprint256.replace(/:/g, '').toLowerCase(), lan.fingerprint);
	} finally {
		server.close();
	}
});

test('LAN addresses skip loopback, link-local and virtual interfaces, IPv4 first', () => {
	const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal });
	const v6 = (address, internal = false) => ({ address, family: 'IPv6', internal });
	const got = lanAddresses({
		lo0: [v4('127.0.0.1', true), v6('::1', true)],
		en0: [v6('fe80::1'), v6('2001:db8::5'), v4('192.168.1.5')],
		en7: [v4('169.254.3.4')],
		utun0: [v4('100.64.0.2')],
		docker0: [v4('172.17.0.1')],
		bridge100: [v4('192.168.64.1')],
		en1: [v4('10.0.0.8')],
	});
	assert.deepEqual(got, ['192.168.1.5', '10.0.0.8', '2001:db8::5']);
});

test('Windows adapters: only the physical ones, private IPv4 first', () => {
	const v4 = (address) => ({ address, family: 'IPv4', internal: false });
	const v6 = (address) => ({ address, family: 'IPv6', internal: false });
	const got = lanAddresses({
		'vEthernet (WSL)': [v4('172.28.160.1')],
		'VirtualBox Host-Only Network': [v4('192.168.56.1')],
		'VMware Network Adapter VMnet8': [v4('192.168.75.1')],
		'ZeroTier One [8056c2e21c000001]': [v4('10.147.17.5')],
		'Local Area Connection* 10': [v4('192.168.137.1')],
		'Bluetooth Network Connection': [v4('169.254.10.2')],
		Tailscale: [v4('100.101.102.103')],
		'Wi-Fi': [v6('2001:db8::7'), v6('fe80::1'), v4('192.168.1.20')],
		'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
	});
	assert.deepEqual(got, ['192.168.1.20', '2001:db8::7']);
});

test('the Ethernet port older Windows calls "Local Area Connection" is kept', () => {
	const got = lanAddresses({ 'Local Area Connection': [{ address: '10.0.0.4', family: 'IPv4', internal: false }] });
	assert.deepEqual(got, ['10.0.0.4']);
});

test('private IPv4 addresses come before other IPv4 ones, whatever the adapter order', () => {
	const v4 = (address) => ({ address, family: 'IPv4', internal: false });
	const got = lanAddresses({
		'Ethernet 3': [v4('100.64.1.9')],
		Ethernet: [v4('203.0.113.4')],
		'Wi-Fi': [v4('192.168.1.20')],
		en5: [v4('172.20.0.3'), v4('172.32.0.3')],
	});
	assert.deepEqual(got, ['192.168.1.20', '172.20.0.3', '100.64.1.9', '203.0.113.4', '172.32.0.3']);
});
