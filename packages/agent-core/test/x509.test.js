// The self-signed LAN certificate made without openssl.
import assert from 'node:assert/strict';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { test } from 'node:test';
import { selfSignedCertificate } from '../src/x509.js';

test('a well-formed P-256 certificate, signed by its own key', () => {
	const now = new Date('2026-11-01T12:00:00Z');
	const { key, cert } = selfSignedCertificate({ now });
	const x = new X509Certificate(cert);
	assert.match(key, /^-----BEGIN PRIVATE KEY-----/);
	assert.equal(x.subject, 'CN=coderemote');
	assert.equal(x.issuer, 'CN=coderemote');
	assert.equal(x.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
	assert.ok(x.verify(x.publicKey));
	assert.ok(x.checkPrivateKey(createPrivateKey(key)));
	assert.equal(x.ca, false);
	assert.deepEqual(x.keyUsage, ['1.3.6.1.5.5.7.3.1']);
	assert.equal(new Date(x.validFrom).toISOString(), '2026-10-31T12:00:00.000Z');
	assert.equal(new Date(x.validTo).toISOString(), '2036-10-29T12:00:00.000Z');
	assert.match(x.serialNumber, /^[4-7][0-9A-F]{31}$/);
});

test('valid now, by default', () => {
	const x = new X509Certificate(selfSignedCertificate().cert);
	assert.ok(new Date(x.validFrom) < new Date());
	assert.ok(new Date(x.validTo) > new Date(Date.now() + 9 * 365 * 24 * 3600 * 1000));
});

test('every call makes a new key', () => {
	const a = new X509Certificate(selfSignedCertificate().cert);
	const b = new X509Certificate(selfSignedCertificate().cert);
	assert.notEqual(a.fingerprint256, b.fingerprint256);
	assert.notEqual(a.serialNumber, b.serialNumber);
});
