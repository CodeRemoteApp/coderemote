// The LAN certificate: generated once with openssl, then reused; and the reachable addresses.
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findOpenssl, lanAddresses, lanCertificate } from '../src/lan.js';
import { isWindows } from '../src/platform.js';

const hasOpenssl = Boolean(findOpenssl());
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lan-cert-'));

test('generates a certificate once and reuses it', { skip: !hasOpenssl }, async () => {
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

test('a new directory gets a new certificate', { skip: !hasOpenssl }, async () => {
	const a = await lanCertificate(path.join(tmp(), 'lan'));
	const b = await lanCertificate(path.join(tmp(), 'lan'));
	assert.notEqual(a.fingerprint, b.fingerprint);
});

test('without openssl there is no certificate, and nothing is left behind', { skip: isWindows }, async () => {
	const dir = path.join(tmp(), 'lan');
	const got = await lanCertificate(dir, { env: { PATH: tmp() } });
	assert.match(got.error, /openssl/);
	assert.equal(fs.existsSync(path.join(dir, 'key.pem')), false);
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
